/**
 * game.js — Phaser 4 Agent Space 游戏入口
 * 使用 LPC office 场景
 */
import * as Phaser from 'phaser';
import { LpcMainScene } from './scenes/LpcMainScene.js';

const config = {
  type: Phaser.AUTO,
  backgroundColor: '#1a1a2e',
  parent: 'game-container',
  pixelArt: true,
  scene: [LpcMainScene],
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 640,
    height: 480,
  },
};

export const game = new Phaser.Game(config);
