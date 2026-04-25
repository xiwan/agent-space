import Phaser from 'phaser';
import { AgentSprite } from '../sprites/AgentSprite.js';

const TILE = 32;
const COLS = 5;
const ROWS = 2;
const DESK_START_X = 2;  // tile offset
const DESK_START_Y = 2;
const DESK_SPACING_X = 3; // tiles between desks
const DESK_SPACING_Y = 3;

/**
 * OfficeScene — procedurally generated pixel office with agent sprites.
 */
export class OfficeScene extends Phaser.Scene {
  constructor() { super('Office'); }

  create() {
    this._drawOffice();
    /** @type {Object<string, AgentSprite>} */
    this.agents = {};
    /** @type {Array<{x: number, y: number}>} desk center positions in px */
    this.deskSlots = this._calcDeskSlots();
    // Track last seen chat timestamps per agent
    this._lastChatTs = {};
  }

  _drawOffice() {
    const mapW = COLS * DESK_SPACING_X + DESK_START_X + 2;
    const mapH = ROWS * DESK_SPACING_Y + DESK_START_Y + 3;

    // Floor
    for (let y = 0; y < mapH; y++) {
      for (let x = 0; x < mapW; x++) {
        this.add.image(x * TILE + TILE / 2, y * TILE + TILE / 2, 'tile-floor');
      }
    }
    // Walls (top row)
    for (let x = 0; x < mapW; x++) {
      this.add.image(x * TILE + TILE / 2, TILE / 2, 'tile-wall');
    }
    // Windows on top wall
    for (let i = 0; i < COLS; i++) {
      const wx = (DESK_START_X + i * DESK_SPACING_X) * TILE + TILE / 2;
      this.add.image(wx, 6, 'tile-window');
    }
    // Desks + monitors
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const dx = (DESK_START_X + col * DESK_SPACING_X) * TILE + TILE / 2;
        const dy = (DESK_START_Y + row * DESK_SPACING_Y) * TILE + TILE / 2;
        this.add.image(dx, dy - 10, 'tile-desk');
        this.add.image(dx, dy - 18, 'tile-monitor-off').setData('slot', row * COLS + col);
      }
    }
    // Decorations: plants at bottom corners, coffee area center
    const bottomY = (mapH - 1) * TILE + TILE / 2;
    this.add.image(TILE * 2, bottomY, 'tile-plant');
    this.add.image((mapW - 2) * TILE, bottomY, 'tile-plant');
    this.add.text(mapW * TILE / 2, bottomY, '☕', { fontSize: '16px' }).setOrigin(0.5);
  }

  _calcDeskSlots() {
    const slots = [];
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const x = (DESK_START_X + col * DESK_SPACING_X) * TILE + TILE / 2;
        const y = (DESK_START_Y + row * DESK_SPACING_Y) * TILE + TILE / 2 + 8;
        slots.push({ x, y });
      }
    }
    return slots;
  }

  /** Called by main.js on each BridgeClient update. */
  updateFromBridge(client) {
    const names = client.getAgentNames();

    // Ensure sprites exist for each agent
    names.forEach((name, i) => {
      if (i >= this.deskSlots.length) return; // max 10
      if (!this.agents[name]) {
        const slot = this.deskSlots[i];
        this.agents[name] = new AgentSprite(this, slot.x, slot.y, name);
      }
    });

    // Remove sprites for agents no longer present
    for (const name of Object.keys(this.agents)) {
      if (!names.includes(name)) {
        this.agents[name].destroy();
        delete this.agents[name];
      }
    }

    // Update states
    for (const name of names) {
      if (!this.agents[name]) continue;
      this.agents[name].setState(client.getAgentState(name));
    }

    // Chat bubbles — show new non-silent entries
    const chats = client.getRecentChats(60);
    for (const chat of chats) {
      const prev = this._lastChatTs[chat.agent] || 0;
      if (chat.ts > prev && this.agents[chat.agent]) {
        this.agents[chat.agent].showBubble(chat.response || '');
        this._lastChatTs[chat.agent] = chat.ts;
      }
    }
  }
}
