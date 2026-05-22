import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5173;
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:18010';
const BRIDGE_TOKEN = process.env.ACP_BRIDGE_TOKEN || '';
const PIXEL_MAPS_DIR = join(__dirname, 'public', 'pixel', 'maps');

const VALID_BG_IDS = new Set(['level1', 'level2', 'level3', 'level3.5', 'level4', 'default']);

const app = express();
app.use(express.json({ limit: '512kb' }));

// --- Pixel Map API ---

app.get('/api/pixel-maps/:bgId', async (req, res) => {
  const { bgId } = req.params;
  if (!VALID_BG_IDS.has(bgId)) return res.status(400).json({ error: 'invalid bgId' });
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
  if (!VALID_BG_IDS.has(bgId)) return res.status(400).json({ error: 'invalid bgId' });
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
