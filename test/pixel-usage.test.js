// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  UsageView,
  formatTokens,
  formatCost,
  formatDuration,
  formatAgo,
  shortenModel,
} from '../src/pixel/UsageView.js';

const SAMPLE = {
  hours: 168,
  calls: 704,
  input_tokens: 5297884,
  output_tokens: 208929,
  total_tokens: 5506813,
  cached_tokens: 2016309,
  cache_creation_tokens: 724944,
  cache_rate_pct: 38.1,
  avg_duration_s: 4.99,
  total_cost_usd: 12.3456, // v2.21.0 (acp-bridge v0.23.0)
  by_model: [
    { model: 'us.anthropic.claude-sonnet-4-6', calls: 112, input_tokens: 2743031, output_tokens: 185369, cached_tokens: 2016309, cache_creation_tokens: 724944, cost_usd: 10.20 },
    { model: 'converse/qwen.qwen3-235b-a22b-2507-v1:0', calls: 392, input_tokens: 980014, output_tokens: 22000, cached_tokens: 0, cache_creation_tokens: 0, cost_usd: 1.85 },
    { model: 'bedrock/deepseek.v3.2', calls: 107, input_tokens: 1000000, output_tokens: 1500, cached_tokens: 0, cache_creation_tokens: 0, cost_usd: 0.30 },
  ],
};

function mockOk(data) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => data });
}
function mockFail(status = 500, message = 'Internal Server Error') {
  return vi.fn().mockResolvedValue({ ok: false, status, text: async () => message });
}
function mockReject(msg = 'network down') {
  return vi.fn().mockRejectedValue(new Error(msg));
}

// ============================================================
// pure formatters
// ============================================================
describe('UsageView formatters', () => {
  it('formatTokens: under 1k → plain number', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });
  it('formatTokens: 1k–1M → "Xk"', () => {
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(208929)).toBe('208.9k');
    expect(formatTokens(1000)).toBe('1k');
  });
  it('formatTokens: 1M+ → "XM"', () => {
    expect(formatTokens(5297884)).toBe('5.3M');
    expect(formatTokens(2_016_309)).toBe('2M');
  });
  it('formatTokens: invalid → "—"', () => {
    expect(formatTokens(null)).toBe('—');
    expect(formatTokens(undefined)).toBe('—');
    expect(formatTokens(NaN)).toBe('—');
  });

  it('formatCost: nominal → "$0.0012"', () => {
    expect(formatCost(0.0012)).toBe('$0.0012');
    expect(formatCost(1.5)).toBe('$1.5000');
  });
  it('formatCost: very small → "<$0.0001"', () => {
    expect(formatCost(0.00005)).toBe('<$0.0001');
  });
  it('formatCost: zero / null → "$0" / "—"', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(null)).toBe('—');
    expect(formatCost(undefined)).toBe('—');
  });

  it('formatDuration', () => {
    expect(formatDuration(4.99)).toBe('4.99s');
    expect(formatDuration(0)).toBe('0.00s');
    expect(formatDuration(null)).toBe('—');
  });

  it('formatAgo', () => {
    expect(formatAgo(12)).toBe('12s ago');
    expect(formatAgo(90)).toBe('1m ago');
    expect(formatAgo(3600)).toBe('1h ago');
  });

  it('shortenModel strips known prefixes', () => {
    expect(shortenModel('us.anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(shortenModel('bedrock/deepseek.v3.2')).toBe('deepseek.v3.2');
    expect(shortenModel('converse/qwen.qwen3-235b-a22b-2507-v1:0')).toMatch(/^qwen\.qwen3/);
    expect(shortenModel(null)).toBe('(unknown)');
  });
});

