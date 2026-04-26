/**
 * BootScene — 预生成纹理，然后跳转 OfficeScene
 * 用 Graphics 绘制占位符像素纹理，无需外部图片资源
 */
import * as Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() { super({ key: 'BootScene' }); }

  create() {
    const T = 32; // tile size

    // 地板砖
    const floor = this.make.graphics({ x: 0, y: 0, add: false });
    floor.fillStyle(0x1a1a2e);
    floor.fillRect(0, 0, T, T);
    floor.lineStyle(1, 0x2a2a4e, 1);
    floor.strokeRect(0, 0, T, T);
    floor.generateTexture('tile_floor', T, T);
    floor.destroy();

    // 工位桌
    const desk = this.make.graphics({ x: 0, y: 0, add: false });
    desk.fillStyle(0x4a3728);
    desk.fillRect(2, 8, 28, 20);
    desk.fillStyle(0x2c5f2e);    // 显示器
    desk.fillRect(8, 2, 16, 12);
    desk.generateTexture('desk', T, T);
    desk.destroy();

    // Agent 待机
    const idle = this.make.graphics({ x: 0, y: 0, add: false });
    idle.fillStyle(0x4fc3f7);
    idle.fillCircle(16, 10, 8);  // 头
    idle.fillStyle(0x29b6f6);
    idle.fillRect(10, 20, 12, 16); // 身体
    idle.generateTexture('agent_idle', T, T + 4);
    idle.destroy();

    // Agent 忙碌（橙色高亮）
    const busy = this.make.graphics({ x: 0, y: 0, add: false });
    busy.fillStyle(0xf39c12);
    busy.fillCircle(16, 10, 8);
    busy.fillStyle(0xe67e22);
    busy.fillRect(10, 20, 12, 16);
    // 忙碌标记 ●
    busy.fillStyle(0xff4444);
    busy.fillCircle(26, 4, 4);
    busy.generateTexture('agent_busy', T, T + 4);
    busy.destroy();

    this.scene.start('OfficeScene');
  }
}
