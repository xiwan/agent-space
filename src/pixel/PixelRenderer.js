/**
 * PixelRenderer — 极简 Canvas 像素办公室渲染
 *
 * 设计取舍:
 *   - 不复刻 pixel-office 的 A* 寻路 / collision map / door 系统
 *     (那些依赖 pixel-office 写死的房间布局, 跟 ACP agent 状态无关)
 *   - 只保留: 画背景 + 画带方向/行走动画的角色 sprite
 *   - 状态变化时, 角色用线性插值平滑走到目标位置
 *
 * Sprite 表 (来自 pixel-office, 112x96, 7 列 × 3 行, 每帧 16x32):
 *   行 0 = 朝下 (down/front)
 *   行 1 = 朝上 (up/back)
 *   行 2 = 朝右 (right;  向左用水平翻转)
 *   列 0~2 = 走路循环 (ping-pong: 0,1,0,2)
 *   列 3 = 坐下/工作
 */

const SPRITE_COLS = 7;
const SPRITE_ROWS = 3;
const FRAME_W = 16;
const FRAME_H = 32;
const RENDER_SCALE = 2;
const NUM_CHARS = 6;

const STATE_COLORS = {
  busy:    '#10b981',  // green
  idle:    '#6b7280',  // gray
  offline: '#475569',  // dim
  error:   '#ef4444',  // red
};

const STATE_LABELS = {
  busy:    'BUSY',
  idle:    'idle',
  offline: 'offline',
  error:   'ERROR',
};

class SpriteSheet {
  constructor(basePath) {
    this.basePath = basePath.replace(/\/$/, '');
    this.background = null;
    this.chars = [];
    this.loaded = false;
    this._loadCount = 0;
    this._total = 1 + NUM_CHARS;
    this._triedFallback = false;
  }

  load() {
    return new Promise((resolve) => {
      const onOne = () => {
        this._loadCount++;
        if (this._loadCount >= this._total) {
          this.loaded = true;
          resolve();
        }
      };

      // background, fallback 路径在 pixel-office 原版里是先 oficina.png 后 placeholder
      // 这里直接用 placeholder; 用户如有 oficina.png 可放进 public/pixel/
      this.background = new Image();
      this.background.onload = onOne;
      this.background.onerror = () => {
        if (this._triedFallback) {
          console.error('[PixelRenderer] background load failed entirely');
          onOne();
          return;
        }
        this._triedFallback = true;
        console.warn('[PixelRenderer] oficina.png not found, using placeholder');
        this.background.src = `${this.basePath}/oficina-placeholder.png`;
      };
      this.background.src = `${this.basePath}/oficina.png`;

      for (let i = 0; i < NUM_CHARS; i++) {
        const img = new Image();
        img.onload = onOne;
        img.onerror = () => {
          console.error(`[PixelRenderer] char_${i}.png load failed`);
          onOne();
        };
        img.src = `${this.basePath}/characters/char_${i}.png`;
        this.chars.push(img);
      }
    });
  }
}

/**
 * 绘制一个角色 sprite
 * @param ctx Canvas 2D context
 * @param sheet SpriteSheet
 * @param x, y 角色脚部坐标 (canvas 像素)
 * @param colorIdx 0~5, 选 char_N.png
 * @param facing 'down' | 'up' | 'left' | 'right'
 * @param walking 是否处于走路状态 (true 时播放走路动画)
 * @param sitting 是否处于坐下状态
 * @param frame 全局帧数
 */
function drawCharacter(ctx, sheet, x, y, colorIdx, facing, walking, sitting, frame) {
  if (!sheet.loaded) return;

  const charImg = sheet.chars[colorIdx % sheet.chars.length];
  if (!charImg.complete || charImg.naturalWidth === 0) return;

  let rowY = 0;
  let flipX = false;
  if (facing === 'down')  rowY = 0;
  else if (facing === 'up')   rowY = 1;
  else if (facing === 'right') rowY = 2;
  else if (facing === 'left')  { rowY = 2; flipX = true; }

  let colX = 1;
  let yOffset = 0;
  if (sitting) {
    colX = 3;
    yOffset = 16;
  } else if (walking) {
    const w = Math.floor(frame / 6) % 4;
    colX = w === 0 ? 0 : w === 1 ? 1 : w === 2 ? 0 : 2;
  }

  const sx = colX * FRAME_W;
  const sy = rowY * FRAME_H;

  ctx.save();
  ctx.translate(x, y);

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(0, 0, 8 * RENDER_SCALE, 3 * RENDER_SCALE, 0, 0, Math.PI * 2);
  ctx.fill();

  if (flipX) ctx.scale(-1, 1);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    charImg,
    sx, sy, FRAME_W, FRAME_H,
    -(FRAME_W / 2) * RENDER_SCALE,
    -FRAME_H * RENDER_SCALE + yOffset,
    FRAME_W * RENDER_SCALE,
    FRAME_H * RENDER_SCALE,
  );

  ctx.restore();
}

