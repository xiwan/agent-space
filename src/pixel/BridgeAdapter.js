/**
 * BridgeAdapter — ACP Bridge → pixel-office config 适配
 *
 * 数据源 (按优先级):
 *   /health/agents    — per-session 实时 state (idle/busy/stale)，权威 busy 信号
 *   /health           — pool / 全局健康
 *   /heartbeat        — 仅取 description / domains 用于面板 (snapshot 是 5 分钟缓存,
 *                       且其 busy 字段是上次心跳轮触发 refresh 时的瞬时态, 不可靠)
 *
 * 输出格式:
 *   {
 *     agents: [{ id, name, color, x, y, state, active, description, domains }],
 *     rooms:  [{ name, x, y }]
 *   }
 *
 * sprite 分配: enabled agents 按 name 字典序排序 → idx % SPRITE_COUNT
 */

export const SPRITE_COUNT = 6;

/**
 * 决定 agent 状态
 *
 * 优先级 (从高到低):
 *   1. !enabled                                       → offline
 *   2. healthAgents (per-session) 任一 state=busy     → busy   ← 实时权威
 *   3. healthAgents alive_sessions > 0                → idle
 *   4. /health.agents alive>0 (无 healthAgents 数据)   → idle  (兼容 fallback)
 *   5. alive=0 + mode=pty + healthy=false             → error
 *   6. alive=0 (其他)                                 → offline
 *
 * ⚠️ 不再使用 /heartbeat snapshot 的 busy 字段 — 它是 5 分钟刷新一次的缓存快照,
 *    抓不到瞬时 busy. 仅用于取 description / domains.
 *
 * ⚠️ 不要用 health.pool.busy / jobs.running — 全局计数, 会让所有 alive agent
 *    在任意进程 busy 时全亮 busy.
 */
export function deriveStatus(name, health, healthAgents) {
  const healthAgent = health?.agents?.find(a => a.name === name);
  if (!healthAgent || !healthAgent.enabled) return 'offline';

  const detail = healthAgents?.agents?.find(a => a.name === name);
  if (detail) {
    const sessions = detail.sessions || [];
    const hasBusy = sessions.some(s => s.state === 'busy');
    if (hasBusy) return 'busy';
    if ((detail.alive_sessions ?? 0) > 0) return 'idle';
    // detail 存在但没活跃 session → 走下面的 alive=0 分支
  }

  if (healthAgent.alive > 0) return 'idle';

  // alive = 0
  if (healthAgent.mode === 'pty' && healthAgent.healthy === false) return 'error';
  return 'offline';
}

/**
 * 默认 slot 布局
 *   office 区: 上半部, baseY=400, 5 列
 *   reception 区: 下半部, baseY=700, 5 列
 */
export function defaultSlots(zone, n) {
  const baseY = zone === 'office' ? 400 : 700;
  const slots = [];
  for (let i = 0; i < n; i++) {
    slots.push({
      x: 120 + (i % 5) * 110,
      y: baseY + Math.floor(i / 5) * 60,
    });
  }
  return slots;
}

/**
 * 主适配函数
 *
 * @param {object} health        — GET /health
 * @param {object} heartbeat     — GET /heartbeat (仅用 description/domains, 可为 null)
 * @param {object} healthAgents  — GET /health/agents (per-session 实时 state, 可为 null)
 * @param {object} opts          — { officeSlots, receptionSlots }
 */
export function adaptToPixelConfig(health, heartbeat, healthAgents, opts = {}) {
  const enabledAgents = (health?.agents ?? [])
    .filter(a => a.enabled)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const officeSlots    = opts.officeSlots    ?? defaultSlots('office',    enabledAgents.length || 1);
  const receptionSlots = opts.receptionSlots ?? defaultSlots('reception', enabledAgents.length || 1);

  const agents = enabledAgents.map((a, idx) => {
    const status = deriveStatus(a.name, health, healthAgents);
    const hbMeta = heartbeat?.snapshot?.agents?.[a.name] ?? {};
    const color = idx % SPRITE_COUNT;

    const slotPool = (status === 'busy' || status === 'error') ? officeSlots : receptionSlots;
    const slot = slotPool[idx % slotPool.length];

    return {
      id: idx,
      name: a.name,
      color,
      x: slot.x,
      y: slot.y,
      state: status,
      active: status !== 'offline',
      description: hbMeta.description || '',
      domains: hbMeta.domains || [],
    };
  });

  return {
    agents,
    rooms: [
      { name: 'Office',    x: 320, y: 400 },
      { name: 'Reception', x: 320, y: 700 },
    ],
  };
}

/**
 * 轮询封装: 定时拉 /api/health + /api/health/agents (+ /api/heartbeat 缓慢), 适配后回调
 *
 * 拉取频率:
 *   - /health         — 每 tick (节奏快, 决定状态)
 *   - /health/agents  — 每 tick (per-session 实时 state, 决定 busy)
 *   - /heartbeat      — 每 N tick 一次 (description/domains 慢变化, 默认 12 = 60s)
 */
export class BridgePoller {
  constructor({ intervalMs = 5000, heartbeatEveryNTicks = 12, onConfig, onError } = {}) {
    this.intervalMs = intervalMs;
    this.heartbeatEveryNTicks = heartbeatEveryNTicks;
    this.onConfig = onConfig;
    this.onError = onError || ((e) => console.warn('[BridgePoller]', e.message));
    this.timer = null;
    this._aborted = false;
    this._tickCount = 0;
    this._cachedHeartbeat = null;
  }

  start() {
    this._aborted = false;
    this._tick();
    this.timer = setInterval(() => this._tick(), this.intervalMs);
  }

  stop() {
    this._aborted = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async _tick() {
    if (this._aborted) return;
    try {
      // 注意: ACP Bridge 在 status=unhealthy 时返回 HTTP 503, 但 body 完全有效.
      // 这里只丢 4xx 和网络错误, 5xx 仍然解析 body — agent 状态信息是有用的.
      const safeFetch = async (url) => {
        const r = await fetch(url);
        if (r.status >= 400 && r.status < 500) return null;
        try { return await r.json(); } catch { return null; }
      };

      const fetches = [
        safeFetch('/api/health'),
        safeFetch('/api/health/agents'),
      ];
      const needHeartbeat = this._tickCount % this.heartbeatEveryNTicks === 0;
      if (needHeartbeat) fetches.push(safeFetch('/api/heartbeat'));

      const results = await Promise.allSettled(fetches);
      const health        = results[0].status === 'fulfilled' ? results[0].value : null;
      const healthAgents  = results[1].status === 'fulfilled' ? results[1].value : null;
      if (needHeartbeat) {
        const hb = results[2].status === 'fulfilled' ? results[2].value : null;
        if (hb) this._cachedHeartbeat = hb;
      }

      this._tickCount++;

      if (!health) {
        this.onError(new Error('health unreachable'));
        return;
      }

      const cfg = adaptToPixelConfig(health, this._cachedHeartbeat, healthAgents);
      this.onConfig(cfg);
    } catch (e) {
      this.onError(e);
    }
  }
}
