/**
 * HeartbeatView — Sidebar 第 4 个 tab, 显示 acp-bridge 心跳 loop 自动触发的 agent
 * 闲聊内容, 并允许调整 heartbeat interval (v2.15.0).
 *
 * 数据源:
 *   GET  /api/heartbeat        → { interval, allowed_intervals, enabled_agents, snapshot }
 *   GET  /api/heartbeat/logs   → { total, logs: [{ ts, agent, silent, duration, response, prompt_preview }, ...] }
 *   PUT  /api/heartbeat/interval { interval: <s> } → { interval, previous } 或 { error }
 *
 * 注意:
 *   - acp-bridge 错误响应 HTTP 仍是 200, body 含 error 字段, 需自己判.
 *   - allowed_intervals 是白名单 (e.g. [60, 120, 300, 600]), 用它做 select 选项.
 *   - snapshot.agents[name] 含 busy/idle, 给 log 卡片打 chip.
 *   - logs 里 silent=true 的项 response 为 null (LLM 回了 [SILENT]).
 *   - 进度条: 距上次 fetch 完成 → 下次 fetch 之间, 0% → 100% 平滑过渡;
 *     fetching 期间换成 indeterminate 动画.
 */

const POLL_INTERVAL_MS = 10000;
const SILENT_LS_KEY = 'pixel.heartbeatHideSilent';
const INTERVAL_LABELS = {
  30: '30s',
  60: '1 min',
  120: '2 min',
  300: '5 min',
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

    this._state = {
      interval: null,
      allowedIntervals: [],
      enabledAgents: [],
      snapshot: null,
      logs: [],
      total: 0,
      hideSilent,
      expandedPrompt: new Set(), // log ts (string) 集合
      lastError: null,           // logs / state 拉取错误
      intervalChange: null,      // {kind:'ok'|'error', text} 一次性显示
      lastFetchedAt: null,
      fetching: false,
      pendingIntervalChange: false,
    };
    this._timer = null;
    this._progressTimer = null; // 进度条 60fps RAF / setInterval

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
   * 拉一次 /heartbeat + /heartbeat/logs (并行).
   */
  async tickOnce() {
    if (!this._fetch) return;
    if (this._state.fetching) return;
    this._state.fetching = true;
    this._renderControls();
    this._startFetchingProgress();
    let stateOk = false, logsOk = false;
    let firstError = null;
    try {
      const [stateR, logsR] = await Promise.allSettled([
        this._fetch('/api/heartbeat'),
        this._fetch('/api/heartbeat/logs'),
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
    } finally {
      this._state.fetching = false;
      // 任一成功就算 lastFetchedAt 更新; 全失败保留旧值, 仅记 error
      if (stateOk || logsOk) this._state.lastFetchedAt = this._now();
      this._state.lastError = (stateOk && logsOk) ? null : firstError;
      this._render();
      this._startCountdownProgress();
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
    if (this._progressTimer) clearInterval(this._progressTimer);
    const el = this.container.querySelector('.hb-progress-bar');
    if (!el) return;
    el.classList.remove('hb-progress-indeterminate');
    const startMs = this._now();
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
      ${errBlock}
      <div class="hb-logs"></div>
    `;
    this._wireControls();
    this._renderLogs();
    this._startCountdownProgress();
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

  _renderLogs() {
    const wrap = this.container.querySelector('.hb-logs');
    if (!wrap) return;
    const { logs, hideSilent, snapshot } = this._state;
    const filtered = (logs || [])
      .filter(l => !hideSilent || !l.silent)
      .slice() // 不污染原数组
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));

    if (filtered.length === 0) {
      const totalNote = (logs && logs.length)
        ? `${logs.length} silent log${logs.length === 1 ? '' : 's'} hidden`
        : 'no heartbeat logs yet';
      wrap.innerHTML = `<div class="hb-empty">${totalNote}</div>`;
      return;
    }

    wrap.innerHTML = filtered.map(l => this._renderLogCard(l, snapshot)).join('');
    this._wireLogs();
  }

  _renderLogCard(log, snapshot) {
    const tsKey = String(log.ts);
    const expanded = this._state.expandedPrompt.has(tsKey);
    const ago = formatRelTs(log.ts, this._now());
    const dur = formatDur(log.duration);
    const stateChip = this._chipForAgent(log.agent, snapshot);
    const respBlock = log.silent
      ? `<div class="hb-card-body hb-silent">[silent]</div>`
      : `<div class="hb-card-body">${escapeHtml(String(log.response ?? ''))}</div>`;
    const promptToggle = log.prompt_preview
      ? `<div class="hb-card-prompt-toggle" data-ts="${escapeAttr(tsKey)}">${expanded ? '▾' : '▸'} prompt</div>`
      : '';
    const promptBody = (expanded && log.prompt_preview)
      ? `<pre class="hb-card-prompt">${escapeHtml(log.prompt_preview)}</pre>`
      : '';
    return `
      <div class="hb-card${log.silent ? ' hb-card-silent' : ''}" data-ts="${escapeAttr(tsKey)}">
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
        const ts = el.dataset.ts;
        if (this._state.expandedPrompt.has(ts)) this._state.expandedPrompt.delete(ts);
        else this._state.expandedPrompt.add(ts);
        this._renderLogs();
      });
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
