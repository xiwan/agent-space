/**
 * CommandHistory — 命令提交记录 + 状态轮询 + DOM 渲染 (v2.10.0)
 *
 * 数据模型 (内存数组, 页面刷新清空):
 *   {
 *     id: string                 — uuid (前端生成, 跟 server id 不同, 因为 sync run 没 id)
 *     kind: 'run'|'job'|'pipeline'
 *     mode: 'single'|'sequence'|... (UI 显示)
 *     agents: string[]
 *     prompt: string             — 提交时的 prompt (conversation 是 topic)
 *     submittedAt: number        — Date.now()
 *     completedAt: number|null
 *     status: 'pending'|'running'|'succeeded'|'failed'
 *     remoteId: string|null      — server 返回的 job_id / pipeline_id (run 没有)
 *     output: any                — 终态时的结果摘要
 *     error: string|null
 *   }
 *
 * 轮询 (5s, 与 BridgePoller 对齐):
 *   遍历未终态 (kind=job/pipeline) 记录, 调 client.pollJob / pollPipeline,
 *   更新 status / output. 终态后停止轮询. run 同步提交时已经拿到结果, 不轮询.
 *
 * DOM:
 *   container.innerHTML 重渲染 (列表通常 < 50, 无性能问题)
 *
 * 触发气泡 (v2.10.0):
 *   onAgentOutput(name, text) 回调 — 收到新输出时触发, 由外部把它转给 PixelRenderer.enqueueBubble
 */

const POLL_INTERVAL_MS = 5000;
const LIVE_POLL_INTERVAL_MS = 3000; // v2.14.1: 降频避免 429 (was 1500)
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'completed', 'failure', 'success', 'error']);

// v2.13.0: 持久化常量
const STORAGE_KEY = 'pixel.commandHistory.v1';
const STORAGE_VERSION = 1;
const MAX_RECORDS = 50;            // FIFO
const MAX_OUTPUT_BYTES = 10 * 1024; // 单条 output 序列化超此 → 截断

let _idCounter = 0;
function genId() {
  _idCounter += 1;
  return `cmd-${Date.now().toString(36)}-${_idCounter}`;
}

/**
 * 把 server 返回的 status 字符串归一化为 'running' | 'succeeded' | 'failed' | 'pending'.
 * ACP Bridge 文档没在 api-reference 里直接列出 jobs/pipelines 的所有 status 值, 这里做防御性映射.
 */
export function normalizeStatus(raw) {
  if (!raw) return 'pending';
  const s = String(raw).toLowerCase();
  if (s === 'succeeded' || s === 'success' || s === 'completed' || s === 'done') return 'succeeded';
  if (s === 'failed' || s === 'failure' || s === 'error') return 'failed';
  if (s === 'running' || s === 'in_progress') return 'running';
  return 'pending';
}

/**
 * 从 job/pipeline 响应里抽取 agent 输出的简短字符串, 用于气泡.
 * jobs: typically { result: { ... } } or { output: "..." }
 * pipelines: { steps: [{ agent, output }] } — 取最近完成的 step
 */
export function extractAgentBubbles(remote, kind) {
  const out = [];
  if (!remote) return out;
  if (kind === 'job' || kind === 'run') {
    const text = pickSingleText(remote);
    if (text) {
      out.push({ agent: remote.agent || null, text: String(text).trim().slice(0, 140) });
    }
  } else if (kind === 'pipeline') {
    // conversation mode: transcript
    if (Array.isArray(remote.transcript) && remote.transcript.length > 0) {
      const last = remote.transcript[remote.transcript.length - 1];
      const text = pickSingleText(last);
      if (text && last.agent) {
        out.push({ agent: last.agent, text: String(text).trim().slice(0, 140) });
      }
    }
    // sequence/parallel/race: steps
    if (out.length === 0 && Array.isArray(remote.steps)) {
      for (const step of remote.steps) {
        const text = pickSingleText(step);
        if (text && step.agent) {
          out.push({ agent: step.agent, text: String(text).trim().slice(0, 140) });
        }
      }
    }
  }
  return out;
}

/**
 * v2.11.0: 把 server 响应抽成可读 conversation turns.
 *
 * 输出: { turns: Array<{agent, text, turn?, duration?, status?, isWinner?}>, hasContent: boolean }
 *
 * 提取优先级:
 *   run/job (单 agent, agent 名由 caller 关联):
 *     1. response.output[*].parts[*].content (ACP 标准)
 *     2. response.result.text
 *     3. response.result.output (非对象)
 *     4. response.output (string)
 *     5. response.text
 *     → 都没 → hasContent=false
 *
 *   pipeline:
 *     - conversation: response.transcript[] = [{turn, agent, content, duration}, ...]
 *       (acp-bridge 真实字段名是 transcript, 不是 turns;
 *        v2.13.1: 修复 v2.11.0 起的字段名错误)
 *     - 向后兼容: 若无 transcript 但 response.turns 是数组 (旧测试 fixture) → 仍接受
 *     - sequence/parallel/race: response.steps[] 同 run/job 同样的字段优先级,
 *       agent = step.agent; 子项额外携带 status / duration / isWinner (race)
 *     - 都没 → hasContent=false
 *
 * 长 text 截断到 800 字符 + ' … (truncated)'.
 *
 * @param {object} remote — server 原响应
 * @param {'run'|'job'|'pipeline'} kind
 * @param {string|null} fallbackAgent — caller 传单 agent (run/job 用)
 * @returns {{turns: Array, hasContent: boolean}}
 */
const MAX_TURN_TEXT = 800;

