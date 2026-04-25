import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config', () => {
  it('has default bridge URL', () => {
    const config = loadConfig();
    expect(config.bridgeUrl).toBe('http://localhost:18010');
  });

  it('has empty default token', () => {
    const config = loadConfig();
    expect(config.authToken).toBe('');
  });
});
