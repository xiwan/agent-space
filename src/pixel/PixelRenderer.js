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
  busy:    '#eab308',  // yellow
  idle:    '#10b981',  // green
  offline: '#9ca3af',  // gray
  error:   '#ef4444',  // red
};

// v2.7.0: idle agent chitchat pool (随机选一句)
const IDLE_CHITCHAT = [
  '☕ coffee?',
  'afk brb',
  'lunch?',
  '🌮 anyone?',
  'zzz...',
  '5 min break',
  'stretch time',
  '🌞 nice day',
  '...',
  'free?',
  'snack run?',
  '🎮 later?',
  '🍵',
  '👀',
  'hi 👋',
];

function pickIdleChat() {
  return IDLE_CHITCHAT[Math.floor(Math.random() * IDLE_CHITCHAT.length)];
}

// v2.16.2: bubble multi-line wrap 配置
export const BUBBLE_MAX_CHARS = 500;
export const BUBBLE_MAX_LINE_PX = 240;
export const BUBBLE_MAX_LINES = 12;
export const BUBBLE_LINE_HEIGHT = 12;  // 10px font + 2px leading

// v2.22.0: "wait for order" 预设选项 — 选中 agent 时头上浮现的选择框
export const ORDER_PRESETS = [
  { id: 'last_task', label: '上一个任务在干嘛？' },
  { id: 'say_something', label: '有什么想说的？' },
];

/**
 * v2.16.2: 字符级断行 (中英文混排, 像素字体, 无 word boundary).
 *
 * 行为:
 *   1. text 先 hard-cap 到 maxChars; 超长在末尾追加 '…' (替换最后一字, 不撑破 cap)
 *   2. 显式 '\n' 强制断行
 *   3. 非换行字符逐字累积, 当 measure(line+ch) > maxLineWidthPx 时换行
 *   4. 行数到达 maxLines 时, 末行末尾以 '…' 收尾 (尽量不破坏单字),
 *      其余字符全部丢弃
 *   5. 单字宽度自身就超过 maxLineWidthPx 时, 仍单独占一行 (不无限循环)
 *
 * @param {string} text     原始文本 (null/undefined/非字符串视为空)
 * @param {(s:string)=>number} measure  字符串像素宽度测量函数
 * @param {number} maxLineWidthPx       每行最大像素宽度
 * @param {number} maxLines             最大行数
 * @param {number} [maxChars=BUBBLE_MAX_CHARS]  字符总数 hard-cap
 * @returns {string[]}                  分好行的字符串数组 (>=0 行)
 */
export function wrapBubbleText(text, measure, maxLineWidthPx, maxLines, maxChars = BUBBLE_MAX_CHARS) {
  if (text == null) return [];
  let s = String(text);
  if (!s) return [];
  if (maxLines <= 0) return [];

  // 1. hard-cap 字符数
  if (s.length > maxChars) {
    s = s.slice(0, Math.max(0, maxChars - 1)) + '…';
  }

  const lines = [];
  let cur = '';
  let truncated = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    // 显式换行符
    if (ch === '\n') {
      lines.push(cur);
      cur = '';
      if (lines.length >= maxLines) {
        if (i < s.length - 1) truncated = true;
        break;
      }
      continue;
    }

    const tentative = cur + ch;
    if (cur.length > 0 && measure(tentative) > maxLineWidthPx) {
      // 当前行装不下, 先收尾
      lines.push(cur);
      cur = '';
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
      cur = ch;
    } else {
      cur = tentative;
    }
  }

  // 收尾: 还有剩余且未达上限
  if (cur.length > 0 && lines.length < maxLines) {
    lines.push(cur);
    cur = '';
  } else if (cur.length > 0) {
    // cur 有剩但已达上限: 也算被截
    truncated = true;
  }

  // 行数被截: 末行末尾以 '…' 收尾 (尽量保留可见信息)
  if (truncated && lines.length > 0) {
    const last = lines[lines.length - 1] || '';
    let candidate = last + '…';
    if (measure(candidate) > maxLineWidthPx && last.length > 0) {
      candidate = last.slice(0, -1) + '…';
    }
    lines[lines.length - 1] = candidate;
  }

  return lines;
}

