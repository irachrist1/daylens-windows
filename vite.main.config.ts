import { defineConfig } from 'vite'
import path from 'node:path'

const isStandalone = process.env.STANDALONE_BUILD === '1'
const convexSiteUrl = JSON.stringify(
  process.env.DAYLENS_CONVEX_SITE_URL ?? 'https://decisive-aardvark-847.convex.site',
)

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
        __DAYLENS_CONVEX_SITE_URL__: convexSiteUrl,
      }
    : {
        __DAYLENS_CONVEX_SITE_URL__: convexSiteUrl,
      },
  build: {
    // Build as Node (not browser) so node: builtins are not externalized
    ...(isStandalone && {
      outDir: path.resolve(__dirname, 'dist/main'),
      emptyOutDir: true,
      ssr: true,
    }),
    rollupOptions: {
      input: path.resolve(__dirname, 'src/main/index.ts'),
      // Native addons and electron itself must not be bundled.
      external: ['electron', 'better-sqlite3', '@paymoapp/active-window', 'keytar'],
      output: {
        // Force output to main.js so it matches package.json "main" field
        // and doesn't collide with the preload (also index.ts → index.js by default).
        entryFileNames: 'main.js',
      },
    },
  },
})
