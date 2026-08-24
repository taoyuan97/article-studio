import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { SEND_BUTTON } from './helpers'

/**
 * 场景 D：重启恢复（独立端口 8902 自管理后端，不与 webServer 共享）。
 * 流程：生成中强杀进程 → 重启（recover_stale_runs 将中断运行标记失败）→
 * 前端深链刷新恢复历史 → 可继续对话生成 v1。
 */

const BACKEND_DIR = path.resolve(import.meta.dirname, '..', '..', 'backend')
const PYTHON = path.join(BACKEND_DIR, '.venv', 'Scripts', 'python.exe')
const PORT = 8902
const BASE = `http://127.0.0.1:${PORT}`

function startServer(wipe: boolean): ChildProcess {
  const args = [
    'scripts/e2e_server.py',
    '--port',
    String(PORT),
    '--data-dir',
    'data/e2e-restart',
    '--chunk-delay',
    '0.2',
  ]
  if (wipe) args.push('--wipe')
  return spawn(PYTHON, args, { cwd: BACKEND_DIR, stdio: 'ignore' })
}

async function waitForHealth(timeout = 30_000): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          const response = await fetch(`${BASE}/api/health`)
          return response.ok
        } catch {
          return false
        }
      },
      { timeout },
    )
    .toBe(true)
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  // Windows 下强杀进程树，模拟后端崩溃
  const killed = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
  })
  await new Promise((resolve) => killed.on('close', resolve))
  await new Promise((resolve) => setTimeout(resolve, 1_000))
}

test('场景 D：后端重启后工作台恢复历史并可继续生成', async ({ page }) => {
  const server = startServer(true)
  try {
    await waitForHealth()

    // 新建文章并发送消息，进入流式生成
    const created = await fetch(`${BASE}/api/articles`, { method: 'POST' })
    const article = (await created.json()) as { id: string }
    await page.goto(`${BASE}/articles/${article.id}`)
    await page.locator('.composer textarea').fill('写一篇长文，重启前别写完')
    await page.locator(SEND_BUTTON).click()
    await expect(page.locator('.status-pill')).toHaveText('正在生成', { timeout: 20_000 })
    await expect(page.locator('.streaming-hint')).toBeVisible()

    // 生成中强杀后端
    await stopServer(server)

    // 重启（不清数据）：中断的运行被标记失败（RUN_INTERRUPTED）
    const revived = startServer(false)
    try {
      await waitForHealth()

      // 深链刷新：SPA fallback + 历史恢复（用户指令已持久化、无运行中状态）
      await page.goto(`${BASE}/articles/${article.id}`)
      await expect(page.locator('.status-pill')).toHaveText('准备就绪')
      await expect(page.locator('.message-user')).toHaveCount(1)
      await expect(page.locator('.message-user')).toContainText('重启前别写完')
      // 中断的运行未落版本
      await expect(page.locator('.version-select')).toContainText('暂无版本')

      // 文章状态已标记失败（可从列表识别）
      const response = await fetch(`${BASE}/api/articles/${article.id}`)
      expect(((await response.json()) as { status: string }).status).toBe('failed')

      // 可继续：重新发送并完成 v1
      await page.locator('.composer textarea').fill('直接写')
      await page.locator(SEND_BUTTON).click()
      await expect(page.locator('.status-pill')).toHaveText('正在生成', { timeout: 20_000 })
      await expect(page.locator('.status-pill')).toHaveText('准备就绪', { timeout: 90_000 })
      await expect(page.getByRole('heading', { name: '当前：v1 ·' })).toBeVisible()
    } finally {
      await stopServer(revived)
    }
  } finally {
    await stopServer(server)
  }
})
