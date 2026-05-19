/**
 * CommandComposer — 命令工具条 (v2.10.0)
 *
 * 表单驱动构造 ACP Bridge 调用. 字段:
 *   - mode: 'single' | 'sequence' | 'parallel' | 'race' | 'conversation'
 *   - sync: 'sync' | 'async'   (仅 mode=single 有效, 其余锁 async)
 *   - agents: Set<string>      (single: =1; 其余: ≥2)
 *   - prompt: string           (mode=conversation 时语义为 topic)
 *   - perStepPrompts: bool     (sequence/parallel/race; default sequence:on, others:off)
 *   - stepPrompts: { [agent]: string }   (perStepPrompts=true 时每个 step 自己的 prompt)
 *   - maxTurns: number         (mode=conversation, default 6, range 2-12)
 *
 * 设计取舍:
 *   - 完全本地状态机, 不存 localStorage (页面刷新就重置 — 命令是临时输入, 不该持久)
 *   - DOM 重渲染策略: 每次 mode 切换 / agents 列表外部更新都全量重渲染.
 *     prompt textarea 单独保留 (避免输入时光标丢)
 *   - buildPayload 是纯函数, 可单独测; render 涉及 DOM, 用 happy-dom 测
 */

const MODES = ['single', 'sequence', 'parallel', 'race', 'conversation'];
const PIPELINE_MODES = new Set(['sequence', 'parallel', 'race', 'conversation']);

// 默认 perStepPrompts: sequence on, parallel/race off, conversation N/A
function defaultPerStepPrompts(mode) {
  return mode === 'sequence';
}

/**
 * 纯函数: 把 state 变成 { endpoint, body }, 或抛出校验错误.
 * 单测可直接 import.
 */
export function buildPayload(state) {
  const errs = validateState(state);
  if (errs.length) throw new Error(errs.join('; '));

  const { mode, sync, prompt, maxTurns } = state;
  const agentList = [...state.agents];

  if (mode === 'single') {
    if (sync === 'sync') {
      return {
        endpoint: '/api/runs',
        body: {
          agent_name: agentList[0],
          input: [{ parts: [{ content: prompt, content_type: 'text/plain' }] }],
        },
      };
    }
    return {
      endpoint: '/api/jobs',
      body: { agent_name: agentList[0], prompt },
    };
  }

  if (mode === 'conversation') {
    return {
      endpoint: '/api/pipelines',
      body: {
        mode: 'conversation',
        participants: agentList,
        topic: prompt,
        config: { max_turns: maxTurns ?? 6 },
      },
    };
  }

  // sequence / parallel / race
  const usePerStep = !!state.perStepPrompts;
  const steps = agentList.map((agent) => ({
    agent,
    prompt: usePerStep ? (state.stepPrompts?.[agent] ?? prompt) : prompt,
  }));
  return {
    endpoint: '/api/pipelines',
    body: { mode, steps },
  };
}

/**
 * 校验 state, 返回错误数组 (空 = 通过). 单测可独立验.
 */
export function validateState(state) {
  const errs = [];
  if (!state) { return ['state required']; }
  if (!MODES.includes(state.mode)) errs.push(`invalid mode: ${state.mode}`);
  if (state.mode === 'single' && !['sync', 'async'].includes(state.sync)) {
    errs.push(`invalid sync: ${state.sync}`);
  }
  const n = state.agents?.size ?? 0;
  if (state.mode === 'single' && n !== 1) errs.push(`single mode requires exactly 1 agent (got ${n})`);
  if (PIPELINE_MODES.has(state.mode) && n < 2) errs.push(`${state.mode} requires ≥2 agents (got ${n})`);
  if (!state.prompt || !state.prompt.trim()) errs.push('prompt is empty');
  if (state.mode === 'conversation') {
    const t = state.maxTurns ?? 6;
    if (!(t >= 2 && t <= 12)) errs.push('maxTurns must be 2-12');
  }
  return errs;
}

export class CommandComposer {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {(payload:{endpoint,body}) => Promise<void>} opts.onSubmit
   */
  constructor(container, opts = {}) {
    if (!container) throw new Error('CommandComposer: container required');
    this.container = container;
    this.onSubmit = opts.onSubmit || (async () => {});
    this._availableAgents = []; // [{name, state}]
    this._submitting = false;

    this._state = {
      mode: 'single',
      sync: 'async',
      agents: new Set(),
      prompt: '',
      perStepPrompts: defaultPerStepPrompts('single'),
      stepPrompts: {},
      maxTurns: 6,
    };

    this._render();
  }

