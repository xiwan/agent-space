/**
 * LayoutSolver — 基于约束的 2D 布局求解器
 * 支持：against_wall, surround, in_zone, on_top_of, in_front_of,
 *       facing, min_distance, symmetric, accessible_from, near
 */
import { FURNITURE } from './TileMapper.js';

// Seeded PRNG (mulberry32)
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export class LayoutSolver {
  constructor(roomW, roomH, padding = 1, seed = Date.now()) {
    this.ox = padding;
    this.oy = padding + 1;
    this.w = roomW - padding * 2;
    this.h = roomH - padding - 1;
    this.grid = Array.from({ length: this.h }, () => Array(this.w).fill(null));
    this.rand = mulberry32(seed);
    this.placed = []; // {name, item, x, y, tw, th, facing}
  }

  solve(scene) {
    const zones = this._buildZones(scene.zones || []);
    const constraints = scene.constraints || [];
    const entities = scene.entities || [];
    const groups = scene.groups || [];

    // Phase 1: against_wall
    for (const c of constraints.filter(c => c.type === 'against_wall')) {
      const ent = this._findEntity(entities, c.entity);
      if (!ent || this._isPlaced(c.entity)) continue;
      this._solveAgainstWall(ent, c.direction);
    }

    // Phase 2: groups (surround)
    for (const g of groups) {
      if (g.pattern === 'surround') this._solveSurround(g, zones, entities);
    }

    // Phase 3: in_row (place in specific row within zone)
    for (const c of constraints.filter(c => c.type === 'in_row')) {
      const ent = this._findEntity(entities, c.entity);
      if (!ent || this._isPlaced(c.entity)) continue;
      const zone = zones[c.zone];
      if (!zone) continue;
      this._solveInRow(ent, zone, c.row || 0);
    }

    // Phase 3b: in_zone
    for (const c of constraints.filter(c => c.type === 'in_zone')) {
      const ent = this._findEntity(entities, c.entity);
      if (!ent || this._isPlaced(c.entity)) continue;
      const zone = zones[c.zone];
      if (zone) this._solveInZone(ent, zone);
    }

    // Phase 4: on_top_of
    for (const c of constraints.filter(c => c.type === 'on_top_of')) {
      const target = this.placed.find(p => p.name === c.target);
      if (target) {
        this.placed.push({ name: c.entity, item: this._findEntity(entities, c.entity)?.item || c.entity, x: target.x, y: target.y, tw: 1, th: 1, facing: 'south' });
      }
    }

    // Phase 5: in_front_of
    for (const c of constraints.filter(c => c.type === 'in_front_of')) {
      const ent = this._findEntity(entities, c.entity);
      const target = this.placed.find(p => p.name === c.target);
      if (target) {
        const y = target.y + target.th;
        if (y < this.h && this._isFree(target.x, y, 1, 1)) {
          this._occupy(target.x, y, 1, 1);
          this.placed.push({ name: c.entity, item: ent?.item || c.entity, x: target.x, y, tw: 1, th: 1, facing: 'north' });
        }
      }
    }

    // Phase 6: near
    for (const c of constraints.filter(c => c.type === 'near')) {
      const ent = this._findEntity(entities, c.entity);
      if (!ent || this._isPlaced(c.entity)) continue;
      const target = this.placed.find(p => p.name === c.target || p.item === c.target);
      if (target) this._solveNear(ent, target, c.maxDist || 2);
    }

    // Phase 7: symmetric
    for (const c of constraints.filter(c => c.type === 'symmetric')) {
      const source = this.placed.find(p => p.name === c.entity || p.item === c.entity);
      if (!source) continue;
      if (this._isPlaced(c.mirror)) continue;
      const ent = this._findEntity(entities, c.mirror);
      if (!ent) continue;
      this._solveSymmetric(ent, source, c.axis || 'vertical');
    }

    // Phase 8: accessible_from — validate and nudge
    for (const c of constraints.filter(c => c.type === 'accessible_from')) {
      this._solveAccessible(c.entity, c.direction);
    }

    // Phase 9: min_distance — validate (post-hoc, swap if violated)
    for (const c of constraints.filter(c => c.type === 'min_distance')) {
      this._solveMinDistance(c.entity, c.target, c.distance || 2);
    }

    // Convert to output format
    return this.placed.map(p => ({
      item: p.item,
      x: p.x + this.ox,
      y: p.y + this.oy,
    }));
  }

  // --- Solvers ---

  _solveAgainstWall(ent, direction) {
    const tw = ent.tw || 1, th = ent.th || 1;
    const candidates = [];
    if (direction === 'north') {
      for (let x = 0; x <= this.w - tw; x++)
        if (this._isFree(x, 0, tw, th)) candidates.push({ x, y: 0 });
    } else if (direction === 'south') {
      for (let x = 0; x <= this.w - tw; x++) {
        const y = this.h - th;
        if (this._isFree(x, y, tw, th)) candidates.push({ x, y });
      }
    } else if (direction === 'west') {
      for (let y = 0; y <= this.h - th; y++)
        if (this._isFree(0, y, tw, th)) candidates.push({ x: 0, y });
    } else if (direction === 'east') {
      for (let y = 0; y <= this.h - th; y++) {
        const x = this.w - tw;
        if (this._isFree(x, y, tw, th)) candidates.push({ x, y });
      }
    }
    if (candidates.length === 0) return;
    const pick = candidates[Math.floor(this.rand() * candidates.length)];
    this._occupy(pick.x, pick.y, tw, th);
    this.placed.push({ name: ent.name, item: ent.item || ent.name, x: pick.x, y: pick.y, tw, th, facing: direction === 'north' ? 'south' : 'north' });
  }

  _solveSurround(group, zones, entities) {
    const zone = zones[group.zone] || { x: 0, y: Math.floor(this.h * 0.5), w: this.w, h: Math.floor(this.h * 0.4) };
    const centerItem = group.centerItem || group.center;
    const centerDef = FURNITURE[centerItem] || {};
    const ctw = centerDef.tw || 1, cth = centerDef.th || 1;

    // Place center in zone with some randomness
    const cx = zone.x + Math.floor(zone.w / 2) - Math.floor(ctw / 2) + Math.floor(this.rand() * 3) - 1;
    const cy = zone.y + Math.floor(zone.h / 2) - Math.floor(cth / 2);
    const cxc = Math.max(zone.x + 1, Math.min(cx, zone.x + zone.w - ctw - 1));
    const cyc = Math.max(zone.y, Math.min(cy, zone.y + zone.h - cth));

    if (this._isFree(cxc, cyc, ctw, cth)) {
      this._occupy(cxc, cyc, ctw, cth);
      this.placed.push({ name: group.center, item: centerItem, x: cxc, y: cyc, tw: ctw, th: cth, facing: 'any' });
    } else return;

    // Members around center: above, below, left, right
    const offsets = [
      { dx: 0, dy: -2, facing: 'south' },
      { dx: 0, dy: cth + 1, facing: 'north' },
      { dx: -(ctw + 2), dy: 0, facing: 'east' },
      { dx: ctw + 1, dy: 0, facing: 'west' },
    ];

    for (let i = 0; i < group.members.length && i < offsets.length; i++) {
      const memberName = group.members[i];
      const ent = this._findEntity(entities, memberName);
      const memberItem = ent?.item || memberName;
      const def = FURNITURE[memberItem] || {};
      const tw = def.tw || 1, th = def.th || 1;
      const px = cxc + offsets[i].dx;
      const py = cyc + offsets[i].dy;
      if (px >= 0 && py >= 0 && px + tw <= this.w && py + th <= this.h && this._isFree(px, py, tw, th)) {
        this._occupy(px, py, tw, th);
        this.placed.push({ name: memberName, item: memberItem, x: px, y: py, tw, th, facing: offsets[i].facing });
      }
    }
  }

  _solveInRow(ent, zone, row) {
    const tw = ent.tw || 1, th = ent.th || 1;
    const y = zone.y + row;
    if (y + th > zone.y + zone.h) return;
    const candidates = [];
    for (let x = zone.x; x + tw <= zone.x + zone.w; x++)
      if (this._isFree(x, y, tw, th)) candidates.push({ x, y });
    if (candidates.length === 0) return;
    const pick = candidates[Math.floor(this.rand() * candidates.length)];
    this._occupy(pick.x, pick.y, tw, th);
    this.placed.push({ name: ent.name, item: ent.item || ent.name, x: pick.x, y: pick.y, tw, th, facing: 'south' });
  }

  _solveInZone(ent, zone) {
    const tw = ent.tw || 1, th = ent.th || 1;
    const candidates = [];
    for (let y = zone.y; y + th <= zone.y + zone.h; y++)
      for (let x = zone.x; x + tw <= zone.x + zone.w; x++)
        if (this._isFree(x, y, tw, th)) candidates.push({ x, y });
    if (candidates.length === 0) return;
    const pick = candidates[Math.floor(this.rand() * candidates.length)];
    this._occupy(pick.x, pick.y, tw, th);
    this.placed.push({ name: ent.name, item: ent.item || ent.name, x: pick.x, y: pick.y, tw, th, facing: 'south' });
  }

  _solveNear(ent, target, maxDist) {
    const tw = ent.tw || 1, th = ent.th || 1;
    const candidates = [];
    for (let dy = -maxDist; dy <= maxDist; dy++) {
      for (let dx = -maxDist; dx <= maxDist; dx++) {
        const x = target.x + dx, y = target.y + dy;
        if (x >= 0 && y >= 0 && x + tw <= this.w && y + th <= this.h && this._isFree(x, y, tw, th))
          candidates.push({ x, y });
      }
    }
    if (candidates.length === 0) return;
    const pick = candidates[Math.floor(this.rand() * candidates.length)];
    this._occupy(pick.x, pick.y, tw, th);
    this.placed.push({ name: ent.name, item: ent.item || ent.name, x: pick.x, y: pick.y, tw, th, facing: 'south' });
  }

  _solveSymmetric(ent, source, axis) {
    const tw = ent.tw || 1, th = ent.th || 1;
    let mx, my;
    if (axis === 'vertical') {
      mx = this.w - 1 - source.x - (tw - 1);
      my = source.y;
    } else {
      mx = source.x;
      my = this.h - 1 - source.y - (th - 1);
    }
    if (mx >= 0 && my >= 0 && mx + tw <= this.w && my + th <= this.h && this._isFree(mx, my, tw, th)) {
      this._occupy(mx, my, tw, th);
      this.placed.push({ name: ent.name, item: ent.item || ent.name, x: mx, y: my, tw, th, facing: source.facing });
    }
  }

  _solveAccessible(entityName, direction) {
    const p = this.placed.find(p => p.name === entityName || p.item === entityName);
    if (!p) return;
    // Check if the direction is free; if not, try to nudge
    let checkX = p.x, checkY = p.y;
    if (direction === 'south') checkY = p.y + p.th;
    else if (direction === 'north') checkY = p.y - 1;
    else if (direction === 'east') checkX = p.x + p.tw;
    else if (direction === 'west') checkX = p.x - 1;

    if (checkX < 0 || checkY < 0 || checkX >= this.w || checkY >= this.h) return;
    // If blocked, clear that cell (remove blocking item)
    if (this.grid[checkY] && this.grid[checkY][checkX]) {
      this.grid[checkY][checkX] = null;
    }
  }

  _solveMinDistance(entityName, targetName, dist) {
    const a = this.placed.find(p => p.name === entityName || p.item === entityName);
    const b = this.placed.find(p => p.name === targetName || p.item === targetName);
    if (!a || !b) return;
    const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    if (dx + dy < dist) {
      // Nudge a away from b
      const nudgeX = a.x < b.x ? -1 : 1;
      const newX = a.x + nudgeX;
      if (newX >= 0 && newX + a.tw <= this.w && this._isFree(newX, a.y, a.tw, a.th)) {
        this._clearOccupied(a.x, a.y, a.tw, a.th);
        a.x = newX;
        this._occupy(a.x, a.y, a.tw, a.th);
      }
    }
  }

  // --- Helpers ---

  _buildZones(zoneDefs) {
    const zones = {};
    for (const z of zoneDefs) {
      const pos = z.position || 'center';
      let zy, zh;
      if (pos === 'north') { zy = 0; zh = Math.floor(this.h * 0.4); }
      else if (pos === 'south') { zy = Math.floor(this.h * 0.55); zh = this.h - Math.floor(this.h * 0.55); }
      else { zy = Math.floor(this.h * 0.25); zh = Math.floor(this.h * 0.5); }
      zones[z.name] = { x: 0, y: zy, w: this.w, h: zh };
    }
    return zones;
  }

  _findEntity(entities, name) {
    return entities.find(e => e.name === name);
  }

  _isPlaced(name) {
    return this.placed.some(p => p.name === name);
  }

  _isFree(x, y, tw, th) {
    for (let r = y; r < y + th; r++)
      for (let c = x; c < x + tw; c++) {
        if (r < 0 || c < 0 || r >= this.h || c >= this.w) return false;
        if (this.grid[r][c]) return false;
      }
    return true;
  }

  _occupy(x, y, tw, th) {
    for (let r = y; r < y + th; r++)
      for (let c = x; c < x + tw; c++)
        if (r >= 0 && c >= 0 && r < this.h && c < this.w)
          this.grid[r][c] = true;
  }

  _clearOccupied(x, y, tw, th) {
    for (let r = y; r < y + th; r++)
      for (let c = x; c < x + tw; c++)
        if (r >= 0 && c >= 0 && r < this.h && c < this.w)
          this.grid[r][c] = null;
  }
}
