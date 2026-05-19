// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandComposer, buildPayload, validateState } from '../src/pixel/CommandComposer.js';

function mkState(over = {}) {
  return {
    mode: 'single',
    sync: 'async',
    agents: new Set(['kiro']),
    prompt: 'hi',
    perStepPrompts: false,
    stepPrompts: {},
    maxTurns: 6,
    ...over,
  };
}

describe('CommandComposer.buildPayload (pure)', () => {
  it('single sync → POST /api/runs with ACP input.parts shape', () => {
    const out = buildPayload(mkState({ sync: 'sync' }));
    expect(out.endpoint).toBe('/api/runs');
    expect(out.body.agent_name).toBe('kiro');
    expect(out.body.input).toEqual([{ parts: [{ content: 'hi', content_type: 'text/plain' }] }]);
  });

  it('single async → POST /api/jobs with prompt', () => {
    const out = buildPayload(mkState({ sync: 'async' }));
    expect(out.endpoint).toBe('/api/jobs');
    expect(out.body).toEqual({ agent_name: 'kiro', prompt: 'hi' });
  });

  it('sequence shared prompt → /api/pipelines with same prompt for each step', () => {
    const out = buildPayload(mkState({
      mode: 'sequence', agents: new Set(['kiro', 'claude']), prompt: 'go',
    }));
    expect(out.endpoint).toBe('/api/pipelines');
    expect(out.body.mode).toBe('sequence');
    expect(out.body.steps).toEqual([
      { agent: 'kiro', prompt: 'go' },
      { agent: 'claude', prompt: 'go' },
    ]);
  });

  it('sequence per-step prompts → each step uses stepPrompts[agent]', () => {
    const out = buildPayload(mkState({
      mode: 'sequence',
      agents: new Set(['kiro', 'claude']),
      prompt: '(default)',
      perStepPrompts: true,
      stepPrompts: { kiro: 'analyze', claude: 'implement' },
    }));
    expect(out.body.steps).toEqual([
      { agent: 'kiro', prompt: 'analyze' },
      { agent: 'claude', prompt: 'implement' },
    ]);
  });

  it('sequence per-step missing fallback to main prompt', () => {
    const out = buildPayload(mkState({
      mode: 'sequence',
      agents: new Set(['kiro', 'claude']),
      prompt: 'fallback',
      perStepPrompts: true,
      stepPrompts: { kiro: 'analyze' }, // claude 没设
    }));
    expect(out.body.steps[1]).toEqual({ agent: 'claude', prompt: 'fallback' });
  });

  it('parallel shared prompt → fan-out same prompt', () => {
    const out = buildPayload(mkState({
      mode: 'parallel', agents: new Set(['a', 'b', 'c']), prompt: 'P',
    }));
    expect(out.body).toEqual({
      mode: 'parallel',
      steps: [
        { agent: 'a', prompt: 'P' },
        { agent: 'b', prompt: 'P' },
        { agent: 'c', prompt: 'P' },
      ],
    });
  });

  it('race mode → /api/pipelines mode=race', () => {
    const out = buildPayload(mkState({
      mode: 'race', agents: new Set(['x', 'y']), prompt: 'fast',
    }));
    expect(out.body.mode).toBe('race');
    expect(out.body.steps.length).toBe(2);
  });

  it('conversation default max_turns=6, uses participants + topic', () => {
    const out = buildPayload(mkState({
      mode: 'conversation', agents: new Set(['k', 'c']), prompt: 'design game',
    }));
    expect(out.endpoint).toBe('/api/pipelines');
    expect(out.body).toEqual({
      mode: 'conversation',
      participants: ['k', 'c'],
      topic: 'design game',
      config: { max_turns: 6 },
    });
  });

  it('conversation custom max_turns', () => {
    const out = buildPayload(mkState({
      mode: 'conversation', agents: new Set(['k', 'c']), prompt: 't', maxTurns: 10,
    }));
    expect(out.body.config.max_turns).toBe(10);
  });

  it('throws on invalid state — mode missing', () => {
    expect(() => buildPayload(mkState({ mode: 'bogus' }))).toThrow(/invalid mode/);
  });

  it('throws on empty prompt', () => {
    expect(() => buildPayload(mkState({ prompt: '   ' }))).toThrow(/prompt is empty/);
  });

  it('throws when single mode has 0 agents', () => {
    expect(() => buildPayload(mkState({ agents: new Set() }))).toThrow(/exactly 1/);
  });

  it('throws when pipeline mode has <2 agents', () => {
    expect(() => buildPayload(mkState({ mode: 'parallel', agents: new Set(['kiro']) })))
      .toThrow(/≥2 agents/);
  });
});

describe('CommandComposer.validateState (pure)', () => {
  it('returns empty for valid single state', () => {
    expect(validateState(mkState())).toEqual([]);
  });

  it('returns errors for empty prompt + bad mode', () => {
    const errs = validateState(mkState({ mode: 'x', prompt: '' }));
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });

  it('flags maxTurns out of range', () => {
    const errs = validateState(mkState({
      mode: 'conversation', agents: new Set(['a','b']), prompt: 't', maxTurns: 99,
    }));
    expect(errs.some(e => /maxTurns/.test(e))).toBe(true);
  });
});

