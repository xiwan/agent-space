// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommandHistory, normalizeStatus, extractAgentBubbles, extractDisplayText, extractPipelineMetadata, truncateRecordForStorage, loadRecordsFromStorage, saveRecordsToStorage, clearStorage } from '../src/pixel/CommandHistory.js';

function mkClient(over = {}) {
  return {
    pollJob: over.pollJob || vi.fn().mockResolvedValue({ status: 'running' }),
    pollPipeline: over.pollPipeline || vi.fn().mockResolvedValue({ status: 'running' }),
    // v2.19.0: 4 个新 endpoint, 默认 noop
    pollJobLive: over.pollJobLive || vi.fn().mockResolvedValue({ content: '', parts_count: 0 }),
    pollPipelineStepLive: over.pollPipelineStepLive || vi.fn().mockResolvedValue({ content: '', parts_count: 0 }),
    cancelPipeline: over.cancelPipeline || vi.fn().mockResolvedValue({ status: 'cancelled' }),
    cancelJob: over.cancelJob || vi.fn().mockResolvedValue({ status: 'cancelled' }),
  };
}

describe('CommandHistory.normalizeStatus', () => {
  it('maps server statuses to canonical', () => {
    expect(normalizeStatus('running')).toBe('running');
    expect(normalizeStatus('in_progress')).toBe('running');
    expect(normalizeStatus('succeeded')).toBe('succeeded');
    expect(normalizeStatus('completed')).toBe('succeeded');
    expect(normalizeStatus('done')).toBe('succeeded');
    expect(normalizeStatus('failed')).toBe('failed');
    expect(normalizeStatus('error')).toBe('failed');
    expect(normalizeStatus(undefined)).toBe('pending');
    expect(normalizeStatus('weird')).toBe('pending');
  });
});

describe('CommandHistory.extractAgentBubbles', () => {
  it('job: takes output text, no agent name', () => {
    const out = extractAgentBubbles({ output: 'hello world' }, 'job');
    expect(out).toEqual([{ agent: null, text: 'hello world' }]);
  });

  it('job: empty → []', () => {
    expect(extractAgentBubbles({}, 'job')).toEqual([]);
  });

  it('pipeline: per-step output keyed by agent', () => {
    const out = extractAgentBubbles({
      steps: [
        { agent: 'kiro', output: 'analysis done' },
        { agent: 'claude', output: 'implementation' },
        { agent: 'qwen' }, // 没 output, skip
      ],
    }, 'pipeline');
    expect(out).toEqual([
      { agent: 'kiro', text: 'analysis done' },
      { agent: 'claude', text: 'implementation' },
    ]);
  });

  it('truncates long output to 140 chars', () => {
    const long = 'x'.repeat(500);
    const out = extractAgentBubbles({ output: long }, 'job');
    expect(out[0].text.length).toBe(140);
  });
});

describe('CommandHistory (DOM + state)', () => {
  let container, client, onAgentOutput, history;

  beforeEach(() => {
    // v2.13.0: 隔离 localStorage 避免测试间污染
    if (typeof localStorage !== 'undefined') localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    client = mkClient();
    onAgentOutput = vi.fn();
    history = new CommandHistory(container, { client, onAgentOutput, pollIntervalMs: 100 });
  });

  it('renders empty placeholder initially', () => {
    expect(container.querySelector('.ch-empty')).not.toBeNull();
  });

  it('pushSubmission(run) stores record with status=succeeded immediately', () => {
    history.pushSubmission(
      { kind: 'run', mode: 'single', agents: ['kiro'], prompt: 'hi' },
      { result: { text: 'hello back' } }
    );
    const list = history.list();
    expect(list.length).toBe(1);
    expect(list[0].status).toBe('succeeded');
    expect(list[0].kind).toBe('run');
    expect(list[0].completedAt).not.toBeNull();
  });

  it('pushSubmission(run) triggers onAgentOutput with agent + text', () => {
    history.pushSubmission(
      { kind: 'run', mode: 'single', agents: ['kiro'], prompt: 'hi' },
      { result: { text: 'hello' } }
    );
    expect(onAgentOutput).toHaveBeenCalledWith('kiro', 'hello');
  });

  it('pushSubmission(job) starts as pending with remoteId', () => {
    history.pushSubmission(
      { kind: 'job', mode: 'single', agents: ['kiro'], prompt: 'hi' },
      { job_id: 'job-1' }
    );
    const r = history.list()[0];
    expect(r.status).toBe('pending');
    expect(r.remoteId).toBe('job-1');
    expect(r.completedAt).toBeNull();
  });

  it('pushSubmission(pipeline) starts pending with pipeline_id', () => {
    history.pushSubmission(
      { kind: 'pipeline', mode: 'parallel', agents: ['a','b'], prompt: 'hi' },
      { pipeline_id: 'p-1' }
    );
    expect(history.list()[0].remoteId).toBe('p-1');
  });

  it('tickOnce polls pending jobs and updates status', async () => {
    client.pollJob.mockResolvedValueOnce({ status: 'succeeded', output: 'done' });
    history.pushSubmission(
      { kind: 'job', mode: 'single', agents: ['kiro'], prompt: 'hi' },
      { job_id: 'job-1' }
    );
    await history.tickOnce();
    const r = history.list()[0];
    expect(r.status).toBe('succeeded');
    expect(r.completedAt).not.toBeNull();
  });

  it('tickOnce calls onAgentOutput on pipeline output', async () => {
    client.pollPipeline.mockResolvedValueOnce({
      status: 'succeeded',
      steps: [
        { agent: 'kiro', output: 'analysis' },
        { agent: 'claude', output: 'impl' },
      ],
    });
    history.pushSubmission(
      { kind: 'pipeline', mode: 'sequence', agents: ['kiro','claude'], prompt: 'go' },
      { pipeline_id: 'p-1' }
    );
    await history.tickOnce();
    expect(onAgentOutput).toHaveBeenCalledWith('kiro', 'analysis');
    expect(onAgentOutput).toHaveBeenCalledWith('claude', 'impl');
  });

  it('tickOnce handles poll error → status=failed', async () => {
    client.pollJob.mockRejectedValueOnce(new Error('network'));
    history.pushSubmission(
      { kind: 'job', mode: 'single', agents: ['k'], prompt: 'p' },
      { job_id: 'j' }
    );
    await history.tickOnce();
    const r = history.list()[0];
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/network/);
  });

  it('tickOnce skips terminal records (no extra fetch)', async () => {
    history.pushSubmission(
      { kind: 'run', mode: 'single', agents: ['k'], prompt: 'p' },
      { output: 'x' }
    );
    await history.tickOnce();
    expect(client.pollJob).not.toHaveBeenCalled();
    expect(client.pollPipeline).not.toHaveBeenCalled();
  });

  it('renders card per record with mode + status class', () => {
    history.pushSubmission(
      { kind: 'job', mode: 'single', agents: ['kiro'], prompt: 'long prompt here' },
      { job_id: 'j-1' }
    );
    const card = container.querySelector('.ch-card');
    expect(card).not.toBeNull();
    expect(card.classList.contains('ch-status-pending')).toBe(true);
    expect(card.querySelector('.ch-mode').textContent).toBe('single');
    expect(card.querySelector('.ch-agents').textContent).toBe('kiro');
    // v2.11.0: prompt 在 .ch-prompt-block 的 summary 或 .ch-prompt-full 里
    expect(card.querySelector('.ch-prompt-block').textContent).toMatch(/long prompt here/);
  });

  it('newest record renders first', () => {
    history.pushSubmission({ kind: 'job', mode: 'single', agents: ['a'], prompt: 'first' }, { job_id: '1' });
    history.pushSubmission({ kind: 'job', mode: 'single', agents: ['b'], prompt: 'second' }, { job_id: '2' });
    const cards = container.querySelectorAll('.ch-card');
    // v2.11.0: prompt 在 .ch-prompt-block 里
    expect(cards[0].querySelector('.ch-prompt-block').textContent).toMatch(/second/);
    expect(cards[1].querySelector('.ch-prompt-block').textContent).toMatch(/first/);
  });

  it('start() / stop() does not throw', () => {
    expect(() => { history.start(); history.stop(); }).not.toThrow();
  });
});

