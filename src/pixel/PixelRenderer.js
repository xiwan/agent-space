/**
 * PixelRenderer — 极简 Canvas 像素办公室渲染
 *
 * 设计取舍:
 *   - 不复刻 pixel-office 的 A* 寻路 / collision map / door 系统
 *     (那些依赖 pixel-office 写死的房间布局, 跟 ACP agent 状态无关)
 *   - 只保留: 画背景 + 画带方向/行走动画的角色 sprite
 *   - 状态变化时, 角色用线性插值平滑走到目标位置
 *
 * v2.4.0:
 *   - 走路从直线插值改为 path-based (path[] 由外部 setConfig 时附在 spec.path 上, 来自 PathFinder)
 *   - 编辑模式: hideSprites + drawEditOverlay (grid 线 + obstacles + zones)
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

      // 默认背景 = placeholder, 后续可由 setBackground(url) 替换
      this.background = new Image();
      this.background.onload = onOne;
      this.background.onerror = () => {
        console.error('[PixelRenderer] placeholder background load failed');
        onOne();
      };
      this.background.src = `${this.basePath}/oficina-placeholder.png`;

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

  /**
   * 异步替换背景图 (运行时切换). 加载失败保留旧图.
   * @param {string} url
   * @returns {Promise<void>} resolve 表示新图已就位; reject 表示加载失败 (旧图未变)
   */
  swapBackground(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.background = img;
        resolve();
      };
      img.onerror = () => {
        console.warn(`[PixelRenderer] background swap failed: ${url}, keeping previous`);
        reject(new Error(`failed to load ${url}`));
      };
      img.src = url;
    });
  }
}

/**
 * 计算 sprite 当前应该用 sheet 哪一帧 (纯函数, 不画).
 * drawCharacter 和 drawOutline 共享此结果, 保证描边和 sprite 用同一帧.
 *
 * @param agent { facing, walking, sitting, state }
 * @param frame 全局帧数
 * @returns {{ sx, sy, flipX, yOffset }}
 */
