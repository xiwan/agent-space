/**
 * ArtifactComposer — Quick 模式 (v2.14.0)
 *
 * 从 artifacts.json 加载预设, 用户选 artifact + 输入 prompt → 自动构造 API payload.
 * 与 CommandComposer 并列, 通过 tab 切换.
 */

/**
 * 替换模板中的 {{input}} 和 {{uid}} 占位符
 */
export function renderTemplate(template, input, uid) {
  return template.replace(/\{\{input\}\}/g, input).replace(/\{\{uid\}\}/g, uid);
}

/**
 * 从 artifact 定义 + 用户输入构造 API payload
 * @returns {{ endpoint: string, body: object }}
 */
export function buildArtifactPayload(artifact, input, selectedAgents) {
  if (!artifact || !input?.trim()) throw new Error('artifact and input required');
  const uid = Math.random().toString(16).slice(2, 10);

  if (artifact.mode === 'conversation') {
    const agents = selectedAgents && selectedAgents.length >= 2
      ? selectedAgents
      : artifact.agents;
    return {
      endpoint: '/api/pipelines',
      body: {
        mode: 'conversation',
        participants: agents,
        topic: renderTemplate(artifact.promptTemplate, input, uid),
        config: { max_turns: artifact.maxTurns ?? 6 },
      },
    };
  }

  // sequence / parallel / race
  const steps = (artifact.steps || []).map(s => ({
    agent: s.agent,
    prompt: renderTemplate(s.promptTemplate, input, uid),
  }));
  const body = { mode: artifact.mode, steps };
  if (artifact.context) {
    const ctx = {};
    for (const [k, v] of Object.entries(artifact.context)) {
      ctx[k] = typeof v === 'string' ? renderTemplate(v, input, uid) : v;
    }
    body.context = ctx;
  }
  // Attach step artifact metadata for UI rendering (resolve {{uid}} in pattern)
  const _artifacts = (artifact.steps || []).map(s => {
    if (!s.artifact) return null;
    const a = { ...s.artifact };
    if (a.pattern) a.pattern = renderTemplate(a.pattern, input, uid);
    return a;
  });
  return { endpoint: '/api/pipelines', body, _artifacts };
}

export class ArtifactComposer {
  /**
   * @param {HTMLElement} container — 渲染目标
   * @param {object} opts
   * @param {function} opts.onSubmit — async (payload) => response
   * @param {Array} opts.artifacts — artifact 定义数组
   * @param {Array} opts.availableAgents — 当前在线 agent 列表 [{name, state}]
   */
  constructor(container, { onSubmit, artifacts = [], availableAgents = [] } = {}) {
    this.container = container;
    this.onSubmit = onSubmit;
    this.artifacts = artifacts;
    this.availableAgents = availableAgents;
    this.selectedIdx = 0;
    this.selectedAgents = new Set(); // conversation 模式用
    this._rendered = false;
    this.render();
  }

  setArtifacts(artifacts) {
    this.artifacts = artifacts || [];
    if (this.selectedIdx >= this.artifacts.length) this.selectedIdx = 0;
    this.render();
  }

  setAvailableAgents(agents) {
    this.availableAgents = agents || [];
    // 如果当前 artifact 是 conversation, 重渲 agent chips
    if (this._rendered) this._renderAgentChips();
  }

  getContainer() { return this.container; }

