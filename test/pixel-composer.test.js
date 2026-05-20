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

  it('mode change to pipeline preserves existing agents (≥2 minimum)', () => {
    // v2.11.0 (A4): mode 切换不再清空全选, 而是保留交集 + 凑齐到 ≥2
    composer.setAvailableAgents([
      { name: 'kiro', state: 'idle' },
      { name: 'claude', state: 'busy' },
      { name: 'qwen', state: 'idle' },
    ]);
    // 起始 single 模式: 只选 kiro
    expect([...composer.getState().agents]).toEqual(['kiro']);
    container.querySelector('.cc-mode').value = 'parallel';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    const active = [...container.querySelectorAll('.cc-agent.active')];
    // 保留 kiro + 凑齐 1 个到 2 个 (从 availableAgents 头部补)
    expect(active.length).toBe(2);
    // kiro 必在
    const activeNames = active.map(a => a.querySelector('input').value);
    expect(activeNames).toContain('kiro');
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

  // ============================================================
  // v2.11.0: A — keyboard + consistency
  // ============================================================
  it('A1: Cmd+Enter in prompt textarea triggers Submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue();
    const c2 = new CommandComposer(container, { onSubmit });
    c2.setAvailableAgents([{ name: 'kiro', state: 'idle' }]);
    const ta = container.querySelector('.cc-prompt');
    ta.value = 'do it';
    ta.dispatchEvent(new Event('input'));
    // metaKey = Cmd 在 Mac, ctrlKey = Ctrl 在 PC
    const ev = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalled();
  });

  it('A1: Ctrl+Enter also triggers Submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue();
    const c2 = new CommandComposer(container, { onSubmit });
    c2.setAvailableAgents([{ name: 'kiro', state: 'idle' }]);
    const ta = container.querySelector('.cc-prompt');
    ta.value = 'do it';
    ta.dispatchEvent(new Event('input'));
    const ev = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalled();
  });

  it('A1: plain Enter does NOT submit (allows newline)', async () => {
    const onSubmit = vi.fn().mockResolvedValue();
    const c2 = new CommandComposer(container, { onSubmit });
    c2.setAvailableAgents([{ name: 'kiro', state: 'idle' }]);
    const ta = container.querySelector('.cc-prompt');
    ta.value = 'do it';
    ta.dispatchEvent(new Event('input'));
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    await Promise.resolve();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('A1: Cmd+Enter does nothing when validateState fails (empty prompt)', async () => {
    const onSubmit = vi.fn().mockResolvedValue();
    const c2 = new CommandComposer(container, { onSubmit });
    c2.setAvailableAgents([{ name: 'kiro', state: 'idle' }]);
    const ta = container.querySelector('.cc-prompt');
    // 不填 prompt
    const ev = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    await Promise.resolve();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('A2: Esc in prompt clears prompt only (not mode/agents)', () => {
    const c2 = new CommandComposer(container);
    c2.setAvailableAgents([{ name: 'kiro', state: 'idle' }]);
    const ta = container.querySelector('.cc-prompt');
    ta.value = 'about to clear';
    ta.dispatchEvent(new Event('input'));
    expect(c2.getState().prompt).toBe('about to clear');
    expect(c2.getState().agents.size).toBe(1);
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    expect(c2.getState().prompt).toBe('');
    // mode/agents 保留
    expect(c2.getState().mode).toBe('single');
    expect(c2.getState().agents.size).toBe(1);
  });

  it('A3: typing in prompt clears prior error status', () => {
    const c2 = new CommandComposer(container);
    c2.setAvailableAgents([{ name: 'kiro', state: 'idle' }]);
    const status = container.querySelector('.cc-status');
    status.textContent = 'submit failed: oops';
    status.dataset.kind = 'error';
    const ta = container.querySelector('.cc-prompt');
    ta.value = 'x';
    ta.dispatchEvent(new Event('input'));
    expect(status.textContent).toBe('');
    expect(status.dataset.kind).toBe('info');
  });

  it('A4: pipeline → pipeline preserves agent intersection', () => {
    const c2 = new CommandComposer(container);
    c2.setAvailableAgents([
      { name: 'a', state: 'idle' },
      { name: 'b', state: 'idle' },
      { name: 'c', state: 'idle' },
    ]);
    container.querySelector('.cc-mode').value = 'sequence';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    // sequence 凑齐到 ≥2 (从头部补 a, b)
    const seqAgents = [...c2.getState().agents];
    expect(seqAgents.length).toBeGreaterThanOrEqual(2);
    // 切到 parallel: 应保留同样的 agents
    container.querySelector('.cc-mode').value = 'parallel';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    expect([...c2.getState().agents]).toEqual(seqAgents);
  });

  it('A4: single→pipeline keeps the single agent + pads to 2', () => {
    const c2 = new CommandComposer(container);
    c2.setAvailableAgents([
      { name: 'a', state: 'idle' },
      { name: 'b', state: 'idle' },
      { name: 'c', state: 'idle' },
    ]);
    // 切 b
    container.querySelector(`input[value="b"]`).click();
    expect([...c2.getState().agents]).toEqual(['b']);
    container.querySelector('.cc-mode').value = 'parallel';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    const after = [...c2.getState().agents];
    expect(after.length).toBe(2);
    expect(after).toContain('b');
  });

  it('A4: pipeline→single keeps only first selected agent', () => {
    const c2 = new CommandComposer(container);
    c2.setAvailableAgents([
      { name: 'a', state: 'idle' },
      { name: 'b', state: 'idle' },
      { name: 'c', state: 'idle' },
    ]);
    container.querySelector('.cc-mode').value = 'sequence';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    // sequence 默认凑 2 个
    expect(c2.getState().agents.size).toBeGreaterThanOrEqual(2);
    container.querySelector('.cc-mode').value = 'single';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    expect(c2.getState().agents.size).toBe(1);
  });

  // ============================================================
  // v2.11.0: B — prompt area sizing
  // ============================================================
  it('B1: prompt textarea has rows=3 default', () => {
    const c2 = new CommandComposer(container);
    expect(container.querySelector('.cc-prompt').getAttribute('rows')).toBe('3');
  });

  it('B3: per-step prompt is textarea (not input)', () => {
    const c2 = new CommandComposer(container);
    c2.setAvailableAgents([
      { name: 'a', state: 'idle' },
      { name: 'b', state: 'idle' },
    ]);
    container.querySelector('.cc-mode').value = 'sequence';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    const stepEls = container.querySelectorAll('.cc-step-prompt');
    expect(stepEls.length).toBeGreaterThan(0);
    stepEls.forEach(el => {
      expect(el.tagName).toBe('TEXTAREA');
    });
  });

  // ============================================================
  // v2.11.0: C — agent chip visualization
  // ============================================================
  it('C1: agent chip has state dot with state-matching background', () => {
    const c2 = new CommandComposer(container);
    c2.setAvailableAgents([
      { name: 'a', state: 'busy' },
      { name: 'b', state: 'idle' },
      { name: 'c', state: 'offline' },
      { name: 'd', state: 'error' },
    ]);
    const chips = container.querySelectorAll('.cc-agent');
    expect(chips.length).toBe(4);
    // 每个 chip 必含 .cc-agent-dot, style.background 非空
    chips.forEach(chip => {
      const dot = chip.querySelector('.cc-agent-dot');
      expect(dot).not.toBeNull();
      expect(dot.style.background).toBeTruthy();
    });
    // 颜色检查 (CSS color RGB)
    const busyDot = chips[0].querySelector('.cc-agent-dot');
    expect(busyDot.style.background.toLowerCase()).toMatch(/eab308|234, 179, 8/);
  });

  it('C1: chip has class matching agent state', () => {
    const c2 = new CommandComposer(container);
    c2.setAvailableAgents([
      { name: 'a', state: 'busy' },
      { name: 'b', state: 'offline' },
    ]);
    const chips = container.querySelectorAll('.cc-agent');
    expect(chips[0].classList.contains('cc-agent-busy')).toBe(true);
    expect(chips[1].classList.contains('cc-agent-offline')).toBe(true);
  });

  it('C4: empty agent list shows "waiting for agent list…"', () => {
    const c2 = new CommandComposer(container);
    expect(container.querySelector('.cc-empty').textContent).toMatch(/waiting for agent list/);
  });

  // ============================================================
  // v2.13.2: shared prompt becomes optional fallback when per-step ON
  // ============================================================
  it('v2.13.2: validate accepts empty prompt when per-step ON + all step prompts filled', () => {
    const state = {
      mode: 'sequence',
      sync: 'async',
      agents: new Set(['a', 'b']),
      prompt: '',
      perStepPrompts: true,
      stepPrompts: { a: 'do A', b: 'do B' },
      maxTurns: 6,
    };
    const errs = validateState(state);
    expect(errs.find(e => e.includes('prompt'))).toBeUndefined();
  });

  it('v2.13.2: validate rejects empty prompt when per-step ON + at least one step empty', () => {
    const state = {
      mode: 'sequence',
      sync: 'async',
      agents: new Set(['a', 'b']),
      prompt: '',
      perStepPrompts: true,
      stepPrompts: { a: 'do A' /* b missing */ },
      maxTurns: 6,
    };
    const errs = validateState(state);
    expect(errs.some(e => /step prompts missing/.test(e))).toBe(true);
  });

  it('v2.13.2: validate requires prompt for parallel even with per-step OFF', () => {
    const state = {
      mode: 'parallel',
      sync: 'async',
      agents: new Set(['a', 'b']),
      prompt: '',
      perStepPrompts: false,
      stepPrompts: { a: 'x', b: 'y' },  // 即使填了也不算 (per-step OFF)
      maxTurns: 6,
    };
    expect(validateState(state).some(e => e === 'prompt is empty')).toBe(true);
  });

  it('v2.13.2: validate still requires prompt for conversation', () => {
    const state = {
      mode: 'conversation', sync: 'async',
      agents: new Set(['a', 'b']), prompt: '',
      perStepPrompts: false, stepPrompts: {}, maxTurns: 6,
    };
    expect(validateState(state).some(e => e === 'prompt is empty')).toBe(true);
  });

  it('v2.13.2: placeholder reflects mode + per-step state', () => {
    const c2 = new CommandComposer(container);
    c2.setAvailableAgents([
      { name: 'a', state: 'idle' }, { name: 'b', state: 'idle' }, { name: 'c', state: 'idle' },
    ]);
    const ta = container.querySelector('.cc-prompt');

    // single (default)
    expect(ta.placeholder).toMatch(/should the agent do/);

    // sequence: per-step ON by default → "Shared prompt — fallback for empty steps"
    container.querySelector('.cc-mode').value = 'sequence';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    let ta2 = container.querySelector('.cc-prompt');
    expect(ta2.placeholder).toMatch(/Shared prompt.*fallback/);

    // 关闭 per-step → "Prompt — sent to all agents"
    const cb = container.querySelector('.cc-perstep');
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
    ta2 = container.querySelector('.cc-prompt');
    expect(ta2.placeholder).toMatch(/sent to all agents/);

    // parallel + per-step OFF (default for parallel) → 同 "sent to all agents"
    container.querySelector('.cc-mode').value = 'parallel';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    ta2 = container.querySelector('.cc-prompt');
    expect(ta2.placeholder).toMatch(/sent to all agents/);

    // conversation
    container.querySelector('.cc-mode').value = 'conversation';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    ta2 = container.querySelector('.cc-prompt');
    expect(ta2.placeholder).toMatch(/Topic/);
  });

  it('v2.13.2: placeholder switches to "Optional shared prompt" when all step prompts filled', () => {
    const c2 = new CommandComposer(container);
    c2.setAvailableAgents([
      { name: 'a', state: 'idle' }, { name: 'b', state: 'idle' },
    ]);
    container.querySelector('.cc-mode').value = 'sequence';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    // 一开始有空 step
    let ta = container.querySelector('.cc-prompt');
    expect(ta.placeholder).toMatch(/fallback for empty steps/);
    // 填完两个 step
    const stepInputs = container.querySelectorAll('.cc-step-prompt');
    stepInputs[0].value = 'do A';
    stepInputs[0].dispatchEvent(new Event('input'));
    stepInputs[1].value = 'do B';
    stepInputs[1].dispatchEvent(new Event('input'));
    ta = container.querySelector('.cc-prompt');
    expect(ta.placeholder).toMatch(/Optional shared prompt/);
  });

  it('v2.13.2: per-step ON applies cc-prompt-secondary class; OFF removes it', () => {
    const c2 = new CommandComposer(container);
    c2.setAvailableAgents([
      { name: 'a', state: 'idle' }, { name: 'b', state: 'idle' },
    ]);
    container.querySelector('.cc-mode').value = 'sequence';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    let ta = container.querySelector('.cc-prompt');
    expect(ta.classList.contains('cc-prompt-secondary')).toBe(true);

    // 关闭 per-step
    const cb = container.querySelector('.cc-perstep');
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
    ta = container.querySelector('.cc-prompt');
    expect(ta.classList.contains('cc-prompt-secondary')).toBe(false);
  });

  it('v2.13.2: Submit becomes enabled when all per-step prompts filled (no shared prompt)', async () => {
    const onSubmit = vi.fn().mockResolvedValue();
    const c2 = new CommandComposer(container, { onSubmit });
    c2.setAvailableAgents([
      { name: 'a', state: 'idle' }, { name: 'b', state: 'idle' },
    ]);
    container.querySelector('.cc-mode').value = 'sequence';
    container.querySelector('.cc-mode').dispatchEvent(new Event('change'));
    // 大框留空
    expect(container.querySelector('.cc-submit').disabled).toBe(true);
    // 填两个 step
    const stepInputs = container.querySelectorAll('.cc-step-prompt');
    stepInputs[0].value = 'do A';
    stepInputs[0].dispatchEvent(new Event('input'));
    stepInputs[1].value = 'do B';
    stepInputs[1].dispatchEvent(new Event('input'));
    // 现在 Submit 应启用
    expect(container.querySelector('.cc-submit').disabled).toBe(false);
  });

  it('v2.13.2: buildPayload uses step prompt over empty shared prompt', () => {
    const state = {
      mode: 'sequence', sync: 'async',
      agents: new Set(['a', 'b']),
      prompt: '',
      perStepPrompts: true,
      stepPrompts: { a: 'A task', b: 'B task' },
      maxTurns: 6,
    };
    const payload = buildPayload(state);
    expect(payload.body.steps).toEqual([
      { agent: 'a', prompt: 'A task' },
      { agent: 'b', prompt: 'B task' },
    ]);
  });
});
