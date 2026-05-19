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
    this.onUploadLocal = opts.onUploadLocal || null; // v2.9.0

    this.mapConfig = null;
    this._open = false;
    this._tool = 'blocked';
    this._mouseDown = false;
    this._mouseButton = 0;
    this._activePointerId = null;
    this._prevTouchAction = null; // v2.8.0: 编辑模式临时锁定 canvas 触摸手势

    this._onPointerDown = (e) => this._handlePointerDown(e);
    this._onPointerUp = (e) => this._handlePointerUp(e);
    this._onPointerMove = (e) => this._handlePointerMove(e);
    this._onPointerCancel = (e) => this._handlePointerUp(e);
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

    // v2.8.0: 锁定 canvas 触摸手势, 防止双指缩放/滚动干扰编辑
    if (this.canvas.style) {
      this._prevTouchAction = this.canvas.style.touchAction || '';
      this.canvas.style.touchAction = 'none';
    }

    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointermove', this._onPointerMove);
    this.canvas.addEventListener('pointerup', this._onPointerUp);
    this.canvas.addEventListener('pointercancel', this._onPointerCancel);
    this.canvas.addEventListener('contextmenu', this._onContextMenu);
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.toolbar.style.display = 'none';

    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('pointercancel', this._onPointerCancel);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);

    // v2.8.0: 恢复 canvas 触摸手势
    if (this.canvas.style && this._prevTouchAction !== null) {
      this.canvas.style.touchAction = this._prevTouchAction;
      this._prevTouchAction = null;
    }

    // 释放可能仍持有的 pointer capture
    if (this._activePointerId !== null && typeof this.canvas.releasePointerCapture === 'function') {
      try { this.canvas.releasePointerCapture(this._activePointerId); } catch {}
    }
    this._activePointerId = null;
    this._mouseDown = false;

    this.onExit();
  }

  isOpen() { return this._open; }
  getTool() { return this._tool; }

  /**
   * v2.9.0: 在 editor 已打开时切换 mapConfig 引用 (用于 upload local 后让 in-memory 同步).
   */
  setMapConfig(mapConfig) {
    this.mapConfig = mapConfig;
  }

  _renderToolbar() {
    const tb = this.toolbar;
    const uploadBtn = this.onUploadLocal
      ? `<button class="me-btn me-upload" title="Push localStorage map for this background to server">📤 Upload local</button>`
      : '';
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
      ${uploadBtn ? `<div class="me-actions">${uploadBtn}</div>` : ''}
      <div class="me-hint">left = paint, right = erase</div>
    `;
    tb.querySelectorAll('.me-tool-btn').forEach(b =>
      b.addEventListener('click', () => { this._tool = b.dataset.tool; this._renderToolbar(); })
    );
    tb.querySelector('.me-save').addEventListener('click', () => this.onSave());
    tb.querySelector('.me-reset').addEventListener('click', () => this._handleReset());
    tb.querySelector('.me-exit').addEventListener('click', () => this.close());
    const uploadEl = tb.querySelector('.me-upload');
    if (uploadEl && this.onUploadLocal) {
      uploadEl.addEventListener('click', () => this.onUploadLocal());
    }
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

  _handlePointerDown(e) {
    // 触摸: 永远 paint (button=0). 鼠标: 右键(button=2) → 擦除.
    this._mouseDown = true;
    this._mouseButton = e.button | 0;
    this._activePointerId = e.pointerId;
    // 拖动时即便手指 / 鼠标移出 canvas 也继续接收事件
    if (typeof this.canvas.setPointerCapture === 'function') {
      try { this.canvas.setPointerCapture(e.pointerId); } catch {}
    }
    this._paintAt(e);
  }

  _handlePointerMove(e) {
    if (!this._mouseDown) return;
    if (this._activePointerId !== null && e.pointerId !== this._activePointerId) return;
    this._paintAt(e);
  }

  _handlePointerUp(e) {
    if (this._activePointerId !== null && e && e.pointerId !== undefined && e.pointerId !== this._activePointerId) return;
    this._mouseDown = false;
    if (this._activePointerId !== null && typeof this.canvas.releasePointerCapture === 'function') {
      try { this.canvas.releasePointerCapture(this._activePointerId); } catch {}
    }
    this._activePointerId = null;
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
