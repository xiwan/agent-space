// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  emptyMapConfig, loadMapConfig, saveMapConfig, clearMapConfig, migrateV1toV2,
  setObstacle, setZoneCell, findZoneAt,
  stateToZone, hashString, getTargetCell,
  cellToPx, pxToCell, getZoneCells,
  loadMapConfigAsync, saveMapConfigAsync,
  GRID_SIZE, COLS, ROWS, ZONE_KEYS,
} from '../src/pixel/MapConfig.js';

describe('MapConfig (v2.5.0 global zones)', () => {

  describe('constants', () => {
    it('grid is 16x16, canvas 960x800', () => {
      expect(GRID_SIZE).toBe(16);
      expect(COLS).toBe(60);
      expect(ROWS).toBe(50);
    });
    it('zone keys are home/work/idle', () => {
      expect(ZONE_KEYS).toEqual(['home', 'work', 'idle']);
    });
  });

  describe('emptyMapConfig', () => {
    it('returns valid v2 schema', () => {
      const c = emptyMapConfig();
      expect(c.version).toBe(2);
      expect(c.gridSize).toBe(16);
      expect(c.cols).toBe(60);
      expect(c.rows).toBe(50);
      expect(c.obstacles.length).toBe(50);
      expect(c.obstacles[0].length).toBe(60);
      expect(c.zones).toEqual({ home: [], work: [], idle: [] });
    });

    it('all cells walkable initially', () => {
      const c = emptyMapConfig();
      const total = c.obstacles.flat().reduce((a, b) => a + b, 0);
      expect(total).toBe(0);
    });
  });

  describe('migrateV1toV2', () => {
    it('merges all agents cells into global pool, deduped', () => {
      const v1 = {
        version: 1,
        gridSize: 16, cols: 60, rows: 50,
        obstacles: [],
        zones: {
          home: { kiro: [[1, 1], [2, 2]], codex: [[2, 2], [3, 3]] },
          work: { kiro: [[10, 5]] },
          idle: {},
        },
      };
      const v2 = migrateV1toV2(v1);
      expect(v2.version).toBe(2);
      // home: kiro + codex 合并去重 = [(1,1), (2,2), (3,3)]
      expect(v2.zones.home).toEqual([[1, 1], [2, 2], [3, 3]]);
      expect(v2.zones.work).toEqual([[10, 5]]);
      expect(v2.zones.idle).toEqual([]);
    });

    it('idempotent on already-v2 input', () => {
      const v2 = emptyMapConfig();
      expect(migrateV1toV2(v2)).toBe(v2);
    });

    it('handles malformed v1 zones gracefully', () => {
      const v1 = {
        version: 1, gridSize: 16, cols: 60, rows: 50, obstacles: [],
        zones: { home: { kiro: 'not an array' }, work: null, idle: { codex: [[1, 1]] } },
      };
      const v2 = migrateV1toV2(v1);
      expect(v2.zones.home).toEqual([]);
      expect(v2.zones.work).toEqual([]);
      expect(v2.zones.idle).toEqual([[1, 1]]);
    });

    it('null input → null', () => {
      expect(migrateV1toV2(null)).toBeNull();
    });
  });

  describe('setObstacle', () => {
    it('toggles obstacle on/off', () => {
      const c = emptyMapConfig();
      setObstacle(c, 5, 10, true);
      expect(c.obstacles[10][5]).toBe(1);
      setObstacle(c, 5, 10, false);
      expect(c.obstacles[10][5]).toBe(0);
    });

    it('rejects out-of-bounds silently', () => {
      const c = emptyMapConfig();
      setObstacle(c, -1, 0, true);
      setObstacle(c, 100, 0, true);
      setObstacle(c, 0, -1, true);
      setObstacle(c, 0, 100, true);
      expect(c.obstacles.flat().reduce((a, b) => a + b, 0)).toBe(0);
    });
  });

  describe('setZoneCell (global, v2.5.0)', () => {
    it('adds and removes a cell', () => {
      const c = emptyMapConfig();
      setZoneCell(c, 'work', 5, 10, true);
      expect(c.zones.work).toEqual([[5, 10]]);
      setZoneCell(c, 'work', 5, 10, false);
      expect(c.zones.work).toEqual([]);
    });

    it('idempotent on add', () => {
      const c = emptyMapConfig();
      setZoneCell(c, 'home', 1, 1, true);
      setZoneCell(c, 'home', 1, 1, true);
      expect(c.zones.home).toEqual([[1, 1]]);
    });

    it('rejects unknown zone silently', () => {
      const c = emptyMapConfig();
      setZoneCell(c, 'nonsense', 5, 5, true);
      expect(c.zones).toEqual({ home: [], work: [], idle: [] });
    });

    it('rejects out-of-bounds silently', () => {
      const c = emptyMapConfig();
      setZoneCell(c, 'work', -1, 0, true);
      setZoneCell(c, 'work', 100, 0, true);
      expect(c.zones.work).toEqual([]);
    });

    it('multiple cells in same zone preserved', () => {
      const c = emptyMapConfig();
      setZoneCell(c, 'work', 1, 1, true);
      setZoneCell(c, 'work', 2, 2, true);
      setZoneCell(c, 'work', 3, 3, true);
      expect(c.zones.work).toEqual([[1, 1], [2, 2], [3, 3]]);
    });
  });

  describe('findZoneAt', () => {
    it('returns the zone owning a cell', () => {
      const c = emptyMapConfig();
      setZoneCell(c, 'idle', 3, 3, true);
      expect(findZoneAt(c, 3, 3)).toEqual({ zoneKey: 'idle' });
    });

    it('returns null for unowned cell', () => {
      const c = emptyMapConfig();
      expect(findZoneAt(c, 5, 5)).toBeNull();
    });

    it('returns first matching zone if cell is in multiple', () => {
      const c = emptyMapConfig();
      setZoneCell(c, 'home', 5, 5, true);
      setZoneCell(c, 'idle', 5, 5, true);
      // ZONE_KEYS = ['home', 'work', 'idle'] → home first
      expect(findZoneAt(c, 5, 5)).toEqual({ zoneKey: 'home' });
    });
  });

  describe('stateToZone', () => {
    it('busy → work', () => expect(stateToZone('busy')).toBe('work'));
    it('idle → idle', () => expect(stateToZone('idle')).toBe('idle'));
    it('offline → home', () => expect(stateToZone('offline')).toBe('home'));
    it('error → home', () => expect(stateToZone('error')).toBe('home'));
    it('unknown → home', () => expect(stateToZone('unknown')).toBe('home'));
  });

  describe('hashString', () => {
    it('stable', () => expect(hashString('kiro')).toBe(hashString('kiro')));
    it('differs', () => expect(hashString('kiro')).not.toBe(hashString('codex')));
    it('distributes 10 names across ≥3 buckets (mod 6)', () => {
      const names = ['kiro', 'codex', 'claude', 'qwen', 'opencode', 'hermes',
                     'harness', 'opengame', 'trae', 'agent10'];
      const buckets = new Set(names.map(n => hashString(n) % 6));
      expect(buckets.size).toBeGreaterThanOrEqual(3);
    });
  });

  describe('getTargetCell (v2.5.0 global)', () => {
    let cfg;
    beforeEach(() => {
      cfg = emptyMapConfig();
      setZoneCell(cfg, 'work', 10, 5, true);
      setZoneCell(cfg, 'work', 11, 5, true);
      setZoneCell(cfg, 'home', 1, 1, true);
      setZoneCell(cfg, 'idle', 20, 20, true);
    });

    it('null mapConfig → null', () => {
      expect(getTargetCell('kiro', 'busy', null)).toBeNull();
    });

    it('busy → cell from work zone', () => {
      const r = getTargetCell('kiro', 'busy', cfg);
      expect([[10, 5], [11, 5]]).toContainEqual(r);
    });

    it('offline → cell from home zone', () => {
      expect(getTargetCell('kiro', 'offline', cfg)).toEqual([1, 1]);
    });

    it('idle → cell from idle zone', () => {
      expect(getTargetCell('kiro', 'idle', cfg)).toEqual([20, 20]);
    });

    it('error → home zone (保守 fallback)', () => {
      expect(getTargetCell('kiro', 'error', cfg)).toEqual([1, 1]);
    });

    it('unknown agent works (any name hashes to a cell)', () => {
      const r = getTargetCell('unknown_agent', 'busy', cfg);
      expect([[10, 5], [11, 5]]).toContainEqual(r);
    });

    it('empty zone → null', () => {
      const empty = emptyMapConfig();
      expect(getTargetCell('kiro', 'busy', empty)).toBeNull();
    });

    it('hash dispatch is stable', () => {
      expect(getTargetCell('kiro', 'busy', cfg)).toEqual(getTargetCell('kiro', 'busy', cfg));
    });

    it('different agents may dispatch to different cells', () => {
      const r1 = getTargetCell('kiro', 'busy', cfg);
      const r2 = getTargetCell('claude', 'busy', cfg);
      // 不强制不同 (hash 可能撞), 但至少都是 work zone 中的
      expect([[10, 5], [11, 5]]).toContainEqual(r1);
      expect([[10, 5], [11, 5]]).toContainEqual(r2);
    });
  });

  describe('cellToPx / pxToCell', () => {
    it('cellToPx returns center', () => {
      expect(cellToPx(0, 0)).toEqual([8, 8]);
      expect(cellToPx(2, 3)).toEqual([40, 56]);
    });

    it('pxToCell returns containing cell', () => {
      expect(pxToCell(0, 0)).toEqual([0, 0]);
      expect(pxToCell(15, 15)).toEqual([0, 0]);
      expect(pxToCell(16, 16)).toEqual([1, 1]);
    });

    it('round-trip stable', () => {
      for (const cell of [[0, 0], [10, 10], [59, 49]]) {
        const [x, y] = cellToPx(cell[0], cell[1]);
        expect(pxToCell(x, y)).toEqual(cell);
      }
    });
  });

  describe('save/load localStorage (v2)', () => {
    beforeEach(() => { localStorage.clear(); });

    it('save then load v2 returns same data', () => {
      const c = emptyMapConfig();
      setObstacle(c, 5, 5, true);
      setZoneCell(c, 'work', 10, 10, true);
      saveMapConfig('level3', c);
      const loaded = loadMapConfig('level3');
      expect(loaded.obstacles[5][5]).toBe(1);
      expect(loaded.zones.work).toEqual([[10, 10]]);
    });

    it('load nonexistent → null', () => {
      expect(loadMapConfig('nope')).toBeNull();
    });

    it('load corrupt JSON → null (no throw)', () => {
      localStorage.setItem('pixel.mapConfig.broken', 'not json');
      expect(() => loadMapConfig('broken')).not.toThrow();
      expect(loadMapConfig('broken')).toBeNull();
    });

    it('load v0 (unknown version) → null', () => {
      localStorage.setItem('pixel.mapConfig.v0', JSON.stringify({ version: 0 }));
      expect(loadMapConfig('v0')).toBeNull();
    });

    it('load v1 → auto-migrate to v2 + persist', () => {
      const v1 = {
        version: 1, gridSize: 16, cols: 60, rows: 50,
        obstacles: Array.from({ length: 50 }, () => Array(60).fill(0)),
        zones: { home: { kiro: [[1, 1]], codex: [[2, 2]] }, work: {}, idle: {} },
      };
      localStorage.setItem('pixel.mapConfig.legacy', JSON.stringify(v1));
      const loaded = loadMapConfig('legacy');
      expect(loaded.version).toBe(2);
      expect(loaded.zones.home).toEqual([[1, 1], [2, 2]]);
      // 持久化: 再读应该已经是 v2 而非 v1
      const raw = JSON.parse(localStorage.getItem('pixel.mapConfig.legacy'));
      expect(raw.version).toBe(2);
    });

    it('clear removes the entry', () => {
      saveMapConfig('temp', emptyMapConfig());
      expect(loadMapConfig('temp')).not.toBeNull();
      clearMapConfig('temp');
      expect(loadMapConfig('temp')).toBeNull();
    });

    it('save with empty bgId → false', () => {
      expect(saveMapConfig('', emptyMapConfig())).toBe(false);
    });

    it('save null cfg → false', () => {
      expect(saveMapConfig('x', null)).toBe(false);
    });
  });

  describe('getZoneCells (v2.6.0)', () => {
    it('returns cells for existing zone', () => {
      const cfg = emptyMapConfig();
      cfg.zones.work = [[1, 2], [3, 4]];
      expect(getZoneCells('work', cfg)).toEqual([[1, 2], [3, 4]]);
    });

    it('returns empty array for empty zone', () => {
      const cfg = emptyMapConfig();
      expect(getZoneCells('idle', cfg)).toEqual([]);
    });

    it('returns empty array for unknown zone key', () => {
      const cfg = emptyMapConfig();
      expect(getZoneCells('unknown', cfg)).toEqual([]);
    });

    it('returns empty array for null mapConfig', () => {
      expect(getZoneCells('home', null)).toEqual([]);
    });
  });

  // === v2.9.0: 服务端 async API ===

  describe('loadMapConfigAsync (v2.9.0)', () => {
    function mockFetchOk(body) {
      return vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
      });
    }
    function mockFetch404() {
      return vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: 'not found' }),
      });
    }
    function mockFetchReject(msg = 'network error') {
      return vi.fn().mockRejectedValue(new Error(msg));
    }

    beforeEach(() => {
      try { localStorage.clear(); } catch {}
    });

    it('server 200 + valid → returns server config and writes localStorage cache', async () => {
      const serverCfg = emptyMapConfig();
      setObstacle(serverCfg, 5, 5, true);
      const fetchMock = mockFetchOk(serverCfg);
      const got = await loadMapConfigAsync('level3', fetchMock);
      expect(got).toEqual(serverCfg);
      expect(fetchMock).toHaveBeenCalledWith('/api/pixel-maps/level3');
      // cache 写入了
      const cached = loadMapConfig('level3');
      expect(cached.obstacles[5][5]).toBe(1);
    });

    it('server 200 + invalid body → falls back to localStorage', async () => {
      const local = emptyMapConfig();
      setZoneCell(local, 'work', 7, 7, true);
      saveMapConfig('level3', local);
      const fetchMock = mockFetchOk({ garbage: true }); // 形态不合法
      const got = await loadMapConfigAsync('level3', fetchMock);
      expect(got.zones.work).toEqual([[7, 7]]);
    });

    it('server 404 → falls back to localStorage', async () => {
      const local = emptyMapConfig();
      setObstacle(local, 1, 1, true);
      saveMapConfig('level3', local);
      const fetchMock = mockFetch404();
      const got = await loadMapConfigAsync('level3', fetchMock);
      expect(got.obstacles[1][1]).toBe(1);
    });

    it('fetch reject (network down) → falls back to localStorage', async () => {
      const local = emptyMapConfig();
      saveMapConfig('level3', local);
      const fetchMock = mockFetchReject();
      const got = await loadMapConfigAsync('level3', fetchMock);
      expect(got).toBeTruthy();
      expect(got.zones).toEqual({ home: [], work: [], idle: [] });
    });

    it('server 404 + no localStorage → returns null', async () => {
      const fetchMock = mockFetch404();
      const got = await loadMapConfigAsync('level3', fetchMock);
      expect(got).toBeNull();
    });

    it('returns null when bgId is empty', async () => {
      const fetchMock = vi.fn();
      const got = await loadMapConfigAsync('', fetchMock);
      expect(got).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('encodes bgId in URL (e.g. level3.5)', async () => {
      const serverCfg = emptyMapConfig();
      const fetchMock = mockFetchOk(serverCfg);
      await loadMapConfigAsync('level3.5', fetchMock);
      // encodeURIComponent('level3.5') === 'level3.5' (dot is unreserved), 但调用形式必须用 encoded
      expect(fetchMock).toHaveBeenCalledWith('/api/pixel-maps/level3.5');
    });

    it('migrates v1 server response to v2 transparently', async () => {
      const v1 = {
        version: 1,
        gridSize: 16,
        cols: 60,
        rows: 50,
        obstacles: Array.from({ length: 50 }, () => Array(60).fill(0)),
        zones: { home: { agentA: [[1, 1]] }, work: {}, idle: {} },
      };
      const fetchMock = mockFetchOk(v1);
      const got = await loadMapConfigAsync('level3', fetchMock);
      expect(got).not.toBeNull();
      expect(got.version).toBe(2);
      expect(got.zones.home).toEqual([[1, 1]]);
    });
  });

  describe('saveMapConfigAsync (v2.9.0)', () => {
    function mockFetchOk() {
      return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    }
    function mockFetch5xx() {
      return vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'oops' }) });
    }
    function mockFetchReject() {
      return vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    }

    beforeEach(() => {
      try { localStorage.clear(); } catch {}
    });

    it('PUTs cfg to server and writes localStorage cache on success', async () => {
      const fetchMock = mockFetchOk();
      const cfg = emptyMapConfig();
      setObstacle(cfg, 3, 3, true);
      const ok = await saveMapConfigAsync('level3', cfg, fetchMock);
      expect(ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/pixel-maps/level3');
      expect(init.method).toBe('PUT');
      expect(init.headers['content-type']).toBe('application/json');
      expect(JSON.parse(init.body).obstacles[3][3]).toBe(1);
      // cache 写入
      expect(loadMapConfig('level3').obstacles[3][3]).toBe(1);
    });

    it('rejects on 5xx and does NOT write localStorage', async () => {
      const fetchMock = mockFetch5xx();
      const cfg = emptyMapConfig();
      await expect(saveMapConfigAsync('level3', cfg, fetchMock)).rejects.toThrow(/500/);
      // localStorage 没写
      expect(loadMapConfig('level3')).toBeNull();
    });

    it('rejects on network error', async () => {
      const fetchMock = mockFetchReject();
      const cfg = emptyMapConfig();
      await expect(saveMapConfigAsync('level3', cfg, fetchMock)).rejects.toThrow(/network error/);
    });

    it('throws synchronously (returns rejected promise) when bgId missing', async () => {
      await expect(saveMapConfigAsync('', emptyMapConfig(), vi.fn())).rejects.toThrow(/bgId required/);
    });

    it('throws when cfg missing', async () => {
      await expect(saveMapConfigAsync('level3', null, vi.fn())).rejects.toThrow(/cfg required/);
    });
  });
});
