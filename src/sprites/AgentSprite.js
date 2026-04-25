import Phaser from 'phaser';

const COLORS = { offline: 0x555555, idle: 0x44aa44, busy: 0xeeaa22, error: 0xdd3333 };

export default class AgentSprite extends Phaser.GameObjects.Container {
  constructor(scene, x, y, name, status = 'offline') {
    super(scene, x, y);
    scene.add.existing(this);

    this.agentName = name;
    this.status = status;

    // Character block
    this.body = scene.add.rectangle(0, -8, 20, 28, COLORS[status] || COLORS.offline);
    // Name label
    this.label = scene.add.text(0, 12, name, {
      fontSize: '8px', color: '#ffffff', fontFamily: 'monospace',
    }).setOrigin(0.5);
    // Status indicator (small dot above head)
    this.dot = scene.add.circle(0, -26, 3, COLORS[status] || COLORS.offline);

    this.add([this.body, this.label, this.dot]);
  }

  setStatus(newStatus) {
    if (this.status === newStatus) return;
    this.status = newStatus;
    const color = COLORS[newStatus] || COLORS.offline;
    this.body.setFillStyle(color);
    this.dot.setFillStyle(color);
  }
}
