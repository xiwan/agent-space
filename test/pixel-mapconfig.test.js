// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  emptyMapConfig, loadMapConfig, saveMapConfig, clearMapConfig,
  setObstacle, setZoneCell, findZoneAt,
  stateToZone, hashString, getTargetCell,
  cellToPx, pxToCell,
  GRID_SIZE, COLS, ROWS, ZONE_KEYS,
} from '../src/pixel/MapConfig.js';

describe('MapConfig (v2.4.0)', () => {

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
    it('returns valid schema', () => {
      const c = emptyMapConfig();
      expect(c.version).toBe(1);
      expect(c.gridSize).toBe(16);
      expect(c.cols).toBe(60);
      expect(c.rows).toBe(50);
      expect(c.obstacles.length).toBe(50);
      expect(c.obstacles[0].length).toBe(60);
      expect(c.zones).toEqual({ home: {}, work: {}, idle: {} });
    });

    it('all cells are walkable initially', () => {
      const c = emptyMapConfig();
      const total = c.obstacles.flat().reduce((a, b) => a + b, 0);
      expect(total).toBe(0);
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
      // 没有崩溃, 也没有改任何东西
      expect(c.obstacles.flat().reduce((a, b) => a + b, 0)).toBe(0);
    });
  });

  describe('setZoneCell', () => {
    it('adds and removes a cell for an agent', () => {
      const c = emptyMapConfig();
      setZoneCell(c, 'work', 'kiro', 5, 10, true);
      expect(c.zones.work.kiro).toEqual([[5, 10]]);
      setZoneCell(c, 'work', 'kiro', 5, 10, false);
      expect(c.zones.work.kiro).toBeUndefined();
    });

    it('multiple agents in same zone are independent', () => {
      const c = emptyMapConfig();
      setZoneCell(c, 'work', 'kiro', 5, 5, true);
      setZoneCell(c, 'work', 'codex', 5, 5, true);
      expect(c.zones.work.kiro).toEqual([[5, 5]]);
      expect(c.zones.work.codex).toEqual([[5, 5]]);
    });

    it('rejects unknown zone silently', () => {
      const c = emptyMapConfig();
      setZoneCell(c, 'nonsense', 'kiro', 5, 5, true);
      expect(c.zones).toEqual({ home: {}, work: {}, idle: {} });
    });

    it('rejects empty agent name', () => {
      const c = emptyMapConfig();
      setZoneCell(c, 'work', '', 5, 5, true);
      expect(c.zones.work).toEqual({});
    });

    it('idempotent on add (no duplicate cells)', () => {
      const c = emptyMapConfig();
      setZoneCell(c, 'home', 'kiro', 1, 1, true);
      setZoneCell(c, 'home', 'kiro', 1, 1, true);
      expect(c.zones.home.kiro).toEqual([[1, 1]]);
    });
  });

  describe('findZoneAt', () => {
    it('finds the zone+agent owning a cell', () => {
      const c = emptyMapConfig();
      setZoneCell(c, 'idle', 'kiro', 3, 3, true);
      const r = findZoneAt(c, 3, 3);
      expect(r).toEqual({ zoneKey: 'idle', agentName: 'kiro' });
    });

    it('returns null for unowned cell', () => {
      const c = emptyMapConfig();
      expect(findZoneAt(c, 5, 5)).toBeNull();
    });
  });

  describe('stateToZone', () => {
    it('maps states to zones correctly', () => {
      expect(stateToZone('busy')).toBe('work');
      expect(stateToZone('idle')).toBe('idle');
      expect(stateToZone('offline')).toBe('home');
      expect(stateToZone('error')).toBe('home');
      expect(stateToZone('unknown')).toBe('home');
    });
  });

  describe('hashString', () => {
    it('is stable for same input', () => {
      expect(hashString('kiro')).toBe(hashString('kiro'));
    });

    it('differs for different inputs', () => {
      expect(hashString('kiro')).not.toBe(hashString('codex'));
    });

    it('distributes 10 names across multiple buckets (mod 6)', () => {
      const names = ['kiro', 'codex', 'claude', 'qwen', 'opencode', 'hermes',
                     'harness', 'opengame', 'trae', 'agent10'];
      const buckets = new Set(names.map(n => hashString(n) % 6));
      expect(buckets.size).toBeGreaterThanOrEqual(3);
    });
  });

  describe('getTargetCell', () => {
    let cfg;
    beforeEach(() => {
      cfg = emptyMapConfig();
      setZoneCell(cfg, 'work', 'kiro', 10, 5, true);
      setZoneCell(cfg, 'work', 'kiro', 11, 5, true);
      setZoneCell(cfg, 'home', 'kiro', 1, 1, true);
      setZoneCell(cfg, 'idle', 'kiro', 20, 20, true);
    });

    it('returns null when mapConfig is null', () => {
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

    it('unknown agent → null', () => {
      expect(getTargetCell('unknown', 'busy', cfg)).toBeNull();
    });

    it('agent has zone but empty cells → null', () => {
      cfg.zones.work.empty_agent = [];
      expect(getTargetCell('empty_agent', 'busy', cfg)).toBeNull();
    });

    it('hash dispatch is stable across calls', () => {
      const r1 = getTargetCell('kiro', 'busy', cfg);
      const r2 = getTargetCell('kiro', 'busy', cfg);
      expect(r1).toEqual(r2);
    });
  });

  describe('cellToPx / pxToCell', () => {
    it('cellToPx returns center of cell', () => {
      expect(cellToPx(0, 0)).toEqual([8, 8]);
      expect(cellToPx(2, 3)).toEqual([40, 56]);
    });

    it('pxToCell returns cell containing pixel', () => {
      expect(pxToCell(0, 0)).toEqual([0, 0]);
      expect(pxToCell(15, 15)).toEqual([0, 0]);
      expect(pxToCell(16, 16)).toEqual([1, 1]);
      expect(pxToCell(40, 56)).toEqual([2, 3]);
    });

    it('round trip cell → px → cell stable', () => {
      for (const cell of [[0, 0], [10, 10], [59, 49]]) {
        const [x, y] = cellToPx(cell[0], cell[1]);
        expect(pxToCell(x, y)).toEqual(cell);
      }
    });
  });

  describe('save/load localStorage', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('save then load returns same data', () => {
      const c = emptyMapConfig();
      setObstacle(c, 5, 5, true);
      setZoneCell(c, 'work', 'kiro', 10, 10, true);
      saveMapConfig('level3', c);
      const loaded = loadMapConfig('level3');
      expect(loaded.obstacles[5][5]).toBe(1);
      expect(loaded.zones.work.kiro).toEqual([[10, 10]]);
    });

    it('load nonexistent → null', () => {
      expect(loadMapConfig('nope')).toBeNull();
    });

    it('load corrupt JSON → null (no throw)', () => {
      localStorage.setItem('pixel.mapConfig.broken', 'not json');
      expect(() => loadMapConfig('broken')).not.toThrow();
      expect(loadMapConfig('broken')).toBeNull();
    });

    it('load wrong-version → null', () => {
      localStorage.setItem('pixel.mapConfig.v0', JSON.stringify({ version: 0 }));
      expect(loadMapConfig('v0')).toBeNull();
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
});
