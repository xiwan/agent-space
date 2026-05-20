// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PixelRenderer, BUSY_EMOJI_THEMES, pickBusyEmojiPool, pickBusyEmojis, computeFrameInfo } from '../src/pixel/PixelRenderer.js';

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

  describe('chat bubble drawing (v2.7.0 reads bubbleText)', () => {
    let renderer, ctx;
    beforeEach(() => {
      const canvas = makeCanvas();
      ctx = canvas._ctx;
      renderer = new PixelRenderer(canvas);
    });

    it('agent with bubbleText draws that text', () => {
      const a = { name: 'k', cx: 100, cy: 100, state: 'idle', bubbleText: 'hello world', color: 0 };
      const texts = [];
      ctx.fillText = vi.fn((...args) => { texts.push(args[0]); });
      renderer._drawBubble(a);
      expect(texts).toContain('hello world');
    });

    it('busy agent with bubbleText draws that text', () => {
      const a = { name: 'k', cx: 100, cy: 100, state: 'busy', bubbleText: 'working hard', color: 0 };
      const texts = [];
      ctx.fillText = vi.fn((...args) => { texts.push(args[0]); });
      renderer._drawBubble(a);
      expect(texts).toContain('working hard');
    });

    it('null/empty bubbleText draws nothing', () => {
      const texts = [];
      ctx.fillText = vi.fn((...args) => { texts.push(args[0]); });
      renderer._drawBubble({ name: 'k', cx: 100, cy: 100, state: 'idle', bubbleText: null, color: 0 });
      renderer._drawBubble({ name: 'k', cx: 100, cy: 100, state: 'idle', bubbleText: '', color: 0 });
      expect(texts).toEqual([]);
    });

    it('long bubbleText is truncated with ellipsis', () => {
      const a = { name: 'k', cx: 100, cy: 100, state: 'idle',
        bubbleText: 'This is a very long bubble that exceeds the maximum width', color: 0 };
      const texts = [];
      ctx.fillText = vi.fn((...args) => { texts.push(args[0]); });
      renderer._drawBubble(a);
      const drawn = texts[0];
      expect(drawn.length).toBeLessThanOrEqual(24);
      expect(drawn.endsWith('…')).toBe(true);
    });

    it('_draw skips bubble when bubbleText is null (even if description set)', () => {
      renderer._spritesVisible = true;
      renderer._paused = false;
      renderer.sheet.loaded = true;
      renderer.sheet.background = { complete: true, naturalWidth: 960, naturalHeight: 800 };
      renderer.sheet.chars = [{ complete: true, naturalWidth: 112, naturalHeight: 96 }];
      // description set but bubbleText is null → bubble NOT drawn (v2.7.0: _tick controls visibility)
      renderer.agents = [{ name: 'k', cx: 50, cy: 50, tx: 50, ty: 50, state: 'idle',
        description: 'should not show', bubbleText: null,
        color: 0, facing: 'down', walking: false, sitting: false }];

      const texts = [];
      ctx.fillText = vi.fn((...args) => { texts.push(args[0]); });
      renderer._draw();
      expect(texts).not.toContain('should not show');
    });
  });

  describe('chat bubble lifecycle state machine (v2.7.0)', () => {
    let renderer;
    beforeEach(() => {
      renderer = new PixelRenderer(makeCanvas());
      renderer._paused = false;
      renderer._spritesVisible = true;
    });

    it('idle agent starts a bubble from IDLE_CHITCHAT pool when cooldown done', () => {
      // No mapConfig/pathfinder → wander is skipped. Focus only on bubble logic.
      renderer.agents = [{
        name: 'bot', cx: 100, cy: 100, tx: 100, ty: 100,
        state: 'idle', facing: 'down', walking: false, sitting: false,
        path: null, pathIdx: 0, pathGridSize: 16, wanderUntil: Number.MAX_SAFE_INTEGER,
        bubbleText: null, bubbleUntil: 0, bubbleNextAt: 0,
        description: 'real-work-desc', color: 0,
      }];
      renderer._tick();
      const a = renderer.agents[0];
      expect(a.bubbleText).not.toBeNull();
      // idle MUST come from chitchat pool, NOT description
      expect(a.bubbleText).not.toBe('real-work-desc');
      expect(a.bubbleUntil).toBeGreaterThan(performance.now());
    });

    it('busy agent uses emoji from theme pool (v2.10.0, replaces v2.7.0 description)', () => {
      renderer.agents = [{
        name: 'bot', cx: 100, cy: 100, tx: 100, ty: 100,
        state: 'busy', facing: 'down', walking: false, sitting: false,
        path: null, pathIdx: 0, pathGridSize: 16, wanderUntil: Number.MAX_SAFE_INTEGER,
        bubbleText: null, bubbleUntil: 0, bubbleNextAt: 0,
        description: 'compiling rust',
        domains: ['backend', 'rust'], color: 0,
      }];
      renderer._tick();
      const text = renderer.agents[0].bubbleText;
      expect(text).not.toBeNull();
      // 不该是 description 文本
      expect(text).not.toBe('compiling rust');
      // 应当是 1-5 个 emoji 紧贴拼接 (用 Array.from 按 codepoint 计算字符数)
      const codepoints = Array.from(text);
      // emoji 经常是多 codepoint (variation selectors / ZWJ), 这里只断言非空 + 包含至少 1 个非 ASCII char
      expect(text.length).toBeGreaterThan(0);
      expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)).toBe(true);
    });

    it('expired bubble is hidden and cooldown is set in the future', () => {
      const past = performance.now() - 1000;
      renderer.agents = [{
        name: 'bot', cx: 100, cy: 100, tx: 100, ty: 100,
        state: 'idle', facing: 'down', walking: false, sitting: false,
        path: null, pathIdx: 0, pathGridSize: 16, wanderUntil: Number.MAX_SAFE_INTEGER,
        bubbleText: '☕ coffee?', bubbleUntil: past, bubbleNextAt: 0,
        description: '', color: 0,
      }];
      renderer._tick();
      const a = renderer.agents[0];
      expect(a.bubbleText).toBeNull();
      // cooldown must be 4-10s in the future
      const now = performance.now();
      expect(a.bubbleNextAt).toBeGreaterThanOrEqual(now + 3990);
      expect(a.bubbleNextAt).toBeLessThanOrEqual(now + 10010);
    });

    it('agent in cooldown does not get a new bubble yet', () => {
      const future = performance.now() + 99999;
      renderer.agents = [{
        name: 'bot', cx: 100, cy: 100, tx: 100, ty: 100,
        state: 'idle', facing: 'down', walking: false, sitting: false,
        path: null, pathIdx: 0, pathGridSize: 16, wanderUntil: Number.MAX_SAFE_INTEGER,
        bubbleText: null, bubbleUntil: 0, bubbleNextAt: future,
        description: '', color: 0,
      }];
      renderer._tick();
      expect(renderer.agents[0].bubbleText).toBeNull();
    });

    it('offline agent never gets a bubble', () => {
      renderer.agents = [{
        name: 'bot', cx: 100, cy: 100, tx: 100, ty: 100,
        state: 'offline', facing: 'down', walking: false, sitting: false,
        path: null, pathIdx: 0, pathGridSize: 16, wanderUntil: Number.MAX_SAFE_INTEGER,
        bubbleText: null, bubbleUntil: 0, bubbleNextAt: 0,
        description: 'should-not-show', color: 0,
      }];
      renderer._tick();
      expect(renderer.agents[0].bubbleText).toBeNull();
    });

    it('busy agent without domains falls back to generic emoji pool (v2.10.0)', () => {
      renderer.agents = [{
        name: 'bot', cx: 100, cy: 100, tx: 100, ty: 100,
        state: 'busy', facing: 'down', walking: false, sitting: false,
        path: null, pathIdx: 0, pathGridSize: 16, wanderUntil: Number.MAX_SAFE_INTEGER,
        bubbleText: null, bubbleUntil: 0, bubbleNextAt: 0,
        description: '', domains: [], color: 0,
      }];
      renderer._tick();
      const text = renderer.agents[0].bubbleText;
      // 不再"短重试", generic 池非空, 应当出 emoji
      expect(text).not.toBeNull();
      expect(text.length).toBeGreaterThan(0);
    });

    it('state change in setConfig clears bubbleText/Until/NextAt (immediate re-bubble allowed)', () => {
      renderer.setConfig({ agents: [{ name: 'bot', x: 100, y: 100, state: 'busy', color: 0, description: 'old' }] });
      // simulate active bubble
      const a = renderer.agents[0];
      a.bubbleText = 'old';
      a.bubbleUntil = performance.now() + 99999;
      a.bubbleNextAt = performance.now() + 99999;

      // state changes
      renderer.setConfig({ agents: [{ name: 'bot', x: 100, y: 100, state: 'idle', color: 0 }] });
      const a2 = renderer.agents[0];
      expect(a2.bubbleText).toBeNull();
      expect(a2.bubbleUntil).toBe(0);
      expect(a2.bubbleNextAt).toBe(0);
    });
  });

  // === v2.10.0: enqueueBubble (强制气泡, 用于 CommandHistory output) ===

  describe('enqueueBubble (v2.10.0)', () => {
    let renderer;
    beforeEach(() => {
      renderer = new PixelRenderer(makeCanvas());
      renderer.setConfig({ agents: [{ name: 'kiro', x: 100, y: 100, state: 'idle', color: 0 }] });
    });

    it('sets bubbleText immediately for matching agent', () => {
      renderer.enqueueBubble('kiro', 'hello there');
      const a = renderer.agents[0];
      expect(a.bubbleText).toBe('hello there');
      expect(a.bubbleUntil).toBeGreaterThan(0);
    });

    it('lifetime is 4-6 seconds (longer than idle chitchat 3-5s)', () => {
      const before = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      renderer.enqueueBubble('kiro', 'x');
      const a = renderer.agents[0];
      const lifetime = a.bubbleUntil - before;
      expect(lifetime).toBeGreaterThanOrEqual(3990);
      expect(lifetime).toBeLessThanOrEqual(6010);
    });

    it('cooldown after forced bubble prevents instant chitchat takeover', () => {
      renderer.enqueueBubble('kiro', 'output');
      const a = renderer.agents[0];
      // bubbleNextAt 应当晚于 bubbleUntil (= 不会到期就被新 chitchat 立刻覆盖)
      expect(a.bubbleNextAt).toBeGreaterThan(a.bubbleUntil);
    });

    it('unknown agent name → no-op (no throw)', () => {
      expect(() => renderer.enqueueBubble('ghost', 'x')).not.toThrow();
      // 现有 agent 不受影响
      expect(renderer.agents[0].bubbleText).toBeNull();
    });

    it('empty/null text → no-op', () => {
      renderer.enqueueBubble('kiro', '');
      expect(renderer.agents[0].bubbleText).toBeNull();
      renderer.enqueueBubble('kiro', null);
      expect(renderer.agents[0].bubbleText).toBeNull();
    });
  });

  // === v2.10.0: busy emoji picker (替代 description) ===

  describe('pickBusyEmojiPool (v2.10.0)', () => {
    it('returns generic pool when domains empty/null/missing', () => {
      expect(pickBusyEmojiPool([])).toEqual(BUSY_EMOJI_THEMES.generic);
      expect(pickBusyEmojiPool(null)).toEqual(BUSY_EMOJI_THEMES.generic);
      expect(pickBusyEmojiPool(undefined)).toEqual(BUSY_EMOJI_THEMES.generic);
    });

    it('matches coding domains (frontend, backend, python, etc)', () => {
      const pool = pickBusyEmojiPool(['frontend']);
      // coding theme 必含 💻
      expect(pool).toContain('💻');
    });

    it('matches testing domain', () => {
      const pool = pickBusyEmojiPool(['qa']);
      expect(pool).toContain('🧪');
    });

    it('matches ops domain', () => {
      const pool = pickBusyEmojiPool(['devops']);
      expect(pool).toContain('🚀');
    });

    it('matches docs domain', () => {
      const pool = pickBusyEmojiPool(['docs']);
      expect(pool).toContain('📝');
    });

    it('matches data domain', () => {
      const pool = pickBusyEmojiPool(['data']);
      expect(pool).toContain('📊');
    });

    it('multiple domains union the pools', () => {
      const pool = pickBusyEmojiPool(['frontend', 'qa']);
      expect(pool).toContain('💻'); // coding
      expect(pool).toContain('🧪'); // testing
    });

    it('unknown domains fall back to generic pool', () => {
      const pool = pickBusyEmojiPool(['blockchain']);
      expect(pool).toEqual(BUSY_EMOJI_THEMES.generic);
    });

    it('pool elements are unique (Set semantic across themes)', () => {
      const pool = pickBusyEmojiPool(['frontend', 'backend']); // 都映射到 coding, 不该有 duplicate
      const unique = new Set(pool);
      expect(pool.length).toBe(unique.size);
    });
  });

  describe('pickBusyEmojis (v2.10.0)', () => {
    it('returns 1-5 emojis joined without separator', () => {
      for (let i = 0; i < 50; i++) {
        const text = pickBusyEmojis(['coding']);
        // 至少 1 个 emoji codepoint
        expect(text.length).toBeGreaterThan(0);
        // 用 Array.from 拆 codepoint, 数量在 1-5 (考虑 ZWJ / variation selector 可能多 codepoint, 这里宽松断言)
        const cps = Array.from(text);
        expect(cps.length).toBeGreaterThanOrEqual(1);
        expect(cps.length).toBeLessThanOrEqual(10); // 5 emoji * up to 2 codepoints (含 variation selector)
      }
    });

    it('all picked emojis come from the matched pool', () => {
      const pool = new Set(pickBusyEmojiPool(['coding']));
      for (let i = 0; i < 30; i++) {
        const text = pickBusyEmojis(['coding']);
        // 把字符串切成 emoji 数组 (按 Array.from 的 codepoint 切, 但 emoji 可能多 codepoint)
        // 简化检查: pool 里的每个 emoji 出现在 text 里至少 0 次, 且 text 里的 codepoint 都属于某个 emoji
        // 这里改用断言: text 里每个 emoji 必须能在 pool 里找到
        // 用一个更简单的检查 — 把 pool 的 emoji 按长度倒序贪婪地 strip text
        let rest = text;
        const sorted = [...pool].sort((a, b) => b.length - a.length);
        while (rest.length > 0) {
          const found = sorted.find(e => rest.startsWith(e));
          if (!found) {
            throw new Error(`emoji in '${text}' not in pool: rest='${rest}'`);
          }
          rest = rest.slice(found.length);
        }
      }
    });

    it('does not repeat emojis within one bubble', () => {
      // 用 coding pool (8 个 emoji), 每次抽至多 5 个 — 不应该重复
      // 由于 pickBusyCount 随机, 跑 100 次找没重复的最大长度抽样
      for (let i = 0; i < 100; i++) {
        const text = pickBusyEmojis(['coding']);
        // 简单: pool 的每个 emoji 在 text 里最多出现 1 次
        const pool = pickBusyEmojiPool(['coding']);
        for (const e of pool) {
          const count = text.split(e).length - 1;
          expect(count).toBeLessThanOrEqual(1);
        }
      }
    });

    it('count distribution skews toward 1-3 (probabilistic, sample-based)', () => {
      // 跑 1000 次, 大致符合 1=30% / 2=40% / 3=20% / 4=8% / 5=2%
      // 用宽容阈值避免 flaky
      const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, other: 0 };
      // 只能用 ASCII 的 generic pool 的元素来 split — 用一个独立 pool 保证 emoji 边界清晰
      // 这里换个策略: 用 stringWidth 估算 — 直接用 generic pool 的元素逐个 strip 计数
      const pool = pickBusyEmojiPool([]).sort((a, b) => b.length - a.length);
      for (let i = 0; i < 1000; i++) {
        let rest = pickBusyEmojis([]);
        let n = 0;
        while (rest.length > 0) {
          const found = pool.find(e => rest.startsWith(e));
          if (!found) break;
          rest = rest.slice(found.length);
          n++;
        }
        if (n >= 1 && n <= 5) counts[n]++;
        else counts.other++;
      }
      // 基本分布: 1 应是最多 (30%) 之一, 2 应该 ≥ 1 的频次 / 2
      // 阈值放宽避免 flaky:
      expect(counts.other).toBeLessThan(50);  // 几乎所有都应在 1-5 范围
      expect(counts[1]).toBeGreaterThan(150);  // 至少 15% (放宽自 30%)
      expect(counts[2]).toBeGreaterThan(200);  // 至少 20% (放宽自 40%)
      expect(counts[5]).toBeLessThan(100);     // 至多 10% (实际 2%)
    });
  });
});

