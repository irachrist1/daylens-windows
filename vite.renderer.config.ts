import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import path from 'node:path'

const isStandalone = process.env.STANDALONE_BUILD === '1'

export default defineConfig({
  // index.html lives in src/renderer/, not the project root
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      // Use path.resolve so this works regardless of cwd at build time
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@daylens/remote-contract': path.resolve(__dirname, 'packages/remote-contract/index.ts'),
    },
  },
  build: {
    ...(isStandalone && {
      outDir: path.resolve(__dirname, 'dist/renderer/main_window'),
      emptyOutDir: true,
    }),
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react':  ['react', 'react-dom', 'react-router-dom'],
          'vendor-charts': ['recharts'],
        },
      },
    },
  },
})
