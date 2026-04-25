import Phaser from 'phaser';

export default class AgentSprite extends Phaser.GameObjects.Container {
  constructor(scene, x, y, name, status = 'offline') {
    super(scene, x, y);
    scene.add.existing(this);

    this.agentName = name;
    this.status = status;

    const colors = { offline: 0x555555, idle: 0x44aa44, busy: 0xeeaa22, error: 0xdd3333 };
    this.body = scene.add.rectangle(0, -8, 20, 28, colors[status] || 0x555555);
    this.label = scene.add.text(0, 12, name, {
      fontSize: '8px',
      color: '#ffffff',
      fontFamily: 'monospace',
    }).setOrigin(0.5);

    this.add([this.body, this.label]);
  }

  setStatus(status) {
    const colors = { offline: 0x555555, idle: 0x44aa44, busy: 0xeeaa22, error: 0xdd3333 };
    this.status = status;
    this.body.setFillStyle(colors[status] || 0x555555);
  }
}