// ============================================================
// v2.13.3: computeFrameInfo (sprite frame layout)
// ============================================================
describe('v2.13.3 computeFrameInfo', () => {
  // sheet: 7 cols × 3 rows, FRAME_W=16, FRAME_H=32
  // cols: 0-2 walk, 3-4 idle, 5-6 work
  // rows: 0=down, 1=up, 2=side (left=flipX)

  it('walking down: cycles col 0,1,2 every 6 frames', () => {
    const a = { facing: 'down', walking: true, state: 'busy' };
    expect(computeFrameInfo(a, 0).sx).toBe(0 * 16);   // col 0
    expect(computeFrameInfo(a, 6).sx).toBe(1 * 16);   // col 1
    expect(computeFrameInfo(a, 12).sx).toBe(2 * 16);  // col 2
    expect(computeFrameInfo(a, 18).sx).toBe(0 * 16);  // 回到 col 0
    // sy 决定方向
    expect(computeFrameInfo(a, 0).sy).toBe(0 * 32);   // row 0 = down
    expect(computeFrameInfo(a, 0).flipX).toBe(false);
  });

  it('walking up: row 1', () => {
    const a = { facing: 'up', walking: true, state: 'idle' };
    expect(computeFrameInfo(a, 0).sy).toBe(1 * 32);
    expect(computeFrameInfo(a, 0).flipX).toBe(false);
  });

  it('walking right: row 2 no flip', () => {
    const a = { facing: 'right', walking: true, state: 'idle' };
    expect(computeFrameInfo(a, 0).sy).toBe(2 * 32);
    expect(computeFrameInfo(a, 0).flipX).toBe(false);
  });

  it('walking left: row 2 with flipX', () => {
    const a = { facing: 'left', walking: true, state: 'idle' };
    expect(computeFrameInfo(a, 0).sy).toBe(2 * 32);
    expect(computeFrameInfo(a, 0).flipX).toBe(true);
  });

  it('standstill busy: col 5/6 alternates every 24 frames', () => {
    const a = { facing: 'down', walking: false, state: 'busy' };
    expect(computeFrameInfo(a, 0).sx).toBe(5 * 16);    // col 5
    expect(computeFrameInfo(a, 24).sx).toBe(6 * 16);   // col 6
    expect(computeFrameInfo(a, 48).sx).toBe(5 * 16);   // 回 col 5
  });

  it('standstill idle: col 3/4', () => {
    const a = { facing: 'down', walking: false, state: 'idle' };
    expect(computeFrameInfo(a, 0).sx).toBe(3 * 16);
    expect(computeFrameInfo(a, 24).sx).toBe(4 * 16);
  });

  it('standstill offline / error use idle frames (col 3/4)', () => {
    const offline = { facing: 'down', walking: false, state: 'offline' };
    const error = { facing: 'down', walking: false, state: 'error' };
    expect(computeFrameInfo(offline, 0).sx).toBe(3 * 16);
    expect(computeFrameInfo(error, 0).sx).toBe(3 * 16);
  });

  it('walking takes precedence over state (busy walking uses walk frames)', () => {
    const a = { facing: 'down', walking: true, state: 'busy' };
    // 不应触发 busy work frames (col 5-6)
    expect(computeFrameInfo(a, 0).sx).toBe(0 * 16);
    expect(computeFrameInfo(a, 6).sx).toBe(1 * 16);
  });

  it('yOffset is 0 (sitting deprecated)', () => {
    const a = { facing: 'down', walking: false, state: 'idle' };
    expect(computeFrameInfo(a, 0).yOffset).toBe(0);
  });

  it('legacy sitting field is ignored', () => {
    const a = { facing: 'down', walking: false, state: 'idle', sitting: true };
    // sitting 不再影响帧选择
    expect(computeFrameInfo(a, 0).sx).toBe(3 * 16);
    expect(computeFrameInfo(a, 0).yOffset).toBe(0);
  });
});

