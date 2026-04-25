import { loadConfig, saveConfig } from './config.js';
import { BridgeClient } from './bridge/BridgeClient.js';
import { ChatLog } from './ui/ChatLog.js';

const setupEl = document.getElementById('setup');
const formEl = document.getElementById('setup-form');
const urlInput = document.getElementById('bridge-url');
const tokenInput = document.getElementById('bridge-token');

const config = loadConfig();
urlInput.value = config.bridgeUrl;
tokenInput.value = config.authToken;

if (config.authToken) {
  boot(config);
} else {
  setupEl.classList.remove('hidden');
}

formEl.addEventListener('submit', (e) => {
  e.preventDefault();
  config.bridgeUrl = urlInput.value.trim() || config.bridgeUrl;
  config.authToken = tokenInput.value.trim();
  saveConfig(config);
  boot(config);
});

function boot(cfg) {
  setupEl.classList.add('hidden');

  const chatLog = new ChatLog(document.getElementById('chat-log'));
  const baseUrl = '/api';
  const client = new BridgeClient(baseUrl, cfg.authToken);

  const barFill = document.getElementById('poll-bar-fill');
  function resetBar() {
    barFill.classList.remove('running');
    barFill.offsetWidth;
    barFill.classList.add('running');
  }

  async function pollLogs() {
    try {
      const data = await client._fetch('/heartbeat/logs');
      if (data) chatLog.updateFromLogs(data.logs || []);
    } catch {}
    resetBar();
  }
  pollLogs();
  setInterval(pollLogs, 30000);
}
