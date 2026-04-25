import config from '../config.js';

export default class BridgeClient {
  constructor() {
    this.failCount = 0;
    this.maxFails = 3;
  }

  get baseUrl() { return config.bridgeUrl; }
  get token() { return config.bridgeToken; }
  get disconnected() { return this.failCount >= this.maxFails; }

  async fetch(path) {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      this.failCount = 0;
      return res.json();
    } catch (err) {
      this.failCount++;
      console.warn(`[BridgeClient] ${path} failed (${this.failCount}/${this.maxFails}):`, err.message);
      return null;
    }
  }

  async getHealth() { return this.fetch('/health'); }
  async getHeartbeat() { return this.fetch('/heartbeat'); }
  async getHeartbeatLogs() { return this.fetch('/heartbeat/logs'); }
}