// ============================================================
// v2.13.3: setPathFinder accepts stateToZone + _tryWander uses it
// ============================================================
describe('v2.13.3 setPathFinder + _tryWander', () => {
  let renderer;
  beforeEach(() => {
    renderer = new PixelRenderer(makeCanvas());
  });

  it('setPathFinder accepts stateToZone, stored on instance', () => {
    const stateToZone = (s) => 'home';
    renderer.setPathFinder({ findPath: () => null, getZoneCells: () => [], stateToZone });
    expect(renderer._stateToZone).toBe(stateToZone);
  });

  it('_tryWander uses injected stateToZone for zone key', () => {
    const calls = [];
    const stateToZone = (s) => {
      calls.push(s);
      return s === 'busy' ? 'work' : 'idle';
    };
    renderer.setPathFinder({
      findPath: () => null,  // 不重要 — 只关心 zoneKey 决策
      getZoneCells: () => [],
      stateToZone,
    });
    renderer._mapConfig = { gridSize: 16 };
    const a = { state: 'busy', cx: 0, cy: 0, path: null };
    renderer._tryWander(a);
    expect(calls).toContain('busy');
  });

  it('_tryWander falls back to legacy logic when stateToZone not injected', () => {
    renderer.setPathFinder({
      findPath: () => null,
      getZoneCells: (key) => {
        // 验证 key
        if (key === 'work' || key === 'idle') return [];
        throw new Error(`unexpected zoneKey: ${key}`);
      },
    });
    renderer._mapConfig = { gridSize: 16 };
    const busyAgent = { state: 'busy', cx: 0, cy: 0, path: null };
    const idleAgent = { state: 'idle', cx: 0, cy: 0, path: null };
    expect(() => renderer._tryWander(busyAgent)).not.toThrow();
    expect(() => renderer._tryWander(idleAgent)).not.toThrow();
  });
});

