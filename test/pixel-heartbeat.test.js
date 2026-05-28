// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  HeartbeatView,
  formatIntervalLabel,
  formatRelTs,
  formatDur,
} from '../src/pixel/HeartbeatView.js';

const NOW_MS = 1779946834500;

const SAMPLE_STATE = {
  enabled_agents: ['claude', 'kiro', 'qwen'],
  interval: 60,
  allowed_intervals: [60, 120, 300, 600],
  snapshot: {
    agents: {
      claude: { busy: 0, idle: 1 },
      kiro:   { busy: 1, idle: 0 },
      qwen:   { busy: 0, idle: 0 },
    },
  },
};

const SAMPLE_LOGS = {
  total: 3,
  logs: [
    { ts: NOW_MS / 1000 - 12, agent: 'claude', silent: false, duration: 4.2,
      response: 'hi everyone, anyone want to debug?', prompt_preview: 'You are claude...' },
    { ts: NOW_MS / 1000 - 60, agent: 'kiro', silent: true, duration: 3.1,
      response: null, prompt_preview: 'You are kiro...' },
    { ts: NOW_MS / 1000 - 200, agent: 'qwen', silent: false, duration: 2.5,
      response: 'busy with refactor', prompt_preview: 'You are qwen...' },
  ],
};

function makeFetch(map) {
  return vi.fn(async (url, opts) => {
    const key = `${(opts && opts.method) || 'GET'} ${url}`;
    const handler = map[key];
    if (!handler) throw new Error(`unhandled fetch: ${key}`);
    return handler(opts);
  });
}

function okResp(data) {
  return { ok: true, status: 200, json: async () => data };
}
function failResp(status, text = 'oops') {
  return { ok: false, status, text: async () => text, json: async () => ({}) };
}