// ============================================================
// v2.11.0: extractDisplayText (pure)
// ============================================================
describe('CommandHistory.extractDisplayText (v2.11.0)', () => {
  it('run + ACP output[*].parts[*].content → 1 turn', () => {
    const r = { output: [{ parts: [{ content: 'hello ' }, { content: 'world' }] }] };
    const d = extractDisplayText(r, 'run', 'kiro');
    expect(d.hasContent).toBe(true);
    expect(d.turns).toEqual([{ agent: 'kiro', text: 'hello world' }]);
  });

  it('run + result.text → 1 turn', () => {
    const d = extractDisplayText({ result: { text: 'hi' } }, 'run', 'kiro');
    expect(d.hasContent).toBe(true);
    expect(d.turns[0].text).toBe('hi');
  });

  it('run + result.output (string) → 1 turn', () => {
    const d = extractDisplayText({ result: { output: 'done' } }, 'run', 'kiro');
    expect(d.hasContent).toBe(true);
    expect(d.turns[0].text).toBe('done');
  });

  it('run + bare output (string) → 1 turn', () => {
    const d = extractDisplayText({ output: 'plain text' }, 'run', 'kiro');
    expect(d.hasContent).toBe(true);
    expect(d.turns[0].text).toBe('plain text');
  });

  it('run + bare text → 1 turn', () => {
    const d = extractDisplayText({ text: 'note' }, 'run', 'kiro');
    expect(d.hasContent).toBe(true);
    expect(d.turns[0].text).toBe('note');
  });

  it('run + nothing → hasContent=false', () => {
    expect(extractDisplayText({}, 'run', 'kiro').hasContent).toBe(false);
    expect(extractDisplayText(null, 'run', 'kiro').hasContent).toBe(false);
    expect(extractDisplayText({ output: 42 }, 'run', 'kiro').hasContent).toBe(false);
  });

  it('job: same priority as run', () => {
    const d = extractDisplayText({ output: 'job done' }, 'job', 'claude');
    expect(d.turns).toEqual([{ agent: 'claude', text: 'job done' }]);
  });

  it('pipeline + steps[] → N turns by step.agent', () => {
    const r = { steps: [
      { agent: 'a', output: 'A says' },
      { agent: 'b', result: { text: 'B says' } },
      { agent: 'c', output: [{ parts: [{ content: 'C parts' }] }] },
    ] };
    const d = extractDisplayText(r, 'pipeline');
    expect(d.hasContent).toBe(true);
    expect(d.turns).toEqual([
      { agent: 'a', text: 'A says' },
      { agent: 'b', text: 'B says' },
      { agent: 'c', text: 'C parts' },
    ]);
  });

  it('pipeline + empty steps → hasContent=false', () => {
    expect(extractDisplayText({ steps: [] }, 'pipeline').hasContent).toBe(false);
  });

  it('pipeline + steps where step has no text → shows status placeholder', () => {
    const d = extractDisplayText({
      steps: [{ agent: 'a' }, { agent: 'b', output: 'B' }],
    }, 'pipeline');
    expect(d.turns.length).toBe(2);
    expect(d.turns[0].agent).toBe('a');
    expect(d.turns[1]).toEqual({ agent: 'b', text: 'B' });
  });

  it('conversation: response.turns preferred over steps', () => {
    const r = {
      turns: [
        { agent: 'a', content: 'hello' },
        { agent: 'b', content: 'hi' },
      ],
      steps: [{ agent: 'x', output: 'should-not-appear' }],
    };
    const d = extractDisplayText(r, 'pipeline');
    expect(d.turns).toEqual([
      { agent: 'a', text: 'hello' },
      { agent: 'b', text: 'hi' },
    ]);
  });

  it('long text truncated to 800 + suffix', () => {
    const long = 'x'.repeat(1500);
    const d = extractDisplayText({ output: long }, 'run', 'a');
    expect(d.turns[0].text.length).toBe(800 + ' … (truncated)'.length);
    expect(d.turns[0].text.endsWith('… (truncated)')).toBe(true);
  });

  it('unknown kind → empty', () => {
    expect(extractDisplayText({ output: 'x' }, 'something', 'a').hasContent).toBe(false);
  });
});