function computeFrameInfo(agent, frame) {
  let rowY = 0;
  let flipX = false;
  if (agent.facing === 'down') rowY = 0;
  else if (agent.facing === 'up') rowY = 1;
  else if (agent.facing === 'right') rowY = 2;
  else if (agent.facing === 'left') { rowY = 2; flipX = true; }

  let colX = 1;
  let yOffset = 0;
  if (agent.sitting) {
    colX = 3;
    yOffset = 16;
  } else if (agent.walking) {
    const w = Math.floor(frame / 6) % 4;
    colX = w === 0 ? 0 : w === 1 ? 1 : w === 2 ? 0 : 2;
  }

  return { sx: colX * FRAME_W, sy: rowY * FRAME_H, flipX, yOffset };
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
 * @returns {{ sx: number, sy: number, flipX: boolean, yOffset: number } | null}
 *   返回此次绘制的 sheet 切片信息, 用于外部画 outline (复用同一帧). null 表示未绘制.
 */
function drawCharacter(ctx, sheet, x, y, colorIdx, facing, walking, sitting, frame) {
  if (!sheet.loaded) return null;

  const charImg = sheet.chars[colorIdx % sheet.chars.length];
  if (!charImg.complete || charImg.naturalWidth === 0) return null;

  const info = computeFrameInfo({ facing, walking, sitting }, frame);
  const { sx, sy, flipX, yOffset } = info;

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

  return info;
}

/**
 * 在 (x, y) 位置画 sprite 的白色像素描边 (8 方向偏移法).
 *
 * 算法: 把当前帧切到 offscreen → 扫描每个非透明像素 → 在主 canvas 8 个 OFFSET
 * 位置画白色 RENDER_SCALE x RENDER_SCALE 方块. 之后 sprite 本身正常画上去会
 * 遮住中心, 视觉上形成 2 px 厚的白边.
 *
 * @param ctx 主 canvas 2D context
 * @param sheet SpriteSheet
 * @param x, y 角色脚部坐标 (canvas 像素, 与 drawCharacter 一致)
 * @param colorIdx
 * @param frameInfo drawCharacter 返回值 { sx, sy, flipX, yOffset }
 */
const OUTLINE_OFFSETS = [
  [-2, -2], [0, -2], [2, -2],
  [-2,  0],          [2,  0],
  [-2,  2], [0,  2], [2,  2],
];
let _outlineCanvas = null;
let _outlineCtx = null;
function getOutlineScratch() {
  if (!_outlineCanvas) {
    _outlineCanvas = document.createElement('canvas');
    _outlineCanvas.width = FRAME_W;
    _outlineCanvas.height = FRAME_H;
    _outlineCtx = _outlineCanvas.getContext('2d', { willReadFrequently: true });
    _outlineCtx.imageSmoothingEnabled = false;
  }
  return { canvas: _outlineCanvas, ctx: _outlineCtx };
}

function drawOutline(ctx, sheet, x, y, colorIdx, frameInfo) {
  if (!frameInfo || !sheet.loaded) return;
  const charImg = sheet.chars[colorIdx % sheet.chars.length];
  if (!charImg.complete || charImg.naturalWidth === 0) return;

  const { sx, sy, flipX, yOffset } = frameInfo;
  const { canvas: tmp, ctx: tctx } = getOutlineScratch();
  tctx.clearRect(0, 0, FRAME_W, FRAME_H);
  tctx.drawImage(charImg, sx, sy, FRAME_W, FRAME_H, 0, 0, FRAME_W, FRAME_H);
  const data = tctx.getImageData(0, 0, FRAME_W, FRAME_H).data;

  // sprite 在主 canvas 上的左上角 (考虑居中对齐 + sitting yOffset)
  const baseX = x - (FRAME_W / 2) * RENDER_SCALE;
  const baseY = y - FRAME_H * RENDER_SCALE + yOffset;

  ctx.save();
  ctx.fillStyle = '#fff';
  for (let py = 0; py < FRAME_H; py++) {
    for (let px = 0; px < FRAME_W; px++) {
      const a = data[(py * FRAME_W + px) * 4 + 3];
      if (a < 8) continue;
      // flipX: 左右镜像 sprite, 描边也要镜像
      const drawPx = flipX ? (FRAME_W - 1 - px) : px;
      const cx = baseX + drawPx * RENDER_SCALE;
      const cy = baseY + py * RENDER_SCALE;
      for (const [ox, oy] of OUTLINE_OFFSETS) {
        ctx.fillRect(cx + ox, cy + oy, RENDER_SCALE, RENDER_SCALE);
      }
    }
  }
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
    this._selectedName = null;

    // v2.4.0: 编辑模式状态
    this._editMode = false;
    this._mapConfig = null;        // 在编辑模式下要画的 obstacles/zones
    this._editTool = null;         // 'clear' | 'blocked' | 'home' | 'work' | 'idle'
    this._editAgent = null;

    // v2.5.0: paused / sprite visibility
    this._paused = true;
    this._spritesVisible = false;

    canvas.addEventListener('click', (e) => this._handleClick(e));
  }

  async init() {
    await this.sheet.load();
  }

  /**
   * 设置当前选中的 agent (用于绘制白色描边)
   * @param {string | null} name agent 名, 传 null 取消选中
   */
  setSelected(name) {
    this._selectedName = name || null;
  }

  /**
   * 异步切换背景图. 加载失败时保留旧图, 不抛出 (仅警告).
   * @param {string | null} url 传 null 表示用 placeholder
   * @returns {Promise<void>}
   */
  async setBackground(url) {
    const target = url || `${this.assetPath.replace(/\/$/, '')}/oficina-placeholder.png`;
    try {
      await this.sheet.swapBackground(target);
    } catch (e) {
      // swapBackground 内已经 console.warn, 这里静默
    }
  }

  /**
   * 接收 BridgeAdapter 输出的 config, 同步到内部 agent 列表.
   *
   * v2.4.0: spec.path 可选 — 由外部 (pixel-main) 在 mapConfig 模式下用 PathFinder
   * 计算好的 [[c,r],...] 路径 (单位: cell). 有 path 时, 走 path; 无 path 时, 直线插值.
   *
   * @param config { agents: [{ name, x, y, state, ..., path?: [[c,r],...] }] }
   */
  setConfig(config) {
    const incoming = config.agents || [];
    const byName = new Map(this.agents.map(a => [a.name, a]));

    const next = incoming.map(spec => {
      const prev = byName.get(spec.name);

      // v2.5.0: paused 时仍更新 metadata, 但保持位置 + path 不变
      if (prev && this._paused) {
        return {
          ...prev,
          // 接受 metadata 变化
          state: spec.state,
          color: spec.color,
          description: spec.description,
          domains: spec.domains,
          active: spec.active,
          // 但不动位置 / 走路状态 / path
        };
      }

      if (!prev) {
        // 新 agent: 即使 paused 也允许 spawn (sprite 出现) — 但默认 paused 时整个 sprite 不可见,
        // 等用户 Start 后再 setSpritesVisible(true). spawn 位置就是 spec.x/y (BridgeAdapter 已用 mapConfig 算成 home).
        return makeAgent(spec);
      }

      // 已存在 + 不 paused: 更新目标位置
      const moved = prev.tx !== spec.x || prev.ty !== spec.y;
      const newFacing = moved
        ? (spec.x > prev.cx ? 'right' : spec.x < prev.cx ? 'left' : prev.facing)
        : prev.facing;
      return {
        ...prev,
        ...spec,
        cx: prev.cx,
        cy: prev.cy,
        tx: spec.x,
        ty: spec.y,
        facing: newFacing,
        walking: moved,
        sitting: !moved && spec.state === 'busy',
        path: spec.path && spec.path.length > 1 ? spec.path.slice() : null,
        pathIdx: 0,
        pathGridSize: spec.pathGridSize || 16,
      };
    });

    this.agents = next;
    this._lastConfigByName = Object.fromEntries(next.map(a => [a.name, a]));
  }

  /**
   * v2.4.0: 切换编辑模式. 编辑模式下 sprite 隐藏, 显示 grid + obstacles + zones overlay.
   * @param {boolean} on
   * @param {object} mapConfig
   */
  setEditMode(on, mapConfig = null) {
    this._editMode = !!on;
    this._mapConfig = mapConfig;
  }

  /**
   * v2.4.0: 编辑器实时改 mapConfig 时通知 renderer 重绘 (mapConfig 是同一对象引用,
   * mutate 即可被下一帧看到, 无需特殊调用).
   * 此 API 留给以后切对象引用时使用.
   */
  setMapConfig(mapConfig) {
    this._mapConfig = mapConfig;
  }

  /**
   * v2.4.0: 设置编辑器当前 tool / agent (仅影响 overlay 高亮; 实际涂刷由 MapEditor 负责)
   */
  setEditCursor(tool, agentName) {
    this._editTool = tool || null;
    this._editAgent = agentName || null;
  }

  /**
   * v2.5.0: 暂停模拟. paused=true 时 setConfig 仍然更新 agent 数据 (state/desc)
   * 但不更新 cx/cy/walking, sprite 冻结在当前位置.
   */
  setPaused(on) {
    this._paused = !!on;
  }

  /**
   * v2.5.0: 控制 sprite 是否可见. 默认隐藏 (start 前).
   * 不影响数据轮询, 仅影响 _draw 是否画 sprite.
   */
  setSpritesVisible(on) {
    this._spritesVisible = !!on;
  }

  isPaused() { return this._paused; }
  areSpritesVisible() { return this._spritesVisible; }

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
    if (this._paused) return; // v2.5.0: paused 不做位置插值, sprite 冻结
    const SPEED = 1.5; // 每帧像素
    for (const a of this.agents) {
      // v2.4.0: 有 path 则走 path (逐 cell 插值); 无 path 退化为直线插值
      let stepX, stepY;
      if (a.path && a.pathIdx < a.path.length) {
        const [pc, pr] = a.path[a.pathIdx];
        const gs = a.pathGridSize;
        stepX = pc * gs + gs / 2;
        stepY = pr * gs + gs / 2;
      } else {
        stepX = a.tx;
        stepY = a.ty;
      }

      const dx = stepX - a.cx;
      const dy = stepY - a.cy;
      const dist = Math.hypot(dx, dy);

      if (dist < SPEED) {
        a.cx = stepX;
        a.cy = stepY;
        // 如果是 path, 推进到下一个 cell
        if (a.path && a.pathIdx < a.path.length - 1) {
          a.pathIdx++;
          // 朝向更新: 看下一段方向
          const [nc, nr] = a.path[a.pathIdx];
          const ng = a.pathGridSize;
          const nx = nc * ng + ng / 2;
          const ny = nr * ng + ng / 2;
          if (Math.abs(nx - a.cx) > Math.abs(ny - a.cy)) {
            a.facing = nx > a.cx ? 'right' : 'left';
          } else {
            a.facing = ny > a.cy ? 'down' : 'up';
          }
        } else {
          // 到达终点
          if (a.walking) {
            a.walking = false;
            a.sitting = a.state === 'busy';
            a.path = null;
          }
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

    // bg — v2.3.0 100%-up-to-canvas (canvas 已扩到 960×800, 容下最大 L4 = 640×800):
    //   图 ≤ canvas → 100% 原尺寸居中, 周围黑边 (像素美术 1:1, 永不放大)
    //   图 > canvas → contain 缩小放下 (理论上不该触发, 仅作为防御性兜底)
    if (sheet.loaded && sheet.background?.complete) {
      const bg = sheet.background;
      const bw = bg.naturalWidth || bg.width;
      const bh = bg.naturalHeight || bg.height;
      if (bw > 0 && bh > 0) {
        ctx.fillStyle = '#0a0f1c';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        let dw, dh;
        if (bw <= canvas.width && bh <= canvas.height) {
          dw = bw;
          dh = bh;
        } else {
          // 防御性: 万一未来有更大的图, 缩小放下而不是裁切
          const scale = Math.min(canvas.width / bw, canvas.height / bh);
          dw = bw * scale;
          dh = bh * scale;
        }
        const dx = Math.floor((canvas.width - dw) / 2);
        const dy = Math.floor((canvas.height - dh) / 2);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bg, 0, 0, bw, bh, dx, dy, dw, dh);
      } else {
        ctx.fillStyle = '#222';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    } else {
      ctx.fillStyle = '#222';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // v2.4.0: 编辑模式 → 画 grid + obstacles + zones overlay, sprite 隐藏
    if (this._editMode) {
      this._drawEditOverlay();
      return;
    }

    // v2.5.0: sprite 隐藏 (start 前) 直接 return, 只画背景
    if (!this._spritesVisible) {
      return;
    }

    // y-sort agents (脚部 y 越大越靠前)
    const sorted = [...this.agents].sort((a, b) => a.cy - b.cy);

    for (const a of sorted) {
      const dim = a.state === 'offline';
      const isSelected = a.name === this._selectedName;
      ctx.globalAlpha = dim ? 0.4 : 1.0;

      // 选中: 先画白色像素描边 (会被 sprite 中心遮住, 视觉上形成 2px 白边)
      if (isSelected) {
        // pre-flight: 先调一次 drawCharacter 拿到 frameInfo, 但不实际渲染顺序问题
        // 我们直接用一份"试算"逻辑模拟 drawCharacter 的 sx/sy/flipX/yOffset 选取
        const frameInfo = computeFrameInfo(a, this.frame);
        ctx.save();
        ctx.globalAlpha = 1; // outline 始终满色
        drawOutline(ctx, sheet, a.cx, a.cy, a.color, frameInfo);
        ctx.restore();
        ctx.globalAlpha = dim ? 0.4 : 1.0; // 恢复
      }

      drawCharacter(ctx, sheet, a.cx, a.cy, a.color, a.facing, a.walking, a.sitting, this.frame);
      ctx.globalAlpha = 1.0;

      // name + state label
      this._drawLabel(a);
    }
  }

  /**
   * v2.4.0: 编辑模式 overlay
   *   - 半透明 grid 线
   *   - obstacles: 红色填充
   *   - zones: 蓝/绿/黄 (home/work/idle), 当前 _editAgent 高亮
   *   - 当前选中 agent 之外的 zone 半透明
   */
  _drawEditOverlay() {
    const { ctx, canvas } = this;
    const cfg = this._mapConfig;

    // 1. 半透明遮罩 (让背景仍可见但变暗)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!cfg) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No map config — start drawing', canvas.width / 2, canvas.height / 2);
      return;
    }

    const gs = cfg.gridSize;

    // 2. obstacles
    ctx.fillStyle = 'rgba(239, 68, 68, 0.5)';
    for (let r = 0; r < cfg.rows; r++) {
      for (let c = 0; c < cfg.cols; c++) {
        if (cfg.obstacles[r][c]) {
          ctx.fillRect(c * gs, r * gs, gs, gs);
        }
      }
    }

    // 3. zones (v2.5.0: 全局, 一种颜色一个 zone)
    const ZONE_COLORS = {
      home: 'rgba(59, 130, 246, 0.55)',  // blue
      work: 'rgba(34, 197, 94, 0.55)',   // green
      idle: 'rgba(234, 179, 8, 0.55)',   // yellow
    };
    for (const zoneKey of ['home', 'work', 'idle']) {
      const cells = cfg.zones[zoneKey] || [];
      ctx.fillStyle = ZONE_COLORS[zoneKey];
      for (const [c, r] of cells) {
        ctx.fillRect(c * gs, r * gs, gs, gs);
      }
    }

    // 4. grid 线
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= cfg.cols; c++) {
      ctx.moveTo(c * gs, 0);
      ctx.lineTo(c * gs, cfg.rows * gs);
    }
    for (let r = 0; r <= cfg.rows; r++) {
      ctx.moveTo(0, r * gs);
      ctx.lineTo(cfg.cols * gs, r * gs);
    }
    ctx.stroke();
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
