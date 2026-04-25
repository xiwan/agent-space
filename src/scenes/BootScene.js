import Phaser from 'phaser';

const TILE = 32;
const FLOOR = 0xd2b48c;
const WALL  = 0x8b8b8b;
const DESK  = 0x8b6914;
const MONITOR_OFF = 0x444444;
const MONITOR_ON  = 0x00ccff;

/** BootScene — generates placeholder tilemap textures. */
export class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  create() {
    this._makeTile('tile-floor', FLOOR);
    this._makeTile('tile-wall', WALL);
    this._makeTile('tile-desk', DESK);
    this._makeTile('tile-monitor-off', MONITOR_OFF, 12, 10);
    this._makeTile('tile-monitor-on', MONITOR_ON, 12, 10);
    this._makeTile('tile-plant', 0x228b22, 16, 20);
    this._makeTile('tile-window', 0x87ceeb, TILE, 12);
    this.scene.start('Office');
  }

  _makeTile(key, color, w = TILE, h = TILE) {
    const g = this.add.graphics();
    g.fillStyle(color, 1);
    g.fillRect(0, 0, w, h);
    g.lineStyle(1, 0x000000, 0.15);
    g.strokeRect(0, 0, w, h);
    g.generateTexture(key, w, h);
    g.destroy();
  }
}
