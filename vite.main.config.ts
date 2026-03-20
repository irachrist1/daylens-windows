import { defineConfig } from 'vite'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    rollupOptions: {
      // Native addons and electron itself must not be bundled
      external: ['electron', 'better-sqlite3'],
    },
  },
})
