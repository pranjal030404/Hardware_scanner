import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = {
  '@shared': resolve('src/shared'),
  '@collectors': resolve('src/collectors')
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: { rollupOptions: { external: ['node:sqlite'] } }
  },
  preload: {
    resolve: { alias },
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].js' } } }
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: { ...alias, '@renderer': resolve('src/renderer') } },
    plugins: [react()]
  }
})
