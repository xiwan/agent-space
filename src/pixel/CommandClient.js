/**
 * CommandClient — ACP Bridge 调用封装 (v2.10.0)
 *
 * 三类提交:
 *   submitRun(payload)       — POST /api/runs (single sync), await 同步响应
 *   submitJob(payload)       — POST /api/jobs (single async), 立刻返回 {job_id}
 *   submitPipeline(payload)  — POST /api/pipelines, 立刻返回 {pipeline_id}
 *
 * 状态查询 (供 StatusPoller 调用, 单次 fetch):
 *   pollJob(id)
 *   pollPipeline(id)
 *
 * 出参形状 (从 ACP Bridge docs/api-reference.md 推导):
 *   - /runs       — 同步, body 含 result/output (具体字段透传, caller 自取)
 *   - /jobs       — 立刻 {job_id} (业务字段); 后续 GET /jobs/{id} 拿 status / output
 *   - /pipelines  — 立刻 {pipeline_id, shared_cwd?, ...}; GET /pipelines/{id} 拿 status / steps
 *
 * 设计取舍:
 *   - 不缓存, 每次调用都新 fetch
 *   - 错误封装: 网络错 / 非 2xx 都 throw Error('xxx (status N)')
 *   - 测试时可注入 fetchImpl
 */

export class CommandClient {
  /**
   * @param {object} opts
   * @param {Function} [opts.fetchImpl] 测试可注入
   */
  constructor(opts = {}) {
    this._fetch = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    if (!this._fetch) throw new Error('CommandClient: fetch unavailable');
  }

  async submitRun(payload) {
    return this._post('/api/runs', payload.body);
  }

  async submitJob(payload) {
    return this._post('/api/jobs', payload.body);
  }

  async submitPipeline(payload) {
    return this._post('/api/pipelines', payload.body);
  }

  /**
   * 通用入口 — 根据 payload.endpoint 路由到对应 submit*.
   * CommandComposer 输出的 payload 直接喂这个最方便.
   */
  async submit(payload) {
    if (!payload || !payload.endpoint) throw new Error('submit: payload.endpoint required');
    if (payload.endpoint === '/api/runs') return this.submitRun(payload);
    if (payload.endpoint === '/api/jobs') return this.submitJob(payload);
    if (payload.endpoint === '/api/pipelines') return this.submitPipeline(payload);
    throw new Error(`submit: unknown endpoint ${payload.endpoint}`);
  }

  async pollJob(jobId) {
    if (!jobId) throw new Error('pollJob: jobId required');
    return this._get(`/api/jobs/${encodeURIComponent(jobId)}`);
  }

  async pollPipeline(pipelineId) {
    if (!pipelineId) throw new Error('pollPipeline: pipelineId required');
    return this._get(`/api/pipelines/${encodeURIComponent(pipelineId)}`);
  }

  /**
   * v2.14: 流式中间内容查询 — running/pending 状态时拿 partial content,
   * completed/failed 时拿最终内容. 通过 parts_count 增长判断是否有新内容.
   * 返回: { job_id, agent, status, content, parts_count }
   */
  async pollJobLive(jobId) {
    if (!jobId) throw new Error('pollJobLive: jobId required');
    return this._get(`/api/jobs/${encodeURIComponent(jobId)}/live`);
  }

  /**
   * v2.14: pipeline step 的流式查询.
   * 返回: { job_id, agent, status, content, parts_count, step }
   */
  async pollPipelineStepLive(pipelineId, stepIndex) {
    if (!pipelineId) throw new Error('pollPipelineStepLive: pipelineId required');
    if (typeof stepIndex !== 'number' || stepIndex < 0) throw new Error('pollPipelineStepLive: stepIndex required');
    return this._get(`/api/pipelines/${encodeURIComponent(pipelineId)}/steps/${stepIndex}/live`);
  }

  async cancelPipeline(pipelineId) {
    if (!pipelineId) throw new Error('cancelPipeline: pipelineId required');
    return this._post(`/api/pipelines/${encodeURIComponent(pipelineId)}/cancel`, {});
  }

  async cancelJob(jobId) {
    if (!jobId) throw new Error('cancelJob: jobId required');
    return this._post(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {});
  }

  // ===== private =====

  async _post(url, body) {
    let r;
    try {
      r = await this._fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`network error: ${e.message}`);
    }
    if (!r || !r.ok) {
      const status = r ? r.status : '?';
      let msg = '';
      try { msg = (await r.text()).slice(0, 200); } catch {}
      throw new Error(`POST ${url} → ${status}${msg ? ` ${msg}` : ''}`);
    }
    try { return await r.json(); }
    catch { return {}; }
  }

  async _get(url) {
    let r;
    try { r = await this._fetch(url); }
    catch (e) { throw new Error(`network error: ${e.message}`); }
    if (!r || !r.ok) {
      const status = r ? r.status : '?';
      throw new Error(`GET ${url} → ${status}`);
    }
    try { return await r.json(); }
    catch { return {}; }
  }
}
