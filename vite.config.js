import { defineConfig } from 'vite';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFile, writeFile, mkdir } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

// v2.9.0: pixel-maps dev middleware (生产对应 serve.js)
const PIXEL_MAPS_DIR = join(__dirname, 'public', 'pixel', 'maps');
const VALID_BG_IDS = new Set(['level1', 'level2', 'level3', 'level3.5', 'level4', 'default']);

function pixelMapsMiddleware() {
  return {
    name: 'pixel-maps-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const m = req.url && req.url.match(/^\/api\/pixel-maps\/([^?#/]+)/);
        if (!m) return next();
        const bgId = decodeURIComponent(m[1]);
        if (!VALID_BG_IDS.has(bgId)) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'invalid bgId' }));
          return;
        }
        const file = join(PIXEL_MAPS_DIR, `${bgId}.json`);

        if (req.method === 'GET') {
          try {
            const data = await readFile(file, 'utf-8');
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(data);
          } catch (e) {
            if (e.code === 'ENOENT') {
              res.statusCode = 404;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ error: 'not found' }));
            } else {
              res.statusCode = 500;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ error: e.message }));
            }
          }
          return;
        }

        if (req.method === 'PUT') {
          let raw = '';
          req.on('data', (chunk) => { raw += chunk; if (raw.length > 524288) req.destroy(); });
          req.on('end', async () => {
            let cfg;
            try { cfg = JSON.parse(raw); } catch {
              res.statusCode = 400;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ error: 'invalid json' }));
              return;
            }
            if (!cfg || typeof cfg !== 'object' || !cfg.zones || !Array.isArray(cfg.obstacles)) {
              res.statusCode = 400;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ error: 'invalid body' }));
              return;
            }
            try {
              await mkdir(PIXEL_MAPS_DIR, { recursive: true });
              await writeFile(file, JSON.stringify(cfg, null, 2));
              res.statusCode = 200;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ ok: true }));
            } catch (e) {
              res.statusCode = 500;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ error: e.message }));
            }
          });
          return;
        }

        // 其他方法直接放过 (不会被 /api 代理拦截, 因为下面的 proxy 只代理非 pixel-maps)
        next();
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [pixelMapsMiddleware()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        demo: resolve(__dirname, 'demo.html'),
        lpc: resolve(__dirname, 'lpc.html'),
        pixel: resolve(__dirname, 'pixel.html'),
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      // /api/pixel-maps/* 由 pixelMapsMiddleware 在 proxy 之前 res.end(), 不会落到这里.
      '/api': {
        target: 'http://172.31.15.10:18010',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (!proxyReq.getHeader('authorization') && process.env.ACP_BRIDGE_TOKEN) {
              proxyReq.setHeader('Authorization', `Bearer ${process.env.ACP_BRIDGE_TOKEN}`);
            }
            proxyReq.removeHeader('x-forwarded-for');
            proxyReq.removeHeader('x-forwarded-proto');
            proxyReq.removeHeader('x-forwarded-host');
          });
          proxy.on('error', (err, req, res) => {
            console.warn('[proxy] error:', err.message);
            if (res.headersSent) return;
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'proxy_error' }));
          });
        },
      },
    },
  },
});
