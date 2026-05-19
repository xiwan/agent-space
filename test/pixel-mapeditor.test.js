// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MapEditor } from '../src/pixel/MapEditor.js';
import { emptyMapConfig, setObstacle, setZoneCell } from '../src/pixel/MapConfig.js';

function mountCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 800;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 800 });
  document.body.appendChild(canvas);
  return canvas;
}

function mouseEvent(type, button, clientX, clientY) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'button', { value: button });
  Object.defineProperty(e, 'clientX', { value: clientX });
  Object.defineProperty(e, 'clientY', { value: clientY });
  return e;
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
});
