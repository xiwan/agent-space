/**
 * LpcMainScene — LPC office map + NPC agents driven by acp-bridge
 *
 * Dynamically creates agent sprites with layered appearance (body + head + hair + shirt + pants).
 * LPC walk-only spritesheet: 576×256, 9 cols × 4 rows, 64×64 frames
 * Rows: 0=up, 1=left, 2=down, 3=right
 */
import * as Phaser from 'phaser';
import { AcpBridgeClient } from '../bridge/AcpBridgeClient.js';
import { AgentManager } from '../systems/AgentManager.js';

const FRAME_W = 64;
const FRAME_H = 64;
const SPRITE_COLS = 9;
const DIR_DOWN = 2;
const DIR_LEFT = 1;
const DIR_RIGHT = 3;

// Available LPC body colors (must match files in assets/lpc/spritesheets/body/bodies/male/walk/)
const BODY_COLORS = ['light', 'bronze', 'brown', 'olive', 'amber', 'taupe', 'black', 'blue'];

// Appearance presets for layered sprites
const APPEARANCES = [
  { body: 'light',  head: 'light',  hair: 'messy1/male/walk/brunette', shirt: 'blue',   pants: 'charcoal' },
  { body: 'bronze', head: 'bronze', hair: 'pixie/male/walk/raven',     shirt: 'maroon', pants: 'brown' },
  { body: 'brown',  head: 'brown',  hair: 'shorthawk/adult/walk/black', shirt: 'green',  pants: 'black' },
  { body: 'olive',  head: 'olive',  hair: 'curtains/adult/walk/blonde', shirt: 'white',  pants: 'navy' },
  { body: 'amber',  head: 'amber',  hair: 'spiked/adult/walk/redhead',  shirt: 'purple', pants: 'gray' },
  { body: 'taupe',  head: 'taupe',  hair: 'bob/male/walk/white',       shirt: 'teal',   pants: 'brown' },
  { body: 'light',  head: 'light',  hair: 'long/adult/walk/blonde',    shirt: 'orange', pants: 'blue' },
  { body: 'bronze', head: 'bronze', hair: 'curtains/adult/walk/raven', shirt: 'red',    pants: 'charcoal' },
];

// Desk layout
const DESK_START_X = 120;
const DESK_SPACING = 130;
const DESK_Y = 160;
const HOME_Y = 240;

export class LpcMainScene extends Phaser.Scene {
  constructor() {
    super({ key: 'LpcMainScene' });
    this.npcs = {};
    this.bridge = null;
    this.agentManager = null;
    this._agentCount = 0;
  }

  preload() {
    this.load.image('office-bg', 'assets/lpc/tilesets/builtin/small-office-map.png');

    // Preload all layers for each appearance preset
    for (let i = 0; i < APPEARANCES.length; i++) {
      const a = APPEARANCES[i];
      this.load.spritesheet(`body-${i}`, `assets/lpc/spritesheets/body/bodies/male/walk/${a.body}.png`, { frameWidth: FRAME_W, frameHeight: FRAME_H });
      this.load.spritesheet(`head-${i}`, `assets/lpc/spritesheets/head/heads/human/male/walk/${a.head}.png`, { frameWidth: FRAME_W, frameHeight: FRAME_H });
      this.load.spritesheet(`hair-${i}`, `assets/lpc/spritesheets/hair/${a.hair}.png`, { frameWidth: FRAME_W, frameHeight: FRAME_H });
      this.load.spritesheet(`shirt-${i}`, `assets/lpc/spritesheets/torso/clothes/longsleeve/longsleeve/male/walk/${a.shirt}.png`, { frameWidth: FRAME_W, frameHeight: FRAME_H });
      this.load.spritesheet(`pants-${i}`, `assets/lpc/spritesheets/legs/pants/male/walk/${a.pants}.png`, { frameWidth: FRAME_W, frameHeight: FRAME_H });
    }
  }