export function extractDisplayText(remote, kind, fallbackAgent = null) {
  const empty = { turns: [], hasContent: false };
  if (!remote || typeof remote !== 'object') return empty;

  if (kind === 'run' || kind === 'job') {
    const text = pickSingleText(remote);
    if (text == null) return empty;
    return {
      turns: [{ agent: fallbackAgent, text: truncate(text, MAX_TURN_TEXT) }],
      hasContent: true,
    };
  }

  if (kind === 'pipeline') {
    // === conversation: response.transcript[] (acp-bridge 真实字段) ===
    if (Array.isArray(remote.transcript) && remote.transcript.length > 0) {
      const turns = remote.transcript
        .map(t => {
          const text = pickSingleText(t);
          if (text == null) return null;
          const out = { agent: t.agent || fallbackAgent, text: truncate(text, MAX_TURN_TEXT) };
          if (typeof t.turn === 'number') out.turn = t.turn;
          if (typeof t.duration === 'number') out.duration = t.duration;
          return out;
        })
        .filter(Boolean);
      if (turns.length > 0) return { turns, hasContent: true };
    }
    // 向后兼容: response.turns 是数组形式 (老测试 fixture, 非 acp-bridge 真实形态)
    if (Array.isArray(remote.turns) && remote.turns.length > 0) {
      const turns = remote.turns
        .map(t => {
          const text = pickSingleText(t);
          if (text == null) return null;
          const out = { agent: t.agent || fallbackAgent, text: truncate(text, MAX_TURN_TEXT) };
          if (typeof t.turn === 'number') out.turn = t.turn;
          if (typeof t.duration === 'number') out.duration = t.duration;
          return out;
        })
        .filter(Boolean);
      if (turns.length > 0) return { turns, hasContent: true };
    }
    // === sequence/parallel/race: steps[] ===
    if (Array.isArray(remote.steps) && remote.steps.length > 0) {
      // race 模式: 唯一 completed 的 step 是 winner
      const isRaceMode = remote.mode === 'race';
      const completedSteps = isRaceMode
        ? remote.steps.filter(s => s && s.status === 'completed' && (s.result || s.output))
        : null;
      const isWinnerOf = (s) => isRaceMode && completedSteps && completedSteps.length === 1 && completedSteps[0] === s;

      const turns = remote.steps
        .map(s => {
          const text = pickSingleText(s);
          // v2.14.2: show all steps (including pending/running without output)
          const out = { agent: s.agent || fallbackAgent, text: text ? truncate(text, MAX_TURN_TEXT) : '' };
          if (typeof s.duration === 'number') out.duration = s.duration;
          if (typeof s.status === 'string' && s.status) out.status = s.status;
          if (s.error) out.text = out.text || `❌ ${s.error}`;
          if (!out.text && s.prompt_preview) out._prompt_preview = s.prompt_preview;
          if (!out.text && !s.prompt_preview && s.status) out.text = `⏳ ${s.status}…`;
          if (isWinnerOf(s)) out.isWinner = true;
          if (Array.isArray(s._progress)) out._progress = s._progress;
          return out;
        })
        .filter(Boolean);
      if (turns.length > 0) return { turns, hasContent: true };
    }
    return empty;
  }

  return empty;
}

/**
 * v2.13.1: 抽 pipeline 顶层 metadata, 用于卡片头展示.
 * 返回字段全可选:
 *   { stopReason, totalDuration, transcriptTurns, paused, mode }
 */
export function extractPipelineMetadata(remote) {
  if (!remote || typeof remote !== 'object') return {};
  const out = {};
  if (typeof remote.stop_reason === 'string' && remote.stop_reason) out.stopReason = remote.stop_reason;
  if (typeof remote.duration === 'number') out.totalDuration = remote.duration;
  if (Array.isArray(remote.transcript)) out.transcriptTurns = remote.transcript.length;
  if (remote.paused === true) out.paused = true;
  if (typeof remote.mode === 'string') out.mode = remote.mode;
  return out;
}

/**
 * 从一个对象里抽 text. 字段优先级 (按真实 ACP Bridge 响应形态调整):
 *   0. obj.result (string) — ACP Bridge job/run 端点最常见形态
 *   1. obj.output[*].parts[*].content (ACP standard)
 *   2. obj.content (conversation turn)
 *   3. obj.result.text (result 是对象时)
 *   4. obj.result.output (string only)
 *   5. obj.text
 *   6. obj.output (string only — 不是 array)
 * 返回 string 或 null.
 */
function pickSingleText(obj) {
  if (!obj || typeof obj !== 'object') return null;
  // 0. result 是字符串 (v2.11.1: ACP Bridge /jobs/{id} 真实形态)
  if (typeof obj.result === 'string' && obj.result.trim()) return obj.result;
  // 1. ACP output[*].parts[*].content
  if (Array.isArray(obj.output)) {
    const parts = [];
    for (const o of obj.output) {
      if (o && Array.isArray(o.parts)) {
        for (const p of o.parts) {
          if (p && typeof p.content === 'string') parts.push(p.content);
        }
      }
    }
    if (parts.length > 0) return parts.join('');
  }
  // 2. conversation turn content
  if (typeof obj.content === 'string' && obj.content.trim()) return obj.content;
  // 3. result.text (result 是对象)
  if (obj.result && typeof obj.result === 'object' && typeof obj.result.text === 'string' && obj.result.text.trim()) return obj.result.text;
  // 4. result.output (string)
  if (obj.result && typeof obj.result === 'object' && typeof obj.result.output === 'string' && obj.result.output.trim()) return obj.result.output;
  // 5. text
  if (typeof obj.text === 'string' && obj.text.trim()) return obj.text;
  // 6. output (string only)
  if (typeof obj.output === 'string' && obj.output.trim()) return obj.output;
  return null;
}

