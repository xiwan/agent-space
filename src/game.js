/**
 * game.js — Phaser 4 Agent Space 游戏入口
 * 独立运行：import 到 index 或 vite dev 直接访问 /game.html
 */
import * as Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.js';
import { OfficeScene } from './scenes/OfficeScene.js';

const config = {
  type: Phaser.AUTO,
  width: window.innerWidth,
  height: window.innerHeight,
  backgroundColor: '#0d1117',
  parent: 'game-container',
  pixelArt: true,
  scene: [BootScene, OfficeScene],
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: window.innerWidth,
    height: window.innerHeight,
  },
};

export const game = new Phaser.Game(config);
