import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5173;
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:18010';
const BRIDGE_TOKEN = process.env.ACP_BRIDGE_TOKEN || '';

const app = express();

// Proxy /api → Bridge
app.use('/api', createProxyMiddleware({
  target: BRIDGE_URL,
  changeOrigin: true,
  pathRewrite: { '^/api': '' },
  on: {
    proxyReq: (proxyReq, req) => {
      if (!req.headers['authorization'] && BRIDGE_TOKEN) {
        proxyReq.setHeader('Authorization', `Bearer ${BRIDGE_TOKEN}`);
      }
      // Strip ALB forwarded headers so bridge sees 127.0.0.1
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
