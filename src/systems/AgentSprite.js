/**
 * AgentSprite — PNG sprite 动画 + zone walking
 *
 * 核心方法:
 *   walkTo(x, y, status) — 播放 walk 动画移动到目标位置，到达后切换状态动画
 *   updateStatus(status)  — 原地切换状态（error/offline 等不需要移动的场景）
 */

const STATUS_COLORS = {
  idle: 0x48bb78, busy: 0xf6ad55, error: 0xf56565, offline: 0x718096,
};

export class AgentSprite {
  constructor(scene, name, x, y) {
    this.scene = scene;
    this.name = name;
    this.status = 'offline';
    this._walkTween = null;
    this._idleTimer = null;

    this.container = scene.add.container(x, y);
    this._updateDepth();

    // sprite
    this._sprite = scene.add.sprite(0, 0, name, 0)
      .setOrigin(0.5, 1).setScale(2);
    this.container.add(this._sprite);

    // label (name + dot inline)
    this._label = scene.add.text(0, -105, '', {
      fontSize: '11px', color: '#e2e8f0', fontFamily: 'monospace',
      backgroundColor: '#00000055', padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 1);
    this.container.add(this._label);

    // init
    this._updateLabel('offline');
    this._playAnim('offline');
    this.container.setAlpha(0.45);

    // interaction
    this._hitArea = scene.add.circle(0, -50, 45, 0x000000, 0)
      .setInteractive({ useHandCursor: true });
    this.container.add(this._hitArea);

    this._hitArea.on('pointerdown', (p) => {
      p.event.stopPropagation();
      this.scene?.showAgentInfo?.(this.name, {
        status: this.status, cbState: 'CLOSED',
        successRate: '94.2%', latency: '1.2s',
        tasks: ['Task 1', 'Task 2', 'Task 3'],
      });
    });
    this._hitArea.on('pointerover', () => {
      if (this.status !== 'offline') this.container.setScale(1.1);
    });
    this._hitArea.on('pointerout', () => this.container.setScale(1));
  }

  /** 走到目标位置后切换状态 */
  walkTo(targetX, targetY, newStatus) {
    if (this.status === newStatus &&
        Math.abs(this.container.x - targetX) < 5 &&
        Math.abs(this.container.y - targetY) < 5) return;

    this._stopMovement();

    const dx = targetX - this.container.x;
    const dy = targetY - this.container.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 10) {
      // 已经在目标位置附近，直接切换
      this.updateStatus(newStatus);
      return;
    }

    // 朝向
    this._sprite.setFlipX(dx < 0);

    // walk 动画
    const walkKey = `${this.name}_walk`;
    if (this.scene.anims.exists(walkKey)) this._sprite.play(walkKey);

    // 移动中先设置为非 offline 透明度
    this.container.setAlpha(1);

    this._walkTween = this.scene.tweens.add({
      targets: this.container,
      x: targetX,
      y: targetY,
      duration: dist * 10, // ~10ms per pixel
      ease: 'Linear',
      onUpdate: () => this._updateDepth(),
      onComplete: () => {
        this._walkTween = null;
        this._sprite.setFlipX(false);
        this.updateStatus(newStatus);
      },
    });
  }

  /** 原地切换状态 */
  updateStatus(status) {
    if (this.status === status) return;
    this.status = status;

    this._updateLabel(status);
    this._stopIdleBehavior();
    this.container.setAlpha(status === 'offline' ? 0.45 : 1);

    if (status === 'idle') {
      this._startIdleBehavior();
    } else {
      this._playAnim(status);
    }
  }

  destroy() {
    this._stopMovement();
    this._hitArea?.destroy();
    this.container.destroy();
  }

  // --- idle 漫步行为 ---

  _startIdleBehavior() {
    this._idleHomeX = this.container.x;
    this._idleHomeY = this.container.y;
    this._playAnim('idle');
    this._scheduleWander();
  }

  _scheduleWander() {
    this._idleTimer = this.scene.time.delayedCall(3000 + Math.random() * 3000, () => {
      if (this.status !== 'idle') return;
      this._doWander();
    });
  }

  _doWander() {
    // 在 slot 附近 ±1.5 tiles 范围内漫步
    const TS = this.scene._tileScaled || 96;
    const range = TS * (0.8 + Math.random() * 0.7);
    const dir = Math.random() < 0.5 ? -1 : 1;
    const targetX = this._idleHomeX + dir * range;

    this._sprite.setFlipX(targetX < this.container.x);

    const walkKey = `${this.name}_walk`;
    if (this.scene.anims.exists(walkKey)) this._sprite.play(walkKey);

    const dist = Math.abs(targetX - this.container.x);
    this._walkTween = this.scene.tweens.add({
      targets: this.container,
      x: targetX,
      duration: dist * 10,
      ease: 'Linear',
      onUpdate: () => this._updateDepth(),
      onComplete: () => {
        this._walkTween = null;
        if (this.status !== 'idle') return;
        this._sprite.setFlipX(false);
        this._playAnim('idle');
        this._scheduleWander();
      },
    });
  }

  _stopIdleBehavior() {
    if (this._idleTimer) { this._idleTimer.remove(false); this._idleTimer = null; }
  }

  _stopMovement() {
    this._stopIdleBehavior();
    if (this._walkTween) { this._walkTween.stop(); this._walkTween = null; }
    this._sprite.setFlipX(false);
  }

  // --- helpers ---

  _updateDepth() {
    const ts = this.scene._tileScaled;
    if (ts) this.container.setDepth(Math.floor(this.container.y / ts * 10));
  }

  _playAnim(status) {
    const key = `${this.name}_${status}`;
    if (this.scene.anims.exists(key)) this._sprite.play(key);
  }

  _updateLabel(status) {
    const dot = { idle: '🟢', busy: '🟠', error: '🔴', offline: '⚫' }[status] || '⚫';
    const text = status === 'offline' ? this.name : `${this.name} — ${status}`;
    this._label.setText(`${dot} ${text}`);
  }
}
