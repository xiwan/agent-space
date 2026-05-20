// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandHistory, normalizeStatus, extractAgentBubbles, extractDisplayText } from '../src/pixel/CommandHistory.js';

function mkClient(over = {}) {
  return {
    pollJob: over.pollJob || vi.fn().mockResolvedValue({ status: 'running' }),
    pollPipeline: over.pollPipeline || vi.fn().mockResolvedValue({ status: 'running' }),
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

  it('truncates long output to 200 chars', () => {
    const long = 'x'.repeat(500);
    const out = extractAgentBubbles({ output: long }, 'job');
    expect(out[0].text.length).toBe(200);
  });
});

describe('CommandHistory (DOM + state)', () => {
  let container, client, onAgentOutput, history;

  beforeEach(() => {
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

  it('pipeline + steps where step has no text → skipped', () => {
    const d = extractDisplayText({
      steps: [{ agent: 'a' }, { agent: 'b', output: 'B' }],
    }, 'pipeline');
    expect(d.turns).toEqual([{ agent: 'b', text: 'B' }]);
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
    container = document.createElement('div');
    document.body.appendChild(container);
    history = new CommandHistory(container, { client: mkClient() });
  });

  it('newest record (idx=0) has prompt-block open by default', () => {
    history.pushSubmission(
      { kind: 'run', mode: 'single', agents: ['a'], prompt: 'first prompt' },
      { output: 'ok' }
    );
    history.pushSubmission(
      { kind: 'run', mode: 'single', agents: ['b'], prompt: 'second prompt' },
      { output: 'ok' }
    );
    const cards = container.querySelectorAll('.ch-card');
    // 最新在前 (cards[0] = second), 默认 open
    expect(cards[0].querySelector('.ch-prompt-block').hasAttribute('open')).toBe(true);
    // 第二张折叠
    expect(cards[1].querySelector('.ch-prompt-block').hasAttribute('open')).toBe(false);
  });

  it('conversation block always open when hasContent', () => {
    history.pushSubmission(
      { kind: 'run', mode: 'single', agents: ['a'], prompt: 'p' },
      { output: 'agent reply text' }
    );
    const card = container.querySelector('.ch-card');
    const convo = card.querySelector('.ch-convo-block');
    expect(convo).not.toBeNull();
    expect(convo.hasAttribute('open')).toBe(true);
    expect(convo.querySelector('.ch-turn-text').textContent).toBe('agent reply text');
    expect(convo.querySelector('.ch-turn-head').textContent).toBe('a');
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
    expect(turns[0].querySelector('.ch-turn-head').textContent).toBe('a');
    expect(turns[0].querySelector('.ch-turn-text').textContent).toBe('A out');
    expect(turns[1].querySelector('.ch-turn-head').textContent).toBe('b');
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
    container = document.createElement('div');
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
    expect(turn.querySelector('.ch-turn-head').textContent).toBe('codex');
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
    expect(container.querySelector('.ch-turn-head').textContent).toBe('qwen');
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
