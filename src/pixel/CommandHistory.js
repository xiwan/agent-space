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
 * 输出: { turns: Array<{agent, text}>, hasContent: boolean }
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
 *     - 优先: response.turns = [{agent, content|text|output}, ...] (conversation mode)
 *     - 否则: response.steps[*] 同 run/job 同样的字段优先级, agent = step.agent
 *     - 都没 → hasContent=false
 *
 * 长 text 截断到 800 字符 + ' … (truncated)'.
 *
 * @param {object} remote — server 原响应
 * @param {'run'|'job'|'pipeline'} kind
 * @param {string|null} fallbackAgent — caller 传单 agent (run/job 用)
 * @returns {{turns: Array<{agent: string|null, text: string}>, hasContent: boolean}}
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
    // conversation mode: response.turns
    if (Array.isArray(remote.turns) && remote.turns.length > 0) {
      const turns = remote.turns
        .map(t => {
          const text = pickSingleText(t);
          if (text == null) return null;
          return { agent: t.agent || fallbackAgent, text: truncate(text, MAX_TURN_TEXT) };
        })
        .filter(Boolean);
      if (turns.length > 0) return { turns, hasContent: true };
    }
    // sequence/parallel/race: steps[]
    if (Array.isArray(remote.steps) && remote.steps.length > 0) {
      const turns = remote.steps
        .map(s => {
          const text = pickSingleText(s);
          if (text == null) return null;
          return { agent: s.agent || fallbackAgent, text: truncate(text, MAX_TURN_TEXT) };
        })
        .filter(Boolean);
      if (turns.length > 0) return { turns, hasContent: true };
    }
    return empty;
  }

  return empty;
}

/**
 * 从一个对象里抽 text. 字段优先级:
 *   1. obj.output[*].parts[*].content (ACP) — array of content joined
 *   2. obj.content (conversation turn)
 *   3. obj.result.text
 *   4. obj.result.output (string only)
 *   5. obj.text
 *   6. obj.output (string only — 不是 array)
 * 返回 string 或 null.
 */
function pickSingleText(obj) {
  if (!obj || typeof obj !== 'object') return null;
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
  // 3. result.text
  if (obj.result && typeof obj.result.text === 'string' && obj.result.text.trim()) return obj.result.text;
  // 4. result.output (string)
  if (obj.result && typeof obj.result.output === 'string' && obj.result.output.trim()) return obj.result.output;
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
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this._records = []; // 最新在前
    this._timer = null;
    this._seenOutputs = new Set(); // dedup: `${recId}:${stepIdx}`
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
    if (mutated) this._render();
  }

  _render() {
    if (this._records.length === 0) {
      this.container.innerHTML = '<div class="ch-empty">no commands submitted yet</div>';
      return;
    }
    // v2.11.0: 最近 1 条 isRecent=true (默认展开 prompt 块)
    this.container.innerHTML = this._records
      .map((r, idx) => this._buildCard(r, idx === 0))
      .join('');
  }

  _buildCard(r, isRecent = false) {
    const ts = new Date(r.submittedAt).toLocaleTimeString();
    const agentsStr = r.agents.join(', ');
    const statusClass = `ch-status-${r.status}`;
    const remoteIdLine = r.remoteId ? `<div class="ch-meta">id: ${escapeHtml(r.remoteId)}</div>` : '';
    const errorLine = r.error ? `<div class="ch-error">${escapeHtml(r.error)}</div>` : '';

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
    const fallbackAgent = r.agents[0] || null;
    const display = extractDisplayText(r.output, r.kind, fallbackAgent);
    let conversationBlock = '';
    if (display.hasContent) {
      const turnsHtml = display.turns.map(t => {
        const agentName = t.agent || '(unknown)';
        // 颜色: 由于 history 不直接知道 agent state, 用 default; 实际颜色由 CSS
        // 通过 .ch-turn 默认色条体现 (chip 区有色, 这里用统一灰色避免误导)
        return `
          <div class="ch-turn">
            <div class="ch-turn-head">${escapeHtml(agentName)}</div>
            <pre class="ch-turn-text">${escapeHtml(t.text)}</pre>
          </div>
        `;
      }).join('');
      conversationBlock = `
        <details class="ch-convo-block" open>
          <summary>▾ Conversation (${display.turns.length} turn${display.turns.length === 1 ? '' : 's'})</summary>
          <div class="ch-turns">${turnsHtml}</div>
        </details>
      `;
    } else if (r.status === 'succeeded' || r.status === 'failed') {
      // 终态但抽不出可读文本 → 提示用户从 raw json 看
      conversationBlock = `<div class="ch-meta ch-no-content">no readable output — see raw JSON below</div>`;
    }

    // === Raw JSON (折叠) ===
    let rawBlock = '';
    if (r.output) {
      const json = JSON.stringify(r.output, null, 2);
      rawBlock = `<details class="ch-raw-block"><summary>▸ Raw JSON (${json.length} bytes)</summary><pre>${escapeHtml(json.slice(0, 4000))}</pre></details>`;
    }

    return `
      <div class="ch-card ${statusClass}">
        <div class="ch-head">
          <span class="ch-mode">${escapeHtml(r.mode)}</span>
          <span class="ch-status">${escapeHtml(r.status)}</span>
          <span class="ch-time">${ts}</span>
        </div>
        <div class="ch-agents">${escapeHtml(agentsStr)}</div>
        ${promptBlock}
        ${conversationBlock}
        ${remoteIdLine}
        ${errorLine}
        ${rawBlock}
      </div>
    `;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}
