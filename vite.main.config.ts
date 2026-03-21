import { defineConfig } from 'vite'
import path from 'node:path'

const isStandalone = process.env.STANDALONE_BUILD === '1'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  define: isStandalone
    ? {
        MAIN_WINDOW_VITE_DEV_SERVER_URL: 'undefined',
        MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window'),
      }
    : {},
  build: {
    ...(isStandalone && {
      outDir: path.resolve(__dirname, 'dist/main'),
      emptyOutDir: true,
    }),
    rollupOptions: {
      // Native addons and electron itself must not be bundled.
      external: ['electron', 'better-sqlite3', '@paymoapp/active-window'],
      output: {
        // Force output to main.js so it matches package.json "main" field
        // and doesn't collide with the preload (also index.ts → index.js by default).
        entryFileNames: 'main.js',
      },
    },
  },
})
