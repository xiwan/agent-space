/**
 * OfficeScene.js — Phaser3 像素办公室主场景（P0 占位版）
 * 复制到 src/scenes/OfficeScene.js
 */
import * as Phaser from 'phaser';
import { AgentDataManager } from '../systems/AgentDataManager.js';
import { AgentSprite } from '../systems/AgentSprite.js';

// DESK_LAYOUT 在 create() 中动态生成，基于 this.scale.width/height

const COLORS = {
  floor:   0x2d3748,
  wall:    0x1a202c,
  desk:    0x4a5568,
  idle:    0x48bb78,
  busy:    0xf6ad55,
  offline: 0x718096,
};

export class OfficeScene extends Phaser.Scene {
  constructor() {
    super({ key: 'OfficeScene' });
    this.agents = {};
    this._lastTapTime = 0;
    this._lastPointer = null;
  }

  create() {
    const W = this.scale.width;
    const H = this.scale.height;

    // 动态 agent 工位布局：3列上排 + 2列下排，居中分布
    const rowY1 = H * 0.38;
    const rowY2 = H * 0.70;
    const DESK_LAYOUT = [
      { name: 'claude',    x: W * 0.22, y: rowY1 },
      { name: 'qwen',      x: W * 0.50, y: rowY1 },
      { name: 'opencode',  x: W * 0.78, y: rowY1 },
      { name: 'hermes',    x: W * 0.35, y: rowY2 },
      { name: 'harness',   x: W * 0.65, y: rowY2 },
      { name: 'kiro',      x: W * 0.50, y: rowY2 + 40 }, // 新增：kiro 工位
    ];
    this._deskLayout = DESK_LAYOUT;
    // 暴露 hideAgentInfo 方法供全局调用
    this.hideAgentInfo = () => {
      const card = document.getElementById('agent-info-card');
      if (card) card.style.display = 'none';
    };

    // 点击空白处关闭信息卡
    this.input.on('pointerdown', (pointer) => {
      const card = document.getElementById('agent-info-card');
      if (card && card.style.display === 'block') {
        // 如果点击的不是信息卡本身（信息卡是DOM，不在Phaser事件系统中）
        // 这里通过检查 pointer 来简化处理：点击场景即认为是空白处
        this.hideAgentInfo();
      }
    });

    this._drawOffice();
    DESK_LAYOUT.forEach(d => this._spawnAgent(d));

    this.dataManager = new AgentDataManager(this);
    this.dataManager.start();

    this.events.once('shutdown', () => this.dataManager.stop());
    this.events.once('destroy',  () => this.dataManager.stop());

    this._setupCameraControls();
  }

  /** 供 AgentSprite 调用显示信息卡 */
  showAgentInfo(agentName, data) {
    window.showAgentInfo(agentName, data);
  }

  _setupCameraControls() {
    const cam = this.cameras.main;
    const DEFAULT_ZOOM = 1;
    const DEFAULT_SCROLL = { x: this.scale.width / 2, y: this.scale.height / 2 };
    let isDragging = false;
    let dragStart = { x: 0, y: 0 };
    let camStart = { x: 0, y: 0 };
    let lastPinchDist = null;

    // 双击重置视角
    this.input.on('pointerdblclick', () => {
      this.tweens.add({
        targets: cam,
        scrollX: DEFAULT_SCROLL.x,
        scrollY: DEFAULT_SCROLL.y,
        zoom: DEFAULT_ZOOM,
        duration: 300,
        ease: 'Cubic.easeOut'
      });
    });

    this.input.on('pointerdown', (pointer) => {
      const now = Date.now();
      // 检测是否为双击（用于快速点击agent的场景，避免触发拖动）
      const isQuickTap = now - this._lastTapTime < 300 && this._lastPointer &&
        Math.abs(pointer.x - this._lastPointer.x) < 10 && Math.abs(pointer.y - this._lastPointer.y) < 10;

      this._lastTapTime = now;
      this._lastPointer = { x: pointer.x, y: pointer.y };

      // 如果是快速点击，不触发拖动（留给agent的click事件）
      if (isQuickTap) return;

      if (pointer.getDuration() > 150) {
        isDragging = true;
        dragStart.x = pointer.x;
        dragStart.y = pointer.y;
        camStart.x = cam.scrollX;
        camStart.y = cam.scrollY;
      }
    });

    this.input.on('pointermove', (pointer) => {
      if (this.input.pointer2.isDown) {
        const p1 = this.input.pointer1;
        const p2 = this.input.pointer2;
        const dist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
        if (lastPinchDist !== null) {
          const delta = dist - lastPinchDist;
          const newZoom = Phaser.Math.Clamp(cam.zoom + delta * 0.005, 0.5, 2);
          cam.setZoom(newZoom);
        }
        lastPinchDist = dist;
        return;
      }
      lastPinchDist = null;
      if (!isDragging) return;
      cam.scrollX = camStart.x + (dragStart.x - pointer.x) / cam.zoom;
      cam.scrollY = camStart.y + (dragStart.y - pointer.y) / cam.zoom;
    });

    this.input.on('pointerup', () => {
      isDragging = false;
    });

    this.input.on('wheel', (pointer, deltaX, deltaY) => {
      const scaleFactor = deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Phaser.Math.Clamp(cam.zoom * scaleFactor, 0.5, 2);
      const worldBefore = { x: pointer.worldX, y: pointer.worldY };
      cam.setZoom(newZoom);
      cam.scrollX += (worldBefore.x - cam.scrollX) * (1 - scaleFactor);
      cam.scrollY += (worldBefore.y - cam.scrollY) * (1 - scaleFactor);
    });

    // 初始化 minimap
    this._initMinimap();
  }

