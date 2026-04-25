import Phaser from 'phaser';
import config from '../config.js';

export default class OfficeScene extends Phaser.Scene {
  constructor() {
    super('Office');
  }

  create() {
    const { cols, rows, tile } = { ...config.office, tile: config.tile };
    const startX = 48;
    const startY = 40;
    const gapX = tile * 2.5;
    const gapY = tile * 2.5;

    // Draw desks as colored rectangles
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = startX + c * gapX;
        const y = startY + r * gapY;
        // Desk
        this.add.rectangle(x, y, tile, tile * 0.6, 0x8b6914).setOrigin(0.5);
        // Monitor
        this.add.rectangle(x, y - tile * 0.3, tile * 0.5, tile * 0.35, 0x333355).setOrigin(0.5);
      }
    }

    // Title
    this.add.text(config.gameWidth / 2, config.gameHeight - 20, 'Agent Space', {
      fontSize: '12px',
      color: '#aaaacc',
      fontFamily: 'monospace',
    }).setOrigin(0.5);
  }
}
