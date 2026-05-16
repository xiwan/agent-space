/**
 * OfficeScene — 数据驱动三层渲染 + zone walking + 内置 tilemap 编辑器
 *
 * 按 E 键切换编辑模式：拖拽家具、显示坐标、导出 JSON
 */
import * as Phaser from 'phaser';
import { AgentDataManager } from '../systems/AgentDataManager.js';
import { AgentSprite } from '../systems/AgentSprite.js';

export class OfficeScene extends Phaser.Scene {
  constructor() {
    super({ key: 'OfficeScene' });
    this.agents = {};
    this._editMode = false;
    this._furnitureSprites = []; // {img, obj} pairs
    this._agentMeta = {};        // name → {description, domains}
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
    this._scale = S;

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

    // --- Layer 1: Furniture ---
    this._furnitureSprites = [];
    for (const obj of (tm.furniture_objects || [])) {
      if (obj._comment) continue;
      const img = this.add.image(obj.col * TS, obj.row * TS, obj.id)
        .setOrigin(0, 0).setScale(S)
        .setDepth(Math.floor(obj.row * 10));
      if (obj.flipX) img.setFlipX(true);
      this._furnitureSprites.push({ img, obj });
    }

    // --- Obstacles ---
    this._obstacles = (tm.obstacles || []).map(o => ({
      x: o.col * TS, y: o.row * TS, w: o.w * TS, h: o.h * TS,
    }));

    // --- Title ---
    this.add.text((cols * TS) / 2, 12, '🏢  ACP Agent Office', {
      fontSize: '18px', color: '#e2e8f0', fontFamily: 'monospace',
    }).setOrigin(0.5).setDepth(9999);

    // --- Layer 2: Agents ---
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
    this.input.on('pointerdown', () => {
      if (!this._editMode) this.hideAgentInfo();
    });

    // --- Data polling ---
    this.dataManager = new AgentDataManager(this);
    this.dataManager.start();
    this.events.once('shutdown', () => this.dataManager.stop());
    this.events.once('destroy', () => this.dataManager.stop());

    // --- Keyboard ---
    this.input.keyboard.on('keydown', (e) => {
      if (e.key === 'e' || e.key === 'E') {
        this._toggleEditMode();
        return;
      }
      // Debug: 1-6 toggle agent
      const idx = parseInt(e.key) - 1;
      const agentNames = Object.keys(tm.agentSlots);
      if (idx >= 0 && idx < agentNames.length) {
        const name = agentNames[idx];
        const sprite = this.agents[name];
        if (!sprite) return;
        this.updateAgentStatus(name, sprite.status === 'offline' ? 'idle' : 'offline');
      }
    });

    this._setupDrag();
    this._createEditorUI();
  }

  // ==================== EDITOR ====================

