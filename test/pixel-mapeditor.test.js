// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MapEditor } from '../src/pixel/MapEditor.js';
import { emptyMapConfig, setObstacle, setZoneCell } from '../src/pixel/MapConfig.js';

function mountCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 800;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 800 });
  // happy-dom 不一定带 set/release PointerCapture, polyfill 成 noop
  if (typeof canvas.setPointerCapture !== 'function') canvas.setPointerCapture = () => {};
  if (typeof canvas.releasePointerCapture !== 'function') canvas.releasePointerCapture = () => {};
  document.body.appendChild(canvas);
  return canvas;
}

// v2.8.0: 模拟 pointerdown/move/up/cancel — 默认 pointerType=mouse, 触摸用 'touch'
function pointerEvent(type, button, clientX, clientY, opts = {}) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'button', { value: button });
  Object.defineProperty(e, 'clientX', { value: clientX });
  Object.defineProperty(e, 'clientY', { value: clientY });
  Object.defineProperty(e, 'pointerId', { value: opts.pointerId ?? 1 });
  Object.defineProperty(e, 'pointerType', { value: opts.pointerType ?? 'mouse' });
  return e;
}

// 旧测试用 mouseEvent 名字 + 'mousedown' type — alias 到 pointerEvent + 'pointerdown'
function mouseEvent(type, button, clientX, clientY) {
  const realType = type === 'mousedown' ? 'pointerdown'
                 : type === 'mousemove' ? 'pointermove'
                 : type === 'mouseup'   ? 'pointerup'
                 : type;
  return pointerEvent(realType, button, clientX, clientY);
}

