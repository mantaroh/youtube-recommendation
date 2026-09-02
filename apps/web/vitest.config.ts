import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['worker/test/**/*.test.ts', 'test/**/*.test.ts'],
  },
})
