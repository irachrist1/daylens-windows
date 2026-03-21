import { defineConfig } from 'vite'
import path from 'node:path'

const isStandalone = process.env.STANDALONE_BUILD === '1'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    ...(isStandalone && {
      outDir: path.resolve(__dirname, 'dist/main'),
      emptyOutDir: false,
    }),
    rollupOptions: {
      external: ['electron'],
      output: {
        format: 'cjs',
        inlineDynamicImports: true,
        // Name explicitly so it doesn't collide with main (also index.ts → index.js).
        // main/index.ts references this as preload.js via __dirname.
        entryFileNames: 'preload.js',
      },
    },
  },
})
