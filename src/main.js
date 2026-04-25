import Phaser from 'phaser';
import { loadConfig, saveConfig } from './config.js';
import { BridgeClient } from './bridge/BridgeClient.js';
import { AgentPanel } from './ui/AgentPanel.js';
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

// Auto-connect if config exists
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

  // Phaser game
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

  // HTML panels
  const agentPanel = new AgentPanel(document.getElementById('agent-list'));
  const chatLog = new ChatLog(document.getElementById('chat-log'));

  // Bridge client
  const useProxy = window.location.hostname === 'localhost';
  const baseUrl = useProxy ? '/api' : cfg.bridgeUrl;
  const client = new BridgeClient(baseUrl, cfg.authToken);

  client.onChange((c) => {
    agentPanel.update(c);
    chatLog.update(c);
    // Update Phaser scene
    const office = game.scene.getScene('Office');
    if (office && office.scene.isActive()) {
      office.updateFromBridge(c);
    }
  });

  client.start(cfg.pollInterval);
}