// ============================================================
// v2.11.0: card structure (prompt block / convo block / raw block)
// ============================================================
describe('CommandHistory v2.11.0 card structure', () => {
  let container;
  let history;

  beforeEach(() => {
    if (typeof localStorage !== "undefined") localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    history = new CommandHistory(container, { client: mkClient() });
  });

  it('newest record (idx=0) has prompt-block open by default', () => {
    // v2.23.0: _render now preserves open/closed <details> state across re-renders.
    // A freshly-pushed newest record opens its prompt block by default.
    history.pushSubmission(
      { kind: 'run', mode: 'single', agents: ['b'], prompt: 'second prompt' },
      { output: 'ok' }
    );
    const cards = container.querySelectorAll('.ch-card');
    // 最新一条默认 open
    expect(cards[0].querySelector('.ch-prompt-block').hasAttribute('open')).toBe(true);
  });

  it('conversation block present (collapsed by default) when hasContent', () => {
    // v2.23.0: convo block no longer `open` by default — collapsed, toggle via ch-toggle-btn.
    // Result text moved behind a <details class="ch-step-result"> block.
    history.pushSubmission(
      { kind: 'run', mode: 'single', agents: ['a'], prompt: 'p' },
      { output: 'agent reply text' }
    );
    const card = container.querySelector('.ch-card');
    const convo = card.querySelector('.ch-convo-block');
    expect(convo).not.toBeNull();
    expect(convo.hasAttribute('open')).toBe(false);
    expect(convo.querySelector('.ch-turn-text').textContent).toBe('agent reply text');
    expect(convo.querySelector('.ch-turn-agent').textContent).toBe('a');
  });

  it('pipeline renders one ch-turn per step', () => {
    history.pushSubmission(
      { kind: 'pipeline', mode: 'sequence', agents: ['a', 'b'], prompt: 'go' },
      { pipeline_id: 'p1' }
    );
    // pending → 没 output → no convo block. 模拟 poll 完成
    const rec = history.list()[0];
    rec.status = 'succeeded';
    rec.output = { steps: [{ agent: 'a', output: 'A out' }, { agent: 'b', output: 'B out' }] };
    history._render();
    const turns = container.querySelectorAll('.ch-turn');
    expect(turns.length).toBe(2);
    expect(turns[0].querySelector('.ch-turn-agent').textContent).toBe('a');
    expect(turns[0].querySelector('.ch-turn-text').textContent).toBe('A out');
    expect(turns[1].querySelector('.ch-turn-agent').textContent).toBe('b');
  });

  it('raw JSON block always present when output exists, default folded', () => {
    history.pushSubmission(
      { kind: 'run', mode: 'single', agents: ['a'], prompt: 'p' },
      { output: 'reply', extra: 'metadata' }
    );
    const raw = container.querySelector('.ch-raw-block');
    expect(raw).not.toBeNull();
    expect(raw.hasAttribute('open')).toBe(false);
    expect(raw.querySelector('pre').textContent).toMatch(/metadata/);
  });

  it('terminal status without readable output shows ch-no-content hint', () => {
    history.pushSubmission(
      { kind: 'pipeline', mode: 'parallel', agents: ['a', 'b'], prompt: 'p' },
      { pipeline_id: 'p1' }
    );
    const rec = history.list()[0];
    rec.status = 'failed';
    rec.output = { error_code: 500 };  // 抽不出可读 text
    history._render();
    const noContent = container.querySelector('.ch-no-content');
    expect(noContent).not.toBeNull();
    expect(noContent.textContent).toMatch(/raw JSON/i);
  });

  it('prompt summary shows char count + 80-char preview', () => {
    const long = 'x'.repeat(200);
    history.pushSubmission(
      { kind: 'run', mode: 'single', agents: ['a'], prompt: long },
      { output: 'ok' }
    );
    const summary = container.querySelector('.ch-prompt-block > summary');
    expect(summary.textContent).toMatch(/200 chars/);
    // 预览截 80 + …
    expect(summary.textContent).toMatch(/…/);
    // 全文在 .ch-prompt-full
    expect(container.querySelector('.ch-prompt-full').textContent).toBe(long);
  });

  it('zero prompt records do not crash card rendering', () => {
    history.pushSubmission(
      { kind: 'run', mode: 'single', agents: ['a'], prompt: '' },
      { output: 'ok' }
    );
    expect(container.querySelector('.ch-card')).not.toBeNull();
    // 空 prompt → 不渲染 prompt-block
    expect(container.querySelector('.ch-prompt-block')).toBeNull();
  });

  it('text escapes < and > in turn output (XSS defense)', () => {
    history.pushSubmission(
      { kind: 'run', mode: 'single', agents: ['a'], prompt: 'p' },
      { output: '<script>alert(1)</script>' }
    );
    const turnText = container.querySelector('.ch-turn-text');
    expect(turnText.textContent).toBe('<script>alert(1)</script>');
    // innerHTML 应为转义后
    expect(turnText.innerHTML).toContain('&lt;script&gt;');
    expect(turnText.innerHTML).not.toContain('<script>');
  });
});

