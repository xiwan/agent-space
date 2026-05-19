// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MapEditor } from '../src/pixel/MapEditor.js';
import { emptyMapConfig, setObstacle, setZoneCell } from '../src/pixel/MapConfig.js';

/**
 * 模拟 mouse event in canvas, 落到指定 cell.
 * canvas 默认 getBoundingClientRect 在 happy-dom 里返回 0×0; 显式设 width/height 后,
 * sx/sy 会变成 NaN. 我们 monkey-patch getBoundingClientRect 给一个合理矩形,
 * 让 paint 的坐标计算可走通.
 */
function mountCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 800;
  // patch getBoundingClientRect → 1:1 屏幕坐标
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

describe('MapEditor (v2.4.0 + v2.4.1 eraser)', () => {
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

  it('open() renders toolbar with all 5 tools', () => {
    editor.open(cfg, ['kiro', 'codex']);
    const buttons = toolbar.querySelectorAll('.me-tool-btn');
    const labels = [...buttons].map(b => b.dataset.tool);
    expect(labels).toEqual(['blocked', 'home', 'work', 'idle', 'eraser']);
  });

  it('open() shows agent dropdown with names', () => {
    editor.open(cfg, ['kiro', 'codex']);
    const opts = toolbar.querySelectorAll('.me-agent option');
    expect([...opts].map(o => o.value)).toEqual(['kiro', 'codex']);
  });

  it('default tool is "blocked"', () => {
    editor.open(cfg, ['kiro']);
    expect(editor.getTool()).toBe('blocked');
  });

  it('blocked + left click paints obstacle', () => {
    editor.open(cfg, ['kiro']);
    canvas.dispatchEvent(mouseEvent('mousedown', 0, 24, 24)); // (1, 1)
    expect(cfg.obstacles[1][1]).toBe(1);
    expect(onChange).toHaveBeenCalled();
  });

  it('blocked + right click erases obstacle', () => {
    cfg.obstacles[1][1] = 1;
    editor.open(cfg, ['kiro']);
    canvas.dispatchEvent(mouseEvent('mousedown', 2, 24, 24));
    expect(cfg.obstacles[1][1]).toBe(0);
  });

  it('zone tool paints for current agent only', () => {
    editor.open(cfg, ['kiro', 'codex']);
    // 切到 work tool
    toolbar.querySelector('[data-tool="work"]').click();
    expect(editor.getTool()).toBe('work');
    canvas.dispatchEvent(mouseEvent('mousedown', 0, 80, 80)); // (5, 5)
    expect(cfg.zones.work.kiro).toEqual([[5, 5]]);
    expect(cfg.zones.work.codex).toBeUndefined();
  });

  // === v2.4.1: eraser tool ===

  it('eraser tool clears obstacle on click', () => {
    cfg.obstacles[3][3] = 1;
    editor.open(cfg, ['kiro']);
    toolbar.querySelector('[data-tool="eraser"]').click();
    canvas.dispatchEvent(mouseEvent('mousedown', 0, 56, 56)); // (3, 3)
    expect(cfg.obstacles[3][3]).toBe(0);
  });

  it('eraser tool clears current agent across all 3 zones at the cell', () => {
    setZoneCell(cfg, 'home', 'kiro', 4, 4, true);
    setZoneCell(cfg, 'work', 'kiro', 4, 4, true);
    setZoneCell(cfg, 'idle', 'kiro', 4, 4, true);
    setZoneCell(cfg, 'work', 'codex', 4, 4, true); // 不属于 kiro, 应保留

    editor.open(cfg, ['kiro', 'codex']);
    toolbar.querySelector('[data-tool="eraser"]').click();
    // agent 默认是 kiro (列表第一个)
    canvas.dispatchEvent(mouseEvent('mousedown', 0, 72, 72)); // (4, 4)

    expect(cfg.zones.home.kiro).toBeUndefined();
    expect(cfg.zones.work.kiro).toBeUndefined();
    expect(cfg.zones.idle.kiro).toBeUndefined();
    expect(cfg.zones.work.codex).toEqual([[4, 4]]); // 别人没动
  });

  it('eraser tool does NOT touch other cells of the same agent', () => {
    setZoneCell(cfg, 'work', 'kiro', 5, 5, true);
    setZoneCell(cfg, 'work', 'kiro', 6, 6, true);

    editor.open(cfg, ['kiro']);
    toolbar.querySelector('[data-tool="eraser"]').click();
    canvas.dispatchEvent(mouseEvent('mousedown', 0, 88, 88)); // (5, 5)

    expect(cfg.zones.work.kiro).toEqual([[6, 6]]); // 仅 (5,5) 被擦
  });

  it('eraser tool clears obstacle even without agent selected', () => {
    cfg.obstacles[2][2] = 1;
    editor.open(cfg, []); // 无 agent
    toolbar.querySelector('[data-tool="eraser"]').click();
    canvas.dispatchEvent(mouseEvent('mousedown', 0, 40, 40)); // (2, 2)
    expect(cfg.obstacles[2][2]).toBe(0);
  });

  it('close() removes mouse listeners (no further paints)', () => {
    editor.open(cfg, ['kiro']);
    editor.close();
    canvas.dispatchEvent(mouseEvent('mousedown', 0, 24, 24));
    expect(cfg.obstacles[1][1]).toBe(0);
  });

  it('reset wipes all obstacles + zones (with confirm=true)', () => {
    cfg.obstacles[1][1] = 1;
    setZoneCell(cfg, 'work', 'kiro', 2, 2, true);
    // mock confirm
    const origConfirm = window.confirm;
    window.confirm = () => true;
    editor.open(cfg, ['kiro']);
    toolbar.querySelector('.me-reset').click();
    window.confirm = origConfirm;

    expect(cfg.obstacles.flat().reduce((a, b) => a + b, 0)).toBe(0);
    expect(cfg.zones).toEqual({ home: {}, work: {}, idle: {} });
  });
});
