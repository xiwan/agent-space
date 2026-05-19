/**
 * MapEditor — 编辑模式状态机 + canvas 鼠标交互 + 工具栏 DOM
 *
 * 不负责: A* 寻路 (PathFinder), 状态映射 (BridgeAdapter), 渲染 overlay (PixelRenderer).
 *
 * 用法:
 *   const editor = new MapEditor(canvas, toolbarEl, {
 *     onSave: () => {},   // 用户点 save
 *     onChange: () => {}, // 任意 mutate 后 (用于 renderer 立即重绘 + 持久化)
 *     onExit: () => {},
 *   });
 *   editor.open(mapConfig, agentNames);  // 进入编辑模式
 *   editor.close();                      // 退出
 */

import { setObstacle, setZoneCell, findZoneAt, ZONE_KEYS, GRID_SIZE } from './MapConfig.js';

const TOOLS = ['blocked', 'home', 'work', 'idle']; // clear 通过右键, 不在 toolbar 显示

export class MapEditor {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} toolbar 工具栏容器, innerHTML 会被替换
   * @param {object} opts
   */
  constructor(canvas, toolbar, opts = {}) {
    if (!canvas) throw new Error('MapEditor: canvas required');
    if (!toolbar) throw new Error('MapEditor: toolbar required');
    this.canvas = canvas;
    this.toolbar = toolbar;
    this.onSave = opts.onSave || (() => {});
    this.onChange = opts.onChange || (() => {});
    this.onExit = opts.onExit || (() => {});

    this.mapConfig = null;
    this.agentNames = [];
    this._open = false;
    this._tool = 'blocked';
    this._agent = null;
    this._mouseDown = false;
    this._mouseButton = 0;

    // 绑定 (后面 add/remove)
    this._onMouseDown = (e) => this._handleMouseDown(e);
    this._onMouseUp = () => { this._mouseDown = false; };
    this._onMouseMove = (e) => this._handleMouseMove(e);
    this._onContextMenu = (e) => { if (this._open) e.preventDefault(); };
  }

  open(mapConfig, agentNames) {
    if (this._open) return;
    this.mapConfig = mapConfig;
    this.agentNames = Array.isArray(agentNames) ? agentNames.slice() : [];
    this._agent = this.agentNames[0] || null;
    this._tool = 'blocked';
    this._open = true;
    this._renderToolbar();
    this.toolbar.style.display = 'block';

    this.canvas.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    this.canvas.addEventListener('mousemove', this._onMouseMove);
    this.canvas.addEventListener('contextmenu', this._onContextMenu);
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.toolbar.style.display = 'none';

    this.canvas.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    this.canvas.removeEventListener('mousemove', this._onMouseMove);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);

    this.onExit();
  }

  isOpen() { return this._open; }
  getTool() { return this._tool; }
  getAgent() { return this._agent; }

  // === 工具栏渲染 ===

  _renderToolbar() {
    const tb = this.toolbar;
    tb.innerHTML = `
      <div class="me-title">EDIT MODE</div>
      <div class="me-row">
        <span class="me-label">Tool:</span>
        <div class="me-tools">
          ${TOOLS.map(t => `<button class="me-tool-btn${t === this._tool ? ' active' : ''}" data-tool="${t}">${t}</button>`).join('')}
        </div>
      </div>
      <div class="me-row">
        <span class="me-label">Agent:</span>
        <select class="me-agent">
          ${this.agentNames.map(n => `<option value="${escapeHtml(n)}"${n === this._agent ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('')}
        </select>
      </div>
      <div class="me-actions">
        <button class="me-btn me-save">💾 Save</button>
        <button class="me-btn me-reset">🗑 Reset</button>
        <button class="me-btn me-exit">✕ Exit</button>
      </div>
      <div class="me-hint">left = paint, right = erase</div>
    `;
    tb.querySelectorAll('.me-tool-btn').forEach(b =>
      b.addEventListener('click', () => { this._tool = b.dataset.tool; this._renderToolbar(); })
    );
    tb.querySelector('.me-agent').addEventListener('change', (e) => { this._agent = e.target.value; });
    tb.querySelector('.me-save').addEventListener('click', () => this.onSave());
    tb.querySelector('.me-reset').addEventListener('click', () => this._handleReset());
    tb.querySelector('.me-exit').addEventListener('click', () => this.close());
  }

  _handleReset() {
    if (!this.mapConfig) return;
    if (typeof confirm === 'function' && !confirm('Clear all obstacles and zones for this map?')) return;
    for (let r = 0; r < this.mapConfig.rows; r++) {
      for (let c = 0; c < this.mapConfig.cols; c++) {
        this.mapConfig.obstacles[r][c] = 0;
      }
    }
    this.mapConfig.zones = { home: {}, work: {}, idle: {} };
    this.onChange();
  }

  // === 鼠标处理 ===

  _handleMouseDown(e) {
    this._mouseDown = true;
    this._mouseButton = e.button;
    this._paintAt(e);
  }

  _handleMouseMove(e) {
    if (!this._mouseDown) return;
    this._paintAt(e);
  }

  _paintAt(e) {
    if (!this.mapConfig) return;
    const rect = this.canvas.getBoundingClientRect();
    const sx = this.canvas.width / rect.width;
    const sy = this.canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * sx;
    const my = (e.clientY - rect.top) * sy;
    const gs = this.mapConfig.gridSize || GRID_SIZE;
    const col = Math.floor(mx / gs);
    const row = Math.floor(my / gs);
    if (col < 0 || col >= this.mapConfig.cols || row < 0 || row >= this.mapConfig.rows) return;

    const erase = this._mouseButton === 2; // 右键擦除

    if (this._tool === 'blocked') {
      setObstacle(this.mapConfig, col, row, !erase);
    } else if (ZONE_KEYS.includes(this._tool)) {
      if (!this._agent) return;
      // 涂当前 agent + 当前 zone
      // 如果右键: 移除该 agent 在该 zone 的此 cell
      // 左键: 加进该 agent 在该 zone (但若该 cell 已属其他 agent 同 zone, 会同时存在 — 这是设计允许的多 agent 共享 cell)
      setZoneCell(this.mapConfig, this._tool, this._agent, col, row, !erase);
    }
    this.onChange();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
