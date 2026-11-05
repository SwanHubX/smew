import { defineConfig } from 'vitest/config'

// https://vitest.dev/config/
// smew 自持的测试工程：只发现本包 tests/ 下的用例
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts']
  }
})
