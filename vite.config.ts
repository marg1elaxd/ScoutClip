import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
  build: {
    rollupOptions: {
      input: {
        // Offscreen documents aren't a manifest key CRXJS auto-discovers
        // (unlike the popup), so it must be added as an explicit entry point.
        offscreen: 'src/offscreen/offscreen.html',
      },
    },
  },
})
