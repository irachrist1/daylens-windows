import { defineConfig } from 'vite'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@daylens/remote-contract': path.resolve(__dirname, 'packages/remote-contract/index.ts'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/mcp-server'),
    emptyOutDir: true,
    ssr: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'packages/mcp-server/src/index.ts'),
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