  /**
   * 由外部 (pixel-main) 在 BridgePoller 收到 cfg 时调用, 把当前 enabled agent 列表注入.
   * 复选框状态会被保留 (intersect): 列表里还在的 agent 保持选中.
   */
  setAvailableAgents(agents) {
    this._availableAgents = agents.map(a => ({ name: a.name, state: a.state }));
    // 清理已不存在的 agent
    const valid = new Set(this._availableAgents.map(a => a.name));
    for (const n of [...this._state.agents]) {
      if (!valid.has(n)) this._state.agents.delete(n);
    }
    // single mode: 没选 → 默认选第一个
    if (this._state.mode === 'single' && this._state.agents.size === 0 && this._availableAgents.length > 0) {
      this._state.agents.add(this._availableAgents[0].name);
    }
    this._renderAgentList();
  }

  getState() { return this._state; }

  _setMode(mode) {
    if (this._state.mode === mode) return;
    this._state.mode = mode;
    // mode 切换默认: single → 单选第一个; pipeline → 全选 enabled
    this._state.agents.clear();
    if (mode === 'single') {
      if (this._availableAgents[0]) this._state.agents.add(this._availableAgents[0].name);
    } else {
      for (const a of this._availableAgents) this._state.agents.add(a.name);
    }
    // sync: 非 single 锁 async
    if (mode !== 'single') this._state.sync = 'async';
    // perStepPrompts: 重置为该 mode 的默认
    this._state.perStepPrompts = defaultPerStepPrompts(mode);
    this._render();
  }

  _toggleAgent(name) {
    if (this._state.mode === 'single') {
      this._state.agents.clear();
      this._state.agents.add(name);
    } else {
      if (this._state.agents.has(name)) this._state.agents.delete(name);
      else this._state.agents.add(name);
    }
    this._renderAgentList();
    this._renderSubmitState();
    this._renderStepPrompts();
  }

  async _handleSubmit() {
    if (this._submitting) return;
    let payload;
    try { payload = buildPayload(this._state); }
    catch (e) {
      this._setStatus(`error: ${e.message}`, 'error');
      return;
    }
    this._submitting = true;
    this._renderSubmitState();
    try {
      await this.onSubmit(payload);
      // 成功后清空 prompt, 保持 mode/agents
      this._state.prompt = '';
      this._state.stepPrompts = {};
      const ta = this.container.querySelector('.cc-prompt');
      if (ta) ta.value = '';
      this._setStatus('submitted', 'ok');
    } catch (e) {
      this._setStatus(`submit failed: ${e.message}`, 'error');
    } finally {
      this._submitting = false;
      this._renderSubmitState();
    }
  }

  _setStatus(text, kind = 'info') {
    const el = this.container.querySelector('.cc-status');
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
  }

  // ===== render =====

