// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandHistory, normalizeStatus, extractAgentBubbles } from '../src/pixel/CommandHistory.js';

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
    expect(card.querySelector('.ch-prompt').textContent).toMatch(/long prompt here/);
  });

  it('newest record renders first', () => {
    history.pushSubmission({ kind: 'job', mode: 'single', agents: ['a'], prompt: 'first' }, { job_id: '1' });
    history.pushSubmission({ kind: 'job', mode: 'single', agents: ['b'], prompt: 'second' }, { job_id: '2' });
    const cards = container.querySelectorAll('.ch-card');
    expect(cards[0].querySelector('.ch-prompt').textContent).toMatch(/second/);
    expect(cards[1].querySelector('.ch-prompt').textContent).toMatch(/first/);
  });

  it('start() / stop() does not throw', () => {
    expect(() => { history.start(); history.stop(); }).not.toThrow();
  });
});
