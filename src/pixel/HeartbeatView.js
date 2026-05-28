/**
 * HeartbeatView — Sidebar 第 4 个 tab (v2.15.0).
 *
 * 数据源:
 *   GET  /api/heartbeat          → { interval, allowed_intervals, enabled_agents, snapshot }
 *   GET  /api/heartbeat/logs     → { total, logs: [{ts, agent, silent, duration, response, prompt_preview}] }
 *   PUT  /api/heartbeat/interval { interval } → { interval, previous } 或 { error }
 *
 * v2.16.0 新增 Intervene 折叠区 (主动干预):
 *   GET    /api/heartbeat/context           → { contexts: [{text, ttl, created_at}] }
 *   POST   /api/heartbeat/context  {text, ttl} → { status:'ok', ttl, active_contexts } | 400 {error}
 *   DELETE /api/heartbeat/context           → { cleared:<n> }
 *   POST   /api/heartbeat/{agent_name}      → { agent, silent, response, snapshot, duration }
 *
 * 注意:
 *   - acp-bridge interval 错误 HTTP 200 + body.error; context inject 错误 HTTP 400 + body.error.
 *     都按 (!ok || body.error) 一并判.
 *   - allowed_intervals 是白名单, 用它做 select 选项.
 *   - snapshot.agents[name] 含 busy/idle, 给 log 卡片打 chip.
 *   - logs 里 silent=true 的项 response 为 null (LLM 回了 [SILENT]).
 *   - 进度条: 距上次 fetch 完成 → 下次 fetch 之间, 0% → 100% 平滑过渡;
 *     fetching 期间换成 indeterminate 动画.
 *   - 默认 hideSilent=true (silent log 占多数), v2.16.0 inject context 是看到非 silent 内容的解药.
 */

const POLL_INTERVAL_MS = 10000;
const SILENT_LS_KEY = 'pixel.heartbeatHideSilent';
const INTERVENE_LS_KEY = 'pixel.heartbeatInterveneOpen';
const TTL_DEFAULT = 3;
const TTL_MIN = 1;
const TTL_MAX = 100;
const INTERVAL_LABELS = {
  30: '30s',
  60: '1 min',
  180: '3 min',
  600: '10 min',
  1800: '30 min',
  3600: '1 h',
};

/**
 * 把 interval (秒) 标签化. 不在白表里就回退为 "Ns".
 */
export function formatIntervalLabel(s) {
  if (s == null || !Number.isFinite(s)) return '—';
  return INTERVAL_LABELS[s] || (s + 's');
}

/**
 * 把绝对秒级时间戳转成 "Ns ago" / "Nm ago" / "Nh ago".
 */
export function formatRelTs(ts, nowMs) {
  if (ts == null || !Number.isFinite(ts)) return '—';
  const dSec = (nowMs / 1000) - ts;
  if (!Number.isFinite(dSec) || dSec < 0) return 'just now';
  if (dSec < 60) return Math.floor(dSec) + 's ago';
  if (dSec < 3600) return Math.floor(dSec / 60) + 'm ago';
  return Math.floor(dSec / 3600) + 'h ago';
}

/**
 * duration 秒 → "4.1s" / "—".
 */
export function formatDur(s) {
  if (s == null || !Number.isFinite(s)) return '—';
  return s.toFixed(1) + 's';
}