// v2.10.0: busy agent emoji 词库 (按工作主题分组)
// 设计目标: 比 description 文本更生动 / 像素气泡更窄 / 风格统一
export const BUSY_EMOJI_THEMES = {
  coding:    ['💻', '⌨️', '🖱️', '🐛', '🔧', '⚙️', '📦', '🧩'],
  thinking:  ['🤔', '💭', '🧠', '💡', '✏️', '📐', '🎨'],
  testing:   ['🧪', '🔍', '✅', '❌', '⚗️', '🎯'],
  ops:       ['🚀', '🛠️', '📡', '☁️', '🐳', '⚡', '🔥'],
  docs:      ['📝', '📚', '📖', '✍️', '📋', '🗂️'],
  data:      ['📊', '📈', '🔢', '🗃️', '🧮'],
  generic:   ['⚙️', '🔨', '💻', '📊', '🎯', '🔍', '✏️', '🧩'],
};

// domain 关键词 → theme 映射 (一个 domain 可命中多个 theme, 取并集池)
const DOMAIN_THEME_RULES = [
  { theme: 'coding',   pattern: /\b(frontend|ui|web|react|vue|backend|api|server|python|java|go|rust|js|typescript|node|cli|code|coding|debug|fix)\b/i },
  { theme: 'thinking', pattern: /\b(design|architect|plan|brainstorm|spec|review)\b/i },
  { theme: 'testing',  pattern: /\b(test|qa|spec|verify|validate|check)\b/i },
  { theme: 'ops',      pattern: /\b(deploy|devops|infra|aws|k8s|docker|kubernetes|ci|cd|build|release|deploy|ops|admin)\b/i },
  { theme: 'docs',     pattern: /\b(doc|docs|writing|markdown|md|readme|wiki|guide)\b/i },
  { theme: 'data',     pattern: /\b(data|sql|analytics|ml|machine|stats|metric|database|db)\b/i },
];

/**
 * v2.10.0: 根据 agent.domains 选择 emoji 池
 * @param {string[]} domains
 * @returns {string[]} emoji 数组 (可能是多个 theme 的并集; 没匹配返回 generic)
 */
export function pickBusyEmojiPool(domains) {
  const themes = new Set();
  for (const d of (domains || [])) {
    for (const rule of DOMAIN_THEME_RULES) {
      if (rule.pattern.test(d)) themes.add(rule.theme);
    }
  }
  if (themes.size === 0) return BUSY_EMOJI_THEMES.generic.slice();
  // 取并集 + 去重 (Set 保持像素风稳定)
  const merged = new Set();
  for (const theme of themes) {
    for (const emoji of BUSY_EMOJI_THEMES[theme] || []) merged.add(emoji);
  }
  return [...merged];
}

// 数量分布 1-5: 1=30%, 2=40%, 3=20%, 4=8%, 5=2%
const BUSY_COUNT_CDF = [0.30, 0.70, 0.90, 0.98, 1.00];
function pickBusyCount() {
  const r = Math.random();
  for (let i = 0; i < BUSY_COUNT_CDF.length; i++) {
    if (r < BUSY_COUNT_CDF[i]) return i + 1;
  }
  return 1;
}

/**
 * v2.10.0: 给一个 busy agent 生成气泡文本 (1-5 个 emoji 紧贴拼接).
 * @param {string[]} domains
 * @returns {string}
 */
