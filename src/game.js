/**
 * game.js — Phaser 4 Agent Space 游戏入口
 * 画布自动 fit 到 game-container，显示房间全貌
 */
import * as Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.js';
import { OfficeScene } from './scenes/OfficeScene.js';

// 房间世界尺寸: 18 cols × 10 rows × 32px × scale 3 = 1728 × 960
const WORLD_W = 1728;
const WORLD_H = 960;

const config = {
  type: Phaser.AUTO,
  backgroundColor: '#0d1117',
  parent: 'game-container',
  pixelArt: true,
  scene: [BootScene, OfficeScene],
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: WORLD_W,
    height: WORLD_H,
  },
};

export const game = new Phaser.Game(config);