// ============================================================
// v2.11.1: real-world ACP Bridge job response shape
// ============================================================
describe('v2.11.1 ACP Bridge job real-world response', () => {
  let container;
  let history;

  beforeEach(() => {
    if (typeof localStorage !== "undefined") localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    history = new CommandHistory(container, { client: mkClient() });
  });

  // 用户实测真实响应 (POST /api/jobs → GET /api/jobs/{id} 完成态)
  const realJobResponse = {
    job_id: 'a798f1ab-c916-4ac1-b667-95aebb153b2b',
    agent: 'codex',
    session_id: '92a74ce3-e8d5-50a0-9456-ec47b158e6fb',
    status: 'completed',
    created_at: 1779281946.068247,
    target: 'channel:1469723146134356173',
    account_id: 'default',
    result: ' 已为您输出李白的《静夜思》，这首唐诗脍炙人口，表达了游子在静夜中对故乡的深深思念。\n',
    error: '',
    tools: [],
    duration: 6.8,
  };

  it('extractDisplayText: priority 0 takes string result', () => {
    const d = extractDisplayText(realJobResponse, 'job', 'codex');
    expect(d.hasContent).toBe(true);
    expect(d.turns.length).toBe(1);
    expect(d.turns[0].agent).toBe('codex');
    expect(d.turns[0].text).toContain('李白');
    expect(d.turns[0].text).toContain('静夜思');
  });

  it('extractDisplayText: result object with .text still works (backward compat)', () => {
    const d = extractDisplayText({ result: { text: 'old shape' } }, 'job', 'a');
    expect(d.hasContent).toBe(true);
    expect(d.turns[0].text).toBe('old shape');
  });

  it('extractDisplayText: empty string result falls through to other fields', () => {
    const d = extractDisplayText({ result: '   ', output: 'fallback' }, 'job', 'a');
    expect(d.hasContent).toBe(true);
    expect(d.turns[0].text).toBe('fallback');
  });

  it('card renders conversation block from real job response (李白)', () => {
    history.pushSubmission(
      { kind: 'job', mode: 'single', agents: ['codex'], prompt: '输出李白的静夜思' },
      { job_id: realJobResponse.job_id }
    );
    // 模拟 poll 完成
    const rec = history.list()[0];
    rec.status = 'succeeded';
    rec.output = realJobResponse;
    history._render();
    const turn = container.querySelector('.ch-turn');
    expect(turn).not.toBeNull();
    expect(turn.querySelector('.ch-turn-agent').textContent).toBe('codex');
    expect(turn.querySelector('.ch-turn-text').textContent).toContain('李白');
  });

  it('card shows duration in head when output.duration is number', () => {
    history.pushSubmission(
      { kind: 'job', mode: 'single', agents: ['codex'], prompt: 'x' },
      { job_id: 'j' }
    );
    const rec = history.list()[0];
    rec.status = 'succeeded';
    rec.output = realJobResponse;
    history._render();
    const dur = container.querySelector('.ch-duration');
    expect(dur).not.toBeNull();
    expect(dur.textContent).toBe('6.8s');
  });

  it('card omits duration when output.duration missing', () => {
    history.pushSubmission(
      { kind: 'job', mode: 'single', agents: ['a'], prompt: 'x' },
      { job_id: 'j' }
    );
    const rec = history.list()[0];
    rec.status = 'succeeded';
    rec.output = { result: 'ok' };  // 无 duration
    history._render();
    expect(container.querySelector('.ch-duration')).toBeNull();
  });

  it('card omits duration when output.error empty string', () => {
    // 复用 realJobResponse, error 是空字符串 → 不渲染 .ch-error-server
    history.pushSubmission(
      { kind: 'job', mode: 'single', agents: ['codex'], prompt: 'x' },
      { job_id: 'j' }
    );
    const rec = history.list()[0];
    rec.status = 'succeeded';
    rec.output = realJobResponse;  // error: ''
    history._render();
    expect(container.querySelector('.ch-error-server')).toBeNull();
  });

  it('card shows server-side error when output.error is non-empty', () => {
    history.pushSubmission(
      { kind: 'job', mode: 'single', agents: ['a'], prompt: 'x' },
      { job_id: 'j' }
    );
    const rec = history.list()[0];
    rec.status = 'failed';
    rec.output = { error: 'Tool execution failed: timeout', duration: 5.2 };
    history._render();
    const errEl = container.querySelector('.ch-error-server');
    expect(errEl).not.toBeNull();
    expect(errEl.textContent).toMatch(/Tool execution failed: timeout/);
  });

  it('agent override: output.agent takes precedence over r.agents[0]', () => {
    // 提交时记 agent="codex" (用户选), server 返回 agent="qwen" (实际派发到的)
    history.pushSubmission(
      { kind: 'job', mode: 'single', agents: ['codex'], prompt: 'x' },
      { job_id: 'j' }
    );
    const rec = history.list()[0];
    rec.status = 'succeeded';
    rec.output = { agent: 'qwen', result: 'rerouted reply' };
    history._render();
    // turn head 应显示 server 报的 'qwen', 不是 ctx 的 'codex'
    expect(container.querySelector('.ch-turn-agent').textContent).toBe('qwen');
  });

  it('XSS defense: server result with HTML content is escaped', () => {
    history.pushSubmission(
      { kind: 'job', mode: 'single', agents: ['a'], prompt: 'x' },
      { job_id: 'j' }
    );
    const rec = history.list()[0];
    rec.status = 'succeeded';
    rec.output = { result: '<img src=x onerror=alert(1)>', duration: 1.0 };
    history._render();
    const turn = container.querySelector('.ch-turn-text');
    expect(turn.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(turn.innerHTML).toContain('&lt;img');
    expect(turn.querySelector('img')).toBeNull();
  });
});

// ============================================================
// v2.13.0: localStorage persistence
// ============================================================
describe('v2.13.0 persistence — pure helpers', () => {
  it('truncateRecordForStorage: small output unchanged', () => {
    const rec = { id: 'r1', output: { result: 'short' } };
    const out = truncateRecordForStorage(rec);
    expect(out).toBe(rec); // 引用相等 (no copy)
  });

  it('truncateRecordForStorage: large output replaced with placeholder', () => {
    // v2.23.0: default MAX_OUTPUT_BYTES raised 10KB → 50KB. Fixture must exceed it.
    const big = 'x'.repeat(60 * 1024);
    const rec = { id: 'r1', output: { result: big } };
    const out = truncateRecordForStorage(rec);
    expect(out._truncated).toBe(true);
    expect(out.output._truncated).toBe(true);
    expect(out.output._original_size).toBeGreaterThan(50000);
    expect(out.output._max_bytes).toBe(50 * 1024);
    expect(out.output._preview).toMatch(/truncated for storage/);
  });

  it('truncateRecordForStorage: respects custom maxBytes', () => {
    const rec = { id: 'r1', output: { result: 'x'.repeat(100) } };
    const out = truncateRecordForStorage(rec, 30);
    expect(out._truncated).toBe(true);
  });

  it('truncateRecordForStorage: null output unchanged', () => {
    const rec = { id: 'r1', output: null };
    expect(truncateRecordForStorage(rec)).toBe(rec);
  });

  // mock storage to test save/load without happy-dom
  const mkMockStorage = () => {
    let store = {};
    return {
      getItem(k) { return store[k] ?? null; },
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; },
      _store: store,
      _read() { return store; },
    };
  };

  it('saveRecordsToStorage + loadRecordsFromStorage: round-trip', () => {
    const ms = mkMockStorage();
    const records = [
      { id: 'r1', kind: 'run', mode: 'single', agents: ['a'], status: 'succeeded',
        prompt: 'p', submittedAt: 1000, completedAt: 1100, output: { result: 'ok' }, error: null },
    ];
    expect(saveRecordsToStorage(records, ms)).toBe(true);
    const loaded = loadRecordsFromStorage(ms);
    expect(loaded.length).toBe(1);
    expect(loaded[0].id).toBe('r1');
    expect(loaded[0].output.result).toBe('ok');
  });

  it('loadRecordsFromStorage: returns [] for missing key', () => {
    const ms = mkMockStorage();
    expect(loadRecordsFromStorage(ms)).toEqual([]);
  });

  it('loadRecordsFromStorage: returns [] for malformed JSON', () => {
    const ms = mkMockStorage();
    ms.setItem('pixel.commandHistory.v1', '{not json');
    expect(loadRecordsFromStorage(ms)).toEqual([]);
  });

  it('loadRecordsFromStorage: returns [] for wrong version', () => {
    const ms = mkMockStorage();
    ms.setItem('pixel.commandHistory.v1', JSON.stringify({ version: 999, records: [] }));
    expect(loadRecordsFromStorage(ms)).toEqual([]);
  });

  it('loadRecordsFromStorage: filters out malformed records', () => {
    const ms = mkMockStorage();
    ms.setItem('pixel.commandHistory.v1', JSON.stringify({
      version: 1, savedAt: 0, records: [
        { /* missing fields */ },
        { id: 'r1', kind: 'run', mode: 'single', agents: ['a'], status: 'ok', submittedAt: 1 },
      ],
    }));
    expect(loadRecordsFromStorage(ms).length).toBe(1);
  });

  it('saveRecordsToStorage: handles quota error gracefully', () => {
    const ms = mkMockStorage();
    ms.setItem = () => { throw new Error('QuotaExceededError'); };
    const oldWarn = console.warn;
    const calls = [];
    console.warn = (...a) => calls.push(a);
    try {
      const ok = saveRecordsToStorage([{ id: 'r1', kind: 'run', mode: 'single', agents: ['a'], status: 'ok', submittedAt: 1 }], ms);
      expect(ok).toBe(false);
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      console.warn = oldWarn;
    }
  });

  it('saveRecordsToStorage: caps at 50 records', () => {
    const ms = mkMockStorage();
    const records = Array.from({ length: 100 }, (_, i) => ({
      id: `r${i}`, kind: 'run', mode: 'single', agents: ['a'], status: 'ok',
      prompt: `p${i}`, submittedAt: i, output: { result: 'x' }, error: null,
    }));
    saveRecordsToStorage(records, ms);
    const loaded = loadRecordsFromStorage(ms);
    expect(loaded.length).toBe(50);
    // 应保留前 50 (caller 已经按"最新在前"传, save 截前 50)
    expect(loaded[0].id).toBe('r0');
    expect(loaded[49].id).toBe('r49');
  });

  it('clearStorage removes the key', () => {
    const ms = mkMockStorage();
    ms.setItem('pixel.commandHistory.v1', '{"version":1,"records":[]}');
    clearStorage(ms);
    expect(ms.getItem('pixel.commandHistory.v1')).toBeNull();
  });
});