  render() {
    const c = this.container;
    if (!c) return;
    c.innerHTML = '';
    this._rendered = true;

    if (!this.artifacts.length) {
      c.innerHTML = '<div class="ac-empty">Loading artifacts...</div>';
      return;
    }

    // artifact 选择行
    const selectRow = el('div', 'ac-row ac-row-select');
    const select = el('select', 'ac-select');
    this.artifacts.forEach((a, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${a.name} — ${a.description}`;
      select.appendChild(opt);
    });
    select.value = this.selectedIdx;
    select.addEventListener('change', () => {
      this.selectedIdx = parseInt(select.value, 10);
      this._syncUI();
    });
    selectRow.appendChild(select);
    c.appendChild(selectRow);

    // agent chips (conversation 模式)
    this._agentChipsEl = el('div', 'ac-agents');
    c.appendChild(this._agentChipsEl);

    // steps 预览 (sequence/parallel/race 模式)
    this._stepsEl = el('div', 'ac-steps');
    c.appendChild(this._stepsEl);

    // prompt 输入
    const promptRow = el('div', 'ac-row ac-row-prompt');
    this._promptEl = el('textarea', 'ac-prompt');
    this._promptEl.rows = 2;
    this._promptEl.placeholder = '输入你的想法...';
    promptRow.appendChild(this._promptEl);
    c.appendChild(promptRow);

    // 提交行
    const actionRow = el('div', 'ac-row ac-row-actions');
    this._statusEl = el('span', 'ac-status');
    actionRow.appendChild(this._statusEl);
    actionRow.appendChild(el('span', 'cc-spacer'));
    this._submitBtn = el('button', 'cc-submit');
    this._submitBtn.textContent = '⚡ Run';
    this._submitBtn.addEventListener('click', () => this._handleSubmit());
    actionRow.appendChild(this._submitBtn);
    c.appendChild(actionRow);

    this._syncUI();
  }

  _syncUI() {
    const artifact = this.artifacts[this.selectedIdx];
    if (!artifact) return;

    // prompt placeholder
    if (artifact.mode === 'conversation') {
      this._promptEl.placeholder = '讨论话题...';
    } else {
      this._promptEl.placeholder = '描述你想要的...';
    }

    // steps 预览
    this._renderSteps();

    // agent chips visibility
    this._renderAgentChips();
  }

  _renderSteps() {
    const artifact = this.artifacts[this.selectedIdx];
    if (!this._stepsEl) return;
    if (!artifact || artifact.mode === 'conversation' || !artifact.steps?.length) {
      this._stepsEl.style.display = 'none';
      this._stepsEl.innerHTML = '';
      return;
    }
    this._stepsEl.style.display = '';
    this._stepsEl.innerHTML = artifact.steps.map((s, i) => {
      const arrow = i < artifact.steps.length - 1 ? ' →' : '';
      return `<span class="ac-step-chip">${s.agent}${arrow}</span>`;
    }).join(' ');
  }

  _renderAgentChips() {
    const artifact = this.artifacts[this.selectedIdx];
    if (!this._agentChipsEl) return;

    if (!artifact || artifact.mode !== 'conversation') {
      this._agentChipsEl.style.display = 'none';
      this._agentChipsEl.innerHTML = '';
      return;
    }

    this._agentChipsEl.style.display = '';
    this._agentChipsEl.innerHTML = '';

    const label = el('span', 'cc-label');
    label.textContent = 'PARTICIPANTS';
    this._agentChipsEl.appendChild(label);

    const chipsWrap = el('div', 'cc-agents');

    // 初始化 selectedAgents (如果空, 默认选 artifact.agents 里的前几个)
    if (this.selectedAgents.size === 0 && artifact.agents) {
      for (const name of artifact.agents) this.selectedAgents.add(name);
    }

    const candidates = artifact.agents || [];
    for (const name of candidates) {
      const chip = el('div', 'cc-agent');
      const avail = this.availableAgents.find(a => a.name === name);
      const state = avail?.state || 'offline';

      const dot = el('span', 'cc-agent-dot');
      dot.style.background = STATE_DOT_COLORS[state] || STATE_DOT_COLORS.unknown;
      chip.appendChild(dot);

      const nameEl = el('span', 'cc-agent-name');
      nameEl.textContent = name;
      chip.appendChild(nameEl);

      if (this.selectedAgents.has(name)) chip.classList.add('active');
      chip.addEventListener('click', () => {
        if (this.selectedAgents.has(name)) {
          if (this.selectedAgents.size > (artifact.minAgents || 2)) {
            this.selectedAgents.delete(name);
          }
        } else {
          this.selectedAgents.add(name);
        }
        this._renderAgentChips();
      });
      chipsWrap.appendChild(chip);
    }
    this._agentChipsEl.appendChild(chipsWrap);
  }

  async _handleSubmit() {
    const artifact = this.artifacts[this.selectedIdx];
    const input = this._promptEl?.value?.trim();
    if (!input) {
      this._setStatus('请输入内容', 'error');
      return;
    }

    try {
      this._submitBtn.disabled = true;
      this._setStatus('submitting...', 'info');

      const agents = artifact.mode === 'conversation'
        ? [...this.selectedAgents]
        : null;
      const payload = buildArtifactPayload(artifact, input, agents);
      const response = await this.onSubmit(payload);

      this._setStatus('✓ submitted', 'ok');
      this._promptEl.value = '';
      setTimeout(() => this._setStatus('', 'info'), 2000);
    } catch (e) {
      this._setStatus(e.message, 'error');
    } finally {
      this._submitBtn.disabled = false;
    }
  }

  _setStatus(text, kind = 'info') {
    if (!this._statusEl) return;
    this._statusEl.textContent = text;
    this._statusEl.dataset.kind = kind;
  }
}

// --- helpers ---
const STATE_DOT_COLORS = {
  busy: '#eab308',
  idle: '#10b981',
  offline: '#9ca3af',
  error: '#ef4444',
  unknown: '#64748b',
};

function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}