// ============================================================
// v2.13.3: _tick fallback no-path stays put (no straight-line through walls)
// ============================================================
describe('v2.13.3 _tick fallback: no path → stay put', () => {
  let renderer;
  beforeEach(() => {
    renderer = new PixelRenderer(makeCanvas());
    // 让 _tick 不被 paused 拦
    renderer._paused = false;
  });

  it('agent without path does NOT drift toward tx/ty', () => {
    const agent = {
      name: 'a', cx: 100, cy: 100, tx: 500, ty: 500,  // tx/ty 远在另一区
      facing: 'down', walking: true, state: 'idle',
      path: null, pathIdx: 0, wanderUntil: Date.now() + 999999, // 阻止 _tryWander
    };
    renderer.agents = [agent];
    // 跑几个 tick
    for (let i = 0; i < 10; i++) renderer._tick();
    // cx/cy 不应朝 500 移动
    expect(agent.cx).toBe(100);
    expect(agent.cy).toBe(100);
    // walking 应被清成 false (no path 到达表态)
    expect(agent.walking).toBe(false);
    // tx/ty 同步到 cx/cy 防止后续触发
    expect(agent.tx).toBe(100);
    expect(agent.ty).toBe(100);
  });

  it('agent with path still walks normally (regression check)', () => {
    const agent = {
      name: 'a', cx: 100, cy: 100, tx: 100, ty: 100,
      facing: 'down', walking: true, state: 'idle',
      path: [[6, 6], [7, 6], [8, 6]], pathIdx: 0, pathGridSize: 16,
      wanderUntil: 0,
    };
    renderer.agents = [agent];
    renderer._tick();
    // path 走向 cell [6,6] 中心 = (104, 104) — 应朝那移动
    expect(agent.cx).toBeGreaterThan(100);
  });
});
