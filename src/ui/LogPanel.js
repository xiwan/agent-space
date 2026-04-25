import BridgeClient from '../bridge/BridgeClient.js';
import config from '../config.js';

export default class LogPanel {
  constructor() {
    this.el = document.getElementById('logs');
    this.bridge = new BridgeClient();
    this.seenTs = new Set();
    this.poll();
    setInterval(() => this.poll(), config.pollInterval.logs);
  }

  async poll() {
    const data = await this.bridge.getHeartbeatLogs();
    if (!data || !data.logs) return;

    // Process newest first, but insert in chronological order
    const newLogs = data.logs
      .filter(l => !this.seenTs.has(l.ts + l.agent))
      .sort((a, b) => a.ts - b.ts);

    if (newLogs.length === 0) return;

    // Clear placeholder on first real data
    if (this.seenTs.size === 0) {
      this.el.innerHTML = '';
    }

    for (const log of newLogs) {
      this.seenTs.add(log.ts + log.agent);
      this.el.appendChild(this.createEntry(log));
    }

    // Auto-scroll to bottom
    this.el.scrollTop = this.el.scrollHeight;
  }

  createEntry(log) {
    const div = document.createElement('div');
    div.className = 'log-entry';

    const time = new Date(log.ts * 1000).toLocaleTimeString();
    const agent = log.agent;

    if (log.silent) {
      div.innerHTML = `<span class="log-time">${time}</span> <span class="log-agent">${agent}</span> <span class="log-silent">silent (${log.duration?.toFixed(1)}s)</span>`;
    } else {
      const text = log.response || '';
      div.innerHTML = `<span class="log-time">${time}</span> <span class="log-agent">${agent}</span> <span class="log-response">${this.escapeHtml(text)}</span>`;
    }

    return div;
  }

  escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
}
