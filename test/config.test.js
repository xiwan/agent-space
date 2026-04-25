import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config', () => {
  it('has correct game dimensions', () => {
    const config = loadConfig();
    expect(config.gameWidth).toBe(480);
    expect(config.gameHeight).toBe(320);
  });

  it('has default bridge URL', () => {
    const config = loadConfig();
    expect(config.bridgeUrl).toBe('http://localhost:18010');
  });
});
