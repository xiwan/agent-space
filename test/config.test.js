import { describe, it, expect } from 'vitest';
import config from '../src/config.js';

describe('config', () => {
  it('has correct game dimensions', () => {
    expect(config.gameWidth).toBe(480);
    expect(config.gameHeight).toBe(320);
  });

  it('has office layout', () => {
    expect(config.office.cols).toBe(5);
    expect(config.office.rows).toBe(2);
    expect(config.office.maxSlots).toBe(10);
  });
});