  _render() {
    const s = this._state;
    const isPipeline = PIPELINE_MODES.has(s.mode);
    const isConversation = s.mode === 'conversation';
    const showPerStep = isPipeline && !isConversation;
    const promptLabel = isConversation ? 'Topic' : 'Prompt';

    this.container.innerHTML = `
      <div class="cc-row cc-row-controls">
        <label class="cc-field">
          <span class="cc-label">Mode</span>
          <select class="cc-mode">
            ${MODES.map(m => `<option value="${m}"${m === s.mode ? ' selected' : ''}>${m}</option>`).join('')}
          </select>
        </label>
        <label class="cc-field">
          <span class="cc-label">Sync</span>
          <select class="cc-sync"${s.mode !== 'single' ? ' disabled' : ''}>
            <option value="sync"${s.sync === 'sync' ? ' selected' : ''}>sync (/runs)</option>
            <option value="async"${s.sync === 'async' ? ' selected' : ''}>async (/jobs)</option>
          </select>
        </label>
        ${isConversation ? `
        <label class="cc-field">
          <span class="cc-label">Max turns</span>
          <input class="cc-max-turns" type="number" min="2" max="12" value="${s.maxTurns}" />
        </label>` : ''}
        ${showPerStep ? `
        <label class="cc-field cc-field-toggle">
          <input type="checkbox" class="cc-perstep"${s.perStepPrompts ? ' checked' : ''} />
          <span class="cc-label">per-step prompts</span>
        </label>` : ''}
      </div>

      <div class="cc-row cc-row-agents">
        <span class="cc-label">Agents</span>
        <div class="cc-agents"></div>
      </div>

      <div class="cc-row cc-row-prompt">
        <textarea class="cc-prompt" rows="2" placeholder="${promptLabel} — what should agent(s) do?">${s.prompt}</textarea>
        <div class="cc-step-prompts"></div>
      </div>

      <div class="cc-row cc-row-actions">
        <span class="cc-status" data-kind="info"></span>
        <span class="cc-spacer"></span>
        <button class="cc-reset" type="button">Reset</button>
        <button class="cc-submit" type="button">Submit ▶</button>
      </div>
    `;

    // wire up
    this.container.querySelector('.cc-mode').addEventListener('change', (e) => this._setMode(e.target.value));
    const syncEl = this.container.querySelector('.cc-sync');
    syncEl.addEventListener('change', (e) => { this._state.sync = e.target.value; });
    const mtEl = this.container.querySelector('.cc-max-turns');
    if (mtEl) mtEl.addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10);
      this._state.maxTurns = isNaN(v) ? 6 : v;
    });
    const psEl = this.container.querySelector('.cc-perstep');
    if (psEl) psEl.addEventListener('change', (e) => {
      this._state.perStepPrompts = e.target.checked;
      this._renderStepPrompts();
    });
    const promptEl = this.container.querySelector('.cc-prompt');
    promptEl.addEventListener('input', (e) => {
      this._state.prompt = e.target.value;
      this._renderSubmitState();
    });
    this.container.querySelector('.cc-submit').addEventListener('click', () => this._handleSubmit());
    this.container.querySelector('.cc-reset').addEventListener('click', () => {
      this._state.prompt = '';
      this._state.stepPrompts = {};
      this._render();
    });

    this._renderAgentList();
    this._renderStepPrompts();
    this._renderSubmitState();
  }

  _renderAgentList() {
    const wrap = this.container.querySelector('.cc-agents');
    if (!wrap) return;
    if (this._availableAgents.length === 0) {
      wrap.innerHTML = '<span class="cc-empty">no agents available</span>';
      return;
    }
    const isSingle = this._state.mode === 'single';
    wrap.innerHTML = this._availableAgents.map(a => {
      const checked = this._state.agents.has(a.name) ? ' checked' : '';
      const cls = `cc-agent cc-agent-${a.state || 'unknown'}${checked ? ' active' : ''}`;
      return `<label class="${cls}">
        <input type="${isSingle ? 'radio' : 'checkbox'}" name="cc-agent" value="${a.name}"${checked} />
        <span>${escapeHtml(a.name)}</span>
      </label>`;
    }).join('');
    wrap.querySelectorAll('input').forEach(input => {
      input.addEventListener('change', () => this._toggleAgent(input.value));
    });
  }

  _renderStepPrompts() {
    const wrap = this.container.querySelector('.cc-step-prompts');
    if (!wrap) return;
    const s = this._state;
    const showPerStep = PIPELINE_MODES.has(s.mode) && s.mode !== 'conversation' && s.perStepPrompts;
    if (!showPerStep) {
      wrap.innerHTML = '';
      return;
    }
    const agents = [...s.agents];
    if (agents.length === 0) {
      wrap.innerHTML = '';
      return;
    }
    wrap.innerHTML = agents.map(name => `
      <div class="cc-step">
        <span class="cc-step-name">${escapeHtml(name)}</span>
        <input class="cc-step-prompt" data-agent="${escapeAttr(name)}" type="text"
               value="${escapeAttr(s.stepPrompts[name] ?? '')}"
               placeholder="prompt for ${escapeHtml(name)}" />
      </div>
    `).join('');
    wrap.querySelectorAll('.cc-step-prompt').forEach(inp => {
      inp.addEventListener('input', (e) => {
        const agent = e.target.dataset.agent;
        s.stepPrompts[agent] = e.target.value;
      });
    });
  }

  _renderSubmitState() {
    const btn = this.container.querySelector('.cc-submit');
    if (!btn) return;
    const errs = validateState(this._state);
    btn.disabled = this._submitting || errs.length > 0;
    btn.textContent = this._submitting ? 'submitting…' : 'Submit ▶';
    btn.title = errs.length ? errs.join('; ') : 'Submit command';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
