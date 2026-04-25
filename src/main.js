import Phaser from 'phaser';
import config from './config.js';
import BootScene from './scenes/BootScene.js';
import OfficeScene from './scenes/OfficeScene.js';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: config.gameWidth,
  height: config.gameHeight,
  pixelArt: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  backgroundColor: '#2b2b3d',
  scene: [BootScene, OfficeScene],
});

export default game;
