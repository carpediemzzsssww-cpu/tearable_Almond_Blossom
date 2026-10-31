import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: Number(process.env.PORT) || 5188 },
  build: { target: 'es2020' },
});
