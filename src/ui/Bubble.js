import Phaser from 'phaser';

/** Pixel speech bubble rendered on the Phaser canvas. */
export class Bubble {
  constructor(scene, x, y) {
    this.scene = scene;
    this.container = scene.add.container(x, y - 40);
    this.bg = scene.add.graphics();
    this.label = scene.add.text(0, 0, '', {
      fontSize: '8px',
      fontFamily: 'monospace',
      color: '#222',
      wordWrap: { width: 120 },
      align: 'center',
    }).setOrigin(0.5);
    this.container.add([this.bg, this.label]);
    this.container.setDepth(100);
    this.container.setVisible(false);
    this._timer = null;
  }

  show(text, duration = 3000) {
    const display = text.length > 60 ? text.slice(0, 57) + '...' : text;
    this.label.setText(display);
    // Draw background
    const pad = 6;
    const w = Math.max(this.label.width + pad * 2, 40);
    const h = this.label.height + pad * 2;
    this.bg.clear();
    this.bg.fillStyle(0xffffff, 0.95);
    this.bg.fillRoundedRect(-w / 2, -h / 2, w, h, 4);
    this.bg.lineStyle(1, 0x888888);
    this.bg.strokeRoundedRect(-w / 2, -h / 2, w, h, 4);
    // Tail triangle
    this.bg.fillStyle(0xffffff, 0.95);
    this.bg.fillTriangle(-4, h / 2, 4, h / 2, 0, h / 2 + 6);

    this.container.setVisible(true);
    this.container.setAlpha(1);

    if (this._timer) this._timer.remove();
    this._timer = this.scene.time.delayedCall(duration, () => {
      this.scene.tweens.add({
        targets: this.container,
        alpha: 0,
        duration: 500,
        onComplete: () => this.container.setVisible(false),
      });
    });
  }

  moveTo(x, y) {
    this.container.setPosition(x, y - 40);
  }

  destroy() {
    if (this._timer) this._timer.remove();
    this.container.destroy();
  }
}
