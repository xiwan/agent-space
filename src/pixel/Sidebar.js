/**
 * Sidebar — Pixel viewer 右侧 agent 卡片列表
 *
 * 职责:
 *   - 接收 cfg.agents 数组 (BridgeAdapter 已字典序排序), 渲染卡片
 *   - 维护 DOM, 响应点击 → 触发 onToggle(name)
 *   - 选中态由外部传入 (setSelected) — 单一 source of truth 在 pixel-main
 *
 * 不负责:
 *   - 选中状态机 (toggle 语义在 pixel-main)
 *   - canvas 渲染 (PixelRenderer 自己有 setSelected)
 */

const STATE_LABELS = {
  busy: 'busy',
  idle: 'idle',
  offline: 'offline',
  error: 'error',
};

export class Sidebar {
  /**
   * @param {HTMLElement} container — 卡片插入到这个元素 (innerHTML 会被覆写)
   * @param {object} opts
   * @param {(name: string) => void} opts.onToggle — 卡片点击回调
   */
  constructor(container, opts = {}) {
    if (!container) throw new Error('Sidebar: container required');
    this.container = container;
    this.onToggle = opts.onToggle || (() => {});
    this.agents = [];
    this.selectedName = null;
  }

  /**
   * 同步 agent 列表 (BridgeAdapter 输出的 cfg.agents)
   * 完全重渲染 — 简单可靠, 卡片数 < 20 时性能无压力
   */
  setAgents(agents) {
    this.agents = Array.isArray(agents) ? agents : [];
    this._render();
  }

  /**
   * 同步选中态 (外部驱动)
   * @param {string | null} name
   */
  setSelected(name) {
    if (this.selectedName === name) return;
    this.selectedName = name;
    this._render();
  }

  _render() {
    this.container.innerHTML = '';
    for (const agent of this.agents) {
      const card = this._buildCard(agent);
      this.container.appendChild(card);
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
    // 用 textContent 注入用户数据避免 XSS (description / domains 来自 ACP bridge agent 配置, 但严防注入)
    card.querySelector('.pixel-card-name').textContent = agent.name;
    card.querySelector('.pixel-card-desc').textContent = desc;
    card.querySelector('.pixel-card-domains').textContent = domains;

    card.addEventListener('click', () => this.onToggle(agent.name));
    return card;
  }
}

// state label 的 textContent 内容是固定枚举, 这里只需对意外字符做最小转义
function escape(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}
