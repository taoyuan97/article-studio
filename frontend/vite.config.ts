/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 端口固定：5173 被占用时直接报错而非自动换 5174（scripts/stop-frontend.cmd 按端口定位进程，端口漂移会导致停不掉）
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      // 图片素材由后端 /static/assets 提供，开发模式同样经代理转发
      '/static': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // 组件测试只收集 src/ 下的用例；e2e/ 为 Playwright 专用，须排除
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // 组件测试不涉及样式加载
    css: false,
  },
})
