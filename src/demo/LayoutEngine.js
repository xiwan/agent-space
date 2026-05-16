/**
 * LayoutEngine — 从物品列表推断约束，调用 LayoutSolver
 */
import { FURNITURE } from './TileMapper.js';
import { LayoutSolver } from './LayoutSolver.js';

export function autoLayout(items, bounds, seed = Date.now()) {
  const solver = new LayoutSolver(bounds.w + 2, bounds.h + 2, 1, seed);
  const scene = inferConstraints(items);
  console.group('🧩 Layout DSL (seed: ' + seed + ')');
  console.log('Entities:', scene.entities.map(e => `${e.name}(${e.tw}x${e.th})`).join(', '));
  console.log('Constraints:');
  for (const c of scene.constraints) {
    const parts = [c.type, c.entity];
    if (c.direction) parts.push(c.direction);
    if (c.target) parts.push('→', c.target);
    if (c.zone) parts.push('in', c.zone);
    if (c.distance) parts.push(`dist=${c.distance}`);
    console.log('  ', parts.join(' '));
  }
  if (scene.groups.length) console.log('Groups:', scene.groups.map(g => `${g.pattern}(${g.center}) [${g.members}]`));
  console.groupEnd();
  const result = solver.solve(scene);
  console.table(result.map(r => ({ item: r.item, x: r.x, y: r.y })));
  return result.map(r => ({
    item: r.item,
    x: r.x + bounds.x - 1,
    y: r.y + bounds.y - 1,
  }));
}

function inferConstraints(items) {
  const entities = [];
  const constraints = [];
  const groups = [];

  const wallItems = new Set(['whiteboard', 'bookshelf', 'shelf', 'frame', 'cabinet', 'tv']);
  const sofaItems = new Set(['sofa', 'armchair']);
  const cornerItems = new Set(['plant', 'lamp', 'floor_lamp', 'extinguisher']);

  let uid = 0;
  const nextId = (base) => `${base}_${uid++}`;

  let lastDeskName = null;
  let prevDeskName = null;
  const sofaNames = [];
  const tableNames = [];
  const plantNames = [];

  for (const item of items) {
    const name = item.item;
    const def = FURNITURE[name] || {};
    const tw = def.tw || 1, th = def.th || 1;

    if (wallItems.has(name)) {
      const eName = nextId(name);
      entities.push({ name: eName, item: name, tw, th });
      constraints.push({ type: 'against_wall', entity: eName, direction: 'north' });
    } else if (name === 'desk') {
      prevDeskName = lastDeskName;
      const eName = nextId('desk');
      lastDeskName = eName;
      entities.push({ name: eName, item: 'desk', tw, th });
      // Desks in work zone, row 2 (below wall items)
      constraints.push({ type: 'in_row', entity: eName, zone: 'work', row: 2 });
      if (prevDeskName) {
        constraints.push({ type: 'min_distance', entity: eName, target: prevDeskName, distance: 3 });
      }
    } else if (name === 'monitor') {
      if (lastDeskName) {
        const eName = nextId('monitor');
        entities.push({ name: eName, item: 'monitor', tw, th });
        constraints.push({ type: 'on_top_of', entity: eName, target: lastDeskName });
      }
    } else if (name === 'chair') {
      if (lastDeskName) {
        const eName = nextId('chair');
        entities.push({ name: eName, item: 'chair', tw, th });
        constraints.push({ type: 'in_front_of', entity: eName, target: lastDeskName });
        constraints.push({ type: 'accessible_from', entity: eName, direction: 'south' });
      }
    } else if (sofaItems.has(name)) {
      const eName = nextId(name);
      entities.push({ name: eName, item: name, tw, th });
      sofaNames.push(eName);
    } else if (name === 'table') {
      const eName = nextId('table');
      entities.push({ name: eName, item: 'table', tw, th });
      tableNames.push(eName);
    } else if (name === 'carpet') {
      const eName = nextId('carpet');
      entities.push({ name: eName, item: 'carpet', tw, th });
      constraints.push({ type: 'in_zone', entity: eName, zone: 'lounge' });
    } else if (cornerItems.has(name)) {
      const eName = nextId(name);
      entities.push({ name: eName, item: name, tw, th });
      plantNames.push(eName);
      const dirs = ['south', 'east', 'west', 'south'];
      constraints.push({ type: 'against_wall', entity: eName, direction: dirs[plantNames.length % dirs.length] });
    } else {
      const eName = nextId(name);
      entities.push({ name: eName, item: name, tw, th });
      constraints.push({ type: 'in_zone', entity: eName, zone: 'work' });
    }
  }

  // Lounge group: sofas surround table
  if (sofaNames.length > 0 && tableNames.length > 0) {
    groups.push({
      center: tableNames[0],
      centerItem: 'table',
      members: sofaNames,
      zone: 'lounge',
      pattern: 'surround',
    });
  } else if (sofaNames.length > 0) {
    // No table, just place sofas in lounge
    for (const s of sofaNames) {
      constraints.push({ type: 'in_zone', entity: s, zone: 'lounge' });
    }
  } else if (tableNames.length > 0) {
    for (const t of tableNames) {
      constraints.push({ type: 'in_zone', entity: t, zone: 'lounge' });
    }
  }

  // Symmetric plants
  if (plantNames.length >= 2) {
    constraints.push({ type: 'symmetric', entity: plantNames[0], mirror: plantNames[1], axis: 'vertical' });
  }

  return {
    entities,
    constraints,
    groups,
    zones: [
      { name: 'work', position: 'north' },
      { name: 'lounge', position: 'south' },
    ],
  };
}
