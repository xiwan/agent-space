/**
 * UsageView — Sidebar 第三个 tab, 展示 LLM token / cache / cost 统计 (v2.12.0)
 *
 * 数据源: GET /api/usage?hours=N (acp-bridge LiteLLM proxy)
 *
 * 重要语义注释:
 *   /usage 的 by_model 是 LiteLLM 调用维度, **不是 per-agent**.
 *   一个 agent 可能用多个 model, 一个 model 也可能被多个 agent 用.
 *   UI 标题用 "By LLM model" 而不是 "By Agent" 防误导.
 *
 * 设计取舍:
 *   - 30s 轮询 (聚合 SQL 不应高频)
 *   - 时间窗 4 档: 1h / 24h / 7d / 30d
 *   - localStorage 持久化时间窗 (`pixel.usageHours`)
 *   - cost 字段: server 不暴露则显 "—", 不前端估算 (避免误导)
 */

const POLL_INTERVAL_MS = 30000;
const HOURS_LS_KEY = 'pixel.usageHours';
const HOURS_OPTIONS = [
  { value: 1, label: '1 hour' },
  { value: 24, label: '24 hours' },
  { value: 168, label: '7 days' },
  { value: 720, label: '30 days' },
];

/**
 * tokens 数字格式化: 1234 → "1.2k", 1234567 → "1.2M".
 */
