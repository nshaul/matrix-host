import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        footage: resolve(__dirname, 'footage.html'),
        stream: resolve(__dirname, 'stream.html'),
      },
    },
  },
})
