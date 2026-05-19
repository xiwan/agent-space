import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
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
