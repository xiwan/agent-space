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
  allowed_intervals: [30, 60, 180, 600, 1800, 3600],
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

const SAMPLE_CONTEXTS = {
  contexts: [
    { text: 'demo at 2pm', ttl: 3, created_at: NOW_MS / 1000 - 30 },
    { text: 'remember to be friendly', ttl: 5, created_at: NOW_MS / 1000 - 120 },
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

/**
 * v2.16.0: 默认 happy-path mock — state + logs + context 三件套.
 */
function defaultMock(overrides = {}) {
  return makeFetch({
    'GET /api/heartbeat':         async () => okResp(SAMPLE_STATE),
    'GET /api/heartbeat/logs':    async () => okResp(SAMPLE_LOGS),
    'GET /api/heartbeat/context': async () => okResp({ contexts: [] }),
    ...overrides,
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
  it('formatIntervalLabel — known values (v2.17.0 aligned with acp-bridge whitelist)', () => {
    expect(formatIntervalLabel(30)).toBe('30s');
    expect(formatIntervalLabel(60)).toBe('1 min');
    expect(formatIntervalLabel(180)).toBe('3 min');
    expect(formatIntervalLabel(600)).toBe('10 min');
    expect(formatIntervalLabel(1800)).toBe('30 min');
    expect(formatIntervalLabel(3600)).toBe('1 h');
  });
  it('formatIntervalLabel — unknown / removed values fall back to "Ns"', () => {
    expect(formatIntervalLabel(45)).toBe('45s');
    // v2.17.0: 120 / 300 已从白名单移除, 走 fallback
    expect(formatIntervalLabel(120)).toBe('120s');
    expect(formatIntervalLabel(300)).toBe('300s');
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
      'GET /api/heartbeat/context': async () => okResp({ contexts: [] }),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();

    const sel = container.querySelector('.hb-interval-select');
    expect(sel.disabled).toBe(false);
    const opts = [...sel.querySelectorAll('option')].map(o => parseInt(o.value, 10));
    expect(opts).toEqual([30, 60, 180, 600, 1800, 3600]);
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
      'GET /api/heartbeat/context': async () => okResp({ contexts: [] }),
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
      'GET /api/heartbeat/context': async () => okResp({ contexts: [] }),
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
      'GET /api/heartbeat/context': async () => okResp({ contexts: [] }),
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
      'GET /api/heartbeat/context': async () => okResp({ contexts: [] }),
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
      'GET /api/heartbeat/context': async () => okResp({ contexts: [] }),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    expect(container.querySelector('.hb-error')).not.toBeNull();
    // 但 logs 仍渲染 (一边失败不阻塞另一边)
    expect(container.querySelectorAll('.hb-card').length).toBeGreaterThan(0);
  });

  it('changeInterval — success path updates UI', async () => {
    // v2.17.0: 用新白名单值 60 → 180 (3 min)
    const f = makeFetch({
      'GET /api/heartbeat':       async () => okResp(SAMPLE_STATE),
      'GET /api/heartbeat/logs':  async () => okResp(SAMPLE_LOGS),
      'GET /api/heartbeat/context': async () => okResp({ contexts: [] }),
      'PUT /api/heartbeat/interval': async () => okResp({ interval: 180, previous: 60 }),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();

    await v.changeInterval(180);
    await flush();

    const ic = container.querySelector('.hb-interval-change');
    expect(ic).not.toBeNull();
    expect(ic.classList.contains('hb-interval-ok')).toBe(true);
    expect(ic.textContent).toMatch(/1 min.*3 min/);
  });

  it('changeInterval — server error body sets hb-interval-error', async () => {
    // acp-bridge 真实行为: HTTP 200 + body 含 error
    const f = makeFetch({
      'GET /api/heartbeat':       async () => okResp(SAMPLE_STATE),
      'GET /api/heartbeat/logs':  async () => okResp(SAMPLE_LOGS),
      'GET /api/heartbeat/context': async () => okResp({ contexts: [] }),
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
      'GET /api/heartbeat/context': async () => okResp({ contexts: [] }),
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
      'GET /api/heartbeat/context': async () => okResp({ contexts: [] }),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    const fetchCountBefore = f.mock.calls.length;
    container.querySelector('.hb-refresh').click();
    await flush();
    expect(f.mock.calls.length).toBeGreaterThan(fetchCountBefore);
  });
});

// ============================================================
// v2.16.0: Intervene 折叠区
// ============================================================
describe('HeartbeatView v2.16.0 — Intervene', () => {
  let container;
  beforeEach(() => {
    try { localStorage.clear(); } catch {}
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
  });

  it('Intervene region is collapsed by default', () => {
    new HeartbeatView(container, { fetchImpl: defaultMock() });
    const toggle = container.querySelector('[data-toggle="intervene"]');
    expect(toggle).not.toBeNull();
    expect(toggle.textContent).toMatch(/▸ Intervene/);
    expect(container.querySelector('.hb-intervene-body')).toBeNull();
  });

  it('clicking toggle expands; localStorage persists', async () => {
    const v = new HeartbeatView(container, { fetchImpl: defaultMock() });
    container.querySelector('[data-toggle="intervene"]').click();
    expect(container.querySelector('.hb-intervene-body')).not.toBeNull();
    expect(container.querySelector('[data-toggle="intervene"]').textContent).toMatch(/▾/);
    expect(localStorage.getItem('pixel.heartbeatInterveneOpen')).toBe('true');
    // 第二次 click 收起
    container.querySelector('[data-toggle="intervene"]').click();
    expect(container.querySelector('.hb-intervene-body')).toBeNull();
    expect(localStorage.getItem('pixel.heartbeatInterveneOpen')).toBe('false');
  });

  it('localStorage open=true → expanded on construct', () => {
    localStorage.setItem('pixel.heartbeatInterveneOpen', 'true');
    new HeartbeatView(container, { fetchImpl: defaultMock() });
    expect(container.querySelector('.hb-intervene-body')).not.toBeNull();
  });

  it('renders inject form + ping select + clear button when expanded (after fetch)', async () => {
    const f = defaultMock();
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    v.toggleIntervene();
    await v.tickOnce();
    expect(container.querySelector('.hb-inject-text')).not.toBeNull();
    expect(container.querySelector('.hb-inject-ttl')).not.toBeNull();
    expect(container.querySelector('.hb-inject-btn')).not.toBeNull();
    const pingSel = container.querySelector('.hb-ping-select');
    expect(pingSel).not.toBeNull();
    const opts = [...pingSel.querySelectorAll('option')].map(o => o.value);
    expect(opts).toEqual(['claude', 'kiro', 'qwen']);
    expect(container.querySelector('.hb-ping-btn')).not.toBeNull();
    expect(container.querySelector('.hb-clear-btn')).not.toBeNull();
  });

  it('renders active context list with text + ttl + ago', async () => {
    const f = defaultMock({
      'GET /api/heartbeat/context': async () => okResp(SAMPLE_CONTEXTS),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    v.toggleIntervene();
    await v.tickOnce();
    const items = container.querySelectorAll('.hb-context-item');
    expect(items.length).toBe(2);
    expect(items[0].querySelector('.hb-context-text').textContent).toBe('demo at 2pm');
    expect(items[0].querySelector('.hb-context-meta').textContent).toMatch(/ttl 3/);
    expect(items[0].querySelector('.hb-context-meta').textContent).toMatch(/30s ago/);
  });

  it('empty context list shows placeholder', async () => {
    const v = new HeartbeatView(container, { fetchImpl: defaultMock(), nowMs: () => NOW_MS });
    v.toggleIntervene();
    await v.tickOnce();
    expect(container.querySelector('.hb-context-empty')).not.toBeNull();
    expect(container.querySelector('.hb-clear-btn').disabled).toBe(true);
  });

  it('inject success path: status ok + active_contexts + clears textarea', async () => {
    const f = defaultMock({
      'POST /api/heartbeat/context': async () => okResp({ status: 'ok', ttl: 3, active_contexts: 1 }),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    v.toggleIntervene();
    await v.tickOnce();
    const txt = container.querySelector('.hb-inject-text');
    txt.value = 'hello world';
    txt.dispatchEvent(new Event('input'));
    await v.injectContext();
    await flush();
    const status = container.querySelector('.hb-intervene-status');
    expect(status.classList.contains('hb-intervene-ok')).toBe(true);
    expect(status.textContent).toMatch(/injected.*ttl 3.*1 active/);
    // textarea 清空
    expect(container.querySelector('.hb-inject-text').value).toBe('');
  });

  it('inject empty text → local validation, no fetch', async () => {
    const post = vi.fn();
    const f = defaultMock({
      'POST /api/heartbeat/context': post,
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    v.toggleIntervene();
    await v.tickOnce();
    await v.injectContext();
    expect(post).not.toHaveBeenCalled();
    const status = container.querySelector('.hb-intervene-status');
    expect(status.classList.contains('hb-intervene-error')).toBe(true);
    expect(status.textContent).toMatch(/text is required/);
  });

  it('inject server 400 → status error', async () => {
    const f = defaultMock({
      'POST /api/heartbeat/context': async () => ({
        ok: false, status: 400, json: async () => ({ error: 'text is required' }),
      }),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    v.toggleIntervene();
    await v.tickOnce();
    const txt = container.querySelector('.hb-inject-text');
    txt.value = 'something';
    txt.dispatchEvent(new Event('input'));
    await v.injectContext();
    await flush();
    const status = container.querySelector('.hb-intervene-status');
    expect(status.classList.contains('hb-intervene-error')).toBe(true);
  });

  it('ttl input clamps to 1..100', () => {
    const v = new HeartbeatView(container, { fetchImpl: defaultMock() });
    v.toggleIntervene();
    v.setInjectTtl(0);
    expect(v.getState().injectTtl).toBe(1);
    v.setInjectTtl(500);
    expect(v.getState().injectTtl).toBe(100);
    v.setInjectTtl(7);
    expect(v.getState().injectTtl).toBe(7);
  });

  it('clear contexts: confirm → DELETE → contexts emptied', async () => {
    let deleted = false;
    const f = defaultMock({
      'GET /api/heartbeat/context': async () => okResp(deleted ? { contexts: [] } : SAMPLE_CONTEXTS),
      'DELETE /api/heartbeat/context': async () => { deleted = true; return okResp({ cleared: 2 }); },
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    v.toggleIntervene();
    await v.tickOnce();
    expect(container.querySelectorAll('.hb-context-item').length).toBe(2);

    const oldConfirm = window.confirm;
    window.confirm = () => true;
    try {
      await v.clearContexts();
      await flush();
    } finally {
      window.confirm = oldConfirm;
    }
    const status = container.querySelector('.hb-intervene-status');
    expect(status.classList.contains('hb-intervene-ok')).toBe(true);
    expect(status.textContent).toMatch(/cleared 2/);
    expect(container.querySelector('.hb-context-empty')).not.toBeNull();
  });

  it('clear contexts: confirm cancelled → no DELETE', async () => {
    const del = vi.fn();
    const f = defaultMock({
      'GET /api/heartbeat/context': async () => okResp(SAMPLE_CONTEXTS),
      'DELETE /api/heartbeat/context': del,
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    v.toggleIntervene();
    await v.tickOnce();
    const oldConfirm = window.confirm;
    window.confirm = () => false;
    try {
      await v.clearContexts();
    } finally {
      window.confirm = oldConfirm;
    }
    expect(del).not.toHaveBeenCalled();
  });

  it('ping success unshifts a new log entry, no wait for next poll', async () => {
    const f = defaultMock({
      'POST /api/heartbeat/claude': async () => okResp({
        agent: 'claude', silent: false, response: 'hello team!',
        duration: 4.5, snapshot: SAMPLE_STATE.snapshot,
      }),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    v.toggleIntervene();
    await v.tickOnce();
    // hideSilent default true, 但我们 ping 拿的是 non-silent → 立即显示
    v.setPingAgent('claude');
    await v.pingAgent();
    await flush();
    const status = container.querySelector('.hb-intervene-status');
    expect(status.classList.contains('hb-intervene-ok')).toBe(true);
    expect(status.textContent).toMatch(/claude spoke/);
    // 第一张卡片是新 ping (ts 现在最大)
    const firstCard = container.querySelector('.hb-card');
    expect(firstCard.querySelector('.hb-card-agent').textContent).toBe('claude');
    expect(firstCard.querySelector('.hb-card-body').textContent).toBe('hello team!');
  });

  it('ping silent agent shows "silent" status', async () => {
    const f = defaultMock({
      'POST /api/heartbeat/kiro': async () => okResp({
        agent: 'kiro', silent: true, response: null, duration: 3.0,
      }),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    v.toggleIntervene();
    await v.tickOnce();
    v.setPingAgent('kiro');
    await v.pingAgent();
    await flush();
    const status = container.querySelector('.hb-intervene-status');
    expect(status.classList.contains('hb-intervene-ok')).toBe(true);
    expect(status.textContent).toMatch(/kiro silent/);
  });

  it('ping 404 → error status', async () => {
    const f = defaultMock({
      'POST /api/heartbeat/ghost': async () => ({
        ok: false, status: 404, json: async () => ({ error: 'agent not found: ghost' }),
      }),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    v.toggleIntervene();
    await v.tickOnce();
    v.setPingAgent('ghost');
    await v.pingAgent();
    await flush();
    const status = container.querySelector('.hb-intervene-status');
    expect(status.classList.contains('hb-intervene-error')).toBe(true);
    expect(status.textContent).toMatch(/ghost.*agent not found/);
  });

  it('ping with no agent selected → local error', async () => {
    const post = vi.fn();
    const f = defaultMock({ 'POST /api/heartbeat/anyone': post });
    // enabledAgents 空
    const f2 = makeFetch({
      'GET /api/heartbeat':         async () => okResp({ ...SAMPLE_STATE, enabled_agents: [] }),
      'GET /api/heartbeat/logs':    async () => okResp(SAMPLE_LOGS),
      'GET /api/heartbeat/context': async () => okResp({ contexts: [] }),
    });
    const v = new HeartbeatView(container, { fetchImpl: f2, nowMs: () => NOW_MS });
    v.toggleIntervene();
    await v.tickOnce();
    v.setPingAgent(null);
    await v.pingAgent();
    const status = container.querySelector('.hb-intervene-status');
    expect(status.classList.contains('hb-intervene-error')).toBe(true);
    expect(status.textContent).toMatch(/no agent selected/);
  });

  it('tickOnce fetches all 3 endpoints (state + logs + context)', async () => {
    const f = defaultMock();
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    const urls = f.mock.calls.map(c => c[0]).sort();
    expect(urls).toEqual([
      '/api/heartbeat',
      '/api/heartbeat/context',
      '/api/heartbeat/logs',
    ]);
  });
});

// ===========================================================================
// v2.17.0 — UX/integrity polish
// ===========================================================================

describe('HeartbeatView v2.17.0 — UX polish', () => {
  let container;
  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    try { localStorage.clear(); } catch {}
  });
  afterEach(() => {
    document.body.innerHTML = '';
    try { localStorage.clear(); } catch {}
    vi.useRealTimers();
  });

  // ---- #1 进度条不被 _render() 反复重置 ----------------------------------

  it('#1 progress bar countdown survives _render() (e.g. toggleIntervene) and reflects real elapsed time', async () => {
    const f = defaultMock();
    let now = NOW_MS;
    const v = new HeartbeatView(container, {
      fetchImpl: f,
      nowMs: () => now,
      pollIntervalMs: 10000,
    });

    // 第一次 tickOnce 完成 → countdown 起点 = NOW_MS
    await v.tickOnce();
    await flush();

    // 走 4 秒
    now = NOW_MS + 4000;

    // 用户点 Intervene 折叠头 → 触发 _render() (但不触发新一轮 fetch)
    v.toggleIntervene();
    await flush();

    // _render → _resumeCountdown 的 step() 立即跑一次,
    // 应基于 _countdownStartMs (= NOW_MS) 算出 4000/10000 = 40%
    // 而不是从 now (NOW_MS+4000) 重新归零变 0%
    const bar = container.querySelector('.hb-progress-bar');
    expect(bar).not.toBeNull();
    const widthPct = parseFloat(bar.style.width);
    expect(widthPct).toBeGreaterThan(35);
    expect(widthPct).toBeLessThan(45);
  });

  it('#1 progress bar resets to 0 ONLY when tickOnce() actually runs', async () => {
    const f = defaultMock();
    let now = NOW_MS;
    const v = new HeartbeatView(container, {
      fetchImpl: f,
      nowMs: () => now,
      pollIntervalMs: 10000,
    });

    await v.tickOnce();
    await flush();
    now = NOW_MS + 7500;
    // 拉一次新数据 → countdown 起点应刷为 NOW_MS+7500
    await v.tickOnce();
    await flush();

    const bar = container.querySelector('.hb-progress-bar');
    const widthPct = parseFloat(bar.style.width);
    expect(widthPct).toBeLessThan(5); // 几乎刚刚归零
  });

  // ---- #2 expandedPrompt 用复合 key 并 prune ----------------------------

  it('#2 expandedPrompt uses (agent | ts) composite key, survives floating-ts re-emission', async () => {
    const f = defaultMock();
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    await flush();

    // 找到 claude 卡片 (有 prompt_preview)
    const toggle = container.querySelector('.hb-card-prompt-toggle');
    expect(toggle).not.toBeNull();
    const key = toggle.dataset.promptKey;
    expect(key).toMatch(/^claude\|\d+\.\d{3}$/);

    // 点击展开
    toggle.click();
    await flush();
    expect(container.querySelector('.hb-card-prompt')).not.toBeNull();
    expect(v.getState().expandedPrompt.has(key)).toBe(true);
  });

  it('#2 expandedPrompt prunes keys for logs that fell out of ring buffer', async () => {
    const f = defaultMock();
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    await flush();

    // 展开 claude 那条
    const toggle = container.querySelector('.hb-card-prompt-toggle');
    toggle.click();
    await flush();
    expect(v.getState().expandedPrompt.size).toBe(1);

    // 模拟下一次 tick — server 不再回 claude (滚出 buffer), 只回 qwen
    f.mockImplementation(async (url, opts) => {
      const key = `${(opts && opts.method) || 'GET'} ${url}`;
      if (key === 'GET /api/heartbeat')         return okResp(SAMPLE_STATE);
      if (key === 'GET /api/heartbeat/context') return okResp({ contexts: [] });
      if (key === 'GET /api/heartbeat/logs')    return okResp({
        total: 1,
        logs: [{ ts: NOW_MS / 1000 - 5, agent: 'qwen', silent: false,
                 duration: 1.0, response: 'new', prompt_preview: 'prompt q' }],
      });
      throw new Error('unhandled: ' + key);
    });
    await v.tickOnce();
    await flush();
    // claude 的 key 应被 prune
    expect(v.getState().expandedPrompt.size).toBe(0);
  });

  // ---- #3 ping 加 _pinged + inject 乐观插入 contexts -----------------------

  it('#3 ping success marks new log entry with hb-card-pinged class', async () => {
    const f = defaultMock({
      'POST /api/heartbeat/claude': async () => okResp({
        agent: 'claude', silent: false, response: 'pinged response', duration: 5.5,
        snapshot: SAMPLE_STATE.snapshot, prompt_preview: 'You are claude...',
      }),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    v.toggleIntervene();
    await v.tickOnce();
    await flush();
    v.setPingAgent('claude');
    await v.pingAgent();
    await flush();

    // 新 log 卡片应有 hb-card-pinged class
    const cards = container.querySelectorAll('.hb-card');
    const pingedCards = container.querySelectorAll('.hb-card-pinged');
    expect(pingedCards.length).toBe(1);
    expect(pingedCards[0].querySelector('.hb-card-agent').textContent).toBe('claude');

    // 新 log 在 _state.logs 头部, 带 _pinged: true
    const logs = v.getState().logs;
    expect(logs[0]._pinged).toBe(true);
    expect(logs[0].response).toBe('pinged response');
  });

  it('#3 inject success optimistically prepends to contexts list (no wait for tickOnce)', async () => {
    const f = defaultMock({
      'POST /api/heartbeat/context': async () => okResp({
        status: 'ok', ttl: 3, active_contexts: 1,
      }),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    v.toggleIntervene();
    await v.tickOnce();
    await flush();

    expect(v.getState().contexts.length).toBe(0);

    v.setInjectText('demo starts at 2pm');
    v.setInjectTtl(3);
    await v.injectContext();
    // tickOnce 在 finally 里会 fire-and-forget; 等 pending 完成
    await flush();

    const contexts = v.getState().contexts;
    expect(contexts.length).toBeGreaterThanOrEqual(1);
    // 第一条应是刚注入的 (乐观插入到头部)
    expect(contexts[0].text).toBe('demo starts at 2pm');
    expect(contexts[0].ttl).toBe(3);
    // UI 也应渲染出这条
    const list = container.querySelector('.hb-context-list');
    expect(list).not.toBeNull();
    expect(list.textContent).toMatch(/demo starts at 2pm/);
  });

  it('#3 inject failure does NOT pollute contexts list (no optimistic insert on error)', async () => {
    const f = defaultMock({
      'POST /api/heartbeat/context': async () => ({
        ok: false, status: 400, json: async () => ({ error: 'text is required' }),
      }),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    v.toggleIntervene();
    await v.tickOnce();
    await flush();

    v.setInjectText('something');
    v.setInjectTtl(3);
    await v.injectContext();
    await flush();

    expect(v.getState().contexts.length).toBe(0);
    const status = container.querySelector('.hb-intervene-status');
    expect(status.classList.contains('hb-intervene-error')).toBe(true);
  });

  // ---- #4 INTERVAL_LABELS 同步 acp-bridge 白名单 -------------------------

  it('#4 select renders correct labels for all 6 acp-bridge whitelist values', async () => {
    const f = defaultMock();
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    await flush();

    const sel = container.querySelector('.hb-interval-select');
    const opts = [...sel.querySelectorAll('option')].map(o => ({
      val: parseInt(o.value, 10),
      label: o.textContent,
    }));
    expect(opts).toEqual([
      { val: 30,   label: '30s' },
      { val: 60,   label: '1 min' },
      { val: 180,  label: '3 min' },
      { val: 600,  label: '10 min' },
      { val: 1800, label: '30 min' },
      { val: 3600, label: '1 h' },
    ]);
  });
});

// =============================================================================
// v2.20.0 — HeartbeatView optimization bundle (B + A + C + D)
// =============================================================================

describe('HeartbeatView v2.20.0 — fetch timeout (B)', () => {
  let container;
  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    try { localStorage.clear(); } catch {}
  });
  afterEach(() => {
    document.body.innerHTML = '';
    try { localStorage.clear(); } catch {}
    vi.useRealTimers();
  });

  it('B: timeout aborts hung fetch and surfaces error', async () => {
    // 让 fetch 收到 abort signal 时手动 reject (模拟真实 AbortController 行为)
    let abortReject;
    const f = vi.fn((url, init) => new Promise((resolve, reject) => {
      abortReject = reject;
      if (init && init.signal) {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }
    }));
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    const tickPromise = v.tickOnce();
    // 等 5s timeout 触发 (用真实 timer, 但等够 6s 避免 vitest 默认 5s case timeout)
    // 我们把 tick 视为非阻塞 — race 一个真实 setTimeout 跳过它
    await Promise.race([
      tickPromise,
      new Promise(resolve => setTimeout(resolve, 5500)),
    ]);
    expect(v.getState().fetching).toBe(false);
    expect(v.getState().lastError).toMatch(/timed out/);
  }, 10000);  // 给这条测试 10s 上限

  it('B: fast fetch within timeout still works', async () => {
    const f = defaultMock();
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    await flush();
    expect(v.getState().fetching).toBe(false);
    expect(v.getState().lastError).toBeNull();
    expect(v.getState().interval).toBe(60);
  });

  it('B: AbortError on the wire is normalized to "timed out" message', async () => {
    const f = vi.fn(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    expect(v.getState().lastError).toMatch(/timed out/);
  });
});

describe('HeartbeatView v2.20.0 — Canvas bubble emit (C)', () => {
  let container, onAgentOutput;
  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    try { localStorage.clear(); } catch {}
    onAgentOutput = vi.fn();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    try { localStorage.clear(); } catch {}
  });

  it('C: first tick does NOT emit (history not replayed)', async () => {
    const f = defaultMock();
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS, onAgentOutput });
    await v.tickOnce();
    await flush();
    expect(onAgentOutput).not.toHaveBeenCalled();
  });

  it('C: second tick emits only newly-added non-silent logs', async () => {
    let secondTick = false;
    const f = makeFetch({
      'GET /api/heartbeat':         async () => okResp(SAMPLE_STATE),
      'GET /api/heartbeat/context': async () => okResp({ contexts: [] }),
      'GET /api/heartbeat/logs':    async () => {
        if (!secondTick) {
          secondTick = true;
          return okResp(SAMPLE_LOGS);
        }
        // 第二轮: 多了一条新 log
        return okResp({
          total: 4,
          logs: [
            { ts: NOW_MS / 1000 - 2, agent: 'kiro', silent: false, duration: 3.0,
              response: 'fresh new chat', prompt_preview: 'You are kiro...' },
            ...SAMPLE_LOGS.logs,
          ],
        });
      },
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS, onAgentOutput });
    await v.tickOnce();   // first — 不 emit
    await flush();
    expect(onAgentOutput).not.toHaveBeenCalled();
    await v.tickOnce();   // second — 有新 log
    await flush();
    expect(onAgentOutput).toHaveBeenCalledTimes(1);
    expect(onAgentOutput).toHaveBeenCalledWith('kiro', 'fresh new chat');
  });

  it('C: skips silent logs', async () => {
    let secondTick = false;
    const f = makeFetch({
      'GET /api/heartbeat':         async () => okResp(SAMPLE_STATE),
      'GET /api/heartbeat/context': async () => okResp({ contexts: [] }),
      'GET /api/heartbeat/logs':    async () => {
        if (!secondTick) { secondTick = true; return okResp({ total: 0, logs: [] }); }
        return okResp({ total: 1, logs: [
          { ts: NOW_MS / 1000, agent: 'kiro', silent: true, duration: 1.0, response: null },
        ]});
      },
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS, onAgentOutput });
    await v.tickOnce();
    await v.tickOnce();
    await flush();
    expect(onAgentOutput).not.toHaveBeenCalled();
  });

  it('C: skips _pinged logs (user just saw it via Intervene)', async () => {
    const f = defaultMock({
      'POST /api/heartbeat/claude': async () => okResp({
        agent: 'claude', silent: false, response: 'hello', duration: 1.0,
        snapshot: SAMPLE_STATE.snapshot, prompt_preview: 'p',
      }),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS, onAgentOutput });
    await v.tickOnce();
    await flush();
    onAgentOutput.mockClear();
    v.toggleIntervene();
    v.setPingAgent('claude');
    await v.pingAgent();
    await flush();
    // ping 不直接 emit (只通过 _pinged 标记); 下次 tickOnce 也跳过
    await v.tickOnce();
    await flush();
    // pingAgent unshift 的 log 带 _pinged → 不 emit
    const pingedRelatedCalls = onAgentOutput.mock.calls.filter(c => c[0] === 'claude');
    expect(pingedRelatedCalls.length).toBe(0);
  });

  it('C: same log (same agent + ts) only emits once across ticks', async () => {
    let tickN = 0;
    const f = makeFetch({
      'GET /api/heartbeat':         async () => okResp(SAMPLE_STATE),
      'GET /api/heartbeat/context': async () => okResp({ contexts: [] }),
      'GET /api/heartbeat/logs':    async () => {
        tickN++;
        if (tickN === 1) return okResp({ total: 0, logs: [] });
        // 后续 N 次都返回同一条 log
        return okResp({ total: 1, logs: [
          { ts: NOW_MS / 1000 - 5, agent: 'kiro', silent: false, duration: 1.0, response: 'same' },
        ]});
      },
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS, onAgentOutput });
    await v.tickOnce();
    await v.tickOnce();
    await v.tickOnce();
    await v.tickOnce();
    await flush();
    expect(onAgentOutput).toHaveBeenCalledTimes(1);
  });
});

describe('HeartbeatView v2.20.0 — agent filter (D1)', () => {
  let container;
  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    try { localStorage.clear(); } catch {}
  });
  afterEach(() => {
    document.body.innerHTML = '';
    try { localStorage.clear(); } catch {}
  });

  it('D1: renders chip per enabledAgent, all selected by default', async () => {
    const f = defaultMock();
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    await flush();
    const chips = [...container.querySelectorAll('.hb-agent-chip')];
    expect(chips.length).toBe(3); // claude, kiro, qwen
    chips.forEach(c => expect(c.classList.contains('hb-agent-chip-on')).toBe(true));
  });

  it('D1: toggle a chip filters that agent OUT of logs', async () => {
    const f = defaultMock();
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    await flush();
    // 初始: claude, qwen 卡片可见 (kiro silent 默认隐藏)
    expect(container.querySelectorAll('.hb-card').length).toBe(2);
    // toggle claude 离开
    v.toggleAgentFilter('claude');
    await flush();
    const cards = [...container.querySelectorAll('.hb-card')];
    const agents = cards.map(c => c.querySelector('.hb-card-agent').textContent);
    expect(agents).not.toContain('claude');
    expect(agents).toContain('qwen');
  });

  it('D1: localStorage persists filter selection', async () => {
    const f = defaultMock();
    const v1 = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v1.tickOnce();
    await flush();
    v1.toggleAgentFilter('claude'); // 取消 claude
    expect(JSON.parse(localStorage.getItem('pixel.heartbeatSelectedAgents'))).toEqual(['kiro', 'qwen']);
    // 重建实例验证持久化
    const c2 = document.createElement('div');
    document.body.appendChild(c2);
    const v2 = new HeartbeatView(c2, { fetchImpl: f, nowMs: () => NOW_MS });
    await v2.tickOnce();
    await flush();
    expect(v2.getState().selectedAgents).toBeInstanceOf(Set);
    expect(v2.getState().selectedAgents.has('claude')).toBe(false);
  });

  it('D1: setAllAgentsSelected(true/false) bulk select/clear', async () => {
    const f = defaultMock();
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    await flush();
    v.setAllAgentsSelected(false);
    expect(v.getState().selectedAgents.size).toBe(0);
    expect(container.querySelectorAll('.hb-card').length).toBe(0);
    expect(container.querySelector('.hb-empty').textContent).toMatch(/agent filter/);
    v.setAllAgentsSelected(true);
    expect(v.getState().selectedAgents.size).toBe(3);
  });

  it('D1: empty enabledAgents → filter row hidden', async () => {
    const f = makeFetch({
      'GET /api/heartbeat':         async () => okResp({ ...SAMPLE_STATE, enabled_agents: [] }),
      'GET /api/heartbeat/logs':    async () => okResp({ total: 0, logs: [] }),
      'GET /api/heartbeat/context': async () => okResp({ contexts: [] }),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    await flush();
    const wrap = container.querySelector('.hb-agent-filter');
    expect(wrap.innerHTML).toBe('');
  });
});

describe('HeartbeatView v2.20.0 — inject context marker (D2)', () => {
  let container;
  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    try { localStorage.clear(); } catch {}
  });
  afterEach(() => {
    document.body.innerHTML = '';
    try { localStorage.clear(); } catch {}
  });

  it('D2: log whose prompt_preview contains active context shows ✨ chip', async () => {
    const f = makeFetch({
      'GET /api/heartbeat':         async () => okResp(SAMPLE_STATE),
      'GET /api/heartbeat/context': async () => okResp({ contexts: [
        { text: 'demo starts at 2pm — say something fun', ttl: 3, created_at: NOW_MS / 1000 - 30 },
      ]}),
      'GET /api/heartbeat/logs':    async () => okResp({ total: 1, logs: [
        { ts: NOW_MS / 1000 - 5, agent: 'claude', silent: false, duration: 4.2,
          response: 'about the demo at 2pm...',
          prompt_preview: 'You are claude. NOTE: demo starts at 2pm — say something fun ...' },
      ]}),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    await flush();
    const card = container.querySelector('.hb-card');
    const injected = card.querySelector('.hb-card-injected');
    expect(injected).not.toBeNull();
    expect(injected.textContent).toMatch(/context/);
  });

  it('D2: log without matching context does NOT show ✨ chip', async () => {
    const f = makeFetch({
      'GET /api/heartbeat':         async () => okResp(SAMPLE_STATE),
      'GET /api/heartbeat/context': async () => okResp({ contexts: [] }),
      'GET /api/heartbeat/logs':    async () => okResp({ total: 1, logs: [
        { ts: NOW_MS / 1000 - 5, agent: 'claude', silent: false, duration: 4.2,
          response: 'just chatting', prompt_preview: 'You are claude...' },
      ]}),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    await flush();
    expect(container.querySelector('.hb-card-injected')).toBeNull();
  });

  it('D2: short context (<8 chars) does NOT trigger marker (avoid false positives)', async () => {
    const f = makeFetch({
      'GET /api/heartbeat':         async () => okResp(SAMPLE_STATE),
      'GET /api/heartbeat/context': async () => okResp({ contexts: [
        { text: 'hi', ttl: 3, created_at: NOW_MS / 1000 - 30 },
      ]}),
      'GET /api/heartbeat/logs':    async () => okResp({ total: 1, logs: [
        { ts: NOW_MS / 1000 - 5, agent: 'claude', silent: false, duration: 4.2,
          response: 'hi everyone', prompt_preview: 'You are claude. hi to you all.' },
      ]}),
    });
    const v = new HeartbeatView(container, { fetchImpl: f, nowMs: () => NOW_MS });
    await v.tickOnce();
    await flush();
    expect(container.querySelector('.hb-card-injected')).toBeNull();
  });
});
