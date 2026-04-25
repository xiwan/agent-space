import Phaser from 'phaser';
import config from '../config.js';
import BridgeClient from '../bridge/BridgeClient.js';
import AgentSprite from '../sprites/AgentSprite.js';
import StatusBar from '../ui/StatusBar.js';
import LogPanel from '../ui/LogPanel.js';

export default class OfficeScene extends Phaser.Scene {
  constructor() {
    super('Office');
  }

  create() {
    this.bridge = new BridgeClient();
    this.agents = {};       // name → AgentSprite
    this.slotPositions = []; // precomputed {x, y} per slot

    this.drawOffice();
    this.statusBar = new StatusBar(this, 4, 4);

    // Initial fetch then poll
    this.poll();
    this.time.addEvent({
      delay: config.pollInterval.health,
      callback: () => this.poll(),
      loop: true,
    });

    // Log panel (DOM-based, right side)
    this.logPanel = new LogPanel();
  }

  drawOffice() {
    const { cols, rows, tile } = { ...config.office, tile: config.tile };
    const startX = 48;
    const startY = 40;
    const gapX = tile * 2.5;
    const gapY = tile * 2.5;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = startX + c * gapX;
        const y = startY + r * gapY;
        // Desk
        this.add.rectangle(x, y, tile, tile * 0.6, 0x8b6914).setOrigin(0.5);
        // Monitor
        this.add.rectangle(x, y - tile * 0.3, tile * 0.5, tile * 0.35, 0x333355).setOrigin(0.5);
        this.slotPositions.push({ x, y: y - tile * 0.1 });
      }
    }

    // Title
    this.add.text(config.gameWidth / 2, config.gameHeight - 12, 'Agent Space', {
      fontSize: '10px', color: '#aaaacc', fontFamily: 'monospace',
    }).setOrigin(0.5);
  }

  async poll() {
    const [health, heartbeat] = await Promise.all([
      this.bridge.getHealth(),
      this.bridge.getHeartbeat(),
    ]);

    if (this.bridge.disconnected) {
      this.statusBar.setDisconnected();
      return;
    }

    if (health) {
      this.statusBar.setConnected(health.version || '?');
      this.updateAgents(health, heartbeat);
    }
  }

  updateAgents(health, heartbeat) {
    const snapshot = heartbeat?.snapshot?.agents || {};
    const enabledAgents = (health.agents || []).filter(a => a.enabled);

    // Track which agents are still present
    const seen = new Set();

    enabledAgents.forEach((agent, i) => {
      if (i >= config.office.maxSlots) return;
      const name = agent.name;
      seen.add(name);

      // Determine status
      let status = 'offline';
      if (agent.alive > 0 && agent.healthy) {
        const snap = snapshot[name];
        status = (snap && snap.busy > 0) ? 'busy' : 'idle';
      } else if (agent.alive > 0 && !agent.healthy) {
        status = 'error';
      }

      // Create or update sprite
      if (!this.agents[name]) {
        const pos = this.slotPositions[i];
        this.agents[name] = new AgentSprite(this, pos.x, pos.y, name, status);
      } else {
        this.agents[name].setStatus(status);
      }
    });

    // Remove agents no longer present
    for (const name of Object.keys(this.agents)) {
      if (!seen.has(name)) {
        this.agents[name].destroy();
        delete this.agents[name];
      }
    }
  }
}
