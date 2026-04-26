/**
 * AgentSprite.js — Phaser3 像素 agent 小人，封装 idle/busy/error 状态动画
 * 用法：new AgentSprite(scene, name, x, y)
 */

const COLORS = {
  idle:    0x48bb78,   // 绿
  busy:    0xf6ad55,   // 橙
  error:   0xf56565,   // 红
  offline: 0x718096,   // 灰
};

// 小人各部位偏移（相对于 sprite 锚点）
const BODY = { w: 14, h: 18, ox: -7,  oy: -18 };
const HEAD = { r: 7,         ox:  0,  oy: -30 };
const DOT  = { r: 4,         ox:  14, oy: -34 }; // 右上角状态点

export class AgentSprite {
  /**
   * @param {Phaser.Scene} scene
   * @param {string} name  - agent 名称
   * @param {number} x
   * @param {number} y
   */
  constructor(scene, name, x, y) {
    this.scene  = scene;
    this.name   = name;
    this.x      = x;
    this.y      = y;
    this.status = 'offline';
    this._tween = null;

    // --- 绘制容器 ---
    this.container = scene.add.container(x, y);

    // 工位桌（静态背景，不随状态变化）
    const desk = scene.add.graphics();
    desk.fillStyle(0x4a5568);
    desk.fillRoundedRect(-38, -22, 76, 60, 8);
    this.container.add(desk);

    // 身体方块
    this._body = scene.add.graphics();
    this.container.add(this._body);

    // 头部圆
    this._head = scene.add.graphics();
    this.container.add(this._head);

    // 状态圆点（右上角）
    this._dot = scene.add.graphics();
    this.container.add(this._dot);

    // 名字标签 + 状态文字
    this._label = scene.add.text(0, 16, '', {
      fontSize: '11px',
      color: '#e2e8f0',
      fontFamily: 'monospace',
      backgroundColor: '#00000055',
      padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 0);
    this.container.add(this._label);

    // 初始渲染
    this._draw(COLORS.offline);
    this._updateLabel('offline');

    // -- interactive setup --
    // 添加互动区域(circle invisible)用于处理pointer事件，避免影响内部graphics绘制
    this.interactiveArea = scene.add.circle(x, y - 20, 25, 0x000000, 0)
      .setInteractive({ useHandCursor: true });
    this.container.add(this.interactiveArea);

    // 点击显示信息卡
    this.interactiveArea.on('pointerdown', (pointer) => {
      pointer.event.stopPropagation(); // 防止触发拖动
      if (this.scene && this.scene.showAgentInfo) {
        this.scene.showAgentInfo(this.name, {
          status: this.status,
          cbState: 'CLOSED', // TODO: 从 dataManager 获取真实 CB 状态
          successRate: '94.2%',
          latency: '1.2s',
          tasks: ['Task 1', 'Task 2', 'Task 3']
        });
      }
    });

    // hover 效果
    this.interactiveArea.on('pointerover', () => {
      if (this.status !== 'offline') {
        this.container.setScale(1.1);
        this.container.setDepth(100);
      }
    });

    this.interactiveArea.on('pointerout', () => {
      this.container.setScale(1);
      this.container.setDepth(0);
    });
  }

  // ─── 公开 API ────────────────────────────────────────────────

  /** 更新状态并触发对应动画 */
  updateStatus(status) {
    if (this.status === status) return;
    this.status = status;

    const color = COLORS[status] ?? COLORS.offline;
    this._draw(color);
    this._stopTween();
    this._updateLabel(status);

    switch (status) {
      case 'busy':    this._animBusy();    break;
      case 'idle':    this._animIdle();    break;
      case 'error':   this._animError();   break;
      case 'offline': this._animOffline(); break;
    }
  }

  /** 销毁（从场景移除） */
  destroy() {
    this._stopTween();
    if (this.interactiveArea) {
      this.interactiveArea.destroy();
    }
    this.container.destroy();
  }

  // ─── 内部绘制 ────────────────────────────────────────────────

  _draw(color) {
    // 身体
    this._body.clear();
    this._body.fillStyle(color);
    this._body.fillRect(BODY.ox, BODY.oy, BODY.w, BODY.h);

    // 头（比身体亮一点）
    this._head.clear();
    this._head.fillStyle(color, 1);
    this._head.fillCircle(HEAD.ox, HEAD.oy, HEAD.r);
    // 高光
    this._head.fillStyle(0xffffff, 0.15);
    this._head.fillCircle(HEAD.ox - 2, HEAD.oy - 2, 3);

    // 状态点
    this._dot.clear();
    this._dot.fillStyle(color);
    this._dot.fillCircle(DOT.ox, DOT.oy, DOT.r);
    // 状态点描边
    this._dot.lineStyle(1.5, 0x0d1117);
    this._dot.strokeCircle(DOT.ox, DOT.oy, DOT.r);
  }

  /** 更新标签文字 */
  _updateLabel(status) {
    const statusText = status === 'offline' ? '' : ` - ${status}`;
    this._label.setText(`${this.name}${statusText}`);
  }

  // ─── 动画 ────────────────────────────────────────────────────

  /** busy：左右抖动，循环 */
  _animBusy() {
    this._tween = this.scene.tweens.add({
      targets:  this.container,
      x:        this.x + 2,
      yoyo:     true,
      repeat:   -1,          // 无限循环
      duration: 80,
      ease:     'Linear',
    });
  }

  /** idle：轻微上下浮动，循环 */
  _animIdle() {
    this._tween = this.scene.tweens.add({
      targets:  this.container,
      y:        this.y - 3,
      yoyo:     true,
      repeat:   -1,
      duration: 900,
      ease:     'Sine.easeInOut',
    });
  }

  /** error：剧烈抖动 + 脉动缩放，提示异常 */
  _animError() {
    // 位置抖动
    const shake = this.scene.tweens.add({
      targets:  this.container,
      x:        this.x + 3,
      yoyo:     true,
      repeat:   -1,
      duration: 60,
      ease:     'Linear',
    });

    // 缩放脉动
    const pulse = this.scene.tweens.add({
      targets:  this.container,
      scaleX:   1.1,
      scaleY:   1.1,
      yoyo:     true,
      repeat:   -1,
      duration: 200,
      ease:     'Sine.easeInOut',
    });

    // 用数组存储，方便 _stopTween 统一处理
    this._tween = [shake, pulse];
  }

  /** offline：淡出至半透明 */
  _animOffline() {
    this.container.x = this.x;  // 复位
    this.container.y = this.y;
    
    // 取消可能存在的缩放
    this.container.scaleX = 1;
    this.container.scaleY = 1;
    
    this._tween = this.scene.tweens.add({
      targets:  this.container,
      alpha:    0.45,
      duration: 400,
      ease:     'Power1',
    });
  }

  _stopTween() {
    if (this._tween) {
      if (Array.isArray(this._tween)) {
        // error 状态有多个 tween（shake + pulse）
        this._tween.forEach(t => {
          this.scene.tweens.remove(t);
          t.stop();
        });
      } else {
        this.scene.tweens.remove(this._tween);
        this._tween.stop();
      }
      this._tween = null;
    }
    // 复位位置、透明度和缩放
    this.container.x       = this.x;
    this.container.y       = this.y;
    this.container.alpha   = 1;
    this.container.scaleX  = 1;
    this.container.scaleY  = 1;
  }
}
