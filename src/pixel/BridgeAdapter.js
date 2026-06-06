/**
 * BridgeAdapter — ACP Bridge → pixel-office config 适配
 *
 * 数据源 (按优先级):
 *   /health/agents    — per-session 实时 state (idle/busy/stale)，权威 busy 信号 (acp mode)
 *   /pipelines        — 兜底 busy 信号 (pty mode 不进 session pool, 只有 pipeline 引用; v2.1.1)
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
 * 从 /pipelines 响应中提取"正在 running 的 step.agent 集合"
 *
 * pipeline.status='running' 且 step.status='running' 才算 — pending 不算 (任务排队中,
 * agent 还没真正干活), completed/failed 也不算.
 *
 * 用作 pty 模式 agent 的 busy 信号兜底: pty agent 任务通过 pipeline 引用执行,
 * 但不会进 ACP session pool, 所以 /health/agents 看不到, 必须从 /pipelines 兜底.
 */
export function extractBusyAgentsFromPipelines(pipelinesResponse) {
  const set = new Set();
  const pipelines = pipelinesResponse?.pipelines ?? [];
  for (const p of pipelines) {
    if (p.status !== 'running') continue;
    for (const s of p.steps ?? []) {
      if (s.status === 'running' && s.agent) {
        set.add(s.agent);
      }
    }
  }
  return set;
}

/**
 * 决定 agent 状态
 *
 * 优先级 (从高到低):
 *   1. !enabled                                       → offline
 *   2. healthAgents (per-session) 任一 state=busy     → busy   ← acp 实时权威
 *   3. agent ∈ pipelineRunningSet                     → busy   ← pty 兜底 (v2.1.1)
 *   4. healthAgents alive_sessions > 0                → idle
 *   5. /health.agents alive>0 (无 healthAgents 数据)   → idle  (兼容 fallback)
 *   6. alive=0 + mode=pty + healthy=false             → error
 *   7. alive=0 (其他)                                 → offline
 *
 * ⚠️ 不再使用 /heartbeat snapshot 的 busy 字段 — 它是 5 分钟刷新一次的缓存快照,
 *    抓不到瞬时 busy. 仅用于取 description / domains.
 *
 * ⚠️ 不要用 health.pool.busy / jobs.running — 全局计数, 会让所有 alive agent
 *    在任意进程 busy 时全亮 busy.
 *
 * @param {string} name             — agent name
 * @param {object} health           — GET /health
 * @param {object} healthAgents     — GET /health/agents
 * @param {Set<string>} [pipelineRunningSet] — extractBusyAgentsFromPipelines() 输出, 可为 null
 */
