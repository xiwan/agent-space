/**
 * MapEditor — 编辑模式状态机 + canvas 鼠标交互 + 工具栏 DOM (v2.5.0: 全局 zones)
 *
 * v2.5.0 变化:
 *   - 删除 agent dropdown 和 _agent 字段
 *   - zones 直接在 mapConfig 全局, 不再按 agent 区分
 *   - eraser 清 obstacle + 清 zones 在该 cell 的占用
 *
 * 用法:
 *   const editor = new MapEditor(canvas, toolbarEl, {
 *     onSave: () => {},   // 用户点 save
 *     onChange: () => {}, // 任意 mutate 后
 *     onExit: () => {},
 *   });
 *   editor.open(mapConfig);
 *   editor.close();
 */

import { setObstacle, setZoneCell, ZONE_KEYS, GRID_SIZE } from './MapConfig.js';

const TOOLS = ['blocked', 'home', 'work', 'idle', 'eraser'];

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
    this._open = false;
    this._tool = 'blocked';
    this._mouseDown = false;
    this._mouseButton = 0;

    this._onMouseDown = (e) => this._handleMouseDown(e);
    this._onMouseUp = () => { this._mouseDown = false; };
    this._onMouseMove = (e) => this._handleMouseMove(e);
    this._onContextMenu = (e) => { if (this._open) e.preventDefault(); };
  }

  /**
   * @param {object} mapConfig
   */
  open(mapConfig) {
    if (this._open) return;
    this.mapConfig = mapConfig;
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
    this.mapConfig.zones = { home: [], work: [], idle: [] };
    this.onChange();
  }

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

    const erase = this._mouseButton === 2;

    if (this._tool === 'eraser') {
      // v2.5.0: eraser 清 obstacle + 清所有 3 zones 在该 cell 的占用 (global)
      setObstacle(this.mapConfig, col, row, false);
      for (const z of ZONE_KEYS) {
        setZoneCell(this.mapConfig, z, col, row, false);
      }
    } else if (this._tool === 'blocked') {
      setObstacle(this.mapConfig, col, row, !erase);
    } else if (ZONE_KEYS.includes(this._tool)) {
      // v2.5.0: 直接 toggle global zone, 不再需要 agent
      setZoneCell(this.mapConfig, this._tool, col, row, !erase);
    }
    this.onChange();
  }
}