function truncate(s, max) {
  const str = String(s);
  if (str.length <= max) return str;
  return str.slice(0, max) + ' … (truncated)';
}

/**
 * v2.13.0: 把 record 序列化前做大小检查, 超 MAX_OUTPUT_BYTES 截断 output 字段.
 * 返回新 record 副本 (不 mutate 原对象), 加 `_truncated: true` 标记.
 * 若 output 是字符串则截字串, 否则保留 JSON 但 stringify 截断后 reparse 失败时退回字符串.
 */
export function truncateRecordForStorage(rec, maxBytes = MAX_OUTPUT_BYTES) {
  if (!rec || rec.output == null) return rec;
  const json = JSON.stringify(rec.output);
  if (!json || json.length <= maxBytes) return rec;
  // 整个 output 退化为占位 + 部分原始 JSON 字符串 (供 raw 块仍能展示部分)
  const head = json.slice(0, maxBytes);
  return {
    ...rec,
    output: {
      _truncated: true,
      _original_size: json.length,
      _max_bytes: maxBytes,
      _preview: head + ' … (truncated for storage)',
    },
    _truncated: true,
  };
}

/**
 * v2.13.0: 从 localStorage 加载 records. 解析失败 / schema 不符 → 返回 [].
 * 不抛异常.
 */
export function loadRecordsFromStorage(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (!storage) return [];
  let raw;
  try { raw = storage.getItem(STORAGE_KEY); } catch { return []; }
  if (!raw) return [];
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  if (!data || typeof data !== 'object') return [];
  if (data.version !== STORAGE_VERSION) return [];
  if (!Array.isArray(data.records)) return [];
  // 防御性过滤: 过掉缺字段的 record
  return data.records.filter(r =>
    r && typeof r === 'object' && r.id && r.kind && r.status &&
    Array.isArray(r.agents) && typeof r.submittedAt === 'number'
  );
}

/**
 * v2.13.0: 写 records 到 localStorage. 失败 (quota / disabled / 等) 记 warn 不抛.
 * 写入前对每条 record 调用 truncateRecordForStorage.
 */
export function saveRecordsToStorage(records, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (!storage) return false;
  if (!Array.isArray(records)) return false;
  const safe = records.slice(0, MAX_RECORDS).map(r => truncateRecordForStorage(r));
  const payload = JSON.stringify({
    version: STORAGE_VERSION,
    savedAt: Date.now() / 1000,
    records: safe,
  });
  try {
    storage.setItem(STORAGE_KEY, payload);
    return true;
  } catch (e) {
    // quota exceeded / private mode / 等 — 不抛, 静默降级
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[CommandHistory] localStorage save failed:', e.message || e);
    }
    return false;
  }
}

export function clearStorage(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  if (!storage) return;
  try { storage.removeItem(STORAGE_KEY); } catch {}
}

export class CommandHistory {
  /**
   * @param {HTMLElement} container — 列表的根 DOM (innerHTML 会被重写)
   * @param {object} opts
   * @param {import('./CommandClient.js').CommandClient} opts.client
   * @param {(name:string|null, text:string) => void} [opts.onAgentOutput]
   * @param {number} [opts.pollIntervalMs] 默认 5000
   */
  constructor(container, opts = {}) {
    if (!container) throw new Error('CommandHistory: container required');
    if (!opts.client) throw new Error('CommandHistory: client required');
    this.container = container;
    this.client = opts.client;
    this.onAgentOutput = opts.onAgentOutput || (() => {});
    // v2.13.0: 通知外部 (Sidebar) 更新 record count UI
    this.onCountChange = opts.onCountChange || (() => {});
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    // v2.13.0: 持久化注入点 (测试可换成 mock storage)
    this._storage = (opts.storage !== undefined) ? opts.storage
                  : (typeof localStorage !== 'undefined' ? localStorage : null);
    this._records = []; // 最新在前
    this._timer = null;
    this._seenOutputs = new Set(); // dedup: `${recId}:${stepIdx}`
    // v2.14.2: SSE subscriptions (pipeline_id → EventSource)
    this._sseMap = new Map();

    // v2.13.0: 启动时尝试从 storage 加载
    const persisted = loadRecordsFromStorage(this._storage);
    if (persisted.length > 0) {
      this._records = persisted;
    }

    this._render();
  }

  /**
   * 提交一条命令并跟踪其后续状态.
   * @param {object} ctx — 提交上下文
   * @param {'run'|'job'|'pipeline'} ctx.kind
   * @param {string} ctx.mode
   * @param {string[]} ctx.agents
   * @param {string} ctx.prompt
   * @param {object} response — submitRun/Job/Pipeline 的返回
   */
  pushSubmission(ctx, response) {
    const rec = {
      id: genId(),
      kind: ctx.kind,
      mode: ctx.mode,
      agents: ctx.agents,
      prompt: ctx.prompt,
      submittedAt: Date.now(),
      completedAt: null,
      status: ctx.kind === 'run' ? 'succeeded' : 'pending',
      remoteId: ctx.kind === 'run' ? null : (response?.job_id ?? response?.pipeline_id ?? null),
      output: ctx.kind === 'run' ? response : null,
      error: null,
      _artifacts: ctx._artifacts || null, // per-step artifact metadata
    };
    if (rec.kind === 'run') {
      rec.completedAt = rec.submittedAt;
      // 对单 agent run: 触发气泡
      const outText = response?.result?.text ?? response?.output ?? null;
      if (outText && ctx.agents[0]) {
        this.onAgentOutput(ctx.agents[0], String(outText).trim());
      }
    }
    // v2.14.2: pipeline → subscribe SSE for real-time step updates
    if (rec.kind === 'pipeline' && rec.remoteId) {
      this._subscribeSSE(rec);
    }
    this._records.unshift(rec);
    // v2.13.0: cap 最多 50 条 + 持久化
    if (this._records.length > MAX_RECORDS) {
      this._records.length = MAX_RECORDS;
    }
    this._persist();
    this._render();
  }