  _initMinimap() {
    const MAP_WIDTH = 120;
    const MAP_HEIGHT = 90;
    const X_OFFSET = 8;
    const Y_OFFSET = 8;
    const mapX = this.scale.width - MAP_WIDTH - X_OFFSET;
    const mapY = Y_OFFSET;

    // 创建小地图摄像机（右上角）
    this.minimapCam = this.cameras.add(
      mapX, mapY, MAP_WIDTH, MAP_HEIGHT
    ).setZoom(0.08).setName('minimap');
    this.minimapCam.setBackgroundColor(0x0d1117);

    // 边框
    this.minimapBorder = this.add.graphics()
      .lineStyle(2, 0x4a9eff, 1)
      .strokeRect(mapX, mapY, MAP_WIDTH, MAP_HEIGHT)
      .setScrollFactor(0)
      .setDepth(1000);

    // 视野矩形指示器
    this.viewportRect = this.add.graphics().setDepth(1001);

    // 点击小地图跳转
    this.input.on('pointerdown', (pointer) => {
      const _mapX = this.scale.width - MAP_WIDTH - X_OFFSET;
      const minimapRect = new Phaser.Geom.Rectangle(
        _mapX, mapY, MAP_WIDTH, MAP_HEIGHT
      );
      if (Phaser.Geom.RectangleContains(minimapRect, pointer.x, pointer.y)) {
        // 将屏幕坐标转换为小地图内的坐标
        const minimapX = pointer.x - _mapX;
        const minimapY = pointer.y - mapY;

        // 计算世界坐标
        const worldX = minimapX / this.minimapCam.zoom;
        const worldY = minimapY / this.minimapCam.zoom;

        // 平滑过渡到目标位置
        this.tweens.add({
          targets: this.cameras.main,
          scrollX: worldX,
          scrollY: worldY,
          duration: 500,
          ease: 'Power2'
        });
      }
    });

    // 监听 resize，重新定位 minimap 相机和边框
    this.scale.on('resize', (gameSize) => {
      const newMapX = gameSize.width - MAP_WIDTH - X_OFFSET;
      this.minimapCam.setPosition(newMapX, mapY);
      this.minimapBorder.clear()
        .lineStyle(2, 0x4a9eff, 1)
        .strokeRect(newMapX, mapY, MAP_WIDTH, MAP_HEIGHT);
    });
  }

  update() {
    // 更新 minimap 视野矩形
    if (this.viewportRect && this.minimapCam) {
      const mainCam = this.cameras.main;

      // 计算主摄像机视野在小地图上的位置
      const mapX = ((mainCam.scrollX - this.minimapCam.scrollX) * this.minimapCam.zoom) + (this.scale.width - 120 - 8);
      const mapY = ((mainCam.scrollY - this.minimapCam.scrollY) * this.minimapCam.zoom) + 8;
      const mapW = (mainCam.width * this.minimapCam.zoom) / mainCam.zoom;
      const mapH = (mainCam.height * this.minimapCam.zoom) / mainCam.zoom;

      this.viewportRect.clear();
      this.viewportRect.lineStyle(2, 0x4a9eff, 0.8);
      this.viewportRect.strokeRect(mapX, mapY, mapW, mapH);
    }
  }

  _drawOffice() {
    const W = this.scale.width;
    const H = this.scale.height;
    const PAD = 30;
    const g = this.add.graphics();

    // 地板
    g.fillStyle(COLORS.floor);
    g.fillRect(PAD, PAD, W - PAD * 2, H - PAD * 2);

    // 墙线
    g.lineStyle(3, COLORS.wall);
    g.strokeRect(PAD, PAD, W - PAD * 2, H - PAD * 2);

    // 装饰格线
    g.lineStyle(1, 0x3d4a5c, 0.4);
    for (let x = PAD + 40; x < W - PAD; x += 40) {
      g.lineBetween(x, PAD, x, H - PAD);
    }
    for (let y = PAD + 40; y < H - PAD; y += 40) {
      g.lineBetween(PAD, y, W - PAD, y);
    }

    // 标题
    this.add.text(W / 2, 18, '🏢  ACP Agent Office', {
      fontSize: '18px',
      color: '#e2e8f0',
      fontFamily: 'monospace',
    }).setOrigin(0.5);
  }

  _spawnAgent({ name, x, y }) {
    this.agents[name] = new AgentSprite(this, name, x, y);
  }

  /** 由 AgentDataManager 调用，更新 agent 状态颜色 */
  updateAgentStatus(name, status) {
    const sprite = this.agents[name];
    if (sprite) sprite.updateStatus(status);
  }
}
