// Сборка MicroPIDE: фронтенд кладётся в dist/, сервер (server/) работает с ним как есть.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // в dev-режиме API и обновления отвечает сервер server/server.mjs
    proxy: {
      '/api': 'http://localhost:8080',
      '/version': 'http://localhost:8080',
      '/update': 'http://localhost:8080',
    },
  },
});
