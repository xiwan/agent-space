import Phaser from 'phaser';

export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload() {
    // Placeholder — no external assets yet
  }

  create() {
    this.scene.start('Office');
  }
}
