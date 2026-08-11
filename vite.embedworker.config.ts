// Bundle for the embedding worker subprocess. Mirrors vite.worker.config.ts:
// a standalone Node bundle with electron stubbed, shipped under dist/ so
// packaged builds can fork it with ELECTRON_RUN_AS_NODE.
import { defineConfig } from 'vite'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      electron: path.resolve(__dirname, 'packages/mcp-server/stubs/electron.mjs'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/embed-worker'),
    emptyOutDir: true,
    ssr: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'packages/embed-worker/src/index.ts'),
      external: [
        '@huggingface/transformers',
      ],
      output: {
        format: 'cjs',
        inlineDynamicImports: true,
        entryFileNames: 'index.cjs',
      },
    },
  },
})
