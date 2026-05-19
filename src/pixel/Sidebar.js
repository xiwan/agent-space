/**
 * Sidebar — Pixel viewer 右侧 (移动端底部) 双 tab 面板 (v2.10.0)
 *
 * 顶部 tab: [Agents] / [History]
 *   - Agents tab: 卡片列表 (沿用 v2.5.0 行为)
 *   - History tab: 由外部 (CommandHistory) 接管 contents
 *
 * 选中态由外部传入 (setSelected) — agent 卡片 → canvas / sidebar 双向 toggle.
 *
 * v2.10.0 变化:
 *   - 顶部加 tab bar
 *   - 不直接管 history 内容 — Sidebar 提供 history 容器, CommandHistory 自己 render 进去
 *   - tab 切换持久化到 localStorage (`pixel.sidebarTab`)
 */

const STATE_LABELS = {
  busy: 'busy',
  idle: 'idle',
  offline: 'offline',
  error: 'error',
};

const TAB_LS_KEY = 'pixel.sidebarTab';

export class Sidebar {
  /**
   * @param {HTMLElement} container — 整个 sidebar 容器, innerHTML 会被覆写
   * @param {object} opts
   * @param {(name: string) => void} opts.onToggle — 卡片点击回调
   * @param {(tab:'agents'|'history') => void} [opts.onTabChange]
   */
  constructor(container, opts = {}) {
    if (!container) throw new Error('Sidebar: container required');
    this.container = container;
    this.onToggle = opts.onToggle || (() => {});
    this.onTabChange = opts.onTabChange || (() => {});
    this.agents = [];
    this.selectedName = null;

    let initialTab = 'agents';
    try {
      const stored = (typeof localStorage !== 'undefined') ? localStorage.getItem(TAB_LS_KEY) : null;
      if (stored === 'agents' || stored === 'history') initialTab = stored;
    } catch {}
    this._tab = initialTab;

    this._renderShell();
  }

  setAgents(agents) {
    this.agents = Array.isArray(agents) ? agents : [];
    this._renderAgents();
  }

  setSelected(name) {
    if (this.selectedName === name) return;
    this.selectedName = name;
    this._renderAgents();
  }

  /**
   * 当前 tab.
   */
  getTab() { return this._tab; }

  /**
   * 由外部 (CommandHistory) 拿到 history container 自己 render.
   */
  getHistoryContainer() {
    return this.container.querySelector('.sidebar-history');
  }

  _setTab(tab) {
    if (tab !== 'agents' && tab !== 'history') return;
    if (this._tab === tab) return;
    this._tab = tab;
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(TAB_LS_KEY, tab);
    } catch {}
    this._applyTabVisibility();
    this.onTabChange(tab);
  }

  _renderShell() {
    this.container.innerHTML = `
      <div class="sidebar-tabs">
        <button class="sidebar-tab" data-tab="agents">Agents</button>
        <button class="sidebar-tab" data-tab="history">History</button>
      </div>
      <div class="sidebar-agents"></div>
      <div class="sidebar-history"></div>
    `;
    this.container.querySelectorAll('.sidebar-tab').forEach(btn => {
      btn.addEventListener('click', () => this._setTab(btn.dataset.tab));
    });
    this._applyTabVisibility();
    this._renderAgents();
  }

  _applyTabVisibility() {
    const tabs = this.container.querySelectorAll('.sidebar-tab');
    tabs.forEach(t => {
      if (t.dataset.tab === this._tab) t.classList.add('active');
      else t.classList.remove('active');
    });
    const a = this.container.querySelector('.sidebar-agents');
    const h = this.container.querySelector('.sidebar-history');
    if (a) a.style.display = this._tab === 'agents' ? '' : 'none';
    if (h) h.style.display = this._tab === 'history' ? '' : 'none';
  }

  _renderAgents() {
    const wrap = this.container.querySelector('.sidebar-agents');
    if (!wrap) return;
    wrap.innerHTML = '';
    for (const agent of this.agents) {
      wrap.appendChild(this._buildCard(agent));
    }
  }

  _buildCard(agent) {
    const card = document.createElement('div');
    const classes = ['pixel-card'];
    if (agent.state === 'offline') classes.push('offline');
    if (agent.name === this.selectedName) classes.push('selected');
    card.className = classes.join(' ');
    card.dataset.name = agent.name;

    const stateLabel = STATE_LABELS[agent.state] || agent.state || 'unknown';
    const desc = agent.description ? agent.description : '(no description)';
    const domains = (agent.domains && agent.domains.length)
      ? agent.domains.join(', ')
      : '—';

    card.innerHTML = `
      <div class="pixel-card-header">
        <span class="pixel-card-name"></span>
        <span class="pixel-state pixel-state-${agent.state}">${escape(stateLabel)}</span>
      </div>
      <div class="pixel-card-desc"></div>
      <div class="pixel-card-domains"></div>
    `;
    card.querySelector('.pixel-card-name').textContent = agent.name;
    card.querySelector('.pixel-card-desc').textContent = desc;
    card.querySelector('.pixel-card-domains').textContent = domains;
    card.addEventListener('click', () => this.onToggle(agent.name));
    return card;
  }
}

function escape(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}
