import { defineConfig } from 'vite'
import path from 'node:path'

const isStandalone = process.env.STANDALONE_BUILD === '1'
const convexSiteUrl = JSON.stringify(
  process.env.DAYLENS_CONVEX_SITE_URL || 'https://decisive-aardvark-847.convex.site',
)
const posthogKey = JSON.stringify(
  process.env.POSTHOG_KEY || 'phc_d0IcV73kr5HKVVY3UGGdUf9Meq1sKE3dJxcVq9ZjkCW',
)
const posthogHost = JSON.stringify(
  process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
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
        __POSTHOG_KEY__: posthogKey,
        __POSTHOG_HOST__: posthogHost,
      }
    : {
        __DAYLENS_CONVEX_SITE_URL__: convexSiteUrl,
        __POSTHOG_KEY__: posthogKey,
        __POSTHOG_HOST__: posthogHost,
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
      external: ['electron', 'better-sqlite3', '@paymoapp/active-window', 'keytar', 'electron-updater'],
      output: {
        format: 'cjs',
        inlineDynamicImports: true,
        entryFileNames: 'main.js',
      },
    },
  },
})
