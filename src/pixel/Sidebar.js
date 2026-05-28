/**
 * Sidebar — Pixel viewer 右侧 (移动端底部) 多 tab 面板.
 *
 * 顶部 tab: [Agents] / [History] / [Usage] / [Heartbeat] (v2.15.0)
 *   - Agents tab: 卡片列表 (沿用 v2.5.0 行为)
 *   - History tab: 由外部 (CommandHistory) 接管 contents
 *   - Usage tab: 由外部 (UsageView) 接管 contents (v2.12.0)
 *   - Heartbeat tab: 由外部 (HeartbeatView) 接管 contents (v2.15.0)
 *
 * 选中态由外部传入 (setSelected) — agent 卡片 → canvas / sidebar 双向 toggle.
 *
 * v2.10.0 变化:
 *   - 顶部加 tab bar
 *   - 不直接管 history 内容 — Sidebar 提供 history 容器, CommandHistory 自己 render 进去
 *   - tab 切换持久化到 localStorage (`pixel.sidebarTab`)
 *
 * v2.15.0 变化:
 *   - 加第 4 tab Heartbeat
 *   - localStorage 接受 'heartbeat' 字面量
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
    // v2.13.0: clear history 回调 (Sidebar 不持有 history 状态, 仅触发外部清除)
    this.onClearHistory = opts.onClearHistory || null;
    this.agents = [];
    this.selectedName = null;

    let initialTab = 'agents';
    try {
      const stored = (typeof localStorage !== 'undefined') ? localStorage.getItem(TAB_LS_KEY) : null;
      if (stored === 'agents' || stored === 'history' || stored === 'usage' || stored === 'heartbeat') initialTab = stored;
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

  /**
   * v2.12.0: 由外部 (UsageView) 拿到 usage container 自己 render.
   */
  getUsageContainer() {
    return this.container.querySelector('.sidebar-usage');
  }

  /**
   * v2.15.0: 由外部 (HeartbeatView) 拿到 heartbeat container 自己 render.
   */
  getHeartbeatContainer() {
    return this.container.querySelector('.sidebar-heartbeat');
  }

  _setTab(tab) {
    if (tab !== 'agents' && tab !== 'history' && tab !== 'usage' && tab !== 'heartbeat') return;
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
        <button class="sidebar-tab" data-tab="usage">Usage</button>
        <button class="sidebar-tab" data-tab="heartbeat">Heartbeat</button>
      </div>
      <div class="sidebar-agents"></div>
      <div class="sidebar-history-wrap">
        <div class="sidebar-history-toolbar">
          <span class="sidebar-history-count" data-history-count>0 records</span>
          <button class="sidebar-history-clear" type="button" title="Clear history">🗑 Clear</button>
        </div>
        <div class="sidebar-history"></div>
      </div>
      <div class="sidebar-usage"></div>
      <div class="sidebar-heartbeat"></div>
    `;
    this.container.querySelectorAll('.sidebar-tab').forEach(btn => {
      btn.addEventListener('click', () => this._setTab(btn.dataset.tab));
    });
    // v2.13.0: clear 按钮
    const clearBtn = this.container.querySelector('.sidebar-history-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => this._handleClearHistory());
    this._applyTabVisibility();
    this._renderAgents();
  }

  /**
   * v2.13.0: clear button click. confirm 后调外部 onClearHistory 回调.
   */
  _handleClearHistory() {
    const ok = (typeof window !== 'undefined' && typeof window.confirm === 'function')
      ? window.confirm('Clear all command history? This cannot be undone.')
      : true;
    if (!ok) return;
    if (this.onClearHistory) this.onClearHistory();
  }

  /**
   * v2.13.0: 由外部 (CommandHistory) 在 record 数量变化时调, 更新 UI 计数.
   */
  setHistoryCount(n) {
    const el = this.container.querySelector('[data-history-count]');
    if (el) el.textContent = `${n} record${n === 1 ? '' : 's'}`;
  }

  _applyTabVisibility() {
    const tabs = this.container.querySelectorAll('.sidebar-tab');
    tabs.forEach(t => {
      if (t.dataset.tab === this._tab) t.classList.add('active');
      else t.classList.remove('active');
    });
    const a = this.container.querySelector('.sidebar-agents');
    const h = this.container.querySelector('.sidebar-history-wrap');
    const u = this.container.querySelector('.sidebar-usage');
    const b = this.container.querySelector('.sidebar-heartbeat');
    if (a) a.style.display = this._tab === 'agents' ? '' : 'none';
    if (h) h.style.display = this._tab === 'history' ? '' : 'none';
    if (u) u.style.display = this._tab === 'usage' ? '' : 'none';
    if (b) b.style.display = this._tab === 'heartbeat' ? '' : 'none';
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
