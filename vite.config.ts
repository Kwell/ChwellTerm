import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 1420, strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/output/**', '**/artifacts/**', '**/.tools/**'] },
  },
  clearScreen: false,
  build: { target: ['es2022', 'chrome105', 'safari14'], rollupOptions: { output: { manualChunks: { terminal: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-search'], react: ['react', 'react-dom'] } } } },
});
