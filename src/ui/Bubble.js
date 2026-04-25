import Phaser from 'phaser';

export default class Bubble extends Phaser.GameObjects.Container {
  constructor(scene, x, y, text, duration = 3000) {
    super(scene, x, y);
    scene.add.existing(this);

    const maxLen = 60;
    const display = text.length > maxLen ? text.slice(0, maxLen) + '...' : text;

    this.bg = scene.add.rectangle(0, 0, display.length * 5 + 16, 18, 0xffffff, 0.9)
      .setOrigin(0.5);
    this.txt = scene.add.text(0, 0, display, {
      fontSize: '7px',
      color: '#222222',
      fontFamily: 'monospace',
    }).setOrigin(0.5);

    this.add([this.bg, this.txt]);

    scene.time.delayedCall(duration, () => {
      this.destroy();
    });
  }
}
