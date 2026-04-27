/**
 * BootScene — 数据驱动资产加载
 *
 * 加载流程:
 *   1. preload: 加载 tilemap.json + atlas.json (元数据)
 *   2. create:  读取元数据 → 动态加载 tileset、sprites、spritesheets → 注册动画 → 启动 OfficeScene
 *
 * 所有资产路径来自 tilemap.json.sprites 和 tilemap.json.tileset，
 * 换场景只需换 tilemap.json，代码不用改。
 */
import * as Phaser from 'phaser';

const FRAME = 64;
const STATE_ANIM = { idle: 'idle', busy: 'talk', error: 'damage', offline: 'wait' };

export class BootScene extends Phaser.Scene {
  constructor() { super({ key: 'BootScene' }); }

  preload() {
    this.load.json('atlas', 'assets/agents/atlas.json');
    this.load.json('tilemap', 'assets/tilemap.json');
  }

  create() {
    const tm = this.cache.json.get('tilemap');
    const atlas = this.cache.json.get('atlas');

    // 1. tileset
    this.load.image(tm.tileset.key, tm.tileset.file);

    // 2. furniture sprites — 从 tilemap.sprites 动态加载
    for (const [key, file] of Object.entries(tm.sprites || {})) {
      this.load.image(key, file);
    }

    // 3. agent spritesheets — 从 atlas.json 动态加载
    for (const name of Object.keys(atlas)) {
      this.load.spritesheet(name, `assets/agents/${name}.png`, {
        frameWidth: FRAME, frameHeight: FRAME,
      });
    }

    this.load.once('complete', () => {
      // 注册 agent 动画
      for (const [name, meta] of Object.entries(atlas)) {
        for (const [state, animKey] of Object.entries(STATE_ANIM)) {
          const anim = meta.anims?.[animKey];
          if (!anim) continue;
          this.anims.create({
            key: `${name}_${state}`,
            frames: this.anims.generateFrameNumbers(name, { start: anim.start, end: anim.end }),
            frameRate: state === 'error' ? 4 : 8,
            repeat: -1,
          });
        }
        const walk = meta.anims?.walk;
        if (walk) {
          this.anims.create({
            key: `${name}_walk`,
            frames: this.anims.generateFrameNumbers(name, { start: walk.start, end: walk.end }),
            frameRate: 10,
            repeat: -1,
          });
        }
      }
      this.scene.start('OfficeScene');
    });

    this.load.start();
  }
}
