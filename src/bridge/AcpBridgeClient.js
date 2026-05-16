/**
 * AcpBridgeClient — polls GET /agents + GET /runs for agent & job status
 */
export class AcpBridgeClient {
  constructor(baseUrl = '/api', token = '') {
    this.baseUrl = baseUrl;
    this.token = token;
    this._timer = null;
    this._interval = 10000;
    this.onUpdate = null; // callback({agents, jobs})
  }

  start() {
    this._poll();
    this._timer = setInterval(() => this._poll(), this._interval);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  async _poll() {
    try {
      const [agents, runs] = await Promise.all([
        this._get('/agents'),
        this._get('/runs'),
      ]);
      if (this.onUpdate) this.onUpdate({ agents, jobs: runs });
    } catch (e) {
      console.warn('[AcpBridgeClient] poll error:', e.message);
    }
  }

  async _get(path) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(`${this.baseUrl}${path}`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}
