// Bundle for the range-facts worker subprocess (DEV-227). Mirrors
// vite.mcp.config.ts: a standalone Node bundle with electron stubbed, shipped
// under dist/ so packaged builds can fork it with ELECTRON_RUN_AS_NODE.
import { defineConfig } from 'vite'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@daylens/remote-contract': path.resolve(__dirname, 'packages/remote-contract/index.ts'),
      electron: path.resolve(__dirname, 'packages/mcp-server/stubs/electron.mjs'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/range-worker'),
    emptyOutDir: true,
    ssr: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'packages/range-worker/src/index.ts'),
      external: [
        'better-sqlite3',
      ],
      output: {
        format: 'cjs',
        inlineDynamicImports: true,
        entryFileNames: 'index.cjs',
      },
    },
  },
})
