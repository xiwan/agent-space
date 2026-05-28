// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { CommandClient } from '../src/pixel/CommandClient.js';

function mkOk(body = {}) {
  return vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}
function mkErr(status = 500, msg = 'server error') {
  return vi.fn().mockResolvedValue({
    ok: false, status,
    text: async () => msg,
    json: async () => ({ error: msg }),
  });
}
function mkNetErr() {
  return vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
}

describe('CommandClient', () => {
  it('throws when fetch not provided and global fetch absent', () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = undefined;
    expect(() => new CommandClient()).toThrow(/fetch unavailable/);
    globalThis.fetch = origFetch;
  });

  it('submitRun POSTs to /api/runs with body', async () => {
    const fetchImpl = mkOk({ result: { text: 'hi' } });
    const c = new CommandClient({ fetchImpl });
    await c.submitRun({ endpoint: '/api/runs', body: { agent_name: 'kiro', input: [] } });
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs', expect.objectContaining({ method: 'POST' }));
    const init = fetchImpl.mock.calls[0][1];
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body).agent_name).toBe('kiro');
  });

  it('submitJob POSTs to /api/jobs and returns parsed JSON', async () => {
    const fetchImpl = mkOk({ job_id: 'job-123' });
    const c = new CommandClient({ fetchImpl });
    const res = await c.submitJob({ endpoint: '/api/jobs', body: { agent_name: 'kiro', prompt: 'hi' } });
    expect(res).toEqual({ job_id: 'job-123' });
  });

  it('submitPipeline POSTs to /api/pipelines', async () => {
    const fetchImpl = mkOk({ pipeline_id: 'p-1' });
    const c = new CommandClient({ fetchImpl });
    const res = await c.submitPipeline({ endpoint: '/api/pipelines', body: { mode: 'parallel', steps: [] } });
    expect(res).toEqual({ pipeline_id: 'p-1' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/pipelines', expect.any(Object));
  });

  it('submit() routes by endpoint', async () => {
    const fetchImpl = mkOk({});
    const c = new CommandClient({ fetchImpl });
    await c.submit({ endpoint: '/api/jobs', body: {} });
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/jobs');
  });

  it('submit() throws on unknown endpoint', async () => {
    const c = new CommandClient({ fetchImpl: mkOk({}) });
    await expect(c.submit({ endpoint: '/api/bogus', body: {} })).rejects.toThrow(/unknown endpoint/);
  });

  it('non-2xx → throws Error with status', async () => {
    const fetchImpl = mkErr(503, 'busy');
    const c = new CommandClient({ fetchImpl });
    await expect(c.submitJob({ endpoint: '/api/jobs', body: {} })).rejects.toThrow(/503/);
  });

  it('network error → throws "network error"', async () => {
    const fetchImpl = mkNetErr();
    const c = new CommandClient({ fetchImpl });
    await expect(c.submitJob({ endpoint: '/api/jobs', body: {} })).rejects.toThrow(/network error/);
  });

  it('pollJob GETs /api/jobs/{id}', async () => {
    const fetchImpl = mkOk({ status: 'running' });
    const c = new CommandClient({ fetchImpl });
    await c.pollJob('job-abc');
    expect(fetchImpl).toHaveBeenCalledWith('/api/jobs/job-abc');
  });

  it('pollPipeline GETs /api/pipelines/{id} and encodes', async () => {
    const fetchImpl = mkOk({ status: 'running' });
    const c = new CommandClient({ fetchImpl });
    await c.pollPipeline('p:1');
    expect(fetchImpl).toHaveBeenCalledWith('/api/pipelines/p%3A1');
  });

  it('poll throws if id missing', async () => {
    const c = new CommandClient({ fetchImpl: mkOk({}) });
    await expect(c.pollJob('')).rejects.toThrow(/jobId required/);
    await expect(c.pollPipeline('')).rejects.toThrow(/pipelineId required/);
  });

  it('poll non-2xx → Error', async () => {
    const fetchImpl = mkErr(404);
    const c = new CommandClient({ fetchImpl });
    await expect(c.pollJob('x')).rejects.toThrow(/404/);
  });

  // ===========================================================================
  // v2.19.0: live + cancel endpoints (from stashed v2.14.2-WIP)
  // ===========================================================================

  it('pollJobLive GETs /api/jobs/{id}/live', async () => {
    const fetchImpl = mkOk({ job_id: 'j1', agent: 'kiro', status: 'running', content: 'partial', parts_count: 3 });
    const c = new CommandClient({ fetchImpl });
    const res = await c.pollJobLive('j1');
    expect(fetchImpl).toHaveBeenCalledWith('/api/jobs/j1/live');
    expect(res.parts_count).toBe(3);
  });

  it('pollJobLive throws if jobId missing', async () => {
    const c = new CommandClient({ fetchImpl: mkOk({}) });
    await expect(c.pollJobLive('')).rejects.toThrow(/jobId required/);
  });

  it('pollPipelineStepLive GETs /api/pipelines/{id}/steps/{i}/live', async () => {
    const fetchImpl = mkOk({ job_id: 'j2', step: 1, content: 'x', parts_count: 1 });
    const c = new CommandClient({ fetchImpl });
    await c.pollPipelineStepLive('p1', 1);
    expect(fetchImpl).toHaveBeenCalledWith('/api/pipelines/p1/steps/1/live');
  });

  it('pollPipelineStepLive validates stepIndex', async () => {
    const c = new CommandClient({ fetchImpl: mkOk({}) });
    await expect(c.pollPipelineStepLive('p1', null)).rejects.toThrow(/stepIndex required/);
    await expect(c.pollPipelineStepLive('p1', -1)).rejects.toThrow(/stepIndex required/);
    await expect(c.pollPipelineStepLive('', 0)).rejects.toThrow(/pipelineId required/);
  });

  it('cancelPipeline POSTs /api/pipelines/{id}/cancel', async () => {
    const fetchImpl = mkOk({ status: 'cancelled' });
    const c = new CommandClient({ fetchImpl });
    await c.cancelPipeline('p1');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/pipelines/p1/cancel');
    expect(init.method).toBe('POST');
  });

  it('cancelJob POSTs /api/jobs/{id}/cancel', async () => {
    const fetchImpl = mkOk({ status: 'cancelled' });
    const c = new CommandClient({ fetchImpl });
    await c.cancelJob('j1');
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/jobs/j1/cancel');
  });

  it('cancel endpoints throw on missing id', async () => {
    const c = new CommandClient({ fetchImpl: mkOk({}) });
    await expect(c.cancelPipeline('')).rejects.toThrow(/pipelineId required/);
    await expect(c.cancelJob('')).rejects.toThrow(/jobId required/);
  });

  it('cancel 404 from server → throws Error with status (UI graceful-degrade can detect)', async () => {
    const fetchImpl = mkErr(404, 'not found');
    const c = new CommandClient({ fetchImpl });
    await expect(c.cancelPipeline('p1')).rejects.toThrow(/404/);
  });
});
