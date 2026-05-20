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
  if (kind === 'job') {
    const text = remote.output ?? remote.result?.text ?? remote.result?.output ?? null;
    if (text) {
      // jobs 不带 agent 名, 由 caller 关联记录的 agents[0]
      out.push({ agent: null, text: String(text).trim().slice(0, 200) });
    }
  } else if (kind === 'pipeline') {
    for (const step of remote.steps ?? []) {
      const text = step.output ?? step.result ?? null;
      if (text && step.agent) {
        out.push({ agent: step.agent, text: String(text).trim().slice(0, 200) });
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
          if (text == null) return null;
          const out = { agent: s.agent || fallbackAgent, text: truncate(text, MAX_TURN_TEXT) };
          if (typeof s.duration === 'number') out.duration = s.duration;
          if (typeof s.status === 'string' && s.status) out.status = s.status;
          if (isWinnerOf(s)) out.isWinner = true;
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
    };
    if (rec.kind === 'run') {
      rec.completedAt = rec.submittedAt;
      // 对单 agent run: 触发气泡
      const outText = response?.result?.text ?? response?.output ?? null;
      if (outText && ctx.agents[0]) {
        this.onAgentOutput(ctx.agents[0], String(outText).trim());
      }
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
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  list() { return this._records.slice(); }

  /**
   * 立刻轮询一次 (用于测试或手动刷新).
   */
  async tickOnce() { return this._tick(); }

  // ===== private =====

  async _tick() {
    const pending = this._records.filter(r =>
      (r.kind === 'job' || r.kind === 'pipeline') &&
      r.remoteId &&
      !TERMINAL_STATUSES.has(r.status)
    );
    if (pending.length === 0) return;
    let mutated = false;
    for (const rec of pending) {
      try {
        const remote = rec.kind === 'job'
          ? await this.client.pollJob(rec.remoteId)
          : await this.client.pollPipeline(rec.remoteId);
        const ns = normalizeStatus(remote.status);
        if (ns !== rec.status) {
          rec.status = ns;
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
        rec.status = 'failed';
        rec.error = e.message;
        rec.completedAt = Date.now();
        mutated = true;
      }
    }
    if (mutated) {
      // v2.13.0: 状态变化 → 持久化
      this._persist();
      this._render();
    }
  }

  /**
   * v2.13.0: 内部统一的持久化入口. 失败静默 (saveRecordsToStorage 处理).
   */
  _persist() {
    saveRecordsToStorage(this._records, this._storage);
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
    const promptOpen = isRecent ? ' open' : '';
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
      const turnsHtml = display.turns.map(t => {
        const agentName = t.agent || '(unknown)';
        // 子字段 chips: turn / duration / status / winner
        const chips = [];
        if (typeof t.turn === 'number') chips.push(`<span class="ch-turn-chip ch-turn-num">#${t.turn}</span>`);
        if (typeof t.duration === 'number') chips.push(`<span class="ch-turn-chip ch-turn-dur">${t.duration.toFixed(1)}s</span>`);
        if (t.isWinner) chips.push(`<span class="ch-turn-chip ch-turn-winner" title="race winner">🏆 winner</span>`);
        if (t.status && t.status !== 'completed' && t.status !== 'succeeded') {
          chips.push(`<span class="ch-turn-chip ch-step-status ch-step-status-${escapeHtml(t.status)}">${escapeHtml(t.status)}</span>`);
        }
        return `
          <div class="ch-turn">
            <div class="ch-turn-head">
              <span class="ch-turn-agent">${escapeHtml(agentName)}</span>
              ${chips.join('')}
            </div>
            <pre class="ch-turn-text">${escapeHtml(t.text)}</pre>
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
      <div class="ch-card ${statusClass}">
        <div class="ch-head">
          <span class="ch-mode">${escapeHtml(r.mode)}</span>
          <span class="ch-status">${escapeHtml(r.status)}</span>
          ${durationLine}
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
