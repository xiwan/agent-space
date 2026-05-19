/**
 * MapConfig — Per-background map configuration (v2.5.0: global zones)
 *
 * 每张背景一份配置, 存 localStorage:
 *   key: pixel.mapConfig.<bgId>     (bgId: level1/level2/level3/level3.5/level4/default)
 *   value: JSON  { gridSize, cols, rows, obstacles[][], zones }
 *
 * v2 schema (2.5.0):
 *   zones: { home: [[c,r],...], work: [[c,r],...], idle: [[c,r],...] }   ← 全局, 所有 agent 共享
 *
 * v1 schema (2.4.x):
 *   zones: { home: { agentName: [[c,r],...], ... }, work: {...}, idle: {...} }
 *
 * v1 → v2 迁移: 合并去重所有 agent 的 cells.
 *
 * 状态 → 区域映射 (in BridgeAdapter):
 *   busy    → work zone
 *   idle    → idle zone
 *   offline → home zone
 *   error   → home zone (保守 fallback)
 *
 * 区域内多 cell: hashString(agent.name) % cells.length 哈希分配 (稳定, 多 agent 散到不同 cell)
 */

export const GRID_SIZE = 16;
export const CANVAS_W = 960;
export const CANVAS_H = 800;
export const COLS = Math.floor(CANVAS_W / GRID_SIZE); // 60
export const ROWS = Math.floor(CANVAS_H / GRID_SIZE); // 50

export const ZONE_KEYS = ['home', 'work', 'idle'];

const LS_PREFIX = 'pixel.mapConfig.';
const SCHEMA_VERSION = 2;

/**
 * 创建一个空的 mapConfig (所有 cell walkable, 所有 zone 空).
 */
export function emptyMapConfig() {
  return {
    version: SCHEMA_VERSION,
    gridSize: GRID_SIZE,
    cols: COLS,
    rows: ROWS,
    obstacles: Array.from({ length: ROWS }, () => Array(COLS).fill(0)),
    zones: { home: [], work: [], idle: [] },
  };
}

/**
 * v1 (per-agent zones) → v2 (global zones) 迁移.
 * 合并所有 agent 的 cells, 同 cell 去重.
 *
 * @param {object} cfg v1 schema
 * @returns {object} v2 schema
 */
export function migrateV1toV2(cfg) {
  if (!cfg || cfg.version !== 1) return cfg;
  const newZones = { home: [], work: [], idle: [] };
  for (const zoneKey of ZONE_KEYS) {
    const seen = new Set();
    const v1Zone = cfg.zones?.[zoneKey] || {};
    // v1Zone is { agentName: [[c,r],...] }
    for (const cells of Object.values(v1Zone)) {
      if (!Array.isArray(cells)) continue;
      for (const cell of cells) {
        if (!Array.isArray(cell) || cell.length !== 2) continue;
        const [c, r] = cell;
        const k = c + ',' + r;
        if (!seen.has(k)) {
          seen.add(k);
          newZones[zoneKey].push([c, r]);
        }
      }
    }
  }
  return { ...cfg, version: SCHEMA_VERSION, zones: newZones };
}

/**
 * 从 localStorage 读取指定背景的 mapConfig.
 * 不存在 / 损坏 → null.
 * v1 数据自动迁移并保存为 v2.
 */
export function loadMapConfig(bgId) {
  if (!bgId) return null;
  let raw;
  try {
    raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(LS_PREFIX + bgId) : null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    let cfg = JSON.parse(raw);
    if (!cfg) return null;

    // v1 → v2 迁移
    if (cfg.version === 1) {
      cfg = migrateV1toV2(cfg);
      // 自动持久化迁移结果
      try { localStorage.setItem(LS_PREFIX + bgId, JSON.stringify(cfg)); } catch {}
    }

    if (cfg.version !== SCHEMA_VERSION) return null;
    if (!Array.isArray(cfg.obstacles) || cfg.obstacles.length !== cfg.rows) return null;
    if (!cfg.zones || !ZONE_KEYS.every(z => Array.isArray(cfg.zones[z]))) return null;
    return cfg;
  } catch {
    return null;
  }
}

