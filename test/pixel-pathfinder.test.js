import { describe, it, expect } from 'vitest';
import { findPath, manhattan, nearestWalkable } from '../src/pixel/PathFinder.js';

// 工具: 5x5 grid, 默认全 walkable
const empty = (rows, cols) => Array.from({ length: rows }, () => Array(cols).fill(0));

// 验证 path 全是 4 方向相邻 (Manhattan step = 1)
function isManhattanPath(path) {
  for (let i = 1; i < path.length; i++) {
    if (manhattan(path[i - 1], path[i]) !== 1) return false;
  }
  return true;
}

// 验证 path 不穿过任何障碍
function isWalkable(path, obstacles) {
  return path.every(([c, r]) => obstacles[r] && obstacles[r][c] === 0);
}

describe('PathFinder (v2.4.0)', () => {
  describe('manhattan', () => {
    it('zero distance', () => expect(manhattan([0, 0], [0, 0])).toBe(0));
    it('horizontal', () => expect(manhattan([0, 0], [3, 0])).toBe(3));
    it('vertical', () => expect(manhattan([0, 0], [0, 4])).toBe(4));
    it('diagonal sum', () => expect(manhattan([1, 2], [4, 6])).toBe(7));
  });

  describe('nearestWalkable', () => {
    it('returns same cell if already walkable', () => {
      const obs = empty(5, 5);
      expect(nearestWalkable(obs, [2, 2], 5, 5)).toEqual([2, 2]);
    });

    it('finds adjacent walkable when start blocked', () => {
      const obs = empty(5, 5);
      obs[2][2] = 1;
      const r = nearestWalkable(obs, [2, 2], 5, 5);
      expect(manhattan(r, [2, 2])).toBe(1);
      expect(obs[r[1]][r[0]]).toBe(0);
    });

    it('returns null if entire grid blocked', () => {
      const obs = Array.from({ length: 3 }, () => Array(3).fill(1));
      expect(nearestWalkable(obs, [1, 1], 3, 3)).toBeNull();
    });
  });

  describe('findPath basic', () => {
    it('straight line in empty grid', () => {
      const obs = empty(5, 5);
      const p = findPath(obs, [0, 0], [4, 0]);
      expect(p).not.toBeNull();
      expect(p.length).toBe(5);
      expect(p[0]).toEqual([0, 0]);
      expect(p[4]).toEqual([4, 0]);
      expect(isManhattanPath(p)).toBe(true);
    });

    it('start equals end → length 1', () => {
      const obs = empty(3, 3);
      const p = findPath(obs, [1, 1], [1, 1]);
      expect(p).toEqual([[1, 1]]);
    });

    it('detours around a single obstacle', () => {
      const obs = empty(5, 5);
      obs[0][2] = obs[1][2] = obs[2][2] = 1;
      const p = findPath(obs, [0, 0], [4, 0]);
      expect(p).not.toBeNull();
      expect(isWalkable(p, obs)).toBe(true);
      expect(isManhattanPath(p)).toBe(true);
      expect(p.length).toBeGreaterThan(5); // 必须绕路
    });

    it('returns null when end is unreachable', () => {
      const obs = empty(5, 5);
      // 整列 2 全是墙
      for (let r = 0; r < 5; r++) obs[r][2] = 1;
      const p = findPath(obs, [0, 0], [4, 0]);
      expect(p).toBeNull();
    });

    it('returns null when end itself is blocked', () => {
      const obs = empty(5, 5);
      obs[0][4] = 1;
      const p = findPath(obs, [0, 0], [4, 0]);
      expect(p).toBeNull();
    });
  });

  describe('findPath start fallback', () => {
    it('uses nearest walkable when start is in obstacle', () => {
      const obs = empty(5, 5);
      obs[0][0] = 1; // 起点是障碍
      const p = findPath(obs, [0, 0], [4, 0]);
      expect(p).not.toBeNull();
      // path[0] 不应是 [0,0] (因为它 blocked), 应该是邻居
      expect(p[0]).not.toEqual([0, 0]);
      expect(obs[p[0][1]][p[0][0]]).toBe(0);
    });

    it('returns null when entire grid blocked', () => {
      const obs = Array.from({ length: 3 }, () => Array(3).fill(1));
      const p = findPath(obs, [0, 0], [2, 2]);
      expect(p).toBeNull();
    });
  });

  describe('findPath properties', () => {
    it('path length is at least manhattan distance + 1 (admissible)', () => {
      const obs = empty(10, 10);
      const start = [0, 0];
      const end = [9, 7];
      const p = findPath(obs, start, end);
      expect(p.length).toBeGreaterThanOrEqual(manhattan(start, end) + 1);
    });

    it('path is exactly manhattan + 1 in empty grid (optimal)', () => {
      const obs = empty(10, 10);
      const p = findPath(obs, [1, 1], [8, 6]);
      expect(p.length).toBe(manhattan([1, 1], [8, 6]) + 1);
    });

    it('all path steps are 4-directional', () => {
      const obs = empty(5, 5);
      // 加几个障碍迫使绕路
      obs[2][2] = obs[2][3] = 1;
      const p = findPath(obs, [0, 0], [4, 4]);
      expect(p).not.toBeNull();
      expect(isManhattanPath(p)).toBe(true);
    });
  });

  describe('findPath edge cases', () => {
    it('null obstacles → null', () => {
      expect(findPath(null, [0, 0], [1, 1])).toBeNull();
    });

    it('empty obstacles → null', () => {
      expect(findPath([], [0, 0], [1, 1])).toBeNull();
    });

    it('end out of bounds → null', () => {
      const obs = empty(3, 3);
      expect(findPath(obs, [0, 0], [5, 0])).toBeNull();
      expect(findPath(obs, [0, 0], [-1, 0])).toBeNull();
    });
  });

  describe('findPath performance', () => {
    it('60x50 grid with 30% obstacles completes in <100ms', () => {
      const COLS = 60, ROWS = 50;
      // 固定 seed 让结果稳定
      const obs = Array.from({ length: ROWS }, (_, r) =>
        Array.from({ length: COLS }, (_, c) => ((r * 31 + c * 17) % 10 < 3) ? 1 : 0)
      );
      obs[0][0] = 0;
      obs[ROWS - 1][COLS - 1] = 0;
      const t0 = performance.now();
      findPath(obs, [0, 0], [COLS - 1, ROWS - 1]);
      const ms = performance.now() - t0;
      expect(ms).toBeLessThan(100);
    });
  });
});
