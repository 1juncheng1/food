import { defineConfig } from 'vitest/config'
import path from 'node:path'

// 项目零测试配置运行已久；本配置只补一件事：@/ 路径别名（与 tsconfig paths 对齐），
// 让测试文件与业务代码中的 @/lib/... 导入在 vitest 下可解析。其余保持默认。
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
  },
})