export function pickBusyEmojis(domains) {
  const pool = pickBusyEmojiPool(domains);
  if (pool.length === 0) return '';
  const n = Math.min(pickBusyCount(), pool.length);
  // Fisher-Yates 截前 n 个: 不重复抽取
  const arr = pool.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n).join('');
}

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
 * v2.13.3: 帧布局重排
 *   sheet 112×96 = 7 cols × 3 rows, FRAME_W=16, FRAME_H=32
 *   col 0,1,2 = walking 3 帧
 *   col 3,4   = idle 站立 2 帧 (state ∈ idle/offline/error 用)
 *   col 5,6   = work 站立 2 帧 (state === busy 用)
 *   row 0=down, 1=up, 2=side (left=flip)
 *
 * @param agent { facing, walking, state }
 * @param frame 全局帧数
 * @returns {{ sx, sy, flipX, yOffset }}
 */
export function computeFrameInfo(agent, frame) {
  let rowY;
  if (agent.facing === 'down') rowY = 0;
  else if (agent.facing === 'up') rowY = 1;
  else rowY = 2; // left/right
  const flipX = agent.facing === 'left';

  let colX;
  if (agent.walking) {
    // 走路: 每 6 帧切 1 帧 (≈ 100ms @ 60fps), 3 帧循环
    colX = Math.floor(frame / 6) % 3;
  } else if (agent.state === 'busy') {
    // 工作站立: col 5-6, 每 24 帧切 1 帧 (≈ 400ms)
    colX = 5 + (Math.floor(frame / 24) % 2);
  } else {
    // idle / offline / error 站立: col 3-4
    colX = 3 + (Math.floor(frame / 24) % 2);
  }

  return { sx: colX * FRAME_W, sy: rowY * FRAME_H, flipX, yOffset: 0 };
}

/**
 * 绘制一个角色 sprite
 * @param ctx Canvas 2D context
 * @param sheet SpriteSheet
 * @param x, y 角色脚部坐标 (canvas 像素)
 * @param colorIdx 0~5, 选 char_N.png
 * @param facing 'down' | 'up' | 'left' | 'right'
 * @param walking 是否处于走路状态 (true 时播放走路动画)
 * @param state 'idle' | 'busy' | 'offline' | 'error' — v2.13.3: 决定 standstill 帧
 * @param frame 全局帧数
 * @returns {{ sx, sy, flipX, yOffset } | null}
 */
