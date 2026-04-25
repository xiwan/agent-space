import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist' },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: ['alb-5173-756109788.us-west-2.elb.amazonaws.com', '.amazonaws.com'],
    proxy: {
      '/api': {
        target: 'http://localhost:18010',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