export function deriveStatus(name, health, healthAgents, pipelineRunningSet = null) {
  const healthAgent = health?.agents?.find(a => a.name === name);
  if (!healthAgent || !healthAgent.enabled) return 'offline';

  const detail = healthAgents?.agents?.find(a => a.name === name);
  if (detail) {
    const sessions = detail.sessions || [];
    const hasBusy = sessions.some(s => s.state === 'busy');
    if (hasBusy) return 'busy';
  }

  // v2.1.1: pty mode 兜底 — pipeline 在跑 ⇒ busy, 即使 session 看起来 idle / 不存在.
  // 也兼顾 acp idle session 但被 pipeline 引用的情况 (并集语义).
  if (pipelineRunningSet?.has(name)) return 'busy';

  if (detail) {
    if ((detail.alive_sessions ?? 0) > 0) return 'idle';
    // detail 存在但没活跃 session → 走下面的 alive=0 分支
  }

  if (healthAgent.alive > 0) return 'idle';

  // mesh remote agents: no local sessions, treat healthy as idle
  if (healthAgent.mode === 'mesh' && healthAgent.healthy) return 'idle';

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
 * @param {object} pipelines     — GET /pipelines (pty busy 兜底, 可为 null)
 * @param {object} opts          — { officeSlots, receptionSlots, mapConfig, getTargetCell, cellToPx }
 *
 * mapConfig 路径 (v2.4.0):
 *   传入 mapConfig + 注入的 getTargetCell/cellToPx (依赖反转, 避免循环依赖) →
 *   状态切换时优先用区域 + 哈希分配; 单 agent 在该 zone 没配置 → fallback 到 defaultSlots.
 */
export function adaptToPixelConfig(health, heartbeat, healthAgents, pipelines, opts = {}) {
  const enabledAgents = (health?.agents ?? [])
    .filter(a => a.enabled)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const officeSlots    = opts.officeSlots    ?? defaultSlots('office',    enabledAgents.length || 1);
  const receptionSlots = opts.receptionSlots ?? defaultSlots('reception', enabledAgents.length || 1);
  const mapConfig      = opts.mapConfig      ?? null;
  const getTargetCell  = opts.getTargetCell  ?? null;
  const cellToPx       = opts.cellToPx       ?? null;

  const pipelineRunningSet = extractBusyAgentsFromPipelines(pipelines);

  const agents = enabledAgents.map((a, idx) => {
    const status = deriveStatus(a.name, health, healthAgents, pipelineRunningSet);
    const hbMeta = heartbeat?.snapshot?.agents?.[a.name] ?? {};
    const agentDetail = healthAgents?.agents?.find(d => d.name === a.name);
    const color = idx % SPRITE_COUNT;

    // v2.4.0: 优先 mapConfig zone; 没配置则 fallback 到 defaultSlots
    let x, y;
    if (mapConfig && getTargetCell && cellToPx) {
      const cell = getTargetCell(a.name, status, mapConfig);
      if (cell) {
        const [px, py] = cellToPx(cell[0], cell[1], mapConfig.gridSize);
        x = px;
        y = py;
      }
    }
    if (x === undefined) {
      const slotPool = (status === 'busy' || status === 'error') ? officeSlots : receptionSlots;
      const slot = slotPool[idx % slotPool.length];
      x = slot.x;
      y = slot.y;
    }

    return {
      id: idx,
      name: a.name,
      color,
      x,
      y,
      state: status,
      active: status !== 'offline',
      description: hbMeta.description || agentDetail?.description || '',
      domains: hbMeta.domains || agentDetail?.domains || [],
      mesh: a.mode === 'mesh' ? true : false,
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
 * 轮询封装: 定时拉 /api/health + /api/health/agents + /api/pipelines (+ /api/heartbeat 缓慢), 适配后回调
 *
 * 拉取频率:
 *   - /health         — 每 tick (节奏快, 决定状态)
 *   - /health/agents  — 每 tick (per-session 实时 state, 决定 busy)
 *   - /pipelines      — 每 tick (pty 模式 busy 兜底, response 50KB 量级 OK)
 *   - /heartbeat      — 每 N tick 一次 (description/domains 慢变化, 默认 12 = 60s)
 */
export class BridgePoller {
  constructor({ intervalMs = 5000, heartbeatEveryNTicks = 12, fetchTimeoutMs = 4000, onConfig, onError } = {}) {
    this.intervalMs = intervalMs;
    this.heartbeatEveryNTicks = heartbeatEveryNTicks;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.onConfig = onConfig;
    this.onError = onError || ((e) => console.warn('[BridgePoller]', e.message));
    this.timer = null;
    this._aborted = false;
    this._tickCount = 0;
    this._cachedHeartbeat = null;

    // v2.13.4: 串行守卫 + 连续失败计数
    this._inFlight = false;
    this._consecutiveFailures = 0;

    // v2.4.0: mapConfig + helper 函数 (依赖反转, 由 caller 注入避免循环 import)
    this._mapConfig = null;
    this._getTargetCell = null;
    this._cellToPx = null;
  }

  /**
   * v2.4.0: 注入/替换 mapConfig (用户编辑后保存或切换背景时调用).
   * 不传或传 null 表示不使用 mapConfig (回退 defaultSlots).
   */
  setMapConfig(mapConfig, getTargetCell, cellToPx) {
    this._mapConfig = mapConfig || null;
    this._getTargetCell = getTargetCell || null;
    this._cellToPx = cellToPx || null;
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
    // v2.13.4: 串行守卫 — 上一次 tick 还没 settle, 跳过这次, 防止 fetch hang 时 setInterval 堆叠
    if (this._inFlight) return;
    this._inFlight = true;

    try {
      // v2.13.4: AbortController 超时 (默认 4s, 比 5s tick 短一拍, 避免堆叠)
      // 网络层错误 / abort / 4xx 都吞成 null, 由上层判断 health 是否拿到.
      // 注意: ACP Bridge 在 status=unhealthy 时返回 HTTP 503, 但 body 完全有效.
      // 这里只丢 4xx, 5xx 仍然解析 body — agent 状态信息是有用的.
      const timeoutMs = this.fetchTimeoutMs;
      const safeFetch = async (url) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const r = await fetch(url, { signal: ctrl.signal });
          if (r.status >= 400 && r.status < 500) return null;
          try { return await r.json(); } catch { return null; }
        } catch {
          return null;
        } finally {
          clearTimeout(t);
        }
      };

      const fetches = [
        safeFetch('/api/health'),
        safeFetch('/api/health/agents'),
        safeFetch('/api/pipelines'),
      ];
      const needHeartbeat = this._tickCount % this.heartbeatEveryNTicks === 0;
      if (needHeartbeat) fetches.push(safeFetch('/api/heartbeat'));

      const results = await Promise.allSettled(fetches);
      const health        = results[0].status === 'fulfilled' ? results[0].value : null;
      const healthAgents  = results[1].status === 'fulfilled' ? results[1].value : null;
      const pipelines     = results[2].status === 'fulfilled' ? results[2].value : null;
      if (needHeartbeat) {
        const hb = results[3].status === 'fulfilled' ? results[3].value : null;
        if (hb) this._cachedHeartbeat = hb;
      }

      this._tickCount++;

      if (!health) {
        this._consecutiveFailures++;
        this.onError(new Error('health unreachable'), this._consecutiveFailures);
        return;
      }

      const cfg = adaptToPixelConfig(health, this._cachedHeartbeat, healthAgents, pipelines, {
        mapConfig: this._mapConfig,
        getTargetCell: this._getTargetCell,
        cellToPx: this._cellToPx,
      });
      this._consecutiveFailures = 0;
      this.onConfig(cfg);
    } catch (e) {
      this._consecutiveFailures++;
      this.onError(e, this._consecutiveFailures);
    } finally {
      this._inFlight = false;
    }
  }
}
