import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared'), '@collectors': resolve('src/collectors') } },
  test: { include: ['tests/**/*.test.{ts,tsx}'], environment: 'node' }
})
