import Phaser from 'phaser';
import { Bubble } from '../ui/Bubble.js';

const COLORS = {
  offline: 0x666666,
  idle:    0x4ade80,
  busy:    0xfacc15,
  error:   0xef4444,
};

/**
 * AgentSprite — a placeholder colored rectangle representing an agent.
 * Will be replaced with pixel art sprite sheets in Phase 2.
 */
export class AgentSprite {
  constructor(scene, x, y, name) {
    this.scene = scene;
    this.name = name;
    this.state = 'offline';

    // Placeholder: 24x32 colored rect
    this.gfx = scene.add.graphics();
    this.gfx.setPosition(x, y);
    this._drawBody(COLORS.offline);

    // Name label below
    this.label = scene.add.text(x, y + 20, name, {
      fontSize: '7px',
      fontFamily: 'monospace',
      color: '#ccc',
    }).setOrigin(0.5);

    // Status icon above
    this.icon = scene.add.text(x, y - 22, '', {
      fontSize: '10px',
    }).setOrigin(0.5);

    // Speech bubble
    this.bubble = new Bubble(scene, x, y);

    // Idle animation timer
    this._idleTween = null;
  }

  _drawBody(color) {
    this.gfx.clear();
    // Body
    this.gfx.fillStyle(color, 1);
    this.gfx.fillRect(-12, -16, 24, 32);
    // Head (lighter)
    const headColor = Phaser.Display.Color.IntegerToColor(color);
    headColor.lighten(30);
    this.gfx.fillStyle(headColor.color, 1);
    this.gfx.fillRect(-8, -16, 16, 12);
  }

  setState(newState) {
    if (newState === this.state) return;
    this.state = newState;
    this._drawBody(COLORS[newState] || COLORS.offline);

    // Icon
    const icons = { offline: '', idle: '', busy: '⚡', error: '❌' };
    this.icon.setText(icons[newState] || '');

    // Idle sway animation
    if (this._idleTween) { this._idleTween.stop(); this._idleTween = null; }
    if (newState === 'idle') {
      this._idleTween = this.scene.tweens.add({
        targets: this.gfx,
        angle: { from: -2, to: 2 },
        duration: 2000,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    } else if (newState === 'busy') {
      // Rapid shake for typing
      this._idleTween = this.scene.tweens.add({
        targets: this.gfx,
        x: this.gfx.x + 1,
        duration: 80,
        yoyo: true,
        repeat: -1,
      });
    } else {
      this.gfx.setAngle(0);
    }

    // Visibility
    const visible = newState !== 'offline';
    this.gfx.setVisible(visible);
    this.icon.setVisible(visible);
  }

  showBubble(text) {
    this.bubble.show(text);
  }

  destroy() {
    if (this._idleTween) this._idleTween.stop();
    this.gfx.destroy();
    this.label.destroy();
    this.icon.destroy();
    this.bubble.destroy();
  }
}