export class HeartbeatView {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {Function} [opts.fetchImpl]
   * @param {number} [opts.pollIntervalMs] 默认 10000
   * @param {Function} [opts.nowMs] 测试用
   */
  constructor(container, opts = {}) {
    if (!container) throw new Error('HeartbeatView: container required');
    this.container = container;
    this._fetch = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this._now = opts.nowMs || (() => Date.now());

    let hideSilent = true;
    try {
      if (typeof localStorage !== 'undefined') {
        const v = localStorage.getItem(SILENT_LS_KEY);
        if (v === 'false') hideSilent = false;
      }
    } catch {}

    let interveneOpen = false;
    try {
      if (typeof localStorage !== 'undefined') {
        const v = localStorage.getItem(INTERVENE_LS_KEY);
        if (v === 'true') interveneOpen = true;
      }
    } catch {}

    this._state = {
      interval: null,
      allowedIntervals: [],
      enabledAgents: [],
      snapshot: null,
      logs: [],
      total: 0,
      contexts: [],                    // v2.16.0: 注入的话题列表
      hideSilent,
      interveneOpen,                   // v2.16.0: 折叠区是否展开
      injectText: '',                  // v2.16.0: textarea 实时内容 (controlled)
      injectTtl: TTL_DEFAULT,          // v2.16.0
      pingAgent: null,                 // v2.16.0: 选中要 ping 的 agent
      pingPending: false,              // v2.16.0: ping in-flight
      injectPending: false,            // v2.16.0
      clearPending: false,             // v2.16.0
      expandedPrompt: new Set(),       // log ts (string) 集合
      lastError: null,                 // logs / state / contexts 拉取错误
      intervalChange: null,            // {kind:'ok'|'error'|'pending', text} 一次性显示
      interveneStatus: null,           // v2.16.0: {kind, text} 一次性显示
      lastFetchedAt: null,
      fetching: false,
      pendingIntervalChange: false,
    };
    this._timer = null;
    this._progressTimer = null;
    this._pingedClearTimer = null;        // v2.17.0 #3
    this._countdownStartMs = null;        // v2.17.0 #1: 真实下次轮询的起点

    this._render();
  }

  start() {
    if (this._timer) return;
    this.tickOnce();
    this._timer = setInterval(() => this.tickOnce(), this.pollIntervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._progressTimer) clearInterval(this._progressTimer);
    this._progressTimer = null;
  }

  getState() { return { ...this._state, expandedPrompt: new Set(this._state.expandedPrompt) }; }

