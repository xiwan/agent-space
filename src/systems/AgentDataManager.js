/**
 * AgentDataManager — 轮询 /health + /heartbeat 驱动 agent 状态
 *
 * 状态判断优先级:
 *   1. /heartbeat snapshot.agents 有 per-agent busy/idle → 精确判断
 *   2. /health agents[] 有 alive/enabled → 判断在线/离线
 *   3. /health pool.busy + jobs.running → 推断非 heartbeat agent 是否 busy
 */
export class AgentDataManager {
  constructor(scene) {
    this.scene = scene;
    this.timer = null;
    this._interval = 10000;
    this._heartbeatAgents = {};  // name → {busy, idle} 来自 /heartbeat
    this._healthData = null;     // 最新 /health 响应
  }

  start() {
    this._poll();
    this.timer = setInterval(() => this._poll(), this._interval);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async _poll() {
    // 并行请求
    const [health, heartbeat] = await Promise.allSettled([
      this._get('/api/health'),
      this._get('/api/heartbeat'),
    ]);

    const hData = health.status === 'fulfilled' ? health.value : null;
    const hbData = heartbeat.status === 'fulfilled' ? heartbeat.value : null;

    if (!hData) return; // health 是必须的

    this._healthData = hData;

    // 从 heartbeat 提取 per-agent busy/idle
    const hbAgents = hbData?.snapshot?.agents ?? {};
    this._heartbeatAgents = hbAgents;

    // 从 health 获取全局 busy 信息
    const poolBusy = hData.pool?.busy ?? 0;
    const jobsRunning = hData.jobs?.running ?? 0;
    const globalBusy = poolBusy > 0 || jobsRunning > 0;

    // 构建已知 agent 集合（health 是权威来源）
    const knownAlive = new Set();
    const allAgents = hData.agents ?? [];

    for (const a of allAgents) {
      if (!a.enabled) continue;

      if (a.alive > 0) {
        knownAlive.add(a.name);

        // 优先用 heartbeat 的 per-agent 数据
        const hb = hbAgents[a.name];
        if (hb) {
          const status = (hb.busy ?? 0) > 0 ? 'busy' : 'idle';
          this.scene.updateAgentStatus(a.name, status);
        } else {
          // 非 heartbeat agent: 用全局 busy 推断
          // 如果全局有 busy 且该 agent alive，可能是它在忙
          // 但无法确定是哪个，保守策略: alive 就是 idle
          this.scene.updateAgentStatus(a.name, globalBusy ? 'busy' : 'idle');
        }
      } else {
        this.scene.updateAgentStatus(a.name, a.healthy === false ? 'error' : 'offline');
      }
    }

    // 标记 health 中不再出现的 agent 为 offline
    const tm = this.scene._tilemap;
    if (tm?.agentSlots) {
      for (const name of Object.keys(tm.agentSlots)) {
        if (!knownAlive.has(name)) {
          this.scene.updateAgentStatus(name, 'offline');
        }
      }
    }
  }

  async _get(path) {
    const resp = await fetch(path);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }
}
