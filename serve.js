import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5173;
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:18010';
const BRIDGE_TOKEN = process.env.ACP_BRIDGE_TOKEN || '';
const ASSETS_DIR = join(__dirname, 'public', 'assets');
const PIXEL_MAPS_DIR = join(__dirname, 'public', 'pixel', 'maps'); // v2.9.0

// v2.9.0: 跨端共享 mapConfig 的 bgId 白名单 (严格枚举, 防路径注入)
const VALID_BG_IDS = new Set(['level1', 'level2', 'level3', 'level3.5', 'level4', 'default']);

const app = express();
app.use(express.json({ limit: '512kb' })); // mapConfig 一份约 50KB, 给点 headroom

// --- Rooms API ---

// List all rooms (directories in public/assets that contain tilemap.json)
app.get('/api/rooms', async (req, res) => {
  try {
    const entries = await readdir(ASSETS_DIR, { withFileTypes: true });
    const rooms = [];
    for (const e of entries) {
      if (e.isDirectory() && existsSync(join(ASSETS_DIR, e.name, 'tilemap.json'))) {
        rooms.push(e.name);
      }
    }
    res.json(rooms);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create new room
app.post('/api/rooms', async (req, res) => {
  const { name } = req.body;
  if (!name || /[^a-zA-Z0-9_-]/.test(name)) {
    return res.status(400).json({ error: 'Invalid room name (alphanumeric, dash, underscore only)' });
  }
  const dir = join(ASSETS_DIR, name);
  try {
    await mkdir(dir, { recursive: true });
    const initial = { gridSize: 32, layers: { floor: [], objects: [], aboveNpc: [], walkable: [] }, assets: [] };
    await writeFile(join(dir, 'tilemap.json'), JSON.stringify(initial, null, 2));
    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get room tilemap
app.get('/api/rooms/:name', async (req, res) => {
  const file = join(ASSETS_DIR, req.params.name, 'tilemap.json');
  try {
    const data = await readFile(file, 'utf-8');
    res.json(JSON.parse(data));
  } catch (e) {
    res.status(404).json({ error: 'Room not found' });
  }
});

// Save room tilemap
app.post('/api/rooms/:name', async (req, res) => {
  const dir = join(ASSETS_DIR, req.params.name);
  if (!existsSync(dir)) return res.status(404).json({ error: 'Room not found' });
  try {
    await writeFile(join(dir, 'tilemap.json'), JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List room assets (PNG files, recursive including subdirectories)
app.get('/api/rooms/:name/assets', async (req, res) => {
  const dir = join(ASSETS_DIR, req.params.name);
  try {
    const pngs = [];
    async function scan(d, prefix) {
      const files = await readdir(d, { withFileTypes: true });
      for (const f of files) {
        if (f.isDirectory()) await scan(join(d, f.name), prefix ? `${prefix}/${f.name}` : f.name);
        else if (f.name.endsWith('.png')) pngs.push(prefix ? `${prefix}/${f.name}` : f.name);
      }
    }
    await scan(dir, '');
    res.json(pngs);
  } catch (e) {
    res.status(404).json({ error: 'Room not found' });
  }
});

// --- v2.9.0: Pixel Map API (跨端共享 mapConfig) ---

app.get('/api/pixel-maps/:bgId', async (req, res) => {
  const { bgId } = req.params;
  if (!VALID_BG_IDS.has(bgId)) {
    return res.status(400).json({ error: 'invalid bgId' });
  }
  const file = join(PIXEL_MAPS_DIR, `${bgId}.json`);
  try {
    const data = await readFile(file, 'utf-8');
    res.type('application/json').send(data);
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/pixel-maps/:bgId', async (req, res) => {
  const { bgId } = req.params;
  if (!VALID_BG_IDS.has(bgId)) {
    return res.status(400).json({ error: 'invalid bgId' });
  }
  const cfg = req.body;
  if (!cfg || typeof cfg !== 'object' || !cfg.zones || !Array.isArray(cfg.obstacles)) {
    return res.status(400).json({ error: 'invalid body' });
  }
  try {
    await mkdir(PIXEL_MAPS_DIR, { recursive: true });
    await writeFile(join(PIXEL_MAPS_DIR, `${bgId}.json`), JSON.stringify(cfg, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Bridge Proxy ---
app.use('/api', createProxyMiddleware({
  target: BRIDGE_URL,
  changeOrigin: true,
  pathRewrite: { '^/api': '' },
  on: {
    proxyReq: (proxyReq, req) => {
      if (!req.headers['authorization'] && BRIDGE_TOKEN) {
        proxyReq.setHeader('Authorization', `Bearer ${BRIDGE_TOKEN}`);
      }
      proxyReq.removeHeader('x-forwarded-for');
      proxyReq.removeHeader('x-forwarded-proto');
      proxyReq.removeHeader('x-forwarded-host');
    },
  },
}));

// Serve static build
app.use(express.static(join(__dirname, 'dist')));
app.get('/{*splat}', (req, res) => res.sendFile(join(__dirname, 'dist', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent Space → http://0.0.0.0:${PORT}`);
  console.log(`Bridge proxy → ${BRIDGE_URL}`);
});