export function formatTokens(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const x = Math.abs(n);
  if (x < 1000) return String(n);
  if (x < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (x < 1_000_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
}

/**
 * cost 数字格式化: 0.0012 → "$0.0012", 0.00005 → "<$0.0001".
 * null/undefined → "—".
 */
export function formatCost(usd) {
  if (usd == null || !Number.isFinite(usd)) return '—';
  if (usd === 0) return '$0';
  if (usd > 0 && usd < 0.0001) return '<$0.0001';
  if (usd < 0 && usd > -0.0001) return '<$0.0001';
  return '$' + usd.toFixed(4);
}

/**
 * 秒数: 4.99 → "4.99s"
 */
export function formatDuration(s) {
  if (s == null || !Number.isFinite(s)) return '—';
  return s.toFixed(2) + 's';
}

/**
 * 相对时间 (秒): 12 → "12s", 90 → "1m", 3600 → "1h".
 */
export function formatAgo(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return Math.floor(seconds) + 's ago';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  return Math.floor(seconds / 3600) + 'h ago';
}

export class UsageView {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {Function} [opts.fetchImpl] — 测试可注入
   * @param {number} [opts.pollIntervalMs] — 默认 30000
   * @param {number} [opts.defaultHours] — 默认 24
   * @param {Function} [opts.nowMs] — 测试用 (Date.now 替身)
   */
  constructor(container, opts = {}) {
    if (!container) throw new Error('UsageView: container required');
    this.container = container;
    this._fetch = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this._now = opts.nowMs || (() => Date.now());

    // 时间窗 — 优先 localStorage, 否则 default
    let initialHours = opts.defaultHours ?? 24;
    try {
      if (typeof localStorage !== 'undefined') {
        const stored = parseInt(localStorage.getItem(HOURS_LS_KEY), 10);
        if (HOURS_OPTIONS.some(o => o.value === stored)) initialHours = stored;
      }
    } catch {}

    this._state = {
      hours: initialHours,
      data: null,
      lastError: null,
      lastFetchedAt: null,
      fetching: false,
    };
    this._timer = null;

    this._render();
  }

  setHours(hours) {
    if (this._state.hours === hours) return;
    if (!HOURS_OPTIONS.some(o => o.value === hours)) return;
    this._state.hours = hours;
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(HOURS_LS_KEY, String(hours));
    } catch {}
    this._render();
    // 立即拉新窗口数据
    this.tickOnce();
  }

  start() {
    if (this._timer) return;
    // 启动时立即拉一次
    this.tickOnce();
    this._timer = setInterval(() => this.tickOnce(), this.pollIntervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  getState() { return { ...this._state }; }

  async tickOnce() {
    if (!this._fetch) return;
    if (this._state.fetching) return;
    this._state.fetching = true;
    this._renderControls(); // 显示 loading
    try {
      const r = await this._fetch(`/api/usage?hours=${this._state.hours}`);
      if (!r || !r.ok) {
        const status = r ? r.status : '?';
        throw new Error(`GET /api/usage → ${status}`);
      }
      const data = await r.json();
      this._state.data = data;
      this._state.lastError = null;
      this._state.lastFetchedAt = this._now();
    } catch (e) {
      this._state.lastError = e.message || String(e);
    } finally {
      this._state.fetching = false;
      this._render();
    }
  }

  // ===== render =====

  _render() {
    const { hours, data, lastError, fetching } = this._state;
    const hoursOpts = HOURS_OPTIONS.map(o =>
      `<option value="${o.value}"${o.value === hours ? ' selected' : ''}>${o.label}</option>`
    ).join('');

    let body = '';
    if (lastError) {
      body = `
        <div class="usage-error">
          <div class="usage-error-msg">${escapeHtml(lastError)}</div>
          <button class="usage-retry" type="button">Retry</button>
        </div>
      `;
    } else if (!data) {
      body = `<div class="usage-empty">${fetching ? 'loading…' : 'no data'}</div>`;
    } else if (data.calls === 0) {
      body = `<div class="usage-empty">no usage data in last ${hours}h</div>`;
    } else {
      body = this._renderBody(data);
    }

    this.container.innerHTML = `
      <div class="usage-controls">
        <select class="usage-hours">
          ${hoursOpts}
        </select>
        <button class="usage-refresh" type="button" title="Refresh now"${fetching ? ' disabled' : ''}>${fetching ? '…' : '↻'}</button>
        <span class="usage-fetched">${this._fetchedAgoText()}</span>
      </div>
      ${body}
    `;
    this._wire();
  }

  _renderControls() {
    // 仅更新 controls (避免 fetching 状态切换重置整个 body 滚动条)
    const ctrls = this.container.querySelector('.usage-controls');
    if (!ctrls) { this._render(); return; }
    const refreshBtn = ctrls.querySelector('.usage-refresh');
    const fetchedSpan = ctrls.querySelector('.usage-fetched');
    if (refreshBtn) {
      refreshBtn.disabled = this._state.fetching;
      refreshBtn.textContent = this._state.fetching ? '…' : '↻';
    }
    if (fetchedSpan) fetchedSpan.textContent = this._fetchedAgoText();
  }

  _fetchedAgoText() {
    if (this._state.fetching) return 'fetching…';
    if (!this._state.lastFetchedAt) return '';
    const ago = (this._now() - this._state.lastFetchedAt) / 1000;
    return `updated ${formatAgo(ago)}`;
  }

  _renderBody(d) {
    const totalIn = d.input_tokens ?? 0;
    const totalOut = d.output_tokens ?? 0;
    const totalAll = d.total_tokens ?? (totalIn + totalOut);
    const cached = d.cached_tokens ?? 0;
    const cacheRate = d.cache_rate_pct ?? 0;
    const avgDur = d.avg_duration_s ?? 0;
    const calls = d.calls ?? 0;

    // by_model 渲染 (按 calls 倒序; 进度条以最大 input+output 为 100%)
    const models = Array.isArray(d.by_model) ? d.by_model : [];
    const maxTotal = models.reduce((m, x) =>
      Math.max(m, (x.input_tokens || 0) + (x.output_tokens || 0)), 0) || 1;

    const modelRows = models.map(m => {
      const mIn = m.input_tokens || 0;
      const mOut = m.output_tokens || 0;
      const mCached = m.cached_tokens || 0;
      const mTotal = mIn + mOut;
      const widthPct = (mTotal / maxTotal) * 100;
      const cachedPct = mIn > 0 ? Math.min(100, (mCached / mIn) * 100) : 0;
      const shortName = shortenModel(m.model);
      return `
        <div class="usage-model-row">
          <div class="usage-model-head">
            <span class="usage-model-name" title="${escapeAttr(m.model || '')}">${escapeHtml(shortName)}</span>
            <span class="usage-model-calls">${m.calls || 0} calls</span>
          </div>
          <div class="usage-bar-wrap">
            <div class="usage-bar usage-bar-total" style="width:${widthPct.toFixed(1)}%"></div>
            <div class="usage-bar usage-bar-cached" style="width:${(widthPct * cachedPct / 100).toFixed(1)}%"></div>
          </div>
          <div class="usage-model-nums">
            <span title="input tokens">in ${formatTokens(mIn)}</span>
            <span title="output tokens">out ${formatTokens(mOut)}</span>
            <span title="cached input tokens">cached ${formatTokens(mCached)}</span>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="usage-summary">
        <div class="usage-metric">
          <div class="usage-metric-label">Calls</div>
          <div class="usage-metric-value">${calls}</div>
          <div class="usage-metric-sub">avg ${formatDuration(avgDur)}</div>
        </div>
        <div class="usage-metric">
          <div class="usage-metric-label">Tokens</div>
          <div class="usage-metric-value">${formatTokens(totalAll)}</div>
          <div class="usage-metric-sub">in ${formatTokens(totalIn)} · out ${formatTokens(totalOut)}</div>
        </div>
        <div class="usage-metric usage-metric-cost" title="server-side cost not exposed via /usage (acp-bridge does not return cost_usd in by_model)">
          <div class="usage-metric-label">Cost</div>
          <div class="usage-metric-value">—</div>
          <div class="usage-metric-sub">(not avail)</div>
        </div>
        <div class="usage-metric">
          <div class="usage-metric-label">Cache rate</div>
          <div class="usage-metric-value">${cacheRate.toFixed(1)}%</div>
          <div class="usage-metric-sub">${formatTokens(cached)} cached</div>
        </div>
      </div>

      ${models.length > 0 ? `
      <div class="usage-models">
        <div class="usage-models-title" title="LLM model dimension — not per-agent">By LLM model</div>
        ${modelRows}
      </div>` : ''}
    `;
  }

  _wire() {
    const sel = this.container.querySelector('.usage-hours');
    if (sel) sel.addEventListener('change', (e) => this.setHours(parseInt(e.target.value, 10)));
    const ref = this.container.querySelector('.usage-refresh');
    if (ref) ref.addEventListener('click', () => this.tickOnce());
    const retry = this.container.querySelector('.usage-retry');
    if (retry) retry.addEventListener('click', () => this.tickOnce());
  }
}

/**
 * 把 model 全名缩短便于显示.
 * "us.anthropic.claude-sonnet-4-6" → "claude-sonnet-4-6"
 * "converse/qwen.qwen3-235b-a22b-2507-v1:0" → "qwen3-235b-a22b-…"
 * "bedrock/deepseek.v3.2" → "deepseek.v3.2"
 */
export function shortenModel(model) {
  if (!model) return '(unknown)';
  // 去掉 provider 前缀
  let s = String(model)
    .replace(/^converse\//, '')
    .replace(/^bedrock\//, '')
    .replace(/^us\.anthropic\./, '')
    .replace(/^anthropic\./, '');
  // 太长截断 (32 字)
  if (s.length > 32) s = s.slice(0, 31) + '…';
  return s;
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