// ============================================================
// v2.13.0: persistence — class behavior
// ============================================================
describe('v2.13.0 CommandHistory class with storage', () => {
  let container;
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('pushSubmission writes to localStorage', () => {
    const h = new CommandHistory(container, { client: mkClient() });
    h.pushSubmission(
      { kind: 'run', mode: 'single', agents: ['a'], prompt: 'hi' },
      { output: 'ok' }
    );
    const raw = localStorage.getItem('pixel.commandHistory.v1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.records.length).toBe(1);
    expect(parsed.records[0].prompt).toBe('hi');
  });

  it('constructor restores from localStorage', () => {
    // 先用一个 history 推一条
    const h1 = new CommandHistory(container, { client: mkClient() });
    h1.pushSubmission({ kind: 'run', mode: 'single', agents: ['a'], prompt: 'first' }, { output: 'ok' });
    // 模拟刷新: 新建另一 history
    const c2 = document.createElement('div');
    document.body.appendChild(c2);
    const h2 = new CommandHistory(c2, { client: mkClient() });
    expect(h2.list().length).toBe(1);
    expect(h2.list()[0].prompt).toBe('first');
    // DOM 也渲染了
    expect(c2.querySelector('.ch-card')).not.toBeNull();
  });

  it('clear() empties memory + localStorage', () => {
    const h = new CommandHistory(container, { client: mkClient() });
    h.pushSubmission({ kind: 'run', mode: 'single', agents: ['a'], prompt: 'p' }, { output: 'ok' });
    expect(localStorage.getItem('pixel.commandHistory.v1')).not.toBeNull();
    h.clear();
    expect(h.list().length).toBe(0);
    expect(localStorage.getItem('pixel.commandHistory.v1')).toBeNull();
    expect(container.querySelector('.ch-empty')).not.toBeNull();
  });

  it('FIFO: 51st record evicts the oldest', () => {
    const h = new CommandHistory(container, { client: mkClient() });
    for (let i = 0; i < 52; i++) {
      h.pushSubmission(
        { kind: 'run', mode: 'single', agents: ['a'], prompt: `p${i}` },
        { output: 'ok' }
      );
    }
    expect(h.list().length).toBe(50);
    // 最新的 (idx=0) 是 p51, 最老的应是 p2 (p0/p1 被砍)
    expect(h.list()[0].prompt).toBe('p51');
    expect(h.list()[49].prompt).toBe('p2');
  });

  it('large output truncated when persisted', () => {
    const h = new CommandHistory(container, { client: mkClient() });
    const big = 'y'.repeat(50 * 1024);
    h.pushSubmission(
      { kind: 'run', mode: 'single', agents: ['a'], prompt: 'p' },
      { result: big, extra: 'meta' }
    );
    const persisted = JSON.parse(localStorage.getItem('pixel.commandHistory.v1'));
    expect(persisted.records[0]._truncated).toBe(true);
    expect(persisted.records[0].output._truncated).toBe(true);
    // 内存里的 record 不被截 (内存版本仍是完整的)
    expect(typeof h.list()[0].output).toBe('object');
  });

  it('onCountChange fires on push and clear', () => {
    const onCountChange = vi.fn();
    const h = new CommandHistory(container, { client: mkClient(), onCountChange });
    // 初始 0
    expect(onCountChange).toHaveBeenCalledWith(0);
    onCountChange.mockClear();
    h.pushSubmission({ kind: 'run', mode: 'single', agents: ['a'], prompt: 'p' }, { output: 'ok' });
    expect(onCountChange).toHaveBeenCalledWith(1);
    onCountChange.mockClear();
    h.clear();
    expect(onCountChange).toHaveBeenCalledWith(0);
  });

  it('persisted pending record is loaded and continues polling on next tick', async () => {
    // seed storage with a pending pipeline record
    const seed = {
      version: 1, savedAt: 0,
      records: [{
        id: 'r-pending', kind: 'pipeline', mode: 'sequence', agents: ['a', 'b'],
        prompt: 'p', submittedAt: 1000, completedAt: null, status: 'pending',
        remoteId: 'pipe-xyz', output: null, error: null,
      }],
    };
    localStorage.setItem('pixel.commandHistory.v1', JSON.stringify(seed));
    // 构造时加载
    const pollPipeline = vi.fn().mockResolvedValue({ status: 'succeeded', steps: [{ agent: 'a', output: 'ok' }] });
    const client = { pollJob: vi.fn(), pollPipeline };
    const h = new CommandHistory(container, { client });
    expect(h.list().length).toBe(1);
    expect(h.list()[0].status).toBe('pending');
    // tick → 应该调 pollPipeline
    await h.tickOnce();
    expect(pollPipeline).toHaveBeenCalledWith('pipe-xyz');
    expect(h.list()[0].status).toBe('succeeded');
  });

  it('storage:null disables persistence', () => {
    const h = new CommandHistory(container, { client: mkClient(), storage: null });
    h.pushSubmission({ kind: 'run', mode: 'single', agents: ['a'], prompt: 'p' }, { output: 'ok' });
    // happy-dom 真 localStorage 不应被写
    expect(localStorage.getItem('pixel.commandHistory.v1')).toBeNull();
  });

  it('truncated note rendered in card when _truncated=true', () => {
    const h = new CommandHistory(container, { client: mkClient() });
    const big = 'z'.repeat(50 * 1024);
    h.pushSubmission(
      { kind: 'run', mode: 'single', agents: ['a'], prompt: 'p' },
      { result: big }
    );
    // mutate 直接 set _truncated 模拟从 storage 加载后的状态
    const rec = h.list()[0];
    rec._truncated = true;
    rec.output = { _truncated: true, _original_size: 51200, _max_bytes: 10240, _preview: 'xx' };
    h._render();
    const note = container.querySelector('.ch-truncated-note');
    expect(note).not.toBeNull();
    expect(note.textContent).toMatch(/truncated for storage/i);
  });
});

// ============================================================
// v2.13.1: conversation transcript + multi-mode pipeline coverage
// ============================================================
describe('v2.13.1 extractDisplayText — conversation transcript', () => {
  // 用户实测真实响应 (中国足球对话)
  const realConvo = {
    pipeline_id: '38d19e89-7d43-466d-b836-5e7594ef4b13',
    mode: 'conversation',
    status: 'completed',
    steps: [
      { agent: 'claude', status: 'pending' },
      { agent: 'harness', status: 'pending' },
    ],
    duration: 34.9,
    paused: false,
    participants: ['claude', 'harness'],
    topic: '讨论中国足球',
    config: { max_turns: 6 },
    turns: 6,
    stop_reason: 'MAX_TURNS',
    transcript: [
      { turn: 1, agent: 'claude', content: '我觉得青训问题严重。', duration: 11.6 },
      { turn: 2, agent: 'harness', content: '确实如此, 但还有更深层。', duration: 2.1 },
      { turn: 3, agent: 'claude', content: '联赛也要改革。', duration: 9.1 },
    ],
  };

  it('reads transcript[] (not steps[]) for conversation mode', () => {
    const d = extractDisplayText(realConvo, 'pipeline');
    expect(d.hasContent).toBe(true);
    expect(d.turns.length).toBe(3);
    expect(d.turns[0].agent).toBe('claude');
    expect(d.turns[0].text).toContain('青训');
  });

  it('preserves turn / duration on each transcript entry', () => {
    const d = extractDisplayText(realConvo, 'pipeline');
    expect(d.turns[0].turn).toBe(1);
    expect(d.turns[0].duration).toBe(11.6);
    expect(d.turns[2].turn).toBe(3);
    expect(d.turns[2].duration).toBe(9.1);
  });

  it('does not fall through to steps[] when transcript exists', () => {
    // realConvo.steps 全 pending — 如果用 steps 路径会 hasContent=false
    const d = extractDisplayText(realConvo, 'pipeline');
    expect(d.hasContent).toBe(true);
    // 不应有 status (transcript 路径不传 status)
    expect(d.turns[0].status).toBeUndefined();
  });

  it('falls back to legacy turns[] field when transcript missing', () => {
    // 旧测试 fixture 兼容
    const legacy = { mode: 'conversation', turns: [{ agent: 'a', content: 'hi' }] };
    const d = extractDisplayText(legacy, 'pipeline');
    expect(d.hasContent).toBe(true);
    expect(d.turns[0].text).toBe('hi');
  });

  it('falls back to steps[] when transcript empty', () => {
    const r = { mode: 'conversation', transcript: [], steps: [{ agent: 'a', result: 'fallback' }] };
    const d = extractDisplayText(r, 'pipeline');
    expect(d.hasContent).toBe(true);
    expect(d.turns[0].text).toBe('fallback');
  });
});

describe('v2.13.1 extractDisplayText — sequence/parallel/race steps', () => {
  it('preserves step.status + duration in turn', () => {
    const r = {
      mode: 'sequence',
      steps: [
        { agent: 'a', status: 'completed', result: 'A done', duration: 0.9 },
        { agent: 'b', status: 'failed', error: 'oops', result: '' },  // result empty
        { agent: 'c', status: 'completed', result: 'C done', duration: 1.5 },
      ],
    };
    const d = extractDisplayText(r, 'pipeline');
    // v2.14.2: all steps shown (b has error text)
    expect(d.turns.length).toBe(3);
    expect(d.turns[0].status).toBe('completed');
    expect(d.turns[0].duration).toBe(0.9);
    expect(d.turns[1].status).toBe('failed');
    expect(d.turns[1].text).toContain('oops');
    expect(d.turns[2].duration).toBe(1.5);
  });

  it('race mode: only one completed step → marks isWinner', () => {
    const r = {
      mode: 'race',
      steps: [
        { agent: 'a', status: 'pending' },
        { agent: 'b', status: 'completed', result: 'B wins', duration: 2.0 },
        { agent: 'c', status: 'pending' },
      ],
    };
    const d = extractDisplayText(r, 'pipeline');
    // v2.14.2: all steps shown, only b has isWinner
    expect(d.turns.length).toBe(3);
    const winner = d.turns.find(t => t.isWinner);
    expect(winner.agent).toBe('b');
    expect(winner.text).toBe('B wins');
  });

  it('non-race mode: no isWinner even if only one step has result', () => {
    const r = {
      mode: 'sequence',
      steps: [
        { agent: 'a', status: 'completed', result: 'A done' },
        { agent: 'b', status: 'pending' },
      ],
    };
    const d = extractDisplayText(r, 'pipeline');
    expect(d.turns[0].isWinner).toBeUndefined();
  });

  it('parallel mode preserves multiple completed steps', () => {
    const r = {
      mode: 'parallel',
      steps: [
        { agent: 'a', status: 'completed', result: 'A out', duration: 5.1 },
        { agent: 'b', status: 'completed', result: 'B out', duration: 3.2 },
      ],
    };
    const d = extractDisplayText(r, 'pipeline');
    expect(d.turns.length).toBe(2);
    expect(d.turns[0].duration).toBe(5.1);
    expect(d.turns[1].duration).toBe(3.2);
  });
});

describe('v2.13.1 extractPipelineMetadata', () => {
  it('extracts stop_reason / total duration / transcript count', () => {
    const r = {
      mode: 'conversation', status: 'completed', duration: 34.9,
      stop_reason: 'MAX_TURNS', paused: false,
      transcript: [{ turn: 1, agent: 'a', content: 'x' }, { turn: 2, agent: 'b', content: 'y' }],
    };
    const m = extractPipelineMetadata(r);
    expect(m.stopReason).toBe('MAX_TURNS');
    expect(m.totalDuration).toBe(34.9);
    expect(m.transcriptTurns).toBe(2);
    expect(m.paused).toBeUndefined();
    expect(m.mode).toBe('conversation');
  });

  it('paused=true surfaces in metadata', () => {
    const m = extractPipelineMetadata({ paused: true });
    expect(m.paused).toBe(true);
  });

  it('null/empty input → empty metadata', () => {
    expect(extractPipelineMetadata(null)).toEqual({});
    expect(extractPipelineMetadata({})).toEqual({});
  });
});

describe('v2.13.1 card rendering — conversation', () => {
  let container;
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('conversation: turn # and duration chips render in turn head', () => {
    const h = new CommandHistory(container, { client: mkClient() });
    h.pushSubmission(
      { kind: 'pipeline', mode: 'conversation', agents: ['a', 'b'], prompt: 'topic' },
      { pipeline_id: 'p1' }
    );
    const rec = h.list()[0];
    rec.status = 'succeeded';
    rec.output = {
      mode: 'conversation', status: 'completed', duration: 12.3,
      stop_reason: 'MAX_TURNS',
      transcript: [
        { turn: 1, agent: 'a', content: 'hi', duration: 11.6 },
        { turn: 2, agent: 'b', content: 'hello', duration: 2.1 },
      ],
    };
    h._render();

    // 两个 turn
    const turns = container.querySelectorAll('.ch-turn');
    expect(turns.length).toBe(2);

    // 第一个 turn 的 chips
    const head0 = turns[0].querySelector('.ch-turn-head');
    expect(head0.querySelector('.ch-turn-num').textContent).toBe('#1');
    expect(head0.querySelector('.ch-turn-dur').textContent).toBe('11.6s');

    // metadata chips 在 turns 上方
    const metaChips = container.querySelectorAll('.ch-meta-chip');
    expect(metaChips.length).toBeGreaterThanOrEqual(2);
    const stopChip = container.querySelector('.ch-meta-stop');
    expect(stopChip).not.toBeNull();
    expect(stopChip.textContent).toMatch(/MAX_TURNS/);
  });

  it('race mode: winner step gets 🏆 winner chip', () => {
    const h = new CommandHistory(container, { client: mkClient() });
    h.pushSubmission(
      { kind: 'pipeline', mode: 'race', agents: ['a', 'b', 'c'], prompt: 'race them' },
      { pipeline_id: 'p1' }
    );
    const rec = h.list()[0];
    rec.status = 'succeeded';
    rec.output = {
      mode: 'race',
      steps: [
        { agent: 'a', status: 'pending' },
        { agent: 'b', status: 'completed', result: 'B wins', duration: 2.0 },
        { agent: 'c', status: 'pending' },
      ],
    };
    h._render();
    const winner = container.querySelector('.ch-turn-winner');
    expect(winner).not.toBeNull();
    expect(winner.textContent).toMatch(/winner/i);
  });

  it('failed step status renders as red chip', () => {
    const h = new CommandHistory(container, { client: mkClient() });
    h.pushSubmission(
      { kind: 'pipeline', mode: 'sequence', agents: ['a', 'b'], prompt: 'do' },
      { pipeline_id: 'p1' }
    );
    const rec = h.list()[0];
    rec.status = 'succeeded';
    rec.output = {
      mode: 'sequence',
      steps: [
        { agent: 'a', status: 'failed', result: 'oops happened', duration: 1.0 },
      ],
    };
    h._render();
    const status = container.querySelector('.ch-step-status-failed');
    expect(status).not.toBeNull();
    expect(status.textContent).toBe('failed');
  });

  it('conversation paused metadata chip renders when paused=true', () => {
    const h = new CommandHistory(container, { client: mkClient() });
    h.pushSubmission(
      { kind: 'pipeline', mode: 'conversation', agents: ['a', 'b'], prompt: 'topic' },
      { pipeline_id: 'p1' }
    );
    const rec = h.list()[0];
    rec.status = 'succeeded';
    rec.output = {
      mode: 'conversation', paused: true,
      transcript: [{ turn: 1, agent: 'a', content: 'x' }],
    };
    h._render();
    expect(container.querySelector('.ch-meta-paused')).not.toBeNull();
  });

  it('XSS defense in transcript content', () => {
    const h = new CommandHistory(container, { client: mkClient() });
    h.pushSubmission(
      { kind: 'pipeline', mode: 'conversation', agents: ['a'], prompt: 'p' },
      { pipeline_id: 'p1' }
    );
    const rec = h.list()[0];
    rec.status = 'succeeded';
    rec.output = {
      mode: 'conversation',
      transcript: [{ turn: 1, agent: 'a', content: '<img src=x onerror=alert(1)>' }],
    };
    h._render();
    const turn = container.querySelector('.ch-turn-text');
    expect(turn.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(turn.querySelector('img')).toBeNull();
  });
});

// =============================================================================
// v2.19.0 — SSE / cancel / live-poll / artifact link (from stashed v2.14.2-WIP)
// =============================================================================

/**
 * 最小 EventSource mock — 让 stash 里的 _subscribeSSE 流程能跑.
 * 测试通过手动调 .emit('event_type', data) 来推 SSE 事件.
 */
class MockEventSource {
  constructor(url) {
    this.url = url;
    this._listeners = {};
    this.readyState = 1;
    this.closed = false;
    MockEventSource.last = this;
  }
  addEventListener(type, handler) {
    (this._listeners[type] = this._listeners[type] || []).push(handler);
  }
  set onerror(fn) { this._onerror = fn; }
  emit(type, dataObj) {
    const handlers = this._listeners[type] || [];
    const evt = { data: JSON.stringify(dataObj) };
    handlers.forEach(h => h(evt));
  }
  triggerError() { if (this._onerror) this._onerror({}); }
  close() { this.closed = true; }
}

describe('v2.19.0 — SSE pipeline events', () => {
  let container, client, onAgentOutput, history;
  let origEventSource;

  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    client = mkClient();
    onAgentOutput = vi.fn();
    origEventSource = globalThis.EventSource;
    globalThis.EventSource = MockEventSource;
    MockEventSource.last = null;
    history = new CommandHistory(container, { client, onAgentOutput, pollIntervalMs: 100 });
  });

  afterEach(() => {
    globalThis.EventSource = origEventSource;
    history.stop();
  });

  it('pipeline submission with remoteId opens SSE connection', () => {
    history.pushSubmission(
      { kind: 'pipeline', mode: 'sequence', agents: ['a', 'b'], prompt: 'p' },
      { pipeline_id: 'pipe-123' }
    );
    expect(MockEventSource.last).not.toBeNull();
    expect(MockEventSource.last.url).toBe('/api/pipelines/pipe-123/events');
  });

  it('step_started event populates rec.output.steps with running status', () => {
    history.pushSubmission(
      { kind: 'pipeline', mode: 'sequence', agents: ['claude', 'kiro'], prompt: 'p' },
      { pipeline_id: 'p1' }
    );
    MockEventSource.last.emit('step_started', { index: 0, agent: 'claude', prompt_preview: 'do x' });
    const rec = history.list()[0];
    expect(rec.output.steps[0].agent).toBe('claude');
    expect(rec.output.steps[0].status).toBe('running');
    expect(rec.status).toBe('running');
  });

  it('step_progress with message.thinking accumulates and emits bubble (>5 chars)', () => {
    history.pushSubmission(
      { kind: 'pipeline', mode: 'sequence', agents: ['claude'], prompt: 'p' },
      { pipeline_id: 'p2' }
    );
    MockEventSource.last.emit('step_started', { index: 0, agent: 'claude' });
    MockEventSource.last.emit('step_progress', { index: 0, agent: 'claude', kind: 'message.thinking', content: 'thinking hard...' });
    const rec = history.list()[0];
    expect(rec.output.steps[0]._thinking).toMatch(/thinking hard/);
    // bubble 应被 enqueue 到 claude 头顶
    expect(onAgentOutput).toHaveBeenCalled();
    const lastCall = onAgentOutput.mock.calls[onAgentOutput.mock.calls.length - 1];
    expect(lastCall[0]).toBe('claude');
    expect(lastCall[1]).toMatch(/^💭 /);
  });

  it('step_progress with message.part triggers bubble emit (flushed on sentence boundary)', () => {
    // v2.23.0: message.part bubbles are accumulated and flushed only on a
    // sentence boundary or 60+ chars, with duration 3000.
    history.pushSubmission(
      { kind: 'pipeline', mode: 'sequence', agents: ['claude'], prompt: 'p' },
      { pipeline_id: 'p3' }
    );
    MockEventSource.last.emit('step_started', { index: 0, agent: 'claude' });
    onAgentOutput.mockClear();
    MockEventSource.last.emit('step_progress', { index: 0, agent: 'claude', kind: 'message.part', content: 'partial output here.' });
    expect(onAgentOutput).toHaveBeenCalledWith('claude', expect.stringContaining('partial output'), expect.objectContaining({ duration: 3000 }));
  });

  it('step_progress with tool.start emits 🔧 bubble', () => {
    history.pushSubmission(
      { kind: 'pipeline', mode: 'sequence', agents: ['kiro'], prompt: 'p' },
      { pipeline_id: 'p4' }
    );
    MockEventSource.last.emit('step_started', { index: 0, agent: 'kiro' });
    onAgentOutput.mockClear();
    MockEventSource.last.emit('step_progress', { index: 0, agent: 'kiro', kind: 'tool.start', title: 'ReadFile', toolCallId: 't1' });
    expect(onAgentOutput).toHaveBeenCalledWith('kiro', '🔧 ReadFile', expect.any(Object));
  });

  it('step_completed sets status + result on the step', () => {
    history.pushSubmission(
      { kind: 'pipeline', mode: 'sequence', agents: ['kiro'], prompt: 'p' },
      { pipeline_id: 'p5' }
    );
    MockEventSource.last.emit('step_started', { index: 0, agent: 'kiro' });
    MockEventSource.last.emit('step_completed', {
      index: 0, agent: 'kiro', status: 'completed',
      result_preview: 'all done', duration: 4.5,
    });
    const rec = history.list()[0];
    expect(rec.output.steps[0].status).toBe('completed');
    expect(rec.output.steps[0].result).toBe('all done');
    expect(rec.output.steps[0].duration).toBe(4.5);
  });

  it('step_failed sets status + error', () => {
    history.pushSubmission(
      { kind: 'pipeline', mode: 'sequence', agents: ['kiro'], prompt: 'p' },
      { pipeline_id: 'p6' }
    );
    MockEventSource.last.emit('step_started', { index: 0, agent: 'kiro' });
    MockEventSource.last.emit('step_failed', { index: 0, agent: 'kiro', error: 'boom' });
    const rec = history.list()[0];
    expect(rec.output.steps[0].status).toBe('failed');
    expect(rec.output.steps[0].error).toBe('boom');
  });

  it('pipeline_done finalizes status + closes SSE', () => {
    history.pushSubmission(
      { kind: 'pipeline', mode: 'sequence', agents: ['kiro'], prompt: 'p' },
      { pipeline_id: 'p7' }
    );
    const es = MockEventSource.last;
    es.emit('pipeline_done', { status: 'succeeded', duration: 12.3 });
    const rec = history.list()[0];
    expect(rec.status).toBe('succeeded');
    expect(rec.completedAt).toBeGreaterThan(0);
    expect(es.closed).toBe(true);
  });

  it('SSE error → connection closed (poll fallback can take over)', () => {
    history.pushSubmission(
      { kind: 'pipeline', mode: 'sequence', agents: ['kiro'], prompt: 'p' },
      { pipeline_id: 'p8' }
    );
    const es = MockEventSource.last;
    es.triggerError();
    expect(es.closed).toBe(true);
  });

  it('history.stop() closes all SSE connections', () => {
    history.pushSubmission({ kind: 'pipeline', mode: 'sequence', agents: ['a'], prompt: 'p' }, { pipeline_id: 'p9' });
    const es = MockEventSource.last;
    history.stop();
    expect(es.closed).toBe(true);
  });
});