/**
 * 持久化到 localStorage.
 */
export function saveMapConfig(bgId, cfg) {
  if (!bgId || !cfg) return false;
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(LS_PREFIX + bgId, JSON.stringify(cfg));
    return true;
  } catch {
    return false;
  }
}

/**
 * 删除某背景的配置.
 */
export function clearMapConfig(bgId) {
  if (!bgId) return;
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LS_PREFIX + bgId);
  } catch {}
}

/**
 * Toggle 一个障碍 cell. (mutate)
 */
export function setObstacle(cfg, col, row, blocked) {
  if (col < 0 || col >= cfg.cols || row < 0 || row >= cfg.rows) return;
  cfg.obstacles[row][col] = blocked ? 1 : 0;
}

/**
 * v2.5.0: 加/移 cell 到全局 zone (不再按 agent 区分).
 *
 * @param {object} cfg
 * @param {string} zoneKey 'home' | 'work' | 'idle'
 * @param {number} col
 * @param {number} row
 * @param {boolean} on  true=加 (idempotent), false=移除
 */
export function setZoneCell(cfg, zoneKey, col, row, on) {
  if (!ZONE_KEYS.includes(zoneKey)) return;
  if (col < 0 || col >= cfg.cols || row < 0 || row >= cfg.rows) return;
  const cells = cfg.zones[zoneKey];
  const idx = cells.findIndex(([c, r]) => c === col && r === row);
  if (on && idx === -1) {
    cells.push([col, row]);
  } else if (!on && idx !== -1) {
    cells.splice(idx, 1);
  }
}

/**
 * 给定 cell, 返回它属于哪个 zone (单 zone, 因为 global). 不属于任何 → null.
 */
export function findZoneAt(cfg, col, row) {
  for (const zoneKey of ZONE_KEYS) {
    if (cfg.zones[zoneKey].some(([c, r]) => c === col && r === row)) {
      return { zoneKey };
    }
  }
  return null;
}

/**
 * 状态 → zone key.
 */
export function stateToZone(state) {
  if (state === 'busy') return 'work';
  if (state === 'idle') return 'idle';
  return 'home'; // offline / error / unknown
}

/**
 * djb2 哈希, 稳定 + 分布均匀.
 */
export function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * v2.5.0: 给定 agent + 状态 + mapConfig, 返回目标 cell [col, row], 或 null (没配置 → fallback).
 * 多 agent 同状态时, 由 hashString(name) 散到不同 cell.
 */
export function getTargetCell(agentName, state, mapConfig) {
  if (!mapConfig) return null;
  const zoneKey = stateToZone(state);
  const cells = mapConfig.zones?.[zoneKey];
  if (!cells || cells.length === 0) return null;
  const idx = hashString(agentName) % cells.length;
  return cells[idx];
}

/**
 * cell 转 px (中心点).
 */
export function cellToPx(col, row, gridSize = GRID_SIZE) {
  return [col * gridSize + gridSize / 2, row * gridSize + gridSize / 2];
}

/**
 * px 转 cell.
 */
export function pxToCell(x, y, gridSize = GRID_SIZE) {
  return [Math.floor(x / gridSize), Math.floor(y / gridSize)];
}

/**
 * v2.6.0: 返回指定 zone 的所有 cell (浅拷贝), 或空数组.
 * @param {string} zoneKey 'home' | 'work' | 'idle'
 * @param {object|null} mapConfig
 * @returns {Array<[number, number]>}
 */
export function getZoneCells(zoneKey, mapConfig) {
  if (!mapConfig || !mapConfig.zones) return [];
  return mapConfig.zones[zoneKey] || [];
}
