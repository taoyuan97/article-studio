import path from 'node:path'
import { defineConfig } from '@playwright/test'

// 浏览器安装在项目本地目录（沙箱/受限环境无法写 %LOCALAPPDATA%\ms-playwright）。
// `pnpm exec playwright install chromium` 前需设置相同的环境变量，
// 详见 docs/ops/manual-tasks-t005-t006.md。
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.resolve(import.meta.dirname, '../.playwright-browsers')

/**
 * E2E 配置：
 * - webServer 用 backend/.venv 的 Python 直接启动 scripts/e2e_server.py
 *   （假模型 + SERVE_FRONTEND=true 单进程托管 frontend/dist，生产形态）；
 * - 每次运行 --wipe 清空数据目录，用例从干净状态开始；
 * - workers=1 串行执行：共享一个后端实例与数据目录，避免相互干扰；
 * - restart-recovery.spec.ts 自行管理独立端口(8902)与数据目录的后端进程。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8901',
    screenshot: 'only-on-failure',
    locale: 'zh-CN',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    // Windows：cmd 不接受正斜杠开头的可执行路径，需用反斜杠
    command: '.venv\\Scripts\\python.exe scripts\\e2e_server.py --port 8901 --wipe',
    url: 'http://127.0.0.1:8901/api/health',
    cwd: '../backend',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
