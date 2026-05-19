// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PixelRenderer } from '../src/pixel/PixelRenderer.js';

// happy-dom doesn't support canvas 2d context; mock it
function makeCanvas() {
  const ctxBase = {
    imageSmoothingEnabled: true,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
  };
  const ctx = new Proxy(ctxBase, {
    get(target, prop) {
      if (prop in target) return target[prop];
      // Auto-stub any method call
      if (prop === 'measureText') { target[prop] = () => ({ width: 40 }); return target[prop]; }
      target[prop] = vi.fn();
      return target[prop];
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  const canvas = {
    width: 960,
    height: 800,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 800 }),
    addEventListener: vi.fn(),
  };
  canvas._ctx = ctx;
  return canvas;
}

describe('PixelRenderer v2.6.0', () => {

  describe('STATE_COLORS', () => {
    let renderer, ctx;
    beforeEach(() => {
      const canvas = makeCanvas();
      ctx = canvas._ctx;
      renderer = new PixelRenderer(canvas);
    });

    it('busy agent name uses yellow (#eab308)', () => {
      renderer.agents = [{ name: 'kiro', cx: 100, cy: 100, state: 'busy', color: 0, facing: 'down', walking: false, sitting: false }];
      const fills = [];
      ctx.fillText = vi.fn((...args) => { fills.push({ style: ctx.fillStyle, text: args[0] }); });
      renderer._drawLabel(renderer.agents[0]);
      const nameFill = fills.find(f => f.text === 'kiro');
      expect(nameFill.style).toBe('#eab308');
    });

    it('idle agent name uses green (#10b981)', () => {
      renderer.agents = [{ name: 'kiro', cx: 100, cy: 100, state: 'idle', color: 0, facing: 'down', walking: false, sitting: false }];
      const fills = [];
      ctx.fillText = vi.fn((...args) => { fills.push({ style: ctx.fillStyle, text: args[0] }); });
      renderer._drawLabel(renderer.agents[0]);
      const nameFill = fills.find(f => f.text === 'kiro');
      expect(nameFill.style).toBe('#10b981');
    });

    it('offline agent name uses gray (#9ca3af)', () => {
      renderer.agents = [{ name: 'kiro', cx: 100, cy: 100, state: 'offline', color: 0, facing: 'down', walking: false, sitting: false }];
      const fills = [];
      ctx.fillText = vi.fn((...args) => { fills.push({ style: ctx.fillStyle, text: args[0] }); });
      renderer._drawLabel(renderer.agents[0]);
      const nameFill = fills.find(f => f.text === 'kiro');
      expect(nameFill.style).toBe('#9ca3af');
    });

    it('error agent name uses red (#ef4444)', () => {
      renderer.agents = [{ name: 'kiro', cx: 100, cy: 100, state: 'error', color: 0, facing: 'down', walking: false, sitting: false }];
      const fills = [];
      ctx.fillText = vi.fn((...args) => { fills.push({ style: ctx.fillStyle, text: args[0] }); });
      renderer._drawLabel(renderer.agents[0]);
      const nameFill = fills.find(f => f.text === 'kiro');
      expect(nameFill.style).toBe('#ef4444');
    });

    it('no state text label is drawn', () => {
      renderer.agents = [{ name: 'kiro', cx: 100, cy: 100, state: 'busy', color: 0, facing: 'down', walking: false, sitting: false }];
      const texts = [];
      ctx.fillText = vi.fn((...args) => { texts.push(args[0]); });
      renderer._drawLabel(renderer.agents[0]);
      expect(texts).toEqual(['kiro']); // only the name, no state
      expect(texts).not.toContain('BUSY');
      expect(texts).not.toContain('idle');
      expect(texts).not.toContain('ERROR');
    });
  });

  describe('no globalAlpha for offline', () => {
    it('_draw does not set globalAlpha to 0.4', () => {
      const canvas = makeCanvas();
      const ctx = canvas._ctx;
      const renderer = new PixelRenderer(canvas);
      renderer._spritesVisible = true;
      renderer._paused = false;
      renderer.sheet.loaded = true;
      renderer.sheet.background = { complete: true, naturalWidth: 960, naturalHeight: 800 };
      renderer.sheet.chars = [{ complete: true, naturalWidth: 112, naturalHeight: 96 }];
      renderer.agents = [{ name: 'off1', cx: 50, cy: 50, tx: 50, ty: 50, state: 'offline', color: 0, facing: 'down', walking: false, sitting: false }];

      const alphaValues = [];
      let _alpha = 1;
      Object.defineProperty(ctx, 'globalAlpha', {
        set(v) { _alpha = v; alphaValues.push(v); },
        get() { return _alpha; },
        configurable: true,
      });

      renderer._draw();
      expect(alphaValues).not.toContain(0.4);
    });
  });

  describe('wander state machine', () => {
    let renderer;
    beforeEach(() => {
      renderer = new PixelRenderer(makeCanvas());
      renderer._paused = false;
      renderer._spritesVisible = true;
      renderer._mapConfig = {
        gridSize: 16, cols: 60, rows: 50,
        obstacles: Array.from({ length: 50 }, () => Array(60).fill(0)),
        zones: { home: [[0, 0]], work: [[5, 5], [6, 6], [7, 7]], idle: [[10, 10], [11, 11], [12, 12]] },
      };
      renderer.setPathFinder({
        findPath: (obs, start, end) => [start, end], // trivial 2-cell path
        getZoneCells: (zoneKey, cfg) => cfg.zones[zoneKey] || [],
      });
    });

    it('idle agent with wanderUntil=0 triggers wander', () => {
      renderer.agents = [{
        name: 'bot', cx: 168, cy: 168, tx: 168, ty: 168,
        state: 'idle', facing: 'down', walking: false, sitting: false,
        path: null, pathIdx: 0, pathGridSize: 16, wanderUntil: 0,
      }];
      renderer._tick();
      const a = renderer.agents[0];
      // Should have picked a path (walking=true)
      expect(a.walking).toBe(true);
      expect(a.path).not.toBeNull();
    });

    it('busy agent with wanderUntil=0 triggers wander in work zone', () => {
      renderer.agents = [{
        name: 'bot', cx: 88, cy: 88, tx: 88, ty: 88,
        state: 'busy', facing: 'down', walking: false, sitting: false,
        path: null, pathIdx: 0, pathGridSize: 16, wanderUntil: 0,
      }];
      renderer._tick();
      const a = renderer.agents[0];
      expect(a.walking).toBe(true);
    });

    it('offline agent does NOT wander', () => {
      renderer.agents = [{
        name: 'bot', cx: 8, cy: 8, tx: 8, ty: 8,
        state: 'offline', facing: 'down', walking: false, sitting: false,
        path: null, pathIdx: 0, pathGridSize: 16, wanderUntil: 0,
      }];
      renderer._tick();
      expect(renderer.agents[0].walking).toBe(false);
      expect(renderer.agents[0].path).toBeNull();
    });

    it('agent with future wanderUntil does NOT wander yet', () => {
      renderer.agents = [{
        name: 'bot', cx: 168, cy: 168, tx: 168, ty: 168,
        state: 'idle', facing: 'down', walking: false, sitting: false,
        path: null, pathIdx: 0, pathGridSize: 16, wanderUntil: performance.now() + 99999,
      }];
      renderer._tick();
      expect(renderer.agents[0].walking).toBe(false);
    });

    it('state change in setConfig resets wanderUntil to 0', () => {
      renderer._paused = false;
      renderer.setConfig({ agents: [{ name: 'bot', x: 88, y: 88, state: 'busy', color: 0 }] });
      const a = renderer.agents[0];
      a.wanderUntil = performance.now() + 99999; // simulate waiting

      // Now state changes to idle
      renderer.setConfig({ agents: [{ name: 'bot', x: 168, y: 168, state: 'idle', color: 0 }] });
      expect(renderer.agents[0].wanderUntil).toBe(0);
      expect(renderer.agents[0].path).toBeNull();
    });

    it('wandering agent is NOT interrupted by poll with same state', () => {
      renderer._paused = false;
      renderer.setConfig({ agents: [{ name: 'bot', x: 88, y: 88, state: 'idle', color: 0 }] });
      const a = renderer.agents[0];
      // Simulate active wander: has path
      a.path = [[5, 5], [6, 6]];
      a.pathIdx = 0;
      a.walking = true;
      a.cx = 88;
      a.cy = 88;

      // Poll arrives with same state but different target cell
      renderer.setConfig({ agents: [{ name: 'bot', x: 200, y: 200, state: 'idle', color: 0 }] });
      // Path should NOT be overwritten
      expect(renderer.agents[0].path).toEqual([[5, 5], [6, 6]]);
      expect(renderer.agents[0].walking).toBe(true);
    });

    it('wander excludes cells occupied by other agents', () => {
      // Restrict idle zone to exactly 2 cells: [10,10] and [11,11]
      renderer._mapConfig = {
        ...renderer._mapConfig,
        zones: { home: [[0, 0]], work: [[5, 5]], idle: [[10, 10], [11, 11]] },
      };
      // A at [10,10], B at [11,11]
      renderer.agents = [
        { name: 'A', cx: 10 * 16 + 8, cy: 10 * 16 + 8, tx: 0, ty: 0, state: 'idle', facing: 'down', walking: false, sitting: false, path: null, pathIdx: 0, pathGridSize: 16, wanderUntil: 0, color: 0 },
        { name: 'B', cx: 11 * 16 + 8, cy: 11 * 16 + 8, tx: 0, ty: 0, state: 'idle', facing: 'down', walking: false, sitting: false, path: null, pathIdx: 0, pathGridSize: 16, wanderUntil: 0, color: 0 },
      ];
      renderer.setPathFinder({
        findPath: (obs, start, end) => [start, end],
        getZoneCells: (zoneKey, cfg) => cfg.zones[zoneKey] || [],
      });

      // A excludes own [10,10] + B's [11,11] → no candidates
      renderer._tryWander(renderer.agents[0]);
      expect(renderer.agents[0].path).toBeNull();
    });

    it('wander treats other agent path-end as occupied', () => {
      // A is wandering with path ending at [11,11]; B should not target [11,11]
      renderer.agents = [
        { name: 'A', cx: 80, cy: 80, tx: 80, ty: 80, state: 'idle', facing: 'down', walking: true, sitting: false,
          path: [[5, 5], [11, 11]], pathIdx: 0, pathGridSize: 16, wanderUntil: 0, color: 0 },
        { name: 'B', cx: 168, cy: 168, tx: 168, ty: 168, state: 'idle', facing: 'down', walking: false, sitting: false,
          path: null, pathIdx: 0, pathGridSize: 16, wanderUntil: 0, color: 0 },
      ];
      // B is at [10,10], idle zone = [[10,10],[11,11],[12,12]]
      // A's target is [11,11] (occupied)
      // B's current is [10,10] (excluded as own cell)
      // → B should pick [12,12]
      let targetEnd = null;
      renderer.setPathFinder({
        findPath: (obs, start, end) => { targetEnd = end; return [start, end]; },
        getZoneCells: (zoneKey, cfg) => cfg.zones[zoneKey] || [],
      });

      renderer._tryWander(renderer.agents[1]);
      expect(targetEnd).toEqual([12, 12]);
    });

    it('arrival sets wanderUntil in the future', () => {
      const now = performance.now();
      renderer.agents = [{
        name: 'bot', cx: 87, cy: 88, tx: 88, ty: 88,
        state: 'idle', facing: 'right', walking: true, sitting: false,
        path: [[5, 5], [5, 5]], pathIdx: 1, pathGridSize: 16, wanderUntil: 0,
      }];
      // Place agent very close to target so it arrives this tick
      renderer.agents[0].cx = 88;
      renderer.agents[0].cy = 88;
      renderer._tick();
      expect(renderer.agents[0].wanderUntil).toBeGreaterThan(now);
      expect(renderer.agents[0].walking).toBe(false);
    });
  });

  describe('makeAgent via setConfig', () => {
    it('new agent has sitting=false regardless of state', () => {
      const renderer = new PixelRenderer(makeCanvas());
      renderer.setConfig({ agents: [{ name: 'x', x: 50, y: 50, state: 'busy', color: 0 }] });
      expect(renderer.agents[0].sitting).toBe(false);
    });

    it('new agent has wanderUntil=0', () => {
      const renderer = new PixelRenderer(makeCanvas());
      renderer.setConfig({ agents: [{ name: 'x', x: 50, y: 50, state: 'idle', color: 0 }] });
      expect(renderer.agents[0].wanderUntil).toBe(0);
    });
  });

  describe('chat bubble (v2.6.0)', () => {
    let renderer, ctx;
    beforeEach(() => {
      const canvas = makeCanvas();
      ctx = canvas._ctx;
      renderer = new PixelRenderer(canvas);
    });

    it('idle agent with description draws bubble', () => {
      const a = { name: 'k', cx: 100, cy: 100, state: 'idle', description: 'hello world', color: 0 };
      const texts = [];
      ctx.fillText = vi.fn((...args) => { texts.push(args[0]); });
      renderer._drawBubble(a);
      expect(texts).toContain('hello world');
    });

    it('busy agent with description draws bubble', () => {
      const a = { name: 'k', cx: 100, cy: 100, state: 'busy', description: 'working hard', color: 0 };
      const texts = [];
      ctx.fillText = vi.fn((...args) => { texts.push(args[0]); });
      renderer._drawBubble(a);
      expect(texts).toContain('working hard');
    });

    it('empty description draws nothing', () => {
      const a = { name: 'k', cx: 100, cy: 100, state: 'idle', description: '', color: 0 };
      const texts = [];
      ctx.fillText = vi.fn((...args) => { texts.push(args[0]); });
      renderer._drawBubble(a);
      expect(texts).toEqual([]);
    });

    it('long description is truncated with ellipsis', () => {
      const a = { name: 'k', cx: 100, cy: 100, state: 'idle',
        description: 'This is a very long description that exceeds the maximum bubble width', color: 0 };
      const texts = [];
      ctx.fillText = vi.fn((...args) => { texts.push(args[0]); });
      renderer._drawBubble(a);
      const drawn = texts[0];
      expect(drawn.length).toBeLessThanOrEqual(24);
      expect(drawn.endsWith('…')).toBe(true);
    });

    it('_draw skips bubble for offline state', () => {
      renderer._spritesVisible = true;
      renderer._paused = false;
      renderer.sheet.loaded = true;
      renderer.sheet.background = { complete: true, naturalWidth: 960, naturalHeight: 800 };
      renderer.sheet.chars = [{ complete: true, naturalWidth: 112, naturalHeight: 96 }];
      renderer.agents = [{ name: 'k', cx: 50, cy: 50, tx: 50, ty: 50, state: 'offline',
        description: 'should not show', color: 0, facing: 'down', walking: false, sitting: false }];

      const texts = [];
      ctx.fillText = vi.fn((...args) => { texts.push(args[0]); });
      renderer._draw();
      expect(texts).not.toContain('should not show');
    });
  });
});