  create() {
    this.add.image(0, 0, 'office-bg').setOrigin(0, 0).setDepth(0);

    this.add.text(320, 12, '🏢 ACP Agent Office (LPC)', {
      fontSize: '14px', color: '#ffffff', fontFamily: 'monospace',
      backgroundColor: '#00000088', padding: { x: 6, y: 3 },
    }).setOrigin(0.5, 0).setDepth(100);

    this.add.text(8, 460, '🟢idle  🟠working  🎉celebrate  🔴error  ⚫offline', {
      fontSize: '10px', color: '#aaa', fontFamily: 'monospace',
      backgroundColor: '#00000088', padding: { x: 4, y: 2 },
    }).setOrigin(0, 1).setDepth(100);

    // Get config from localStorage (set by setup form)
    const config = JSON.parse(localStorage.getItem('agent-space-config') || '{}');
    const bridgeUrl = (config.bridgeUrl && config.bridgeUrl.startsWith('/')) ? config.bridgeUrl : '/api';
    const token = config.authToken || '';

    // Connect to acp-bridge
    this.bridge = new AcpBridgeClient(bridgeUrl, token);
    this.agentManager = new AgentManager();

    this.agentManager.onChange = (name, state) => {
      this._ensureNpc(name);
      this._onAgentStateChange(name, state);
    };

    let gotData = false;
    this.bridge.onUpdate = (data) => {
      gotData = true;
      const agentList = Array.isArray(data.agents) ? data.agents : (data.agents?.agents || []);
      for (const agent of agentList) {
        const name = agent.name || agent.agent_name;
        if (name) this._ensureNpc(name);
      }
      this.agentManager.update(data);
    };

    this.bridge.start();

    // Fallback: if bridge doesn't respond in 3s, show default agents
    this.time.delayedCall(3000, () => {
      if (!gotData) {
        for (const name of ['kiro', 'claude', 'harness', 'codex']) this._ensureNpc(name);
      }
    });

    this.events.once('shutdown', () => this.bridge.stop());
    this.events.once('destroy', () => this.bridge.stop());
  }

  _ensureNpc(name) {
    if (this.npcs[name]) return;

    const index = this._agentCount++;
    const deskX = DESK_START_X + index * DESK_SPACING;
    const cfg = { index: index % APPEARANCES.length, homeX: deskX, homeY: HOME_Y, deskX, deskY: DESK_Y };

    this._createNpc(name, cfg);
  }