function drawCharacter(ctx, sheet, x, y, colorIdx, facing, walking, state, frame) {
  if (!sheet.loaded) return null;

  const charImg = sheet.chars[colorIdx % sheet.chars.length];
  if (!charImg.complete || charImg.naturalWidth === 0) return null;

  const info = computeFrameInfo({ facing, walking, state }, frame);
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
    sitting: false,
    wanderUntil: 0,
    // v2.7.0: intermittent chat bubble
    bubbleText: null,
    bubbleUntil: 0,
    bubbleNextAt: 0,
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

    // v2.22.0: wait-for-order 交互态
    this.onAgentOrder = opts.onAgentOrder || null;  // (name, presetId, label) => void
    this._waitOrderName = null;        // 当前处于 wait-order 的 agent 名
    this._orderHitRects = [];          // 每帧记录选择框选项的 [x,y,w,h,presetId,label] 用于点击命中

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
   * v2.22.0: 设置/取消处于 "wait for order" 的 agent.
   * 该 agent 站立不动 (停 wander + 不冒随机气泡), 头上浮现预设选择框.
   * @param {string | null} name agent 名, 传 null 取消
   */
  /**
   * v2.22.0: 设置/取消处于 "wait for order" 的 agent.
   * 该 agent 站立不动 (停 wander + 不冒随机气泡), 头上浮现预设选择框.
   * busy 的 agent 不进入 wait-order — 让它继续自己行动.
   * @param {string | null} name agent 名, 传 null 取消
   */
  setWaitOrder(name) {
    if (name) {
      const a = this.agents.find(x => x.name === name);
      if (a && a.state === 'busy') { this._waitOrderName = null; this._orderHitRects = []; return; }
    }
    this._waitOrderName = name || null;
    if (!name) this._orderHitRects = [];
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
      const stateChanged = prev.state !== spec.state;

      // v2.6.0: agent 正在 wander 且 state 没变 → 只更新 metadata, 不打断 wander
      const isWandering = !stateChanged && (prev.path || prev.wanderUntil > 0);
      if (isWandering) {
        return {
          ...prev,
          state: spec.state,
          color: spec.color,
          description: spec.description,
          domains: spec.domains,
          active: spec.active,
        };
      }

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
        sitting: false,
        path: stateChanged ? null : (spec.path && spec.path.length > 1 ? spec.path.slice() : null),
        pathIdx: 0,
        pathGridSize: spec.pathGridSize || 16,
        wanderUntil: stateChanged ? 0 : (prev.wanderUntil || 0),
        // v2.7.0: state 切换时清空气泡 (新 state 立即可冒新词)
        bubbleText: stateChanged ? null : (prev.bubbleText || null),
        bubbleUntil: stateChanged ? 0 : (prev.bubbleUntil || 0),
        bubbleNextAt: stateChanged ? 0 : (prev.bubbleNextAt || 0),
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
   * v2.6.0: 注入寻路 + zone 查询函数 (依赖反转, renderer 不直接 import).
   * @param {{ findPath: Function, getZoneCells: Function }} fns
   */
  setPathFinder(fns) {
    this._findPath = fns.findPath || null;
    this._getZoneCells = fns.getZoneCells || null;
    // v2.13.3: 接受 stateToZone 注入 (统一状态→zone 映射, 替代 _tryWander hardcode)
    this._stateToZone = fns.stateToZone || null;
  }

  /**
   * v2.10.0: 强制在指定 agent 头顶弹一条气泡 (覆盖 idle/busy 自然轮换).
   * 4-6 秒寿命 (略长于 idle chitchat 的 3-5s, 让用户能看清 agent 输出).
   * 气泡到期后正常恢复 idle/busy 词库循环.
   *
   * v2.20.0: 加 opts.duration 让 caller 控制气泡显示时长 (默认随机 4-6s).
   *
   * @param {string} name
   * @param {string} text — 全文; 渲染端按 v2.16.2 wrapBubbleText 多行换行 (<=500 字)
   * @param {object} [opts]
   * @param {number} [opts.duration] 显示毫秒数 (默认 4000-6000 随机)
   */
  enqueueBubble(name, text, opts = {}) {
    const a = this.agents.find(x => x.name === name);
    if (!a) return;
    if (!text) return;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    a.bubbleText = String(text);
    const duration = (opts && Number.isFinite(opts.duration) && opts.duration > 0)
      ? opts.duration
      : 5000;
    a.bubbleUntil = now + duration;
    // 让冷却从此刻起正常算 (避免立刻被新 chitchat 抢)
    a.bubbleNextAt = a.bubbleUntil + 1500;
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
    const now = performance.now();
    for (const a of this.agents) {
      // v2.22.0: wait-order agent 站立不动 — 停 wander/walking, 清气泡 (改显选择框)
      if (a.name === this._waitOrderName) {
        // 期间若转 busy → 自动解除 wait-order, 让它去工作
        if (a.state === 'busy') {
          this._waitOrderName = null;
          this._orderHitRects = [];
        } else {
          a.walking = false;
          a.path = null;
          a.bubbleText = null;
          continue;
        }
      }
      // v2.6.0: wander — 无 path + idle/busy + 等待结束 → 选新 cell
      if (!a.path && (a.state === 'idle' || a.state === 'busy') && now >= (a.wanderUntil || 0)) {
        this._tryWander(a);
      }

      // v2.4.0: 有 path 则走 path (逐 cell 插值); 无 path 则原地不动 (v2.13.3 修: 防止
      // state 切换瞬间 path=null 直线穿墙. 之前 stepX = a.tx 会朝 BridgeAdapter
      // 给的代表 cell 直线插值, 跨墙跨区).
      let stepX, stepY;
      if (a.path && a.pathIdx < a.path.length) {
        const [pc, pr] = a.path[a.pathIdx];
        const gs = a.pathGridSize;
        stepX = pc * gs + gs / 2;
        stepY = pr * gs + gs / 2;
      } else {
        // no path → 原地, 等下次 wander 触发寻路
        stepX = a.cx;
        stepY = a.cy;
        if (a.walking) {
          a.walking = false;
          a.tx = a.cx;
          a.ty = a.cy;
        }
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
            a.path = null;
            // v2.6.0: 同步 tx/ty 到当前位置, 防止 fallback 直线插值拉回代表 cell
            a.tx = a.cx;
            a.ty = a.cy;
            // v2.6.0: 到达后设 wander 等待
            if (a.state === 'idle' || a.state === 'busy') {
              a.wanderUntil = now + 2000 + Math.random() * 3000;
            }
          }
        }
      } else {
        a.cx += (dx / dist) * SPEED;
        a.cy += (dy / dist) * SPEED;
      }

      // v2.7.0: intermittent chat bubble lifecycle
      // - bubble expires → hide + schedule next (4-10s cooldown)
      // - cooldown done & state in {idle,busy} → pick text (busy: description, idle: random chitchat)
      //                                            set bubbleUntil = now + 3-5s
      if (a.bubbleText && now >= a.bubbleUntil) {
        a.bubbleText = null;
        a.bubbleNextAt = now + 4000 + Math.random() * 6000;
      }
      if (!a.bubbleText && now >= (a.bubbleNextAt || 0) && (a.state === 'idle' || a.state === 'busy')) {
        const text = a.state === 'busy'
          ? pickBusyEmojis(a.domains)  // v2.10.0: emoji 取代 description
          : pickIdleChat();
        if (text) {
          a.bubbleText = text;
          a.bubbleUntil = now + 3000 + Math.random() * 2000;
        } else {
          // busy 但 emoji 池都空 (理论不会, generic 池非空) — short retry
          a.bubbleNextAt = now + 1000;
        }
      }
    }
  }

  /**
   * v2.6.0: 尝试在当前 state 对应 zone 内选一个新 cell 并寻路.
   * 排除当前 cell + 其他 agent 已占用 / 正在前往的 cell.
   */
  _tryWander(a) {
    if (!this._mapConfig || !this._findPath || !this._getZoneCells) return;
    // v2.13.3: 优先用注入的 stateToZone (统一映射), 否则回退到旧 hardcode
    const zoneKey = this._stateToZone
      ? this._stateToZone(a.state)
      : (a.state === 'busy' ? 'work' : 'idle');
    const cells = this._getZoneCells(zoneKey, this._mapConfig);
    if (!cells || cells.length === 0) return;
    const gs = this._mapConfig.gridSize;
    const curCol = Math.floor(a.cx / gs);
    const curRow = Math.floor(a.cy / gs);

    // 收集其他 agent 的 "目标 cell" (path 终点) + 当前所在 cell
    const occupied = new Set();
    for (const other of this.agents) {
      if (other === a) continue;
      // 终点优先 (它正在过去)
      if (other.path && other.path.length > 0) {
        const [tc, tr] = other.path[other.path.length - 1];
        occupied.add(`${tc},${tr}`);
      } else {
        // 没在走 → 用当前 cell
        const oc = Math.floor(other.cx / gs);
        const or = Math.floor(other.cy / gs);
        occupied.add(`${oc},${or}`);
      }
    }

    const candidates = cells.filter(([c, r]) =>
      !(c === curCol && r === curRow) && !occupied.has(`${c},${r}`)
    );
    if (candidates.length === 0) return; // zone 满了, 等下次 tick
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    const path = this._findPath(this._mapConfig.obstacles, [curCol, curRow], target);
    if (path && path.length > 1) {
      a.path = path;
      a.pathIdx = 0;
      a.pathGridSize = gs;
      a.walking = true;
      // 朝向: 看第一步方向
      const [nc, nr] = path[1];
      const nx = nc * gs + gs / 2;
      const ny = nr * gs + gs / 2;
      if (Math.abs(nx - a.cx) > Math.abs(ny - a.cy)) {
        a.facing = nx > a.cx ? 'right' : 'left';
      } else {
        a.facing = ny > a.cy ? 'down' : 'up';
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

    // v2.22.0: 每帧重建选择框命中区
    this._orderHitRects = [];

    for (const a of sorted) {
      const isSelected = a.name === this._selectedName;

      // 选中: 先画白色像素描边 (会被 sprite 中心遮住, 视觉上形成 2px 白边)
      if (isSelected) {
        const frameInfo = computeFrameInfo(a, this.frame);
        ctx.save();
        drawOutline(ctx, sheet, a.cx, a.cy, a.color, frameInfo);
        ctx.restore();
      }

      drawCharacter(ctx, sheet, a.cx, a.cy, a.color, a.facing, a.walking, a.state, this.frame);

      // name label
      this._drawLabel(a);

      // v2.22.0: wait-order agent 头上画预设选择框 (优先于普通气泡)
      if (a.name === this._waitOrderName) {
        this._drawOrderBox(a);
      } else if (a.bubbleText) {
        // v2.7.0: pixel chat bubble — only draw when bubbleText set by _tick lifecycle
        this._drawBubble(a);
      }
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
    const nameColor = STATE_COLORS[a.state] || '#fff';

    ctx.save();
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // bg
    const tw = ctx.measureText(text).width;
    const meshIcon = a.mesh ? '🌐' : '';
    const meshW = meshIcon ? ctx.measureText(meshIcon).width + 2 : 0;
    const padX = 4;
    const totalW = tw + meshW + padX * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(a.cx - totalW / 2, labelY - 9, totalW, 14);

    // name (colored by state)
    ctx.fillStyle = nameColor;
    if (meshIcon) {
      ctx.fillText(meshIcon + ' ' + text, a.cx, labelY - 1);
    } else {
      ctx.fillText(text, a.cx, labelY - 1);
    }

    ctx.restore();
  }

  /**
   * v2.7.0: 像素风聊天气泡. 只画 a.bubbleText (由 _tick 的状态机维护).
   * 风格: 纯色填充 + 1px 黑边 (像素风, 无圆角无阴影), 像素字体, 方块尾巴.
   * v2.16.2: 多行换行 + 500 字符上限 (用 wrapBubbleText 抽出).
   */
  _drawBubble(a) {
    const { ctx } = this;
    const raw = (a.bubbleText || '').trim();
    if (!raw) return;

    // Fade-out in last 800ms
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const remaining = a.bubbleUntil - now;
    const fadeMs = 800;
    const alpha = remaining < fadeMs ? Math.max(0, remaining / fadeMs) : 1;
    if (alpha <= 0) return;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '10px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    // 多行换行 (字符级断行, 中英文混排)
    const measure = (s) => ctx.measureText(s).width;
    const lines = wrapBubbleText(raw, measure, BUBBLE_MAX_LINE_PX, BUBBLE_MAX_LINES);
    if (lines.length === 0) {
      ctx.restore();
      return;
    }

    const padX = 6;
    const padY = 4;
    const lineH = BUBBLE_LINE_HEIGHT;

    // bubble 宽度 = 最长行宽 + 左右 padding (clamp 到 maxLineWidthPx + padding)
    let maxW = 0;
    for (const ln of lines) {
      const w = measure(ln);
      if (w > maxW) maxW = w;
    }
    const bw = Math.ceil(maxW + padX * 2);
    const bh = lines.length * lineH + padY * 2;

    // bubble 位于名字标签上方, 留 4px 间距 + 4px 给尾巴
    const bubbleBottom = a.cy - 80 - 9 - 8; // labelY (a.cy-80) - bg upper(9) - gap(8)
    const bubbleTop = bubbleBottom - bh;
    const bx = Math.round(a.cx - bw / 2);
    const by = Math.round(bubbleTop);

    // 1. 黑边 (外层 +1px)
    ctx.fillStyle = '#000';
    ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);

    // 2. 白色填充
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(bx, by, bw, bh);

    // 3. 像素方块尾巴 (3 阶递减, 像素风)
    const tailX = Math.round(a.cx);
    const tailY = by + bh; // 紧贴 bubble 底部
    // 黑边 (大方块)
    ctx.fillStyle = '#000';
    ctx.fillRect(tailX - 3, tailY,     6, 1);
    ctx.fillRect(tailX - 2, tailY + 1, 4, 1);
    ctx.fillRect(tailX - 1, tailY + 2, 2, 1);
    // 白填充 (内层)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(tailX - 2, tailY,     4, 1);
    ctx.fillRect(tailX - 1, tailY + 1, 2, 1);

    // 4. 文字 (逐行, 左对齐)
    ctx.fillStyle = '#1f2937';
    const textX = bx + padX;
    const firstLineMid = by + padY + lineH / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], textX, firstLineMid + i * lineH);
    }

    ctx.restore();
  }

  /**
   * v2.22.0: 在 agent 头上画 "wait for order" 预设选择框.
   * 每个预设是一个可点击的像素按钮; 命中区记录到 this._orderHitRects.
   */
  _drawOrderBox(a) {
    const { ctx } = this;
    ctx.save();
    ctx.font = '10px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const padX = 6;
    const rowH = 18;
    const gap = 2;
    const measure = (s) => ctx.measureText(s).width;
    let maxW = 0;
    for (const p of ORDER_PRESETS) maxW = Math.max(maxW, measure(p.label));
    const bw = Math.ceil(maxW + padX * 2);
    const bh = ORDER_PRESETS.length * rowH + (ORDER_PRESETS.length - 1) * gap + padX;

    const boxBottom = a.cy - 80 - 9 - 8;
    const by = Math.round(boxBottom - bh);
    const bx = Math.round(a.cx - bw / 2);

    // 黑边 + 深色面板
    ctx.fillStyle = '#000';
    ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(bx, by, bw, bh);

    // 逐个预设画按钮 + 记录命中区
    let ry = by + Math.floor(padX / 2);
    for (const p of ORDER_PRESETS) {
      ctx.fillStyle = '#f3f4f6';
      ctx.fillRect(bx + 2, ry, bw - 4, rowH);
      ctx.fillStyle = '#1f2937';
      ctx.fillText(p.label, a.cx, ry + rowH / 2);
      this._orderHitRects.push([bx + 2, ry, bw - 4, rowH, p.id, p.label]);
      ry += rowH + gap;
    }

    // 像素尾巴
    const tailX = Math.round(a.cx);
    const tailY = by + bh;
    ctx.fillStyle = '#000';
    ctx.fillRect(tailX - 3, tailY, 6, 1);
    ctx.fillRect(tailX - 2, tailY + 1, 4, 1);
    ctx.fillRect(tailX - 1, tailY + 2, 2, 1);

    ctx.restore();
  }

  _handleClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;

    // v2.22.0: 优先命中 wait-order 选择框
    for (const [rx, ry, rw, rh, presetId, label] of this._orderHitRects) {
      if (mx >= rx && mx <= rx + rw && my >= ry && my <= ry + rh) {
        if (this.onAgentOrder) this.onAgentOrder(this._waitOrderName, presetId, label);
        return;
      }
    }

    if (!this.onAgentClick) return;
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
