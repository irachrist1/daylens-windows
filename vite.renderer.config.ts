import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import path from 'node:path'

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      // Use path.resolve so this works regardless of cwd at build time
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
})
