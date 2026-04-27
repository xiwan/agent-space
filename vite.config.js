import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist' },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:18010',
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
