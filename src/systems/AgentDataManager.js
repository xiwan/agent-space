/**
 * AgentDataManager.js — ACP Bridge 数据轮询，驱动 OfficeScene 状态更新
 * 复制到 src/systems/AgentDataManager.js
 */
export class AgentDataManager {
  constructor(scene) {
    this.scene = scene;
    this.timer = null;
    this._interval = 10000; // 10秒轮询
    this._healthyAgents = new Set(); // 记录 /health 中 alive=true 的 agents
  }

  start() {
    this._fetch();
    this._fetchHealth(); // 补充 /health 轮询
    this.timer = setInterval(() => {
      this._fetch();
      this._fetchHealth();
    }, this._interval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async _fetch() {
    try {
      const resp = await fetch('/api/heartbeat');

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();
      const snapshot = data.snapshot ?? {};
      const agents = snapshot.agents ?? {};

      Object.entries(agents).forEach(([name, a]) => {
        let s;
        if ((a.busy ?? 0) > 0) {
          s = 'busy';
        } else if ((a.idle ?? 0) > 0) {
          s = 'idle';
        } else {
          s = 'offline';
        }
        this.scene.updateAgentStatus(name, s);
        this._healthyAgents.add(name);
      });
    } catch (e) {
      console.warn('[AgentDataManager] heartbeat fetch failed:', e.message);
    }
  }

  async _fetchHealth() {
    try {
      const resp = await fetch('/api/health');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      // 处理 /health 中 alive=true 但 /heartbeat.snapshot.agents 中不存在的 agents
      data.agents?.forEach(a => {
        if (a.alive > 0 && a.enabled && a.mode !== 'heartbeat') {
          // 非心跳 agent（如 kiro），若 heartbeat 未返回，则默认为 idle
          if (!this._healthyAgents.has(a.name)) {
            // 首次 encounter，初始化为 idle
            this._healthyAgents.add(a.name);
            this.scene.updateAgentStatus(a.name, 'idle');
          }
        }
      });

      // 清理已下线的 agents
      if (data.agents) {
        const currentAlive = new Set(
          data.agents.filter(a => a.alive > 0).map(a => a.name)
        );
        this._healthyAgents.forEach(name => {
          if (!currentAlive.has(name)) {
            this.scene.updateAgentStatus(name, 'offline');
            this._healthyAgents.delete(name);
          }
        });
      }
    } catch (e) {
      console.warn('[AgentDataManager] health fetch failed:', e.message);
    }
  }
}