  _createNpc(name, cfg) {
    const idx = cfg.index;
    const layers = ['body', 'head', 'pants', 'shirt', 'hair'];
    const sprites = [];

    // Create layered sprites + animations for each layer
    for (const layer of layers) {
      const key = `${layer}-${idx}`;

      // Create animations (unique per agent name to avoid conflicts)
      this.anims.create({ key: `${name}-${layer}-idle`, frames: this.anims.generateFrameNumbers(key, { start: DIR_DOWN * SPRITE_COLS, end: DIR_DOWN * SPRITE_COLS + 1 }), frameRate: 2, repeat: -1 });
      this.anims.create({ key: `${name}-${layer}-walk`, frames: this.anims.generateFrameNumbers(key, { start: DIR_DOWN * SPRITE_COLS + 1, end: DIR_DOWN * SPRITE_COLS + SPRITE_COLS - 1 }), frameRate: 10, repeat: -1 });
      this.anims.create({ key: `${name}-${layer}-walk-left`, frames: this.anims.generateFrameNumbers(key, { start: DIR_LEFT * SPRITE_COLS + 1, end: DIR_LEFT * SPRITE_COLS + SPRITE_COLS - 1 }), frameRate: 10, repeat: -1 });
      this.anims.create({ key: `${name}-${layer}-walk-right`, frames: this.anims.generateFrameNumbers(key, { start: DIR_RIGHT * SPRITE_COLS + 1, end: DIR_RIGHT * SPRITE_COLS + SPRITE_COLS - 1 }), frameRate: 10, repeat: -1 });
      this.anims.create({ key: `${name}-${layer}-work`, frames: this.anims.generateFrameNumbers(key, { start: DIR_DOWN * SPRITE_COLS + 1, end: DIR_DOWN * SPRITE_COLS + 4 }), frameRate: 6, repeat: -1 });
      this.anims.create({ key: `${name}-${layer}-celebrate`, frames: [...this.anims.generateFrameNumbers(key, { start: DIR_LEFT * SPRITE_COLS, end: DIR_LEFT * SPRITE_COLS + 2 }), ...this.anims.generateFrameNumbers(key, { start: DIR_RIGHT * SPRITE_COLS, end: DIR_RIGHT * SPRITE_COLS + 2 })], frameRate: 8, repeat: 3 });
      this.anims.create({ key: `${name}-${layer}-error`, frames: this.anims.generateFrameNumbers(key, { start: DIR_DOWN * SPRITE_COLS, end: DIR_DOWN * SPRITE_COLS + 1 }), frameRate: 4, repeat: -1 });

      const sprite = this.add.sprite(cfg.deskX, cfg.deskY, key, DIR_DOWN * SPRITE_COLS)
        .setOrigin(0.5, 1)
        .setDepth(10 + Math.floor(cfg.deskY));

      sprite.play(`${name}-${layer}-work`);
      sprites.push(sprite);
    }

    // Name label
    const label = this.add.text(cfg.deskX, cfg.deskY - 68, `🟢 ${name}`, {
      fontSize: '10px', color: '#e2e8f0', fontFamily: 'monospace',
      backgroundColor: '#00000077', padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 1).setDepth(200);

    this.npcs[name] = { sprites, label, cfg, state: 'working', tween: null };
  }

  _playAnim(npc, name, animSuffix) {
    const layers = ['body', 'head', 'pants', 'shirt', 'hair'];
    for (let i = 0; i < npc.sprites.length; i++) {
      npc.sprites[i].play(`${name}-${layers[i]}-${animSuffix}`);
    }
  }

  _onAgentStateChange(name, state) {
    const npc = this.npcs[name];
    if (!npc) return;

    npc.state = state;

    const dots = { idle: '🟢', working: '🟠', celebrate: '🎉', error: '🔴', offline: '⚫' };
    npc.label.setText(`${dots[state] || '⚫'} ${name}`);

    if (npc.tween) { npc.tween.stop(); npc.tween = null; }

    const alpha = state === 'offline' ? 0.4 : 1;
    for (const s of npc.sprites) s.setAlpha(alpha);

    switch (state) {
      case 'working':
        this._walkTo(npc, name, npc.cfg.deskX, npc.cfg.deskY, () => this._playAnim(npc, name, 'work'));
        break;
      case 'celebrate':
        this._playAnim(npc, name, 'celebrate');
        break;
      case 'error':
        this._playAnim(npc, name, 'error');
        for (const s of npc.sprites) s.setTint(0xff4444);
        this.time.delayedCall(3000, () => { for (const s of npc.sprites) s.clearTint(); });
        break;
      case 'idle':
        this._walkTo(npc, name, npc.cfg.homeX, npc.cfg.homeY, () => this._playAnim(npc, name, 'idle'));
        break;
      default:
        this._playAnim(npc, name, 'idle');
        break;
    }
  }

  _walkTo(npc, name, targetX, targetY, onComplete) {
    const dx = targetX - npc.sprites[0].x;
    const dy = targetY - npc.sprites[0].y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 5) { onComplete(); return; }

    const dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'walk-left' : 'walk-right') : 'walk';
    this._playAnim(npc, name, dir);

    // Tween all sprites together
    npc.tween = this.tweens.add({
      targets: npc.sprites,
      x: targetX, y: targetY,
      duration: dist * 8,
      ease: 'Linear',
      onUpdate: () => {
        const y = npc.sprites[0].y;
        for (const s of npc.sprites) s.setDepth(10 + Math.floor(y));
        npc.label.setPosition(npc.sprites[0].x, y - 68);
      },
      onComplete: () => { npc.tween = null; onComplete(); },
    });
  }
}
