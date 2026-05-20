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

// v2.11.0: state 颜色 (与 PixelRenderer.STATE_COLORS 对齐)
const STATE_DOT_COLORS = {
  busy: '#eab308',
  idle: '#10b981',
  offline: '#9ca3af',
  error: '#ef4444',
  unknown: '#64748b',
};

/**
 * v2.11.0: textarea 自适应高度. 调用方在 input 事件里调.
 * 重置高度到 auto 让 scrollHeight 反映真实内容, 然后限制到 maxPx.
 */
function autoResizeTextarea(el, maxPx = 200) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, maxPx) + 'px';
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
 *
 * v2.13.2: prompt 必填规则放宽:
 *   - single / conversation → 必填
 *   - pipeline (sequence/parallel/race) + perStepPrompts=false → 必填
 *   - pipeline + perStepPrompts=true: 每个 selected agent 的 stepPrompts 都非空 → 大框可空
 *     (任一 step 空 → 大框必填作 fallback)
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

  // v2.13.2: prompt 必填判定
  const promptIsEmpty = !state.prompt || !state.prompt.trim();
  const isPipelineMultiStep = state.mode === 'sequence' || state.mode === 'parallel' || state.mode === 'race';
  const usePerStep = isPipelineMultiStep && !!state.perStepPrompts;
  if (usePerStep) {
    // 每个 selected agent 的 stepPrompts 必须都非空, 否则大框作 fallback
    const allStepsFilled = [...state.agents].every(a => {
      const v = state.stepPrompts?.[a];
      return typeof v === 'string' && v.trim().length > 0;
    });
    if (promptIsEmpty && !allStepsFilled) {
      errs.push('prompt is empty (some step prompts missing — fill all steps or provide a shared prompt)');
    }
  } else {
    // single / conversation / pipeline-without-perstep → prompt 必填
    if (promptIsEmpty) errs.push('prompt is empty');
  }

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
    const prevMode = this._state.mode;
    this._state.mode = mode;
    // v2.11.0 (A4): mode 切换不再粗暴清空 agents.
    //   - 先过滤至当前 availableAgents
    //   - single 且 size>1 → 仅留第一个 (优先保留之前已选的, 否则用 availableAgents[0])
    //   - pipeline (sequence/parallel/race/conversation) 且 size<2 → 从 availableAgents 头部补齐到 ≥2
    const valid = new Set(this._availableAgents.map(a => a.name));
    for (const n of [...this._state.agents]) {
      if (!valid.has(n)) this._state.agents.delete(n);
    }
    if (mode === 'single') {
      if (this._state.agents.size > 1) {
        const keep = [...this._state.agents][0];
        this._state.agents.clear();
        this._state.agents.add(keep);
      } else if (this._state.agents.size === 0 && this._availableAgents[0]) {
        this._state.agents.add(this._availableAgents[0].name);
      }
    } else {
      // pipeline 模式需要 ≥2
      if (this._state.agents.size < 2) {
        for (const a of this._availableAgents) {
          if (this._state.agents.size >= 2) break;
          this._state.agents.add(a.name);
        }
      }
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

  /**
   * v2.13.2: 根据 mode + perStepPrompts + step 状态算 textarea placeholder.
   */
  _computePromptPlaceholder() {
    const s = this._state;
    const tail = '  (Cmd/Ctrl+Enter to submit, Esc to clear)';
    if (s.mode === 'conversation') return 'Topic — what to discuss?' + tail;
    if (s.mode === 'single') return 'Prompt — what should the agent do?' + tail;
    // sequence / parallel / race
    if (!s.perStepPrompts) return 'Prompt — sent to all agents' + tail;
    // per-step ON: 看是否所有 step 都填了
    const allFilled = [...s.agents].every(a => {
      const v = s.stepPrompts?.[a];
      return typeof v === 'string' && v.trim().length > 0;
    });
    if (allFilled && s.agents.size > 0) return 'Optional shared prompt' + tail;
    return 'Shared prompt — fallback for empty steps' + tail;
  }

  /**
   * v2.13.2: per-step ON + 是 pipeline 多步模式 → 大框降为次要角色.
   */
  _isPromptSecondary() {
    const s = this._state;
    return (s.mode === 'sequence' || s.mode === 'parallel' || s.mode === 'race') && !!s.perStepPrompts;
  }

  _render() {
    const s = this._state;
    const isPipeline = PIPELINE_MODES.has(s.mode);
    const isConversation = s.mode === 'conversation';
    const showPerStep = isPipeline && !isConversation;
    const promptPlaceholder = this._computePromptPlaceholder();
    const promptSecondary = this._isPromptSecondary();
    const promptClass = 'cc-prompt' + (promptSecondary ? ' cc-prompt-secondary' : '');

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
        <textarea class="${promptClass}" rows="3" placeholder="${escapeAttr(promptPlaceholder)}">${escapeHtml(s.prompt)}</textarea>
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
      // v2.13.2: 切换 per-step → 重算 placeholder + secondary class + Submit 启用态
      this._renderSubmitState();
    });
    const promptEl = this.container.querySelector('.cc-prompt');
    promptEl.addEventListener('input', (e) => {
      this._state.prompt = e.target.value;
      autoResizeTextarea(e.target, 200);
      // A3: 用户继续输入 → 清掉残留的 error 状态
      const statusEl = this.container.querySelector('.cc-status');
      if (statusEl && statusEl.dataset.kind === 'error') {
        statusEl.textContent = '';
        statusEl.dataset.kind = 'info';
      }
      this._renderSubmitState();
    });
    // A1/A2: 键盘快捷键
    promptEl.addEventListener('keydown', (e) => {
      // Cmd/Ctrl+Enter → Submit (前提 validate 通过)
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (validateState(this._state).length === 0 && !this._submitting) {
          this._handleSubmit();
        }
        return;
      }
      // Esc → 仅清 prompt (不动 mode/agents)
      if (e.key === 'Escape') {
        e.preventDefault();
        this._state.prompt = '';
        e.target.value = '';
        autoResizeTextarea(e.target, 200);
        this._renderSubmitState();
      }
    });
    // 初始挂载后立刻自适应一次 (回填 prompt 时 textarea 内容已就位)
    autoResizeTextarea(promptEl, 200);

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
      // C4: 友好空态文案
      wrap.innerHTML = '<span class="cc-empty">waiting for agent list…</span>';
      return;
    }
    const isSingle = this._state.mode === 'single';
    wrap.innerHTML = this._availableAgents.map(a => {
      const checked = this._state.agents.has(a.name) ? ' checked' : '';
      const stateKey = a.state || 'unknown';
      const cls = `cc-agent cc-agent-${stateKey}${checked ? ' active' : ''}`;
      // C1: 左侧 4×4 像素方块 (state color)
      const dotColor = STATE_DOT_COLORS[stateKey] || STATE_DOT_COLORS.unknown;
      return `<label class="${cls}" title="${escapeAttr(a.name)} (${stateKey})">
        <span class="cc-agent-dot" style="background:${dotColor}"></span>
        <input type="${isSingle ? 'radio' : 'checkbox'}" name="cc-agent" value="${escapeAttr(a.name)}"${checked} />
        <span class="cc-agent-name">${escapeHtml(a.name)}</span>
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
    // B3: per-step input → textarea (1 行起步, 自适应到 max 120px)
    wrap.innerHTML = agents.map(name => `
      <div class="cc-step">
        <span class="cc-step-name">${escapeHtml(name)}</span>
        <textarea class="cc-step-prompt" data-agent="${escapeAttr(name)}" rows="1"
               placeholder="prompt for ${escapeAttr(name)}">${escapeHtml(s.stepPrompts[name] ?? '')}</textarea>
      </div>
    `).join('');
    wrap.querySelectorAll('.cc-step-prompt').forEach(inp => {
      // 初始自适应
      autoResizeTextarea(inp, 120);
      inp.addEventListener('input', (e) => {
        const agent = e.target.dataset.agent;
        s.stepPrompts[agent] = e.target.value;
        autoResizeTextarea(e.target, 120);
        // v2.13.2: step 填写状态变化 → 重算大框 placeholder + Submit 启用态
        this._renderSubmitState();
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
    // v2.13.2: 顺手刷 prompt placeholder (随 step 填写状态变化)
    this._refreshPromptPlaceholder();
  }

  /**
   * v2.13.2: 动态刷新 prompt textarea 的 placeholder + secondary class.
   * 不重建 textarea, 保留 cursor / scroll / IME 状态.
   */
  _refreshPromptPlaceholder() {
    const ta = this.container.querySelector('.cc-prompt');
    if (!ta) return;
    ta.placeholder = this._computePromptPlaceholder();
    if (this._isPromptSecondary()) ta.classList.add('cc-prompt-secondary');
    else ta.classList.remove('cc-prompt-secondary');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
