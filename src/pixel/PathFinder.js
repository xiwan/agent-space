/**
 * PathFinder — A* 4 方向寻路
 *
 * Grid 约定:
 *   obstacles: 2D array, [row][col], 1 = blocked, 0 = walkable
 *   cell: [col, row] tuple
 *
 * 算法:
 *   - 4 方向 (上下左右), Manhattan 启发式
 *   - 起点不在 walkable cell → BFS 找最近的 walkable 当伪起点 (避免卡死)
 *   - 终点不可达 → null
 *
 * 性能: 60×50 grid + 30% 障碍, 单次搜索 < 5ms.
 */

export function manhattan(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function neighbors4(c, r, cols, rows) {
  const out = [];
  if (c > 0)        out.push([c - 1, r]);
  if (c < cols - 1) out.push([c + 1, r]);
  if (r > 0)        out.push([c, r - 1]);
  if (r < rows - 1) out.push([c, r + 1]);
  return out;
}

const cellKey = (c, r) => `${c},${r}`;

/**
 * 找最近的 walkable cell (BFS 4 方向). 起点本身 walkable 直接返回.
 *
 * @param {number[][]} obstacles
 * @param {[number, number]} cell
 * @param {number} cols
 * @param {number} rows
 * @returns {[number, number] | null} null = 整张图全是障碍
 */
export function nearestWalkable(obstacles, cell, cols, rows) {
  const [c, r] = cell;
  if (c >= 0 && c < cols && r >= 0 && r < rows && !obstacles[r][c]) return cell;

  const visited = new Set([cellKey(c, r)]);
  const queue = [[c, r]];
  let head = 0;
  while (head < queue.length) {
    const [cc, cr] = queue[head++];
    for (const [nc, nr] of neighbors4(cc, cr, cols, rows)) {
      const k = cellKey(nc, nr);
      if (visited.has(k)) continue;
      visited.add(k);
      if (!obstacles[nr][nc]) return [nc, nr];
      queue.push([nc, nr]);
    }
  }
  return null;
}

/**
 * A* 寻路.
 *
 * @param {number[][]} obstacles 2D array, [row][col], 1=blocked, 0=walkable
 * @param {[number, number]} start [col, row]
 * @param {[number, number]} end [col, row]
 * @returns {Array<[number, number]> | null} 含起终点的 cell 序列, null 不可达
 */
export function findPath(obstacles, start, end) {
  if (!obstacles || obstacles.length === 0) return null;
  const rows = obstacles.length;
  const cols = obstacles[0].length;
  if (cols === 0) return null;

  const realStart = nearestWalkable(obstacles, start, cols, rows);
  if (!realStart) return null;

  const [ec, er] = end;
  if (er < 0 || er >= rows || ec < 0 || ec >= cols || obstacles[er][ec]) return null;

  const open = [{
    pos: realStart,
    g: 0,
    h: manhattan(realStart, end),
    f: manhattan(realStart, end),
    parent: null,
  }];
  const gScore = new Map([[cellKey(...realStart), 0]]);
  const closed = new Set();

  while (open.length > 0) {
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) bestIdx = i;
    }
    const cur = open.splice(bestIdx, 1)[0];
    const [cc, cr] = cur.pos;

    if (cc === ec && cr === er) {
      const path = [];
      let n = cur;
      while (n) { path.unshift(n.pos); n = n.parent; }
      return path;
    }

    closed.add(cellKey(cc, cr));

    for (const [nc, nr] of neighbors4(cc, cr, cols, rows)) {
      if (obstacles[nr][nc]) continue;
      const nk = cellKey(nc, nr);
      if (closed.has(nk)) continue;
      const tentativeG = cur.g + 1;
      const prev = gScore.get(nk);
      if (prev !== undefined && prev <= tentativeG) continue;
      gScore.set(nk, tentativeG);
      const h = manhattan([nc, nr], end);
      open.push({
        pos: [nc, nr],
        g: tentativeG,
        h,
        f: tentativeG + h,
        parent: cur,
      });
    }
  }
  return null;
}
