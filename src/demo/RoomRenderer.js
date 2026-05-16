/**
 * RoomRenderer — Canvas-based tilemap renderer
 */
import { TILES, FURNITURE } from './TileMapper.js';

const TILE_SIZE = 32;
const SCALE = 2;
const TS = TILE_SIZE * SCALE;

export class RoomRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tilesetImg = null;
    this.spriteCache = {};
  }

  async loadTileset() {
    this.tilesetImg = await this._loadImg('assets/tileset_all.png');
  }

  async render(env, onProgress) {
    const [cols, rows] = env.map_size || [12, 10];
    this.canvas.width = cols * TS;
    this.canvas.height = rows * TS;
    this.ctx.imageSmoothingEnabled = false;

    const room = env.rooms?.[0];
    const bounds = room?.bounds || { x: 1, y: 2, w: cols - 2, h: rows - 3 };

    // Background
    this.ctx.fillStyle = '#1a1a2e';
    this.ctx.fillRect(0, 0, cols * TS, rows * TS);

    // Floor
    if (onProgress) onProgress('绘制地板...');
    this._drawFloor(bounds);

    // Walls
    if (onProgress) onProgress('绘制墙壁...');
    this._drawWalls(bounds);

    // Items — use absolute grid positions from JSON
    const items = room?.items || [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (onProgress) onProgress(`放置 ${item.item} (${i + 1}/${items.length})`);
      const pos = this._getPosition(item, bounds);
      await this._drawFurniture(item.item, pos.x, pos.y);
      await this._delay(50);
    }

    if (onProgress) onProgress('完成 ✓');
  }

  _drawFloor(bounds) {
    const { x, y, w, h } = bounds;
    for (let r = y; r < y + h; r++) {
      for (let c = x; c < x + w; c++) {
        this._drawTile(TILES.floor_tile, c, r);
      }
    }
  }

  _drawWalls(bounds) {
    const { x, y, w, h } = bounds;
    // Top wall (brick, 2 rows)
    for (let c = x - 1; c <= x + w; c++) {
      this._drawTile(TILES.wall_brick, c, y - 2);
      this._drawTile(TILES.wall_lower, c, y - 1);
    }
    // Side walls
    for (let r = y; r < y + h; r++) {
      this._drawTile(TILES.wall_plain, x - 1, r);
      this._drawTile(TILES.wall_plain, x + w, r);
    }
    // Bottom wall
    for (let c = x - 1; c <= x + w; c++) {
      this._drawTile(TILES.wall_plain, c, y + h);
    }
  }

  _getPosition(item, bounds) {
    // If item has explicit x,y use those (absolute grid coords)
    if (item.x !== undefined && item.y !== undefined) {
      return { x: item.x, y: item.y };
    }
    // Otherwise use anchor system
    const { x, y, w, h } = bounds;
    const offset = item.offset || 0;
    const anchor = item.anchor || 'center';

    if (anchor === 'wall_north') return { x: x + 1 + offset, y: y };
    if (anchor === 'wall_south') return { x: x + 1 + offset, y: y + h - 1 };
    if (anchor === 'wall_east')  return { x: x + w - 1, y: y + 1 + offset };
    if (anchor === 'wall_west')  return { x: x, y: y + 1 + offset };
    if (anchor === 'corner_nw')  return { x: x, y: y };
    if (anchor === 'corner_ne')  return { x: x + w - 1, y: y };
    if (anchor === 'corner_sw')  return { x: x, y: y + h - 1 };
    if (anchor === 'corner_se')  return { x: x + w - 1, y: y + h - 1 };
    if (anchor === 'center')     return { x: x + Math.floor(w / 2), y: y + Math.floor(h / 2) };
    return { x: x + Math.floor(w / 2), y: y + Math.floor(h / 2) };
  }

  async _drawFurniture(itemType, col, row) {
    const def = FURNITURE[itemType];
    if (!def) return;
    const img = await this._getSprite(def.src);
    const tw = def.tw || 1;
    const th = def.th || 1;
    const dw = tw * TS;
    const dh = th * TS;

    // Desktop items render smaller (60% size, centered on tile)
    if (def.desktop) {
      const scale = 0.6;
      const fw = dw * scale, fh = dh * scale;
      const dx = col * TS + (dw - fw) / 2;
      const dy = row * TS + (dh - fh) / 2;
      this.ctx.drawImage(img, dx, dy, fw, fh);
      return;
    }

    // Normal items: maintain aspect ratio, fill tile area
    const aspect = img.naturalWidth / img.naturalHeight;
    const areaAspect = dw / dh;
    let fw, fh;
    if (aspect > areaAspect) {
      fw = dw;
      fh = dw / aspect;
    } else {
      fh = dh;
      fw = dh * aspect;
    }
    const dx = col * TS + (dw - fw) / 2;
    const dy = row * TS + (dh - fh);
    this.ctx.drawImage(img, dx, dy, fw, fh);
  }

  _drawTile(tileIdx, col, row) {
    if (!this.tilesetImg) return;
    this.ctx.drawImage(
      this.tilesetImg,
      tileIdx * TILE_SIZE, 0, TILE_SIZE, TILE_SIZE,
      col * TS, row * TS, TS, TS
    );
  }

  async _getSprite(src) {
    if (!this.spriteCache[src]) {
      this.spriteCache[src] = await this._loadImg(src);
    }
    return this.spriteCache[src];
  }

  _loadImg(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