describe('v2.19.0 — Cancel button graceful 404 degrade', () => {
  let container, history, origEventSource;

  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    origEventSource = globalThis.EventSource;
    globalThis.EventSource = MockEventSource;
    MockEventSource.last = null;
  });

  afterEach(() => {
    globalThis.EventSource = origEventSource;
    if (history) history.stop();
  });

  it('renders Cancel button on running pipeline', () => {
    const client = mkClient();
    history = new CommandHistory(container, { client, pollIntervalMs: 1000000 });
    history.pushSubmission({ kind: 'pipeline', mode: 'sequence', agents: ['a'], prompt: 'p' }, { pipeline_id: 'pX' });
    history._render();
    expect(container.querySelector('.ch-cancel-btn')).not.toBeNull();
  });

  it('does NOT render Cancel button on completed pipeline', () => {
    const client = mkClient();
    history = new CommandHistory(container, { client, pollIntervalMs: 1000000 });
    history.pushSubmission({ kind: 'pipeline', mode: 'sequence', agents: ['a'], prompt: 'p' }, { pipeline_id: 'pY' });
    const rec = history.list()[0];
    rec.status = 'succeeded';
    history._render();
    expect(container.querySelector('.ch-cancel-btn')).toBeNull();
  });

  it('cancel 404 → button shows "✕ N/A" graceful degrade', async () => {
    const cancelPipeline = vi.fn().mockRejectedValue(new Error('HTTP 404 not found'));
    const client = mkClient({ cancelPipeline });
    history = new CommandHistory(container, { client, pollIntervalMs: 1000000 });
    history.pushSubmission({ kind: 'pipeline', mode: 'sequence', agents: ['a'], prompt: 'p' }, { pipeline_id: 'pZ' });
    history._render();
    const btn = container.querySelector('.ch-cancel-btn');
    btn.click();
    // 等 promise 解析
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(cancelPipeline).toHaveBeenCalledWith('pZ');
    expect(btn.textContent).toBe('✕ N/A');
  });

  it('cancel success → button shows "✕ Cancelled"', async () => {
    const cancelPipeline = vi.fn().mockResolvedValue({ status: 'cancelled' });
    const client = mkClient({ cancelPipeline });
    history = new CommandHistory(container, { client, pollIntervalMs: 1000000 });
    history.pushSubmission({ kind: 'pipeline', mode: 'sequence', agents: ['a'], prompt: 'p' }, { pipeline_id: 'pZZ' });
    history._render();
    const btn = container.querySelector('.ch-cancel-btn');
    btn.click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(btn.textContent).toBe('✕ Cancelled');
  });

  it('cancel network error (non-404) → "✕ Error"', async () => {
    const cancelPipeline = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = mkClient({ cancelPipeline });
    history = new CommandHistory(container, { client, pollIntervalMs: 1000000 });
    history.pushSubmission({ kind: 'pipeline', mode: 'sequence', agents: ['a'], prompt: 'p' }, { pipeline_id: 'pE' });
    history._render();
    const btn = container.querySelector('.ch-cancel-btn');
    btn.click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(btn.textContent).toBe('✕ Error');
  });
});