// ============================================================
// UsageView (DOM)
// ============================================================
describe('UsageView', () => {
  let container;
  let nowFn;
  let nowVal;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    localStorage.clear();
    nowVal = 1_700_000_000_000;
    nowFn = () => nowVal;
  });

  it('throws if container missing', () => {
    expect(() => new UsageView(null)).toThrow(/container/);
  });

  it('renders shell with hours dropdown + refresh button initially', () => {
    new UsageView(container, { fetchImpl: mockOk(SAMPLE), nowMs: nowFn });
    expect(container.querySelector('.usage-controls')).not.toBeNull();
    expect(container.querySelector('.usage-hours')).not.toBeNull();
    expect(container.querySelector('.usage-refresh')).not.toBeNull();
  });

  it('default hours = 24 when no localStorage', () => {
    const v = new UsageView(container, { fetchImpl: mockOk(SAMPLE), nowMs: nowFn });
    expect(v.getState().hours).toBe(24);
    const sel = container.querySelector('.usage-hours');
    expect(sel.value).toBe('24');
  });

  it('reads hours from localStorage on construction', () => {
    localStorage.setItem('pixel.usageHours', '168');
    const v = new UsageView(container, { fetchImpl: mockOk(SAMPLE), nowMs: nowFn });
    expect(v.getState().hours).toBe(168);
  });

  it('ignores invalid localStorage hours value', () => {
    localStorage.setItem('pixel.usageHours', '99999');
    const v = new UsageView(container, { fetchImpl: mockOk(SAMPLE), nowMs: nowFn });
    expect(v.getState().hours).toBe(24);
  });

  it('tickOnce: success path renders summary + by_model rows', async () => {
    const fetchImpl = mockOk(SAMPLE);
    const v = new UsageView(container, { fetchImpl, nowMs: nowFn });
    await v.tickOnce();
    expect(fetchImpl).toHaveBeenCalledWith('/api/usage?hours=24');
    expect(container.querySelector('.usage-summary')).not.toBeNull();
    expect(container.querySelectorAll('.usage-metric').length).toBe(4);
    const rows = container.querySelectorAll('.usage-model-row');
    expect(rows.length).toBe(3);
    // claude row should show 112 calls
    expect(rows[0].querySelector('.usage-model-calls').textContent).toBe('112 calls');
  });

  it('tickOnce: failure path renders error + retry', async () => {
    const v = new UsageView(container, { fetchImpl: mockFail(503), nowMs: nowFn });
    await v.tickOnce();
    expect(container.querySelector('.usage-error')).not.toBeNull();
    expect(container.querySelector('.usage-retry')).not.toBeNull();
    expect(v.getState().lastError).toMatch(/503/);
  });

  it('tickOnce: network error path', async () => {
    const v = new UsageView(container, { fetchImpl: mockReject('ENOTCONN'), nowMs: nowFn });
    await v.tickOnce();
    expect(v.getState().lastError).toMatch(/ENOTCONN/);
  });

  it('setHours triggers new fetch with new param + persists', async () => {
    const fetchImpl = mockOk(SAMPLE);
    const v = new UsageView(container, { fetchImpl, nowMs: nowFn });
    await v.tickOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/usage?hours=24');
    v.setHours(168);
    await Promise.resolve(); // let async tickOnce in setHours start
    await Promise.resolve();
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
    const lastCall = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1][0];
    expect(lastCall).toBe('/api/usage?hours=168');
    expect(localStorage.getItem('pixel.usageHours')).toBe('168');
  });

  it('setHours rejects invalid values', () => {
    const v = new UsageView(container, { fetchImpl: mockOk(SAMPLE), nowMs: nowFn });
    v.setHours(99999);
    expect(v.getState().hours).toBe(24);
  });

  it('zero calls renders "no usage data" message', async () => {
    const empty = { ...SAMPLE, calls: 0, by_model: [] };
    const v = new UsageView(container, { fetchImpl: mockOk(empty), nowMs: nowFn });
    await v.tickOnce();
    expect(container.querySelector('.usage-empty')).not.toBeNull();
    expect(container.querySelector('.usage-empty').textContent).toMatch(/no usage data/i);
  });

  it('start() schedules polling, stop() clears', async () => {
    vi.useFakeTimers();
    const fetchImpl = mockOk(SAMPLE);
    const v = new UsageView(container, { fetchImpl, pollIntervalMs: 1000, nowMs: nowFn });
    v.start();
    await Promise.resolve();
    await Promise.resolve();
    const initialCalls = fetchImpl.mock.calls.length;
    expect(initialCalls).toBeGreaterThanOrEqual(1);
    vi.advanceTimersByTime(1500);
    await Promise.resolve();
    await Promise.resolve();
    v.stop();
    vi.useRealTimers();
  });

  it('cost metric shows server-fed total_cost_usd (v2.21.0 + acp-bridge v0.23.0)', async () => {
    const v = new UsageView(container, { fetchImpl: mockOk(SAMPLE), nowMs: nowFn });
    await v.tickOnce();
    const costMetric = container.querySelector('.usage-metric-cost');
    expect(costMetric).not.toBeNull();
    // total_cost_usd: 12.3456 → "$12.35"
    expect(costMetric.querySelector('.usage-metric-value').textContent).toMatch(/\$12\.\d+/);
    // sub label is hours (no longer "(not avail)")
    expect(costMetric.querySelector('.usage-metric-sub').textContent).toMatch(/\(\d+h\)/);
  });

  it('cost metric falls back to "—" when server omits total_cost_usd (legacy backend)', async () => {
    const legacy = { ...SAMPLE };
    delete legacy.total_cost_usd;
    const v = new UsageView(container, { fetchImpl: mockOk(legacy), nowMs: nowFn });
    await v.tickOnce();
    const val = container.querySelector('.usage-metric-cost .usage-metric-value');
    expect(val.textContent).toBe('—');
  });

  it('per-model cost chip renders when cost_usd present, hidden otherwise', async () => {
    const v = new UsageView(container, { fetchImpl: mockOk(SAMPLE), nowMs: nowFn });
    await v.tickOnce();
    // SAMPLE 三个 model 都带 cost_usd → 都应该有 .usage-model-cost
    const chips = [...container.querySelectorAll('.usage-model-cost')];
    expect(chips.length).toBe(3);
    expect(chips[0].textContent).toMatch(/\$10\.\d+/);
    expect(chips[1].textContent).toMatch(/\$1\.8\d/);
    expect(chips[2].textContent).toMatch(/\$0\.\d+/);
  });

  it('per-model cost chip hidden when server omits cost_usd', async () => {
    const noCostSample = {
      ...SAMPLE,
      by_model: SAMPLE.by_model.map(m => {
        const { cost_usd, ...rest } = m;
        return rest;
      }),
    };
    const v = new UsageView(container, { fetchImpl: mockOk(noCostSample), nowMs: nowFn });
    await v.tickOnce();
    const chips = container.querySelectorAll('.usage-model-cost');
    expect(chips.length).toBe(0);
  });

  it('summary shows formatted big numbers', async () => {
    const v = new UsageView(container, { fetchImpl: mockOk(SAMPLE), nowMs: nowFn });
    await v.tickOnce();
    const metricValues = [...container.querySelectorAll('.usage-metric-value')].map(el => el.textContent);
    // [calls, tokens, cost, cache rate]
    expect(metricValues[0]).toBe('704');
    expect(metricValues[1]).toBe('5.5M');
    // v2.21.0: cost is now real ($12.3456 formatted). formatCost rounds to 2dp.
    expect(metricValues[2]).toMatch(/\$12\.\d+/);
    expect(metricValues[3]).toBe('38.1%');
  });

  it('clicking refresh triggers a new fetch', async () => {
    const fetchImpl = mockOk(SAMPLE);
    const v = new UsageView(container, { fetchImpl, nowMs: nowFn });
    await v.tickOnce();
    const before = fetchImpl.mock.calls.length;
    container.querySelector('.usage-refresh').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(before);
  });

  it('Retry button after error fires new fetch', async () => {
    let mode = 'fail';
    const fetchImpl = vi.fn().mockImplementation(async () => {
      if (mode === 'fail') return { ok: false, status: 500, text: async () => 'oops' };
      return { ok: true, status: 200, json: async () => SAMPLE };
    });
    const v = new UsageView(container, { fetchImpl, nowMs: nowFn });
    await v.tickOnce();
    expect(container.querySelector('.usage-retry')).not.toBeNull();
    mode = 'ok';
    container.querySelector('.usage-retry').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelector('.usage-retry')).toBeNull();
    expect(container.querySelector('.usage-summary')).not.toBeNull();
  });

  it('changing hours dropdown triggers fetch with new param', async () => {
    const fetchImpl = mockOk(SAMPLE);
    const v = new UsageView(container, { fetchImpl, nowMs: nowFn });
    await v.tickOnce();
    const sel = container.querySelector('.usage-hours');
    sel.value = '168';
    sel.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();
    const lastCall = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1][0];
    expect(lastCall).toBe('/api/usage?hours=168');
  });

  it('XSS defense: model name with HTML escaped in display', async () => {
    const xss = {
      ...SAMPLE,
      by_model: [{ model: '<script>alert(1)</script>', calls: 1, input_tokens: 100, output_tokens: 50, cached_tokens: 0 }],
    };
    const v = new UsageView(container, { fetchImpl: mockOk(xss), nowMs: nowFn });
    await v.tickOnce();
    const nameEl = container.querySelector('.usage-model-name');
    expect(nameEl.querySelector('script')).toBeNull();
    expect(nameEl.innerHTML).toContain('&lt;script&gt;');
  });
});
