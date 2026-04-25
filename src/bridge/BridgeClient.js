/**
 * BridgeClient — polls ACP Bridge APIs and emits state updates.
 */
export class BridgeClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.listeners = [];
    this._timers = [];
    this._failCount = 0;
    this.connected = false;
    /** @type {{ agents: Array, pool: Object } | null} */
    this.health = null;
    /** @type {{ enabled_agents: string[], snapshot: Object } | null} */
    this.heartbeat = null;
    /** @type {Array} */
    this.logs = [];
  }

  /** Subscribe to state changes. cb receives (client). */
  onChange(cb) { this.listeners.push(cb); }
  _emit() { this.listeners.forEach(cb => cb(this)); }

  async _fetch(path) {
    const headers = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(`${this.baseUrl}${path}`, { headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  async poll() {
    try {
      const [health, heartbeat, logs] = await Promise.all([
        this._fetch('/health'),
        this._fetch('/heartbeat').catch(() => null),
        this._fetch('/heartbeat/logs').catch(() => ({ logs: [] })),
      ]);
      this.health = health;
      this.heartbeat = heartbeat;
      this.logs = logs.logs || [];
      this._failCount = 0;
      this.connected = true;
    } catch (e) {
      this._failCount++;
      if (this._failCount >= 3) this.connected = false;
      console.warn('BridgeClient poll error:', e.message);
    }
    this._emit();
  }

  start(interval = 10000) {
    this.poll();
    this._timers.push(setInterval(() => this.poll(), interval));
  }

  stop() {
    this._timers.forEach(clearInterval);
    this._timers = [];
  }

  /** Derive per-agent state: offline | idle | busy | error */
  getAgentState(agentName) {
    if (!this.health) return 'offline';
    const agent = this.health.agents?.find(a => a.name === agentName);
    if (!agent || !agent.enabled) return 'offline';
    if (agent.alive === 0) return 'offline';
    if (!agent.healthy) return 'error';
    // Check heartbeat snapshot for busy/idle detail
    const snap = this.heartbeat?.snapshot?.agents?.[agentName];
    if (snap && snap.busy > 0) return 'busy';
    return 'idle';
  }

  /** Get enabled agent names in order. */
  getAgentNames() {
    if (!this.health) return [];
    return this.health.agents
      .filter(a => a.enabled)
      .map(a => a.name);
  }

  /** Get recent non-silent chat entries. */
  getRecentChats(maxAge = 300) {
    const cutoff = Date.now() / 1000 - maxAge;
    return this.logs.filter(l => !l.silent && l.ts > cutoff);
  }
}
