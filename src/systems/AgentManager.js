/**
 * AgentManager — maps acp-bridge agent/job data to NPC animation states
 *
 * States: idle | working | celebrate | error | offline
 */
export class AgentManager {
  constructor() {
    this.agents = {}; // name → { status, jobId }
    this._celebrateTimers = {};
    this.onChange = null; // callback(name, newState)
  }

  /**
   * Process raw data from AcpBridgeClient
   */
  update({ agents = [], jobs = [] }) {
    const agentNames = new Set();

    // Build running/completed/failed job lookup by agent
    const jobByAgent = {};
    const jobList = Array.isArray(jobs) ? jobs : (jobs.runs || jobs.items || []);
    for (const job of jobList) {
      const name = job.agent_name || job.agent;
      if (!name) continue;
      const existing = jobByAgent[name];
      // Keep the most recent/active job
      if (!existing || job.status === 'running' || job.state === 'running') {
        jobByAgent[name] = job;
      }
    }

    // Process agents list
    const agentList = Array.isArray(agents) ? agents : (agents.agents || []);
    for (const agent of agentList) {
      const name = agent.name || agent.agent_name;
      if (!name) continue;
      agentNames.add(name);

      const job = jobByAgent[name];
      const jobStatus = job?.status || job?.state || '';

      let newState;
      if (!agent.alive && agent.alive !== undefined) {
        newState = 'offline';
      } else if (jobStatus === 'running' || jobStatus === 'in_progress') {
        newState = 'working';
      } else if (jobStatus === 'failed' || jobStatus === 'error') {
        newState = 'error';
      } else if (jobStatus === 'completed' || jobStatus === 'success') {
        newState = 'celebrate';
      } else {
        newState = 'idle';
      }

      const prev = this.agents[name]?.status;
      this.agents[name] = { status: newState, jobId: job?.id };

      if (newState !== prev && this.onChange) {
        this.onChange(name, newState);
      }

      // Auto-return from celebrate after 3s
      if (newState === 'celebrate' && prev !== 'celebrate') {
        this._scheduleCelebrateEnd(name);
      }
    }

    // Mark missing agents as offline
    for (const name of Object.keys(this.agents)) {
      if (!agentNames.has(name) && this.agents[name].status !== 'offline') {
        this.agents[name].status = 'offline';
        if (this.onChange) this.onChange(name, 'offline');
      }
    }
  }

  _scheduleCelebrateEnd(name) {
    if (this._celebrateTimers[name]) clearTimeout(this._celebrateTimers[name]);
    this._celebrateTimers[name] = setTimeout(() => {
      if (this.agents[name]?.status === 'celebrate') {
        this.agents[name].status = 'idle';
        if (this.onChange) this.onChange(name, 'idle');
      }
    }, 3000);
  }
}
