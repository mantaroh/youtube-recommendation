import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The SPA build.
 *
 * Output goes to `dist/client`, which is what `wrangler.jsonc` points the assets
 * binding at, so `vite build && wrangler deploy` ships both halves as one deployment
 * (design section 5).
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    // `pnpm dev:ui` runs the UI alone against `wrangler dev` on 8787, for the times
    // when a hot-reloading UI is worth more than an exact production topology.
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
})
