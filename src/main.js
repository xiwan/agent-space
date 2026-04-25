import Phaser from 'phaser';
import { loadConfig, saveConfig } from './config.js';
import { BridgeClient } from './bridge/BridgeClient.js';
import { ChatLog } from './ui/ChatLog.js';
import { BootScene } from './scenes/BootScene.js';
import { OfficeScene } from './scenes/OfficeScene.js';

// --- Setup form ---
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

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-container',
    width: cfg.gameWidth,
    height: cfg.gameHeight,
    pixelArt: true,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    backgroundColor: '#0f0f23',
    scene: [BootScene, OfficeScene],
  });

  const chatLog = new ChatLog(document.getElementById('chat-log'));

  const useProxy = window.location.hostname === 'localhost';
  const baseUrl = useProxy ? '/api' : cfg.bridgeUrl;
  const client = new BridgeClient(baseUrl, cfg.authToken);

  // Agent status: poll every 10s
  client.onChange((c) => {
    const office = game.scene.getScene('Office');
    if (office && office.scene.isActive()) {
      office.updateFromBridge(c);
    }
  });
  client.start(cfg.pollInterval);

  // Chat logs: poll every 30s
  async function pollLogs() {
    try {
      const data = await client._fetch('/heartbeat/logs');
      if (data) chatLog.updateFromLogs(data.logs || []);
    } catch {}
  }
  pollLogs();
  setInterval(pollLogs, 30000);
}