describe('CommandComposer (DOM)', () => {
  let container;
  let onSubmit;
  let composer;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    onSubmit = vi.fn().mockResolvedValue();
    composer = new CommandComposer(container, { onSubmit });
  });

  it('renders mode select with all 5 options', () => {
    const opts = [...container.querySelectorAll('.cc-mode option')].map(o => o.value);
    expect(opts).toEqual(['single', 'sequence', 'parallel', 'race', 'conversation']);
  });

  it('renders sync select, disabled when mode != single', () => {
    expect(container.querySelector('.cc-sync').disabled).toBe(false);
    container.querySelector('.cc-mode').value = 'parallel';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    expect(container.querySelector('.cc-sync').disabled).toBe(true);
  });

  it('shows max-turns input only for conversation mode', () => {
    expect(container.querySelector('.cc-max-turns')).toBeNull();
    container.querySelector('.cc-mode').value = 'conversation';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    expect(container.querySelector('.cc-max-turns')).not.toBeNull();
  });

  it('shows per-step toggle only for sequence/parallel/race', () => {
    expect(container.querySelector('.cc-perstep')).toBeNull(); // single: no
    container.querySelector('.cc-mode').value = 'sequence';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    expect(container.querySelector('.cc-perstep')).not.toBeNull();
    expect(container.querySelector('.cc-perstep').checked).toBe(true); // sequence default on
    container.querySelector('.cc-mode').value = 'parallel';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    expect(container.querySelector('.cc-perstep').checked).toBe(false); // parallel default off
    container.querySelector('.cc-mode').value = 'conversation';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    expect(container.querySelector('.cc-perstep')).toBeNull(); // conversation: no
  });

  it('setAvailableAgents renders chips, single mode auto-selects first', () => {
    composer.setAvailableAgents([
      { name: 'kiro', state: 'idle' },
      { name: 'claude', state: 'busy' },
    ]);
    const chips = container.querySelectorAll('.cc-agent');
    expect(chips.length).toBe(2);
    expect(chips[0].classList.contains('active')).toBe(true);
    expect(chips[1].classList.contains('active')).toBe(false);
  });

  it('mode change to pipeline auto-selects all agents', () => {
    composer.setAvailableAgents([
      { name: 'kiro', state: 'idle' },
      { name: 'claude', state: 'busy' },
      { name: 'qwen', state: 'idle' },
    ]);
    container.querySelector('.cc-mode').value = 'parallel';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    const active = [...container.querySelectorAll('.cc-agent.active')];
    expect(active.length).toBe(3);
  });

  it('Submit disabled when prompt empty', () => {
    composer.setAvailableAgents([{ name: 'kiro', state: 'idle' }]);
    expect(container.querySelector('.cc-submit').disabled).toBe(true);
  });

  it('Submit enabled when state valid; clicking calls onSubmit with payload', async () => {
    composer.setAvailableAgents([{ name: 'kiro', state: 'idle' }]);
    const ta = container.querySelector('.cc-prompt');
    ta.value = 'do it';
    ta.dispatchEvent(new Event('input'));
    expect(container.querySelector('.cc-submit').disabled).toBe(false);
    container.querySelector('.cc-submit').click();
    // 等微任务
    await new Promise(r => setTimeout(r, 0));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      endpoint: '/api/jobs',
      body: { agent_name: 'kiro', prompt: 'do it' },
    });
  });

  it('Submit clears prompt + restores button after success', async () => {
    composer.setAvailableAgents([{ name: 'kiro', state: 'idle' }]);
    const ta = container.querySelector('.cc-prompt');
    ta.value = 'work';
    ta.dispatchEvent(new Event('input'));
    container.querySelector('.cc-submit').click();
    await new Promise(r => setTimeout(r, 0));
    expect(ta.value).toBe('');
    expect(container.querySelector('.cc-submit').textContent).toBe('Submit ▶');
  });

  it('Submit failure shows error in status', async () => {
    onSubmit.mockRejectedValueOnce(new Error('boom'));
    composer.setAvailableAgents([{ name: 'kiro', state: 'idle' }]);
    const ta = container.querySelector('.cc-prompt');
    ta.value = 'x';
    ta.dispatchEvent(new Event('input'));
    container.querySelector('.cc-submit').click();
    await new Promise(r => setTimeout(r, 10));
    expect(container.querySelector('.cc-status').textContent).toMatch(/boom/);
  });

  it('Reset clears prompt without changing mode/agents', () => {
    composer.setAvailableAgents([{ name: 'kiro', state: 'idle' }]);
    const ta = container.querySelector('.cc-prompt');
    ta.value = 'hello';
    ta.dispatchEvent(new Event('input'));
    container.querySelector('.cc-reset').click();
    expect(container.querySelector('.cc-prompt').value).toBe('');
    expect(composer.getState().mode).toBe('single');
  });

  it('per-step prompt inputs render in sequence mode', () => {
    composer.setAvailableAgents([
      { name: 'kiro', state: 'idle' },
      { name: 'claude', state: 'idle' },
    ]);
    container.querySelector('.cc-mode').value = 'sequence';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    const stepInputs = container.querySelectorAll('.cc-step-prompt');
    expect(stepInputs.length).toBe(2);
    expect(stepInputs[0].dataset.agent).toBe('kiro');
  });

  it('toggling per-step off hides step prompts', () => {
    composer.setAvailableAgents([
      { name: 'kiro', state: 'idle' },
      { name: 'claude', state: 'idle' },
    ]);
    container.querySelector('.cc-mode').value = 'sequence';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    expect(container.querySelectorAll('.cc-step-prompt').length).toBe(2);
    const cb = container.querySelector('.cc-perstep');
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
    expect(container.querySelectorAll('.cc-step-prompt').length).toBe(0);
  });
});
