/**
 * MapConfig — Per-background map configuration
 *
 * 每张背景一份配置, 存 localStorage:
 *   key: pixel.mapConfig.<bgId>     (bgId: level1/level2/level3/level3.5/level4/default)
 *   value: JSON  { gridSize, cols, rows, obstacles[][], zones }
 *
 * 状态 → 区域映射 (in BridgeAdapter):
 *   busy    → work zone
 *   idle    → idle zone
 *   offline → home zone
 *   error   → home zone (保守 fallback)
 *
 * 区域内多 cell: hashString(agent.name) % cells.length 哈希分配 (稳定无重叠检测)
 */

export const GRID_SIZE = 16;
export const CANVAS_W = 960;
export const CANVAS_H = 800;
export const COLS = Math.floor(CANVAS_W / GRID_SIZE); // 60
export const ROWS = Math.floor(CANVAS_H / GRID_SIZE); // 50

export const ZONE_KEYS = ['home', 'work', 'idle'];

const LS_PREFIX = 'pixel.mapConfig.';
const SCHEMA_VERSION = 1;

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
    zones: { home: {}, work: {}, idle: {} },
  };
}

/**
 * 从 localStorage 读取指定背景的 mapConfig.
 * 不存在 / 损坏 / 版本不匹配 → null (caller fallback).
 *
 * @param {string} bgId
 * @returns {object | null}
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
    const cfg = JSON.parse(raw);
    if (!cfg || cfg.version !== SCHEMA_VERSION) return null;
    if (!Array.isArray(cfg.obstacles) || cfg.obstacles.length !== cfg.rows) return null;
    if (!cfg.zones || !ZONE_KEYS.every(z => cfg.zones[z] && typeof cfg.zones[z] === 'object')) return null;
    return cfg;
  } catch {
    return null;
  }
}

/**
 * 持久化到 localStorage.
 * @param {string} bgId
 * @param {object} cfg
 * @returns {boolean} 成功 = true
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
 * 给指定 agent 在指定 zone 增加/移除一个 cell.
 *
 * @param {object} cfg
 * @param {string} zoneKey 'home' | 'work' | 'idle'
 * @param {string} agentName
 * @param {number} col
 * @param {number} row
 * @param {boolean} on  true=加, false=移除
 */
export function setZoneCell(cfg, zoneKey, agentName, col, row, on) {
  if (!ZONE_KEYS.includes(zoneKey)) return;
  if (!agentName) return;
  if (col < 0 || col >= cfg.cols || row < 0 || row >= cfg.rows) return;

  const zone = cfg.zones[zoneKey];
  if (!zone[agentName]) zone[agentName] = [];
  const cells = zone[agentName];
  const idx = cells.findIndex(([c, r]) => c === col && r === row);
  if (on && idx === -1) {
    cells.push([col, row]);
  } else if (!on && idx !== -1) {
    cells.splice(idx, 1);
    if (cells.length === 0) delete zone[agentName];
  }
}

/**
 * 给定 cell, 返回它属于哪个 zone + 哪个 agent (用于编辑器右键擦除).
 * 不属于任何 zone → null.
 */
export function findZoneAt(cfg, col, row) {
  for (const zoneKey of ZONE_KEYS) {
    const zone = cfg.zones[zoneKey];
    for (const [agentName, cells] of Object.entries(zone)) {
      if (cells.some(([c, r]) => c === col && r === row)) {
        return { zoneKey, agentName };
      }
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
  // offline / error
  return 'home';
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
 * 给定 agent + 状态 + mapConfig, 返回目标 cell [col, row], 或 null (没配置 → fallback).
 */
export function getTargetCell(agentName, state, mapConfig) {
  if (!mapConfig) return null;
  const zoneKey = stateToZone(state);
  const cells = mapConfig.zones?.[zoneKey]?.[agentName];
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