  setHideSilent(v) {
    const next = !!v;
    if (this._state.hideSilent === next) return;
    this._state.hideSilent = next;
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(SILENT_LS_KEY, next ? 'true' : 'false');
    } catch {}
    this._renderLogs();
  }

  /**
   * 拉一次 /heartbeat + /heartbeat/logs + /heartbeat/context (并行).
   */
  async tickOnce() {
    if (!this._fetch) return;
    if (this._state.fetching) return;
    this._state.fetching = true;
    this._renderControls();
    this._startFetchingProgress();
    let stateOk = false, logsOk = false, ctxOk = false;
    let firstError = null;
    try {
      const [stateR, logsR, ctxR] = await Promise.allSettled([
        this._fetch('/api/heartbeat'),
        this._fetch('/api/heartbeat/logs'),
        this._fetch('/api/heartbeat/context'),
      ]);
      // /heartbeat
      if (stateR.status === 'fulfilled') {
        const r = stateR.value;
        if (r && r.ok) {
          const data = await r.json();
          this._state.interval = data.interval ?? null;
          this._state.allowedIntervals = Array.isArray(data.allowed_intervals) ? data.allowed_intervals : [];
          this._state.enabledAgents = Array.isArray(data.enabled_agents) ? data.enabled_agents : [];
          this._state.snapshot = data.snapshot || null;
          stateOk = true;
        } else {
          firstError = firstError || `GET /api/heartbeat → ${r ? r.status : '?'}`;
        }
      } else {
        firstError = firstError || (stateR.reason?.message || 'GET /api/heartbeat failed');
      }
      // /heartbeat/logs
      if (logsR.status === 'fulfilled') {
        const r = logsR.value;
        if (r && r.ok) {
          const data = await r.json();
          this._state.logs = Array.isArray(data.logs) ? data.logs : [];
          this._state.total = data.total ?? this._state.logs.length;
          logsOk = true;
        } else {
          firstError = firstError || `GET /api/heartbeat/logs → ${r ? r.status : '?'}`;
        }
      } else {
        firstError = firstError || (logsR.reason?.message || 'GET /api/heartbeat/logs failed');
      }
      // v2.16.0: /heartbeat/context
      if (ctxR.status === 'fulfilled') {
        const r = ctxR.value;
        if (r && r.ok) {
          const data = await r.json();
          this._state.contexts = Array.isArray(data.contexts) ? data.contexts : [];
          ctxOk = true;
        } else {
          firstError = firstError || `GET /api/heartbeat/context → ${r ? r.status : '?'}`;
        }
      } else {
        firstError = firstError || (ctxR.reason?.message || 'GET /api/heartbeat/context failed');
      }
    } finally {
      this._state.fetching = false;
      // 任一成功就算 lastFetchedAt 更新
      if (stateOk || logsOk || ctxOk) this._state.lastFetchedAt = this._now();
      this._state.lastError = (stateOk && logsOk && ctxOk) ? null : firstError;
      // v2.17.0 #1: 在 _render 之前设新的 countdown 起点, 让 _resumeCountdown 拿到
      this._countdownStartMs = this._now();
      this._render();
      this._resumeCountdown();
    }
  }

  /**
   * 修改 interval. acp-bridge 错误响应 HTTP 200 + body 含 error.
   */
  async changeInterval(seconds) {
    if (!this._fetch) return;
    if (this._state.pendingIntervalChange) return;
    const before = this._state.interval;
    this._state.pendingIntervalChange = true;
    this._state.intervalChange = { kind: 'pending', text: `setting interval to ${formatIntervalLabel(seconds)}…` };
    this._render();
    try {
      const r = await this._fetch('/api/heartbeat/interval', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interval: seconds }),
      });
      let body = null;
      try { body = await r.json(); } catch {}
      if (!r || !r.ok || !body || body.error) {
        const msg = (body && body.error) || (r ? `HTTP ${r.status}` : 'no response');
        this._state.intervalChange = { kind: 'error', text: `interval change failed: ${msg}` };
      } else {
        const prev = body.previous ?? before;
        const cur = body.interval ?? seconds;
        this._state.interval = cur;
        this._state.intervalChange = { kind: 'ok', text: `interval ${formatIntervalLabel(prev)} → ${formatIntervalLabel(cur)}` };
      }
    } catch (e) {
      this._state.intervalChange = { kind: 'error', text: `interval change failed: ${e.message || e}` };
    } finally {
      this._state.pendingIntervalChange = false;
      // 立即重拉 /heartbeat 同步 (非阻塞)
      this._render();
      this.tickOnce();
    }
  }

  // ============================================================
  // v2.16.0: Intervene 折叠区
  // ============================================================

  /**
   * 切换 Intervene 折叠区开合.
   */
  toggleIntervene() {
    this._state.interveneOpen = !this._state.interveneOpen;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(INTERVENE_LS_KEY, this._state.interveneOpen ? 'true' : 'false');
      }
    } catch {}
    this._render();
  }

  setInjectText(t) { this._state.injectText = String(t || ''); }
  setInjectTtl(n) {
    const v = parseInt(n, 10);
    if (!Number.isFinite(v)) return;
    this._state.injectTtl = Math.max(TTL_MIN, Math.min(TTL_MAX, v));
  }
  setPingAgent(name) { this._state.pingAgent = name || null; }

  /**
   * POST /heartbeat/context — 注入话题, 让所有 agent 下次 N 次 heartbeat 看到.
   * acp-bridge 错误是 HTTP 400 + body.error.
   */
  async injectContext() {
    if (!this._fetch) return;
    const text = (this._state.injectText || '').trim();
    if (!text) {
      this._state.interveneStatus = { kind: 'error', text: 'inject failed: text is required' };
      this._render();
      return;
    }
    if (this._state.injectPending) return;
    const ttl = Math.max(TTL_MIN, Math.min(TTL_MAX, this._state.injectTtl | 0));
    this._state.injectPending = true;
    this._state.interveneStatus = { kind: 'pending', text: `injecting (ttl ${ttl})…` };
    this._render();
    try {
      const r = await this._fetch('/api/heartbeat/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, ttl }),
      });
      let body = null;
      try { body = await r.json(); } catch {}
      if (!r || !r.ok || !body || body.error) {
        const msg = (body && body.error) || (r ? `HTTP ${r.status}` : 'no response');
        this._state.interveneStatus = { kind: 'error', text: `inject failed: ${msg}` };
      } else {
        this._state.interveneStatus = {
          kind: 'ok',
          text: `injected (ttl ${body.ttl ?? ttl}, ${body.active_contexts ?? '?'} active)`,
        };
        // v2.17.0 #3: 乐观插入到 contexts list 头, 等 tickOnce 回包覆盖.
        // server 也会回这条, 不打 _optimistic marker.
        const optimistic = {
          text,
          ttl: body.ttl ?? ttl,
          created_at: this._now() / 1000,
        };
        this._state.contexts = [optimistic, ...(this._state.contexts || [])];
        this._state.injectText = ''; // 清空输入
      }
    } catch (e) {
      this._state.interveneStatus = { kind: 'error', text: `inject failed: ${e.message || e}` };
    } finally {
      this._state.injectPending = false;
      this._render();
      this.tickOnce(); // 立即刷新 contexts list
    }
  }

  /**
   * DELETE /heartbeat/context — 清空所有注入话题.
   */
  async clearContexts(skipConfirm = false) {
    if (!this._fetch) return;
    if (this._state.clearPending) return;
    if (!skipConfirm && typeof window !== 'undefined' && typeof window.confirm === 'function') {
      const ok = window.confirm('Clear all injected contexts? This affects every agent on next heartbeat.');
      if (!ok) return;
    }
    this._state.clearPending = true;
    this._state.interveneStatus = { kind: 'pending', text: 'clearing…' };
    this._render();
    try {
      const r = await this._fetch('/api/heartbeat/context', { method: 'DELETE' });
      let body = null;
      try { body = await r.json(); } catch {}
      if (!r || !r.ok) {
        this._state.interveneStatus = { kind: 'error', text: `clear failed: HTTP ${r ? r.status : '?'}` };
      } else {
        const n = (body && body.cleared) ?? 0;
        this._state.interveneStatus = { kind: 'ok', text: `cleared ${n} context${n === 1 ? '' : 's'}` };
        this._state.contexts = [];
      }
    } catch (e) {
      this._state.interveneStatus = { kind: 'error', text: `clear failed: ${e.message || e}` };
    } finally {
      this._state.clearPending = false;
      this._render();
      this.tickOnce();
    }
  }

  /**
   * POST /heartbeat/{agent} — 立即触发某 agent 的 heartbeat (不等 interval).
   * 成功后把 response 即刻 unshift 到 logs 头, 不等下次轮询.
   */
  async pingAgent(name) {
    if (!this._fetch) return;
    const target = name || this._state.pingAgent;
    if (!target) {
      this._state.interveneStatus = { kind: 'error', text: 'ping failed: no agent selected' };
      this._render();
      return;
    }
    if (this._state.pingPending) return;
    this._state.pingPending = true;
    this._state.interveneStatus = { kind: 'pending', text: `pinging ${target}…` };
    this._render();
    try {
      const r = await this._fetch(`/api/heartbeat/${encodeURIComponent(target)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      let body = null;
      try { body = await r.json(); } catch {}
      if (!r || !r.ok || !body || body.error) {
        const msg = (body && body.error) || (r ? `HTTP ${r.status}` : 'no response');
        this._state.interveneStatus = { kind: 'error', text: `ping ${target} failed: ${msg}` };
      } else {
        const tag = body.silent ? 'silent' : 'spoke';
        this._state.interveneStatus = { kind: 'ok', text: `${target} ${tag}` };
        // 把这次 ping 结果即刻塞进 logs 头, 不等下次轮询
        // v2.17.0 #3: 加 _pinged 标记, 让卡片用 hb-card-pinged 高亮 (1500ms CSS 动画)
        const entry = {
          ts: this._now() / 1000,
          agent: body.agent || target,
          silent: !!body.silent,
          duration: body.duration ?? null,
          response: body.silent ? null : (body.response ?? ''),
          prompt_preview: body.prompt_preview || '',
          _pinged: true,
        };
        this._state.logs = [entry, ...(this._state.logs || [])];
        if (body.snapshot) this._state.snapshot = body.snapshot;
      }
    } catch (e) {
      this._state.interveneStatus = { kind: 'error', text: `ping ${target} failed: ${e.message || e}` };
    } finally {
      this._state.pingPending = false;
      this._render();
    }
  }

  // ============================================================
  // progress bar (controls 行下方一条 2px 进度条)
  // ============================================================

  _startFetchingProgress() {
    if (this._progressTimer) clearInterval(this._progressTimer);
    this._progressTimer = null;
    const el = this.container.querySelector('.hb-progress-bar');
    if (el) {
      el.style.width = '100%';
      el.classList.add('hb-progress-indeterminate');
    }
  }

  _startCountdownProgress() {
    // v2.17.0 #1: alias 保留向后兼容 (内部统一用 _resumeCountdown)
    this._resumeCountdown();
  }

  /**
   * v2.17.0 #1: 进度条复位时不重置 startMs, 用 this._countdownStartMs.
   * 这样 _render() 在非 tickOnce 触发的场景 (hideSilent toggle / inject 状态变化等)
   * 重建 .hb-progress-bar 节点时, 进度仍延续真实下次轮询的剩余时间.
   * 仅 tickOnce() finally 阶段刷新 _countdownStartMs.
   */
  _resumeCountdown() {
    if (this._progressTimer) clearInterval(this._progressTimer);
    const el = this.container.querySelector('.hb-progress-bar');
    if (!el) {
      this._progressTimer = null;
      return;
    }
    el.classList.remove('hb-progress-indeterminate');
    const startMs = this._countdownStartMs ?? this._now();
    const total = this.pollIntervalMs;
    const step = () => {
      const elapsed = this._now() - startMs;
      const pct = Math.max(0, Math.min(100, (elapsed / total) * 100));
      const node = this.container.querySelector('.hb-progress-bar');
      if (!node) {
        if (this._progressTimer) clearInterval(this._progressTimer);
        this._progressTimer = null;
        return;
      }
      node.style.width = pct.toFixed(1) + '%';
      if (pct >= 100) {
        if (this._progressTimer) clearInterval(this._progressTimer);
        this._progressTimer = null;
      }
    };
    step();
    // 250ms 步进足够平滑且节能
    this._progressTimer = setInterval(step, 250);
  }

  // ============================================================
  // render
  // ============================================================

  _render() {
    const focusInfo = this._captureFocus();
    const { interval, allowedIntervals, lastError, fetching, lastFetchedAt } = this._state;

    const intervals = (allowedIntervals && allowedIntervals.length)
      ? allowedIntervals
      : (interval ? [interval] : []);
    const intervalOpts = intervals.map(s =>
      `<option value="${s}"${s === interval ? ' selected' : ''}>${formatIntervalLabel(s)}</option>`
    ).join('');

    const fetchedText = fetching
      ? 'fetching…'
      : lastFetchedAt
        ? `updated ${formatRelTs(lastFetchedAt / 1000, this._now())}`
        : '';

    const errBlock = lastError
      ? `<div class="hb-error">${escapeHtml(lastError)}</div>`
      : '';

    this.container.innerHTML = `
      <div class="hb-controls">
        <label class="hb-interval-label">interval</label>
        <select class="hb-interval-select"${intervalOpts ? '' : ' disabled'}>
          ${intervalOpts || '<option>—</option>'}
        </select>
        <label class="hb-silent-toggle">
          <input type="checkbox" class="hb-hide-silent"${this._state.hideSilent ? ' checked' : ''}>
          <span>hide silent</span>
        </label>
        <button class="hb-refresh" type="button" title="Refresh now"${fetching ? ' disabled' : ''}>${fetching ? '…' : '↻'}</button>
        <span class="hb-fetched">${fetchedText}</span>
      </div>
      <div class="hb-progress"><div class="hb-progress-bar"></div></div>
      ${this._renderIntervalChange()}
      ${this._renderIntervene()}
      ${errBlock}
      <div class="hb-logs"></div>
    `;
    this._wireControls();
    this._wireIntervene();
    this._renderLogs();
    this._resumeCountdown();
    this._restoreFocus(focusInfo);
  }

  /**
   * v2.16.0: 跨 _render 保留 textarea/input 焦点 + 光标位置, 防 10s 轮询时光标乱跳.
   */
  _captureFocus() {
    if (typeof document === 'undefined') return null;
    const el = document.activeElement;
    if (!el || !this.container.contains(el)) return null;
    const cls = ['hb-inject-text', 'hb-inject-ttl', 'hb-ping-select'].find(c => el.classList && el.classList.contains(c));
    if (!cls) return null;
    return {
      cls,
      selStart: el.selectionStart != null ? el.selectionStart : null,
      selEnd: el.selectionEnd != null ? el.selectionEnd : null,
    };
  }
  _restoreFocus(info) {
    if (!info) return;
    const el = this.container.querySelector('.' + info.cls);
    if (!el) return;
    try {
      el.focus();
      if (info.selStart != null && el.setSelectionRange) {
        el.setSelectionRange(info.selStart, info.selEnd);
      }
    } catch {}
  }

  _renderControls() {
    const ctrls = this.container.querySelector('.hb-controls');
    if (!ctrls) { this._render(); return; }
    const refreshBtn = ctrls.querySelector('.hb-refresh');
    if (refreshBtn) {
      refreshBtn.disabled = this._state.fetching;
      refreshBtn.textContent = this._state.fetching ? '…' : '↻';
    }
    const fetchedSpan = ctrls.querySelector('.hb-fetched');
    if (fetchedSpan) {
      fetchedSpan.textContent = this._state.fetching
        ? 'fetching…'
        : (this._state.lastFetchedAt ? `updated ${formatRelTs(this._state.lastFetchedAt / 1000, this._now())}` : '');
    }
    // interval-change 状态条: 整体 _render 会重渲一次, 这里只负责 fetching 期间的小更新.
  }

  _renderIntervalChange() {
    const ic = this._state.intervalChange;
    if (!ic) return '';
    const cls = ic.kind === 'ok' ? 'hb-interval-change hb-interval-ok'
              : ic.kind === 'error' ? 'hb-interval-change hb-interval-error'
              : 'hb-interval-change hb-interval-pending';
    return `<div class="${cls}">${escapeHtml(ic.text)}</div>`;
  }

  // ============================================================
  // v2.16.0: Intervene render
  // ============================================================

  _renderIntervene() {
    const open = this._state.interveneOpen;
    const arrow = open ? '▾' : '▸';
    const head = `<div class="hb-intervene-toggle" data-toggle="intervene">${arrow} Intervene</div>`;
    if (!open) return `<div class="hb-intervene">${head}</div>`;

    const enabled = this._state.enabledAgents || [];
    const pingTarget = this._state.pingAgent || enabled[0] || '';
    const agentOpts = enabled.length
      ? enabled.map(a => `<option value="${escapeAttr(a)}"${a === pingTarget ? ' selected' : ''}>${escapeHtml(a)}</option>`).join('')
      : '<option value="">(none)</option>';

    const status = this._renderInterveneStatus();
    const ctxList = this._renderContextList();
    const txt = escapeHtml(this._state.injectText || '');
    const ttl = this._state.injectTtl;
    const injecting = this._state.injectPending;
    const clearing = this._state.clearPending;
    const pinging = this._state.pingPending;

    const body = `
      <div class="hb-intervene-body">
        <div class="hb-intervene-section">
          <label class="hb-intervene-label">Inject context (all agents, next N heartbeats)</label>
          <textarea class="hb-inject-text" rows="2" placeholder="e.g. demo starts at 2pm — say something fun" ${injecting ? 'disabled' : ''}>${txt}</textarea>
          <div class="hb-intervene-row">
            <label class="hb-ttl-label">ttl</label>
            <input type="number" class="hb-inject-ttl" min="${TTL_MIN}" max="${TTL_MAX}" step="1" value="${ttl}" ${injecting ? 'disabled' : ''}>
            <button class="hb-inject-btn" type="button" ${injecting ? 'disabled' : ''}>${injecting ? '…' : 'Inject'}</button>
          </div>
        </div>

        <div class="hb-intervene-section">
          <div class="hb-intervene-row hb-intervene-row-head">
            <label class="hb-intervene-label">Active contexts</label>
            <button class="hb-clear-btn" type="button" ${clearing || (this._state.contexts || []).length === 0 ? 'disabled' : ''}>${clearing ? '…' : 'Clear all'}</button>
          </div>
          ${ctxList}
        </div>

        <div class="hb-intervene-section">
          <label class="hb-intervene-label">Ping now (skip interval)</label>
          <div class="hb-intervene-row">
            <select class="hb-ping-select" ${pinging || enabled.length === 0 ? 'disabled' : ''}>${agentOpts}</select>
            <button class="hb-ping-btn" type="button" ${pinging || enabled.length === 0 ? 'disabled' : ''}>${pinging ? '…' : 'Ping'}</button>
          </div>
        </div>

        ${status}
      </div>
    `;
    return `<div class="hb-intervene hb-intervene-open">${head}${body}</div>`;
  }

  _renderInterveneStatus() {
    const s = this._state.interveneStatus;
    if (!s) return '';
    const cls = s.kind === 'ok' ? 'hb-intervene-status hb-intervene-ok'
              : s.kind === 'error' ? 'hb-intervene-status hb-intervene-error'
              : 'hb-intervene-status hb-intervene-pending';
    return `<div class="${cls}">${escapeHtml(s.text)}</div>`;
  }

  _renderContextList() {
    const ctxs = this._state.contexts || [];
    if (ctxs.length === 0) {
      return `<div class="hb-context-empty">no active contexts</div>`;
    }
    const now = this._now();
    return `<div class="hb-context-list">${ctxs.map(c => {
      const ago = formatRelTs(c.created_at, now);
      const text = String(c.text || '');
      return `
        <div class="hb-context-item">
          <div class="hb-context-text">${escapeHtml(text)}</div>
          <div class="hb-context-meta">ttl ${c.ttl ?? '?'} · ${escapeHtml(ago)}</div>
        </div>
      `;
    }).join('')}</div>`;
  }

  _wireIntervene() {
    const toggle = this.container.querySelector('[data-toggle="intervene"]');
    if (toggle) toggle.addEventListener('click', () => this.toggleIntervene());
    if (!this._state.interveneOpen) return;

    const txt = this.container.querySelector('.hb-inject-text');
    if (txt) txt.addEventListener('input', (e) => this.setInjectText(e.target.value));
    const ttl = this.container.querySelector('.hb-inject-ttl');
    if (ttl) {
      ttl.addEventListener('change', (e) => {
        this.setInjectTtl(e.target.value);
        e.target.value = String(this._state.injectTtl); // clamp echo
      });
    }
    const injectBtn = this.container.querySelector('.hb-inject-btn');
    if (injectBtn) injectBtn.addEventListener('click', () => this.injectContext());

    const clearBtn = this.container.querySelector('.hb-clear-btn');
    if (clearBtn) clearBtn.addEventListener('click', () => this.clearContexts());

    const pingSel = this.container.querySelector('.hb-ping-select');
    if (pingSel) pingSel.addEventListener('change', (e) => this.setPingAgent(e.target.value));
    const pingBtn = this.container.querySelector('.hb-ping-btn');
    if (pingBtn) pingBtn.addEventListener('click', () => this.pingAgent());
  }

  _renderLogs() {
    const wrap = this.container.querySelector('.hb-logs');
    if (!wrap) return;
    const { logs, hideSilent, snapshot } = this._state;
    const filtered = (logs || [])
      .filter(l => !hideSilent || !l.silent)
      .slice() // 不污染原数组
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));

    // v2.17.0: prune expandedPrompt — 删掉已不在 logs 列表里的 key
    // 防止 ring buffer 滚出后旧 key 永久残留
    this._pruneExpandedPrompt(filtered);

    if (filtered.length === 0) {
      const totalNote = (logs && logs.length)
        ? `${logs.length} silent log${logs.length === 1 ? '' : 's'} hidden`
        : 'no heartbeat logs yet';
      wrap.innerHTML = `<div class="hb-empty">${totalNote}</div>`;
      return;
    }

    const now = this._now();
    wrap.innerHTML = filtered.map(l => this._renderLogCard(l, snapshot, now)).join('');
    this._wireLogs();

    // v2.17.0 #3: ping unshift 的 log 标了 _pinged, 1500ms 后清掉重渲一次,
    // 让 hb-card-pinged 高亮动画自然结束 (CSS keyframe 控制视觉, JS 只清状态)
    this._scheduleClearPinged();
  }

  /**
   * v2.17.0: 复合 key (agent | ts.toFixed(3)) 取代单纯的 ts 字符串.
   * 防浮点格式漂移 + 不同 agent 同 ts 撞车.
   */
  _promptKey(log) {
    const ts = Number(log.ts);
    const tsStr = Number.isFinite(ts) ? ts.toFixed(3) : 'na';
    return (log.agent || '') + '|' + tsStr;
  }

  _pruneExpandedPrompt(filteredLogs) {
    if (!this._state.expandedPrompt || this._state.expandedPrompt.size === 0) return;
    const validKeys = new Set(filteredLogs.map(l => this._promptKey(l)));
    for (const k of [...this._state.expandedPrompt]) {
      if (!validKeys.has(k)) this._state.expandedPrompt.delete(k);
    }
  }

  _scheduleClearPinged() {
    const logs = this._state.logs || [];
    if (!logs.some(l => l._pinged)) return;
    if (this._pingedClearTimer) return; // 已经排队
    this._pingedClearTimer = setTimeout(() => {
      this._pingedClearTimer = null;
      let dirty = false;
      for (const l of this._state.logs) {
        if (l._pinged) { delete l._pinged; dirty = true; }
      }
      if (dirty) this._renderLogs();
    }, 1500);
  }

  _renderLogCard(log, snapshot, now) {
    const promptKey = this._promptKey(log);
    const expanded = this._state.expandedPrompt.has(promptKey);
    const ago = formatRelTs(log.ts, now ?? this._now());
    const dur = formatDur(log.duration);
    const stateChip = this._chipForAgent(log.agent, snapshot);
    const respBlock = log.silent
      ? `<div class="hb-card-body hb-silent">[silent]</div>`
      : `<div class="hb-card-body">${escapeHtml(String(log.response ?? ''))}</div>`;
    const promptToggle = log.prompt_preview
      ? `<div class="hb-card-prompt-toggle" data-prompt-key="${escapeAttr(promptKey)}">${expanded ? '▾' : '▸'} prompt</div>`
      : '';
    const promptBody = (expanded && log.prompt_preview)
      ? `<pre class="hb-card-prompt">${escapeHtml(log.prompt_preview)}</pre>`
      : '';
    const pingedCls = log._pinged ? ' hb-card-pinged' : '';
    return `
      <div class="hb-card${log.silent ? ' hb-card-silent' : ''}${pingedCls}" data-prompt-key="${escapeAttr(promptKey)}">
        <div class="hb-card-head">
          <span class="hb-card-agent">${escapeHtml(log.agent || '?')}</span>
          ${stateChip}
          <span class="hb-card-ago">${escapeHtml(ago)}</span>
          <span class="hb-card-dur">${escapeHtml(dur)}</span>
        </div>
        ${respBlock}
        ${promptToggle}
        ${promptBody}
      </div>
    `;
  }

  _chipForAgent(agentName, snapshot) {
    if (!snapshot || !snapshot.agents || !agentName) return '';
    const a = snapshot.agents[agentName];
    if (!a) return '';
    const busy = a.busy | 0;
    const idle = a.idle | 0;
    if (busy > 0) return `<span class="hb-state-chip hb-state-busy">busy ${busy}</span>`;
    if (idle > 0) return `<span class="hb-state-chip hb-state-idle">idle ${idle}</span>`;
    return `<span class="hb-state-chip hb-state-offline">offline</span>`;
  }

  _wireControls() {
    const sel = this.container.querySelector('.hb-interval-select');
    if (sel) sel.addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10);
      if (Number.isFinite(v)) this.changeInterval(v);
    });
    const cb = this.container.querySelector('.hb-hide-silent');
    if (cb) cb.addEventListener('change', (e) => this.setHideSilent(e.target.checked));
    const ref = this.container.querySelector('.hb-refresh');
    if (ref) ref.addEventListener('click', () => this.tickOnce());
  }

  _wireLogs() {
    this.container.querySelectorAll('.hb-card-prompt-toggle').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.dataset.promptKey;
        if (!key) return;
        if (this._state.expandedPrompt.has(key)) this._state.expandedPrompt.delete(key);
        else this._state.expandedPrompt.add(key);
        this._renderLogs();
      });
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
