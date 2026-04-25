import Phaser from 'phaser';

export default class StatusBar extends Phaser.GameObjects.Container {
  constructor(scene, x, y) {
    super(scene, x, y);
    scene.add.existing(this);

    this.label = scene.add.text(0, 0, 'Bridge: disconnected', {
      fontSize: '8px',
      color: '#888888',
      fontFamily: 'monospace',
    });
    this.add([this.label]);
  }

  setConnected(version) {
    this.label.setText(`Bridge: v${version}`).setColor('#66cc66');
  }

  setDisconnected() {
    this.label.setText('Bridge: disconnected').setColor('#cc6666');
  }
}
