/**
 * OfficeScene — 数据驱动三层渲染 + zone walking
 *
 * Layer 0 (ground):    TilemapLayer — tileset 网格
 * Layer 1 (furniture): TilemapLayer + Sprites — 混合渲染
 * Layer 2 (agents):    AgentSprite — 动画 + zone walking, depth 按 y
 *
 * 摄像头: 默认显示全貌，支持拖动平移
 */
import * as Phaser from 'phaser';
import { AgentDataManager } from '../systems/AgentDataManager.js';
import { AgentSprite } from '../systems/AgentSprite.js';

export class OfficeScene extends Phaser.Scene {
  constructor() {
    super({ key: 'OfficeScene' });
    this.agents = {};
  }

  create() {
    const tm = this.cache.json.get('tilemap');
    const T = tm.tileSize;
    const S = tm.scale;
    const TS = T * S;
    const cols = tm.size.cols;
    const rows = tm.size.rows;

    this._tileScaled = TS;
    this._roomCols = cols;
    this._roomRows = rows;
    this._tilemap = tm;

    // slot 查找表
    this._slotMap = {};
    for (const zone of Object.values(tm.zones)) {
      for (const slot of zone.slots) this._slotMap[slot.id] = slot;
    }

    // --- Layer 0: Ground ---
    const map = this.add.tilemap(null, T, T, cols, rows);
    const tileset = map.addTilesetImage(tm.tileset.key);
    const groundLayer = map.createBlankLayer('ground', tileset, 0, 0);
    groundLayer.setScale(S).setDepth(0);

    for (let r = 0; r < rows; r++) {
      const rowStr = tm.ground[r];
      for (let c = 0; c < rowStr.length; c++) {
        const gid = tm.legend[rowStr[c]];
        if (gid !== undefined) map.putTileAt(gid, c, r, false, groundLayer);
      }
    }

    // --- Layer 1: Furniture objects (sprites, depth by row) ---
    for (const obj of (tm.furniture_objects || [])) {
      if (obj._comment) continue;
      const img = this.add.image(obj.col * TS, obj.row * TS, obj.id)
        .setOrigin(0, 0).setScale(S)
        .setDepth(Math.floor(obj.row * 10));
      if (obj.flipX) img.setFlipX(true);
    }

    // --- Title ---
    this.add.text((cols * TS) / 2, 12, '🏢  ACP Agent Office', {
      fontSize: '18px', color: '#e2e8f0', fontFamily: 'monospace',
    }).setOrigin(0.5).setDepth(9999);

    // --- Layer 2: Agents (start at living zone) ---
    for (const [name, slotMapping] of Object.entries(tm.agentSlots)) {
      const slot = this._slotMap[slotMapping.living];
      if (!slot) continue;
      this.agents[name] = new AgentSprite(this, name, slot.col * TS, slot.row * TS);
    }

    // --- Agent info card ---
    this.hideAgentInfo = () => {
      const card = document.getElementById('agent-info-card');
      if (card) card.style.display = 'none';
    };
    this.input.on('pointerdown', () => this.hideAgentInfo());

    // --- Data polling ---
    this.dataManager = new AgentDataManager(this);
    this.dataManager.start();
    this.events.once('shutdown', () => this.dataManager.stop());
    this.events.once('destroy', () => this.dataManager.stop());

    // --- Debug: press 1-6 to toggle agent idle/offline ---
    const agentNames = Object.keys(tm.agentSlots);
    this.input.keyboard.on('keydown', (e) => {
      const idx = parseInt(e.key) - 1;
      if (idx >= 0 && idx < agentNames.length) {
        const name = agentNames[idx];
        const sprite = this.agents[name];
        if (!sprite) return;
        const next = sprite.status === 'offline' ? 'idle' : 'offline';
        console.log(`[debug] ${name}: ${sprite.status} → ${next}`);
        this.updateAgentStatus(name, next);
      }
    });

    // --- Camera: drag only ---
    this._setupDrag();
  }

  showAgentInfo(agentName, data) {
    window.showAgentInfo(agentName, data);
  }

  updateAgentStatus(name, status) {
    const sprite = this.agents[name];
    if (!sprite) return;

    const tm = this._tilemap;
    const TS = this._tileScaled;
    const targetZone = tm.statusToZone?.[status] || null;

    if (targetZone && tm.agentSlots?.[name]) {
      const slotId = tm.agentSlots[name][targetZone];
      const slot = this._slotMap[slotId];
      if (slot) {
        sprite.walkTo(slot.col * TS, slot.row * TS, status);
        return;
      }
    }
    sprite.updateStatus(status);
  }

  _setupDrag() {
    const cam = this.cameras.main;
    let dragging = false;
    let dragStart = { x: 0, y: 0 };
    let camStart = { x: 0, y: 0 };

    this.input.on('pointerdown', (p) => {
      dragging = true;
      dragStart = { x: p.x, y: p.y };
      camStart = { x: cam.scrollX, y: cam.scrollY };
    });

    this.input.on('pointermove', (p) => {
      if (!dragging || !p.isDown) return;
      cam.scrollX = camStart.x + (dragStart.x - p.x) / cam.zoom;
      cam.scrollY = camStart.y + (dragStart.y - p.y) / cam.zoom;
    });

    this.input.on('pointerup', () => { dragging = false; });
  }
}