/**
 * 角色状态对象 (内部, 包含插值用的当前位置 + 目标位置)
 */
function makeAgent(spec) {
  return {
    ...spec,
    cx: spec.x,
    cy: spec.y,
    tx: spec.x,
    ty: spec.y,
    facing: 'down',
    walking: false,
    sitting: spec.state === 'busy', // busy → 坐在工位
  };
}

export class PixelRenderer {
  /**
   * @param canvas HTMLCanvasElement
   * @param opts.assetPath 资源路径前缀, 默认 '/pixel'
   * @param opts.onAgentClick 点击 agent 回调 (agent) => void
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.assetPath = opts.assetPath || '/pixel';
    this.onAgentClick = opts.onAgentClick || null;

    this.sheet = new SpriteSheet(this.assetPath);
    this.agents = [];
    this.frame = 0;
    this._running = false;
    this._lastConfigByName = {};

    canvas.addEventListener('click', (e) => this._handleClick(e));
  }

  async init() {
    await this.sheet.load();
  }

  /**
   * 接收 BridgeAdapter 输出的 config, 同步到内部 agent 列表
   */
  setConfig(config) {
    const incoming = config.agents || [];
    const byName = new Map(this.agents.map(a => [a.name, a]));

    const next = incoming.map(spec => {
      const prev = byName.get(spec.name);
      if (!prev) return makeAgent(spec);

      // 已存在: 更新目标位置, 保持当前位置不变 (会插值过去)
      const moved = prev.tx !== spec.x || prev.ty !== spec.y;
      const newFacing = moved
        ? (spec.x > prev.cx ? 'right' : spec.x < prev.cx ? 'left' : prev.facing)
        : prev.facing;
      return {
        ...prev,
        ...spec,                 // overwrite x/y/state/active/description/domains
        cx: prev.cx,             // 保留当前插值位置
        cy: prev.cy,
        tx: spec.x,              // 新目标
        ty: spec.y,
        facing: newFacing,
        walking: moved,
        sitting: !moved && spec.state === 'busy',
      };
    });

    this.agents = next;
    this._lastConfigByName = Object.fromEntries(next.map(a => [a.name, a]));
  }

  start() {
    if (this._running) return;
    this._running = true;
    const loop = () => {
      if (!this._running) return;
      this._tick();
      this._draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this._running = false;
  }

  _tick() {
    this.frame++;
    const SPEED = 1.5; // 每帧像素
    for (const a of this.agents) {
      const dx = a.tx - a.cx;
      const dy = a.ty - a.cy;
      const dist = Math.hypot(dx, dy);
      if (dist < SPEED) {
        a.cx = a.tx;
        a.cy = a.ty;
        if (a.walking) {
          a.walking = false;
          a.sitting = a.state === 'busy';
        }
      } else {
        a.cx += (dx / dist) * SPEED;
        a.cy += (dy / dist) * SPEED;
      }
    }
  }

  _draw() {
    const { ctx, canvas, sheet } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // bg
    if (sheet.loaded && sheet.background?.complete) {
      const bg = sheet.background;
      // 背景拉伸到 canvas
      ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = '#222';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // y-sort agents (脚部 y 越大越靠前)
    const sorted = [...this.agents].sort((a, b) => a.cy - b.cy);

    for (const a of sorted) {
      const dim = a.state === 'offline';
      ctx.globalAlpha = dim ? 0.4 : 1.0;
      drawCharacter(ctx, sheet, a.cx, a.cy, a.color, a.facing, a.walking, a.sitting, this.frame);
      ctx.globalAlpha = 1.0;

      // name + state label
      this._drawLabel(a);
    }
  }

  _drawLabel(a) {
    const { ctx } = this;
    const labelY = a.cy - 80;
    const text = `${a.name}`;
    const stateText = STATE_LABELS[a.state] || a.state;
    const stateColor = STATE_COLORS[a.state] || '#888';

    ctx.save();
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // bg
    const tw = ctx.measureText(text).width;
    const sw = ctx.measureText(stateText).width;
    const padX = 4;
    const totalW = Math.max(tw, sw) + padX * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(a.cx - totalW / 2, labelY - 10, totalW, 24);

    // name
    ctx.fillStyle = '#fff';
    ctx.fillText(text, a.cx, labelY - 1);

    // state
    ctx.fillStyle = stateColor;
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText(stateText, a.cx, labelY + 10);

    ctx.restore();
  }

  _handleClick(e) {
    if (!this.onAgentClick) return;
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;

    // hit test: 角色脚部 (cx, cy), bbox 大约 16*scale 宽 32*scale 高 (向上)
    const hitW = FRAME_W * RENDER_SCALE;
    const hitH = FRAME_H * RENDER_SCALE;
    for (const a of this.agents) {
      if (mx >= a.cx - hitW / 2 && mx <= a.cx + hitW / 2 &&
          my >= a.cy - hitH       && my <= a.cy) {
        this.onAgentClick(a);
        return;
      }
    }
  }
}
