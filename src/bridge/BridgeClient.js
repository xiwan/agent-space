import config from '../config.js';

export default class BridgeClient {
  constructor() {
    this.baseUrl = config.bridgeUrl;
    this.token = config.bridgeToken;
    this.failCount = 0;
  }

  async fetch(path) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    this.failCount = 0;
    return res.json();
  }

  async getHealth() {
    return this.fetch('/health');
  }

  async getHeartbeat() {
    return this.fetch('/heartbeat');
  }

  async getHeartbeatLogs() {
    return this.fetch('/heartbeat/logs');
  }

  async getStats() {
    return this.fetch('/stats');
  }
}