  /**
   * v2.13.0: 清空内存 + 清 localStorage. UI 上由"Clear"按钮触发 (调用方负责确认).
   */
  clear() {
    this._records = [];
    this._seenOutputs.clear();
    clearStorage(this._storage);
    this._render();
  }

  /**
   * 启动 5s 轮询. 已启动则忽略.
   */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), this.pollIntervalMs);
    if (!this._liveTimer) {
      this._liveTimer = setInterval(() => this._tickLive(), LIVE_POLL_INTERVAL_MS);
    }
    // Re-subscribe SSE for any running pipelines restored from storage
    for (const rec of this._records) {
      if (rec.kind === 'pipeline' && rec.remoteId && !TERMINAL_STATUSES.has(rec.status) && !this._sseMap.has(rec.remoteId)) {
        this._subscribeSSE(rec);
      }
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._liveTimer) clearInterval(this._liveTimer);
    this._liveTimer = null;
    if (this._elapsedTimer) cancelAnimationFrame(this._elapsedTimer);
    this._elapsedTimer = null;
    // v2.14.2: close all SSE connections
    for (const es of this._sseMap.values()) es.close();
    this._sseMap.clear();
  }

  list() { return this._records.slice(); }

  /**
   * 立刻轮询一次 (用于测试或手动刷新).
   */
  async tickOnce() { return this._tick(); }

  // ===== private =====

  /**
   * v2.14.2: Subscribe to pipeline SSE events for real-time step progress.
   * Falls back to polling if EventSource unavailable or connection fails.
   */
  _subscribeSSE(rec) {
    if (typeof EventSource === 'undefined') return;
    const url = `/api/pipelines/${encodeURIComponent(rec.remoteId)}/events`;
    const es = new EventSource(url);
    this._sseMap.set(rec.remoteId, es);

    // Build/update rec.output.steps from events
    const ensureOutput = () => {
      if (!rec.output || typeof rec.output !== 'object') rec.output = {};
    };

    es.addEventListener('step_started', (e) => {
      try {
        const d = JSON.parse(e.data);
        ensureOutput();
        if (!Array.isArray(rec.output.steps)) rec.output.steps = [];
        // Ensure step slot exists
        while (rec.output.steps.length <= d.index) rec.output.steps.push({});
        rec.output.steps[d.index] = { agent: d.agent, status: 'running', _progress: [], prompt_preview: d.prompt_preview || '' };
        rec.status = 'running';
        this._persist();
        this._render();
        if (d.agent) this.onAgentOutput(d.agent, `▶ started: ${d.prompt_preview || ''}`.trim().slice(0, 140));
      } catch {}
    });

    es.addEventListener('step_progress', (e) => {
      try {
        const d = JSON.parse(e.data);
        ensureOutput();
        if (!Array.isArray(rec.output.steps)) rec.output.steps = [];
        while (rec.output.steps.length <= d.index) rec.output.steps.push({});
        const step = rec.output.steps[d.index];
        if (!step.agent && d.agent) step.agent = d.agent;
        if (!Array.isArray(step._progress)) step._progress = [];
        // Accumulate thinking text per step for bubble display
        if (!step._thinking) step._thinking = '';
        if (d.kind === 'message.thinking' && d.content) step._thinking += d.content;
        // Cap progress entries to avoid unbounded growth
        if (step._progress.length < 200) {
          // Collapse consecutive thinking chunks into one entry
          if (d.kind === 'message.thinking') {
            const last = step._progress[step._progress.length - 1];
            if (last && last.kind === 'message.thinking') {
              last.content = (last.content || '') + (d.content || '');
            } else {
              step._progress.push({ kind: d.kind, content: d.content });
            }
          } else {
            step._progress.push({ kind: d.kind, title: d.title, content: d.content, status: d.status, toolCallId: d.toolCallId, text: d.text });
          }
        }
        this._render();
        // Bubble: message.thinking → show accumulated tail
        if (d.kind === 'message.thinking' && d.agent && step._thinking.length > 5) {
          const tail = step._thinking.trim().slice(-80);
          this.onAgentOutput(d.agent, `💭 ${tail}`, { duration: 1500 });
        }
        // Bubble: message.part → agent output bubble
        if (d.kind === 'message.part' && d.content && d.agent) {
          const dedupKey = `prog:${rec.id}:${d.index}:${step._progress.length}`;
          if (!this._seenOutputs.has(dedupKey)) {
            this._seenOutputs.add(dedupKey);
            this.onAgentOutput(d.agent, String(d.content).trim().slice(0, 140), { duration: 2000 });
          }
        }
        // Bubble: tool.start → show tool name
        if (d.kind === 'tool.start' && d.title && d.agent) {
          const dedupKey = `prog:${rec.id}:${d.index}:tool:${d.toolCallId || d.title}`;
          if (!this._seenOutputs.has(dedupKey)) {
            this._seenOutputs.add(dedupKey);
            this.onAgentOutput(d.agent, `🔧 ${d.title}`, { duration: 2000 });
          }
        }
      } catch {}
    });

    es.addEventListener('step_completed', (e) => {
      try {
        const d = JSON.parse(e.data);
        ensureOutput();
        if (!Array.isArray(rec.output.steps)) rec.output.steps = [];
        while (rec.output.steps.length <= d.index) rec.output.steps.push({});
        rec.output.steps[d.index] = {
          agent: d.agent,
          status: d.status || 'completed',
          result: d.result_preview || '',
          duration: d.duration,
        };
        this._persist();
        this._render();
        if (d.agent && d.result_preview) {
          this.onAgentOutput(d.agent, String(d.result_preview).trim().slice(0, 140));
        }
      } catch {}
    });

    es.addEventListener('step_failed', (e) => {
      try {
        const d = JSON.parse(e.data);
        ensureOutput();
        if (!Array.isArray(rec.output.steps)) rec.output.steps = [];
        while (rec.output.steps.length <= d.index) rec.output.steps.push({});
        rec.output.steps[d.index] = {
          agent: d.agent,
          status: 'failed',
          error: d.error || 'unknown error',
          duration: d.duration,
        };
        this._persist();
        this._render();
      } catch {}
    });

    es.addEventListener('pipeline_done', (e) => {
      try {
        const d = JSON.parse(e.data);
        rec.status = normalizeStatus(d.status);
        rec.completedAt = Date.now();
        if (d.error) rec.error = d.error;
        ensureOutput();
        rec.output.status = d.status;
        rec.output.duration = d.duration;
        if (d.error) rec.output.error = d.error;
      } catch {}
      this._closeSSE(rec.remoteId);
      this._persist();
      this._render();
    });

    es.onerror = () => {
      // SSE failed — close and let polling take over
      this._closeSSE(rec.remoteId);
    };
  }

  _closeSSE(pipelineId) {
    const es = this._sseMap.get(pipelineId);
    if (es) { es.close(); this._sseMap.delete(pipelineId); }
  }

  async _tick() {
    const pending = this._records.filter(r =>
      (r.kind === 'job' || r.kind === 'pipeline') &&
      r.remoteId &&
      !TERMINAL_STATUSES.has(r.status) &&
      !this._sseMap.has(r.remoteId) // v2.14.2: skip if SSE active
    );
    if (pending.length === 0) return;
    // v2.14.1: 最多 poll 最新 2 条, 避免多条 running 时打穿 rate limit
    const targets = pending.slice(-2);
    let mutated = false;
    for (const rec of targets) {
      try {
        const remote = rec.kind === 'job'
          ? await this.client.pollJob(rec.remoteId)
          : await this.client.pollPipeline(rec.remoteId);
        const ns = normalizeStatus(remote.status);
        if (ns !== rec.status) {
          rec.status = ns;
          mutated = true;
        }
        // v2.14.2: always update output so UI shows step progress in real-time
        if (remote && (remote.steps || remote.transcript)) {
          rec.output = remote;
          mutated = true;
        }
        if (TERMINAL_STATUSES.has(ns)) {
          rec.completedAt = Date.now();
          rec.output = remote;
          mutated = true;
        }
        // 抽气泡 (dedup)
        const bubbles = extractAgentBubbles(remote, rec.kind);
        bubbles.forEach((b, i) => {
          const dedupKey = `${rec.id}:${i}:${b.text.slice(0, 32)}`;
          if (!this._seenOutputs.has(dedupKey)) {
            this._seenOutputs.add(dedupKey);
            const target = b.agent || rec.agents[0];
            if (target) this.onAgentOutput(target, b.text);
          }
        });
      } catch (e) {
        // v2.14.2: 429/5xx/network → transient, don't mark failed immediately
        const isTransient = /→ (429|5\d\d)|network error/i.test(e.message);
        if (isTransient) {
          rec._retries = (rec._retries || 0) + 1;
          if (rec._retries >= 30) {
            rec.status = 'failed';
            rec.error = `gave up after ${rec._retries} retries: ${e.message}`;
            rec.completedAt = Date.now();
            mutated = true;
          }
          // else: silently skip, retry next tick
        } else {
          rec.status = 'failed';
          rec.error = e.message;
          rec.completedAt = Date.now();
          mutated = true;
        }
      }
    }
    if (mutated) {
      // v2.13.0: 状态变化 → 持久化
      this._persist();
      this._render();
    }
  }

  /**
   * v2.14: 流式中间内容轮询 (1.5s) — 拿 partial content 喂 bubble.
   * 与 _tick 分离: _tick 负责状态转移 + 持久化 (5s),
   * _tickLive 只负责把 live content 推到 bubble (1.5s, 不持久化).
   *
   * 策略:
   *   job: 直接 GET /jobs/{id}/live, 用 parts_count 判断是否有新内容,
   *        有新内容则把 content 截到 140 字喂 bubble.
   *   pipeline: 走当前 running 的 step (从 5s 轮询的 output.steps 推断),
   *             如果暂无信息则跳过 (等 _tick 拿到 steps 后再来).
   */
  async _tickLive() {
    if (!this.client.pollJobLive) return; // 老 client 没接口
    const pending = this._records.filter(r =>
      (r.kind === 'job' || r.kind === 'pipeline') &&
      r.remoteId &&
      !TERMINAL_STATUSES.has(r.status) &&
      !this._sseMap.has(r.remoteId) // v2.14.2: skip if SSE active
    );
    if (pending.length === 0) return;

    // v2.14.1: 只 poll 最新 1 条, 避免多条 running 时打穿 rate limit
    const target = pending[pending.length - 1];
    try {
      if (target.kind === 'job') {
        const live = await this.client.pollJobLive(target.remoteId);
        this._consumeLiveContent(target, live, 'job');
      } else {
        // pipeline: 从最近一次 _tick 拿到的 output 推断当前 step
        const stepIdx = this._inferRunningStepIndex(target);
        if (stepIdx != null) {
          const live = await this.client.pollPipelineStepLive(target.remoteId, stepIdx);
          this._consumeLiveContent(target, live, 'pipeline-step');
        }
      }
    } catch (e) {
      // live 失败不影响正常 _tick — 静默
    }
  }

  /**
   * 从 live 响应中抽 content 喂 bubble. 用 parts_count 判断是否有新内容.
   * 同一 (rec, agent) 只在 parts_count 增长时才 emit.
   */
  _consumeLiveContent(rec, live, source) {
    if (!live || typeof live !== 'object') return;
    const content = typeof live.content === 'string' ? live.content : '';
    if (!content.trim()) return;
    const partsCount = typeof live.parts_count === 'number' ? live.parts_count : -1;
    const agent = live.agent || rec.agents[0];
    if (!agent) return;
    // dedup key: rec.id + step (pipeline) + parts_count
    const stepTag = source === 'pipeline-step' && typeof live.step === 'number' ? `:${live.step}` : '';
    const dedupKey = `live:${rec.id}${stepTag}:${partsCount}`;
    if (this._seenOutputs.has(dedupKey)) return;
    this._seenOutputs.add(dedupKey);
    // 截到 140 字 (与 extractAgentBubbles 保持一致)
    const text = content.trim().slice(0, 140);
    this.onAgentOutput(agent, text);
  }

  /**
   * v2.14: 推断 pipeline 当前 running 的 step index.
   * 从最近一次 _tick 拿到的 rec.output.steps 找第一个 status != completed/succeeded 的 step.
   * 没有 output 或全部完成时返回 null.
   */
  _inferRunningStepIndex(rec) {
    const steps = rec.output?.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      // 没拿到 steps 时, 从 step 0 开始 (开头那一步通常先跑)
      return 0;
    }
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const ss = (s && typeof s.status === 'string') ? s.status.toLowerCase() : '';
      if (ss !== 'completed' && ss !== 'succeeded' && ss !== 'success' && ss !== 'done') {
        return i;
      }
    }
    return null; // 全部完成
  }

  /**
   * v2.13.0: 内部统一的持久化入口. 失败静默 (saveRecordsToStorage 处理).
   */
  _persist() {
    saveRecordsToStorage(this._records, this._storage);
  }

  /**
   * v2.14.2: Build artifact link HTML for a completed step.
   * - type "file": link to /api/pipelines/{id}/artifacts/download?path=matched_file
   * - type "url": extract URL from step result text
   */
  _buildArtifactLink(rec, stepIdx, turn) {
    const artDef = rec._artifacts && rec._artifacts[stepIdx];
    if (!artDef) return '';
    const stepStatus = turn.status || '';
    if (stepStatus !== 'completed' && stepStatus !== 'succeeded' && stepStatus !== '') return '';
    // Only show for completed steps with content
    if (!turn.text || turn.text.startsWith('⏳')) return '';

    if (artDef.type === 'url') {
      // Extract URL matching pattern from step result
      const urlMatch = turn.text.match(new RegExp(`(${escapeRegex(artDef.pattern)}[^\\s"'<>)]*)`));
      if (urlMatch) {
        return `<div class="ch-artifact"><a href="${escapeHtml(urlMatch[1])}" target="_blank" rel="noopener">${escapeHtml(artDef.label)} ${escapeHtml(urlMatch[1])}</a></div>`;
      }
    }

    if (artDef.type === 'file' && rec.remoteId) {
      // Trigger async file list fetch and render (lazy — use data attribute for click handler)
      const downloadBase = `/api/pipelines/${encodeURIComponent(rec.remoteId)}/artifacts/download?path=`;
      const listUrl = `/api/pipelines/${encodeURIComponent(rec.remoteId)}/artifacts`;
      return `<div class="ch-artifact" data-list-url="${escapeHtml(listUrl)}" data-download-base="${escapeHtml(downloadBase)}" data-pattern="${escapeHtml(artDef.pattern)}" data-label="${escapeHtml(artDef.label)}"><a href="#" class="ch-artifact-fetch">${escapeHtml(artDef.label)} ⬇</a></div>`;
    }

    return '';
  }

  /**
   * v2.15: Render step_progress entries as a compact activity log.
   */
  _buildProgressHtml(progress, isOpen) {
    if (!Array.isArray(progress) || progress.length === 0) return '';
    // Build toolCallId → title map for resolving tool.done with empty title
    const toolNames = {};
    for (const p of progress) {
      if (p.kind === 'tool.start' && p.toolCallId && p.title) toolNames[p.toolCallId] = p.title;
    }
    const lines = [];
    for (const p of progress) {
      if (p.kind === 'tool.start') {
        lines.push(`<span class="ch-prog-tool">🔧 ${escapeHtml(p.title || 'tool')}</span>`);
      } else if (p.kind === 'tool.done') {
        const icon = p.status === 'completed' ? '✓' : '✗';
        const name = p.title || (p.toolCallId && toolNames[p.toolCallId]) || 'tool';
        lines.push(`<span class="ch-prog-tool ch-prog-tool-${escapeHtml(p.status || 'done')}">${icon} ${escapeHtml(name)}</span>`);
      } else if (p.kind === 'message.part') {
        lines.push(`<span class="ch-prog-msg">${escapeHtml((p.content || '').slice(0, 120))}</span>`);
      } else if (p.kind === 'message.thinking') {
        // Show last 120 chars of accumulated thinking
        const text = (p.content || '').trim();
        lines.push(`<span class="ch-prog-think">💭 ${escapeHtml(text.slice(-120))}</span>`);
      } else if (p.kind === 'status') {
        lines.push(`<span class="ch-prog-status">📋 ${escapeHtml((p.text || '').slice(0, 100))}</span>`);
      }
    }
    if (lines.length === 0) return '';
    const openAttr = isOpen ? ' open' : '';
    return `<details class="ch-progress-block"${openAttr}><summary>▾ Progress (${lines.length})</summary><div class="ch-progress-log">${lines.join('\n')}</div></details>`;
  }

  _render() {
    if (this._records.length === 0) {
      this.container.innerHTML = '<div class="ch-empty">no commands submitted yet</div>';
      this.onCountChange(0);
      return;
    }
    // v2.11.0: 最近 1 条 isRecent=true (默认展开 prompt 块)
    this.container.innerHTML = this._records
      .map((r, idx) => this._buildCard(r, idx === 0))
      .join('');
    this.onCountChange(this._records.length);
    // v2.14.2: artifact file download click handler
    this.container.querySelectorAll('.ch-artifact-fetch').forEach(link => {
      link.addEventListener('click', async (e) => {
        e.preventDefault();
        const wrap = link.closest('.ch-artifact');
        const listUrl = wrap.dataset.listUrl;
        const downloadBase = wrap.dataset.downloadBase;
        const pattern = wrap.dataset.pattern;
        const label = wrap.dataset.label;
        try {
          const res = await fetch(listUrl);
          const data = await res.json();
          const files = (data.files || []).filter(f => {
            if (pattern.startsWith('*.')) {
              return f.path.endsWith(pattern.slice(1));
            }
            return f.path.includes(pattern);
          });
          if (files.length === 0) {
            wrap.innerHTML = `<span class="ch-artifact-empty">${label} (no files found)</span>`;
          } else {
            wrap.innerHTML = files.map(f =>
              `<a href="${downloadBase}${encodeURIComponent(f.path)}" target="_blank" class="ch-artifact-link">${label} ${escapeHtml(f.path)}</a>`
            ).join(' ');
          }
        } catch (err) {
          wrap.innerHTML = `<span class="ch-artifact-empty">${label} (fetch error)</span>`;
        }
      });
    });
    // Cancel button handler
    this.container.querySelectorAll('.ch-cancel-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const remoteId = btn.dataset.remoteId;
        const kind = btn.dataset.kind;
        btn.disabled = true;
        btn.textContent = '…';
        try {
          if (kind === 'pipeline') await this.client.cancelPipeline(remoteId);
          else await this.client.cancelJob(remoteId);
          btn.textContent = '✕ Cancelled';
        } catch (e) {
          btn.textContent = /404|not.found/i.test(e.message) ? '✕ N/A' : '✕ Error';
        }
      });
    });
    // Elapsed timer
    this._updateElapsed();
  }

  _updateElapsed() {
    if (this._elapsedTimer) cancelAnimationFrame(this._elapsedTimer);
    const els = this.container.querySelectorAll('.ch-elapsed');
    if (els.length === 0) return;
    const tick = () => {
      const now = Date.now();
      els.forEach(el => {
        const started = Number(el.dataset.started);
        if (!started) return;
        const sec = Math.floor((now - started) / 1000);
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        el.textContent = `${m}:${s.toString().padStart(2, '0')}`;
      });
      this._elapsedTimer = requestAnimationFrame(tick);
    };
    tick();
  }

  _buildCard(r, isRecent = false) {
    const ts = new Date(r.submittedAt).toLocaleTimeString();
    const agentsStr = r.agents.join(', ');
    const statusClass = `ch-status-${r.status}`;
    const remoteIdLine = r.remoteId ? `<div class="ch-meta">id: ${escapeHtml(r.remoteId)}</div>` : '';
    const errorLine = r.error ? `<div class="ch-error">${escapeHtml(r.error)}</div>` : '';

    // v2.11.1: 从 server 响应里抽 metadata
    const out = (r.output && typeof r.output === 'object') ? r.output : null;
    // duration
    let durationLine = '';
    if (out && typeof out.duration === 'number' && Number.isFinite(out.duration)) {
      durationLine = `<span class="ch-duration">${out.duration.toFixed(1)}s</span>`;
    }
    // server-side error (与 r.error 区分: r.error 是网络/客户端错, server.error 是业务错)
    let serverErrorLine = '';
    if (out && typeof out.error === 'string' && out.error.trim()) {
      serverErrorLine = `<div class="ch-error ch-error-server">${escapeHtml(out.error)}</div>`;
    }

    // === Prompt block (折叠, 最近 1 条默认展开) ===
    const fullPrompt = r.prompt || '';
    const promptLen = fullPrompt.length;
    const promptShort = fullPrompt.slice(0, 80) + (promptLen > 80 ? '…' : '');
    // Pipeline: always collapsed (steps have their own prompt_preview)
    const promptOpen = (isRecent && r.kind !== 'pipeline') ? ' open' : '';
    const promptBlock = promptLen > 0 ? `
      <details class="ch-prompt-block"${promptOpen}>
        <summary>▸ Prompt (${promptLen} chars): ${escapeHtml(promptShort)}</summary>
        <pre class="ch-prompt-full">${escapeHtml(fullPrompt)}</pre>
      </details>
    ` : '';

    // === Conversation block (extractDisplayText, 默认展开) ===
    // v2.11.1: 优先用 server 返回的 agent 字段, 否则退到 ctx.agents[0]
    const fallbackAgent = (out && typeof out.agent === 'string' && out.agent) || r.agents[0] || null;
    const display = extractDisplayText(r.output, r.kind, fallbackAgent);
    // v2.13.1: pipeline metadata
    const meta = (r.kind === 'pipeline') ? extractPipelineMetadata(r.output) : {};
    let conversationBlock = '';
    if (display.hasContent) {
      const turnsHtml = display.turns.map((t, i) => {
        const agentName = t.agent || '(unknown)';
        // 子字段 chips: turn / duration / status / winner
        const chips = [];
        if (typeof t.turn === 'number') chips.push(`<span class="ch-turn-chip ch-turn-num">#${t.turn}</span>`);
        if (typeof t.duration === 'number') chips.push(`<span class="ch-turn-chip ch-turn-dur">${t.duration.toFixed(1)}s</span>`);
        if (t.isWinner) chips.push(`<span class="ch-turn-chip ch-turn-winner" title="race winner">🏆 winner</span>`);
        if (t.status && t.status !== 'completed' && t.status !== 'succeeded') {
          chips.push(`<span class="ch-turn-chip ch-step-status ch-step-status-${escapeHtml(t.status)}">${escapeHtml(t.status)}</span>`);
        }
        // v2.14.2: artifact link
        const artifactHtml = this._buildArtifactLink(r, i, t);
        // v2.15: step_progress — only show for running steps or steps without final output
        const isRunning = t.status === 'running';
        const hasOutput = t.text && !t.text.startsWith('⏳');
        const progressHtml = (t._progress && (isRunning || !hasOutput))
          ? this._buildProgressHtml(t._progress, isRunning)
          : '';
        return `
          <div class="ch-turn">
            <div class="ch-turn-head">
              <span class="ch-turn-agent">${escapeHtml(agentName)}</span>
              ${chips.join('')}
            </div>
            ${progressHtml}
            ${t._prompt_preview ? `<details class="ch-step-prompt"><summary>📝 Prompt (${t._prompt_preview.length} chars)</summary><pre class="ch-prompt-full">${escapeHtml(t._prompt_preview)}</pre></details>` : `<pre class="ch-turn-text">${escapeHtml(t.text)}</pre>`}
            ${artifactHtml}
          </div>
        `;
      }).join('');
      // 顶部 metadata chip 行 (conversation 专属)
      const metaChips = [];
      if (typeof meta.transcriptTurns === 'number') metaChips.push(`<span class="ch-meta-chip">💬 ${meta.transcriptTurns} turn${meta.transcriptTurns === 1 ? '' : 's'}</span>`);
      if (meta.stopReason) metaChips.push(`<span class="ch-meta-chip ch-meta-stop">🛑 ${escapeHtml(meta.stopReason)}</span>`);
      if (meta.paused) metaChips.push(`<span class="ch-meta-chip ch-meta-paused">⏸ paused</span>`);
      const metaRow = metaChips.length > 0 ? `<div class="ch-meta-chips">${metaChips.join('')}</div>` : '';
      conversationBlock = `
        <details class="ch-convo-block" open>
          <summary>▾ Conversation (${display.turns.length} turn${display.turns.length === 1 ? '' : 's'})</summary>
          ${metaRow}
          <div class="ch-turns">${turnsHtml}</div>
        </details>
      `;
    } else if (r.status === 'succeeded' || r.status === 'failed') {
      conversationBlock = `<div class="ch-meta ch-no-content">no readable output — see raw JSON below</div>`;
    }

    // === Raw JSON (折叠) ===
    let rawBlock = '';
    if (r.output) {
      const json = JSON.stringify(r.output, null, 2);
      // v2.13.0: 截断标记
      const truncatedNote = r._truncated
        ? `<div class="ch-meta ch-truncated-note">⚠ output truncated for storage (was ${(r.output._original_size ?? json.length).toLocaleString()} bytes)</div>`
        : '';
      rawBlock = `${truncatedNote}<details class="ch-raw-block"><summary>▸ Raw JSON (${json.length} bytes)</summary><pre>${escapeHtml(json.slice(0, 4000))}</pre></details>`;
    }

    return `
      <div class="ch-card ${statusClass}" data-rec-id="${escapeHtml(r.id)}">
        <div class="ch-head">
          <span class="ch-mode">${escapeHtml(r.mode)}</span>
          <span class="ch-status">${escapeHtml(r.status)}</span>
          ${durationLine}
          ${(!TERMINAL_STATUSES.has(r.status) && r.submittedAt) ? `<span class="ch-elapsed" data-started="${r.submittedAt}"></span>` : ''}
          ${(!TERMINAL_STATUSES.has(r.status) && r.remoteId) ? `<button class="ch-cancel-btn" data-remote-id="${escapeHtml(r.remoteId)}" data-kind="${escapeHtml(r.kind)}">✕ Cancel</button>` : ''}
          <span class="ch-time">${ts}</span>
        </div>
        <div class="ch-agents">${escapeHtml(agentsStr)}</div>
        ${promptBlock}
        ${conversationBlock}
        ${remoteIdLine}
        ${serverErrorLine}
        ${errorLine}
        ${rawBlock}
      </div>
    `;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