  _createEditorUI() {
    // 编辑器 HUD（初始隐藏）
    this._editorLabel = this.add.text(8, 8, '', {
      fontSize: '13px', color: '#4ade80', fontFamily: 'monospace',
      backgroundColor: '#000000aa', padding: { x: 6, y: 4 },
    }).setScrollFactor(0).setDepth(10000).setVisible(false);

    // 选中物品的坐标提示
    this._coordLabel = this.add.text(0, 0, '', {
      fontSize: '10px', color: '#facc15', fontFamily: 'monospace',
      backgroundColor: '#000000cc', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(10001).setVisible(false);

    // 选中高亮框
    this._selectBox = this.add.graphics().setDepth(10001);
  }

  _toggleEditMode() {
    this._editMode = !this._editMode;
    const TS = this._tileScaled;

    if (this._editMode) {
      this._editorLabel.setText('📐 EDIT MODE  [E] exit  [drag] move  [click] select  [X] export').setVisible(true);
      // 让所有家具可拖拽
      for (const { img, obj } of this._furnitureSprites) {
        img.setInteractive({ draggable: true, useHandCursor: true });
        img.on('drag', (p, dragX, dragY) => {
          img.x = dragX;
          img.y = dragY;
          img.setDepth(Math.floor(dragY / TS * 10));
          obj.col = +(dragX / TS).toFixed(2);
          obj.row = +(dragY / TS).toFixed(2);
          this._showCoord(img, obj);
        });
        img.on('pointerdown', (p) => {
          p.event.stopPropagation();
          this._selectItem(img, obj);
        });
      }
      // X 键导出
      this._exportHandler = (e) => {
        if (e.key === 'x' || e.key === 'X') this._exportJSON();
      };
      this.input.keyboard.on('keydown', this._exportHandler);
    } else {
      this._editorLabel.setVisible(false);
      this._coordLabel.setVisible(false);
      this._selectBox.clear();
      for (const { img } of this._furnitureSprites) {
        img.removeInteractive();
        img.removeAllListeners();
      }
      if (this._exportHandler) {
        this.input.keyboard.off('keydown', this._exportHandler);
        this._exportHandler = null;
      }
    }
  }

  _selectItem(img, obj) {
    this._showCoord(img, obj);
    const S = this._scale;
    const w = img.width * S;
    const h = img.height * S;
    this._selectBox.clear()
      .lineStyle(2, 0x4ade80, 0.8)
      .strokeRect(img.x, img.y, w, h);
  }

  _showCoord(img, obj) {
    const S = this._scale;
    this._coordLabel
      .setText(`${obj.id}  col:${obj.col} row:${obj.row}`)
      .setPosition(img.x + (img.width * S) / 2, img.y - 4)
      .setVisible(true);
  }

  _exportJSON() {
    // 重建 furniture_objects（保留 _comment 行）
    const out = [];
    let spriteIdx = 0;
    for (const orig of this._tilemap.furniture_objects) {
      if (orig._comment) {
        out.push(orig);
        continue;
      }
      const { obj } = this._furnitureSprites[spriteIdx++];
      const entry = { id: obj.id, col: obj.col, row: obj.row };
      if (obj.flipX) entry.flipX = true;
      out.push(entry);
    }

    const exported = { ...this._tilemap, furniture_objects: out };
    const json = JSON.stringify(exported, null, 2);

    // 复制到剪贴板
    navigator.clipboard.writeText(json).then(() => {
      this._editorLabel.setText('✅ JSON copied to clipboard!');
      this.time.delayedCall(2000, () => {
        if (this._editMode) this._editorLabel.setText('📐 EDIT MODE  [E] exit  [drag] move  [X] export');
      });
    }).catch(() => {
      // fallback: 下载文件
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'tilemap.json';
      a.click();
      this._editorLabel.setText('✅ tilemap.json downloaded');
    });
  }

  // ==================== GAME LOGIC ====================

  showAgentInfo(agentName, data) { window.showAgentInfo(agentName, data); }

  updateAgentMeta(name, meta) {
    this._agentMeta[name] = meta;
  }

  getAgentMeta(name) {
    return this._agentMeta[name] || { description: '', domains: [] };
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
      if (slot) { sprite.walkTo(slot.col * TS, slot.row * TS, status); return; }
    }
    sprite.updateStatus(status);
  }

  _setupDrag() {
    const cam = this.cameras.main;
    let dragging = false;
    let dragStart = { x: 0, y: 0 };
    let camStart = { x: 0, y: 0 };

    this.input.on('pointerdown', (p) => {
      if (this._editMode) return; // 编辑模式下不拖摄像头
      dragging = true;
      dragStart = { x: p.x, y: p.y };
      camStart = { x: cam.scrollX, y: cam.scrollY };
    });
    this.input.on('pointermove', (p) => {
      if (!dragging || !p.isDown || this._editMode) return;
      cam.scrollX = camStart.x + (dragStart.x - p.x) / cam.zoom;
      cam.scrollY = camStart.y + (dragStart.y - p.y) / cam.zoom;
    });
    this.input.on('pointerup', () => { dragging = false; });
  }
}