describe('MapEditor (v2.5.0 global zones)', () => {
  let canvas, toolbar, editor, cfg, onChange;

  beforeEach(() => {
    document.body.innerHTML = '';
    canvas = mountCanvas();
    toolbar = document.createElement('div');
    document.body.appendChild(toolbar);
    onChange = vi.fn();
    editor = new MapEditor(canvas, toolbar, { onChange });
    cfg = emptyMapConfig();
  });

  it('throws if canvas missing', () => {
    expect(() => new MapEditor(null, toolbar)).toThrow(/canvas/);
  });

  it('throws if toolbar missing', () => {
    expect(() => new MapEditor(canvas, null)).toThrow(/toolbar/);
  });

  it('open() renders toolbar with 5 tools', () => {
    editor.open(cfg);
    const buttons = toolbar.querySelectorAll('.me-tool-btn');
    expect([...buttons].map(b => b.dataset.tool)).toEqual(['blocked', 'home', 'work', 'idle', 'eraser']);
  });

  it('NO agent dropdown rendered (v2.5.0)', () => {
    editor.open(cfg);
    expect(toolbar.querySelector('.me-agent')).toBeNull();
  });

  it('default tool is blocked', () => {
    editor.open(cfg);
    expect(editor.getTool()).toBe('blocked');
  });

  it('blocked + left click paints obstacle', () => {
    editor.open(cfg);
    canvas.dispatchEvent(mouseEvent('mousedown', 0, 24, 24)); // (1, 1)
    expect(cfg.obstacles[1][1]).toBe(1);
    expect(onChange).toHaveBeenCalled();
  });

  it('blocked + right click erases obstacle', () => {
    cfg.obstacles[1][1] = 1;
    editor.open(cfg);
    canvas.dispatchEvent(mouseEvent('mousedown', 2, 24, 24));
    expect(cfg.obstacles[1][1]).toBe(0);
  });

  it('zone tool paints to global zone (no agent needed)', () => {
    editor.open(cfg);
    toolbar.querySelector('[data-tool="work"]').click();
    canvas.dispatchEvent(mouseEvent('mousedown', 0, 80, 80)); // (5, 5)
    expect(cfg.zones.work).toEqual([[5, 5]]);
  });

  it('zone right-click erases from global zone', () => {
    setZoneCell(cfg, 'work', 5, 5, true);
    editor.open(cfg);
    toolbar.querySelector('[data-tool="work"]').click();
    canvas.dispatchEvent(mouseEvent('mousedown', 2, 80, 80));
    expect(cfg.zones.work).toEqual([]);
  });

  it('eraser clears obstacle', () => {
    cfg.obstacles[3][3] = 1;
    editor.open(cfg);
    toolbar.querySelector('[data-tool="eraser"]').click();
    canvas.dispatchEvent(mouseEvent('mousedown', 0, 56, 56));
    expect(cfg.obstacles[3][3]).toBe(0);
  });

  it('eraser clears all 3 zones at the cell', () => {
    setZoneCell(cfg, 'home', 4, 4, true);
    setZoneCell(cfg, 'work', 4, 4, true);
    setZoneCell(cfg, 'idle', 4, 4, true);
    editor.open(cfg);
    toolbar.querySelector('[data-tool="eraser"]').click();
    canvas.dispatchEvent(mouseEvent('mousedown', 0, 72, 72)); // (4, 4)
    expect(cfg.zones.home).toEqual([]);
    expect(cfg.zones.work).toEqual([]);
    expect(cfg.zones.idle).toEqual([]);
  });

  it('eraser does NOT touch other cells', () => {
    setZoneCell(cfg, 'work', 5, 5, true);
    setZoneCell(cfg, 'work', 6, 6, true);
    editor.open(cfg);
    toolbar.querySelector('[data-tool="eraser"]').click();
    canvas.dispatchEvent(mouseEvent('mousedown', 0, 88, 88)); // (5, 5)
    expect(cfg.zones.work).toEqual([[6, 6]]);
  });

  it('close() removes mouse listeners', () => {
    editor.open(cfg);
    editor.close();
    canvas.dispatchEvent(mouseEvent('mousedown', 0, 24, 24));
    expect(cfg.obstacles[1][1]).toBe(0);
  });

  it('reset wipes obstacles + zones (with confirm=true)', () => {
    cfg.obstacles[1][1] = 1;
    setZoneCell(cfg, 'work', 2, 2, true);
    const origConfirm = window.confirm;
    window.confirm = () => true;
    editor.open(cfg);
    toolbar.querySelector('.me-reset').click();
    window.confirm = origConfirm;
    expect(cfg.obstacles.flat().reduce((a, b) => a + b, 0)).toBe(0);
    expect(cfg.zones).toEqual({ home: [], work: [], idle: [] });
  });

  it('reset cancel preserves data', () => {
    cfg.obstacles[1][1] = 1;
    const origConfirm = window.confirm;
    window.confirm = () => false;
    editor.open(cfg);
    toolbar.querySelector('.me-reset').click();
    window.confirm = origConfirm;
    expect(cfg.obstacles[1][1]).toBe(1);
  });

  it('opens and reads current tool', () => {
    editor.open(cfg);
    toolbar.querySelector('[data-tool="idle"]').click();
    expect(editor.getTool()).toBe('idle');
  });

  // === v2.8.0: 触摸事件 + canvas touch-action 锁定 ===

  it('v2.8.0: pointerdown (touch) paints obstacle (button=0, pointerType=touch)', () => {
    editor.open(cfg);
    canvas.dispatchEvent(pointerEvent('pointerdown', 0, 24, 24, { pointerType: 'touch' }));
    expect(cfg.obstacles[1][1]).toBe(1);
  });

  it('v2.8.0: pointermove (touch) drags paint across cells', () => {
    editor.open(cfg);
    canvas.dispatchEvent(pointerEvent('pointerdown', 0, 24, 24, { pointerType: 'touch' }));
    canvas.dispatchEvent(pointerEvent('pointermove', 0, 40, 40, { pointerType: 'touch' }));
    canvas.dispatchEvent(pointerEvent('pointermove', 0, 56, 56, { pointerType: 'touch' }));
    expect(cfg.obstacles[1][1]).toBe(1);
    expect(cfg.obstacles[2][2]).toBe(1);
    expect(cfg.obstacles[3][3]).toBe(1);
  });

  it('v2.8.0: pointermove without prior pointerdown is ignored', () => {
    editor.open(cfg);
    canvas.dispatchEvent(pointerEvent('pointermove', 0, 24, 24, { pointerType: 'touch' }));
    expect(cfg.obstacles[1][1]).toBe(0);
  });

  it('v2.8.0: pointerup releases drag — subsequent move is no-op', () => {
    editor.open(cfg);
    canvas.dispatchEvent(pointerEvent('pointerdown', 0, 24, 24, { pointerType: 'touch' }));
    canvas.dispatchEvent(pointerEvent('pointerup', 0, 24, 24, { pointerType: 'touch' }));
    canvas.dispatchEvent(pointerEvent('pointermove', 0, 40, 40, { pointerType: 'touch' }));
    expect(cfg.obstacles[1][1]).toBe(1); // 第一笔
    expect(cfg.obstacles[2][2]).toBe(0); // 没继续画
  });

  it('v2.8.0: pointercancel releases drag (e.g. browser interrupt)', () => {
    editor.open(cfg);
    canvas.dispatchEvent(pointerEvent('pointerdown', 0, 24, 24, { pointerType: 'touch' }));
    canvas.dispatchEvent(pointerEvent('pointercancel', 0, 24, 24, { pointerType: 'touch' }));
    canvas.dispatchEvent(pointerEvent('pointermove', 0, 40, 40, { pointerType: 'touch' }));
    expect(cfg.obstacles[2][2]).toBe(0);
  });

  it('v2.8.0: touch (button=0) is always paint, never erase', () => {
    cfg.obstacles[1][1] = 1;
    editor.open(cfg);
    // touch 模拟下: button=0, 不应触发 erase
    canvas.dispatchEvent(pointerEvent('pointerdown', 0, 24, 24, { pointerType: 'touch' }));
    expect(cfg.obstacles[1][1]).toBe(1); // 仍是 1, 因为 paint 时 setObstacle 把它再设为 1
  });

  it('v2.8.0: open() locks canvas touch-action to "none"', () => {
    canvas.style.touchAction = 'auto';
    editor.open(cfg);
    expect(canvas.style.touchAction).toBe('none');
  });

  it('v2.8.0: close() restores prior touch-action', () => {
    canvas.style.touchAction = 'manipulation';
    editor.open(cfg);
    expect(canvas.style.touchAction).toBe('none');
    editor.close();
    expect(canvas.style.touchAction).toBe('manipulation');
  });

  it('v2.8.0: close() restores empty touch-action when none was set', () => {
    // 默认 (未设置), open 应记录为空, close 还原为空
    expect(canvas.style.touchAction).toBe('');
    editor.open(cfg);
    expect(canvas.style.touchAction).toBe('none');
    editor.close();
    expect(canvas.style.touchAction).toBe('');
  });

  it('v2.8.0: stale pointerId moves are ignored (multi-touch defense)', () => {
    editor.open(cfg);
    canvas.dispatchEvent(pointerEvent('pointerdown', 0, 24, 24, { pointerType: 'touch', pointerId: 1 }));
    // 第二根手指 (pointerId 2) 的 move 应被忽略
    canvas.dispatchEvent(pointerEvent('pointermove', 0, 56, 56, { pointerType: 'touch', pointerId: 2 }));
    expect(cfg.obstacles[1][1]).toBe(1);
    expect(cfg.obstacles[3][3]).toBe(0);
  });
});