async function flush() {
  // 等所有 microtask + 一轮 macrotask
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

describe('HeartbeatView formatters', () => {
  it('formatIntervalLabel — known values', () => {
    expect(formatIntervalLabel(60)).toBe('1 min');
    expect(formatIntervalLabel(120)).toBe('2 min');
    expect(formatIntervalLabel(300)).toBe('5 min');
    expect(formatIntervalLabel(600)).toBe('10 min');
  });
  it('formatIntervalLabel — unknown falls back to "Ns"', () => {
    expect(formatIntervalLabel(45)).toBe('45s');
    expect(formatIntervalLabel(null)).toBe('—');
    expect(formatIntervalLabel(undefined)).toBe('—');
  });

  it('formatRelTs — seconds / minutes / hours', () => {
    const now = 1_000_000_000_000;
    expect(formatRelTs(now / 1000 - 12, now)).toBe('12s ago');
    expect(formatRelTs(now / 1000 - 90, now)).toBe('1m ago');
    expect(formatRelTs(now / 1000 - 3700, now)).toBe('1h ago');
    expect(formatRelTs(null, now)).toBe('—');
    expect(formatRelTs(now / 1000 + 5, now)).toBe('just now'); // 未来
  });

  it('formatDur', () => {
    expect(formatDur(4.2)).toBe('4.2s');
    expect(formatDur(0)).toBe('0.0s');
    expect(formatDur(null)).toBe('—');
    expect(formatDur(NaN)).toBe('—');
  });
});

describe('HeartbeatView render', () => {
  let container;
  beforeEach(() => {
    try { localStorage.clear(); } catch {}
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
  });

  it('throws if no container', () => {
    expect(() => new HeartbeatView(null)).toThrow(/container/);
  });

  it('renders empty state initially (no fetch yet, no data)', () => {
    new HeartbeatView(container, { fetchImpl: vi.fn() });
    expect(container.querySelector('.hb-controls')).not.toBeNull();
    expect(container.querySelector('.hb-progress')).not.toBeNull();
    expect(container.querySelector('.hb-progress-bar')).not.toBeNull();
    // empty: select 是 disabled (no allowed_intervals yet)
    const sel = container.querySelector('.hb-interval-select');
    expect(sel.disabled).toBe(true);
    expect(container.querySelector('.hb-empty')).not.toBeNull();
  });

  it('after tickOnce — populates interval select + logs', async () => {
    const f = makeFetch({
      'GET /api/heartbeat':       async () => okResp(SAMPLE_STATE),
      'GET /api/heartbeat/logs':  async () => okResp(SAMPLE_LOGS),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();

    const sel = container.querySelector('.hb-interval-select');
    expect(sel.disabled).toBe(false);
    const opts = [...sel.querySelectorAll('option')].map(o => parseInt(o.value, 10));
    expect(opts).toEqual([60, 120, 300, 600]);
    expect(sel.value).toBe('60');

    // hideSilent default = true → kiro 卡片应隐藏 (silent=true)
    const cards = container.querySelectorAll('.hb-card');
    expect(cards.length).toBe(2);
    const agents = [...cards].map(c => c.querySelector('.hb-card-agent').textContent);
    expect(agents).toContain('claude');
    expect(agents).toContain('qwen');
    expect(agents).not.toContain('kiro');
  });

  it('toggle hideSilent reveals silent log cards', async () => {
    const f = makeFetch({
      'GET /api/heartbeat':       async () => okResp(SAMPLE_STATE),
      'GET /api/heartbeat/logs':  async () => okResp(SAMPLE_LOGS),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();

    const cb = container.querySelector('.hb-hide-silent');
    expect(cb.checked).toBe(true);
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));

    const cards = container.querySelectorAll('.hb-card');
    expect(cards.length).toBe(3);
    expect(localStorage.getItem('pixel.heartbeatHideSilent')).toBe('false');
    // silent 卡片应有特殊 class
    const silentCard = [...cards].find(c => c.classList.contains('hb-card-silent'));
    expect(silentCard).toBeTruthy();
    expect(silentCard.querySelector('.hb-silent').textContent).toBe('[silent]');
  });

  it('hides logs in sort order (newest first)', async () => {
    const f = makeFetch({
      'GET /api/heartbeat':       async () => okResp(SAMPLE_STATE),
      'GET /api/heartbeat/logs':  async () => okResp(SAMPLE_LOGS),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    // 全部显示
    container.querySelector('.hb-hide-silent').checked = false;
    container.querySelector('.hb-hide-silent').dispatchEvent(new Event('change'));

    const agents = [...container.querySelectorAll('.hb-card-agent')].map(e => e.textContent);
    // ts 倒序: claude (-12s), kiro (-60s), qwen (-200s)
    expect(agents).toEqual(['claude', 'kiro', 'qwen']);
  });

  it('renders snapshot state chip on log card', async () => {
    const f = makeFetch({
      'GET /api/heartbeat':       async () => okResp(SAMPLE_STATE),
      'GET /api/heartbeat/logs':  async () => okResp(SAMPLE_LOGS),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    // claude → idle (busy=0, idle=1)
    const claudeCard = [...container.querySelectorAll('.hb-card')]
      .find(c => c.querySelector('.hb-card-agent').textContent === 'claude');
    expect(claudeCard.querySelector('.hb-state-idle')).not.toBeNull();
  });

  it('expand prompt preview on toggle click', async () => {
    const f = makeFetch({
      'GET /api/heartbeat':       async () => okResp(SAMPLE_STATE),
      'GET /api/heartbeat/logs':  async () => okResp(SAMPLE_LOGS),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();

    expect(container.querySelector('.hb-card-prompt')).toBeNull();
    const toggle = container.querySelector('.hb-card-prompt-toggle');
    toggle.click();
    expect(container.querySelector('.hb-card-prompt')).not.toBeNull();
    // 第二次点 → 收起
    container.querySelector('.hb-card-prompt-toggle').click();
    expect(container.querySelector('.hb-card-prompt')).toBeNull();
  });

  it('error from /heartbeat shows hb-error block', async () => {
    const f = makeFetch({
      'GET /api/heartbeat':       async () => failResp(500),
      'GET /api/heartbeat/logs':  async () => okResp(SAMPLE_LOGS),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    expect(container.querySelector('.hb-error')).not.toBeNull();
    // 但 logs 仍渲染 (一边失败不阻塞另一边)
    expect(container.querySelectorAll('.hb-card').length).toBeGreaterThan(0);
  });

  it('changeInterval — success path updates UI', async () => {
    const f = makeFetch({
      'GET /api/heartbeat':       async () => okResp(SAMPLE_STATE),
      'GET /api/heartbeat/logs':  async () => okResp(SAMPLE_LOGS),
      'PUT /api/heartbeat/interval': async () => okResp({ interval: 120, previous: 60 }),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();

    await v.changeInterval(120);
    await flush();

    const ic = container.querySelector('.hb-interval-change');
    expect(ic).not.toBeNull();
    expect(ic.classList.contains('hb-interval-ok')).toBe(true);
    expect(ic.textContent).toMatch(/1 min.*2 min/);
  });

  it('changeInterval — server error body sets hb-interval-error', async () => {
    // acp-bridge 真实行为: HTTP 200 + body 含 error
    const f = makeFetch({
      'GET /api/heartbeat':       async () => okResp(SAMPLE_STATE),
      'GET /api/heartbeat/logs':  async () => okResp(SAMPLE_LOGS),
      'PUT /api/heartbeat/interval': async () => okResp({ error: 'interval 30 not in allowed_intervals' }),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    await v.changeInterval(30);
    await flush();

    const ic = container.querySelector('.hb-interval-change');
    expect(ic.classList.contains('hb-interval-error')).toBe(true);
    expect(ic.textContent).toMatch(/interval change failed/);
  });

  it('changeInterval — network reject sets error', async () => {
    const f = makeFetch({
      'GET /api/heartbeat':       async () => okResp(SAMPLE_STATE),
      'GET /api/heartbeat/logs':  async () => okResp(SAMPLE_LOGS),
      'PUT /api/heartbeat/interval': async () => { throw new Error('network down'); },
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    await v.changeInterval(120);
    await flush();
    const ic = container.querySelector('.hb-interval-change');
    expect(ic.classList.contains('hb-interval-error')).toBe(true);
  });

  it('progress bar: indeterminate during fetch, finite after', async () => {
    let resolveState;
    const stateP = new Promise(r => { resolveState = r; });
    const f = vi.fn(async (url) => {
      if (url === '/api/heartbeat') return stateP;
      if (url === '/api/heartbeat/logs') return okResp(SAMPLE_LOGS);
      throw new Error('?');
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    const p = v.tickOnce();
    // tickOnce 启动后立刻设置 indeterminate
    await Promise.resolve();
    expect(container.querySelector('.hb-progress-bar.hb-progress-indeterminate')).not.toBeNull();
    // 完成
    resolveState(okResp(SAMPLE_STATE));
    await p;
    await flush();
    expect(container.querySelector('.hb-progress-bar.hb-progress-indeterminate')).toBeNull();
  });

  it('refresh button triggers tickOnce', async () => {
    const f = makeFetch({
      'GET /api/heartbeat':       async () => okResp(SAMPLE_STATE),
      'GET /api/heartbeat/logs':  async () => okResp(SAMPLE_LOGS),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    const fetchCountBefore = f.mock.calls.length;
    container.querySelector('.hb-refresh').click();
    await flush();
    expect(f.mock.calls.length).toBeGreaterThan(fetchCountBefore);
  });
});
