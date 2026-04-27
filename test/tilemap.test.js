import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const tm = JSON.parse(readFileSync('public/assets/tilemap.json', 'utf8'));

describe('tilemap.json structure', () => {
  it('has required top-level fields', () => {
    expect(tm.tileSize).toBe(32);
    expect(tm.scale).toBe(3);
    expect(tm.size).toEqual({ cols: 18, rows: 10 });
    expect(tm.tileset).toBeDefined();
    expect(tm.sprites).toBeDefined();
    expect(tm.ground).toBeDefined();
    expect(tm.furniture_objects).toBeDefined();
    expect(tm.zones).toBeDefined();
    expect(tm.statusToZone).toBeDefined();
    expect(tm.agentSlots).toBeDefined();
  });

  it('ground rows match size', () => {
    expect(tm.ground.length).toBe(tm.size.rows);
    tm.ground.forEach((row, i) => {
      expect(row.length, `row ${i}`).toBe(tm.size.cols);
    });
  });

  it('ground chars are all in legend', () => {
    const valid = new Set(Object.keys(tm.legend));
    tm.ground.forEach((row, r) => {
      [...row].forEach((ch, c) => {
        expect(valid.has(ch), `ground[${r}][${c}]='${ch}'`).toBe(true);
      });
    });
  });

  it('furniture_objects have valid ids matching sprites', () => {
    const spriteKeys = new Set(Object.keys(tm.sprites));
    tm.furniture_objects.filter(o => !o._comment).forEach((obj, i) => {
      expect(spriteKeys.has(obj.id), `objects[${i}].id='${obj.id}'`).toBe(true);
    });
  });

  it('zone slots are within bounds', () => {
    for (const [name, zone] of Object.entries(tm.zones)) {
      const b = zone.bounds;
      zone.slots.forEach((s, i) => {
        expect(s.col >= b.colStart && s.col <= b.colEnd, `${name}.slots[${i}] col`).toBe(true);
        expect(s.row >= b.rowStart && s.row <= b.rowEnd, `${name}.slots[${i}] row`).toBe(true);
      });
    }
  });

  it('agentSlots reference existing slot ids', () => {
    const allSlots = new Set();
    for (const zone of Object.values(tm.zones)) {
      zone.slots.forEach(s => allSlots.add(s.id));
    }
    for (const [agent, mapping] of Object.entries(tm.agentSlots)) {
      expect(allSlots.has(mapping.office), `${agent}.office`).toBe(true);
      expect(allSlots.has(mapping.living), `${agent}.living`).toBe(true);
    }
  });

  it('statusToZone maps to valid zone names or null', () => {
    const zoneNames = new Set(Object.keys(tm.zones));
    for (const [status, zone] of Object.entries(tm.statusToZone)) {
      expect(zone === null || zoneNames.has(zone), `${status} → ${zone}`).toBe(true);
    }
  });
});
