import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, type Page } from '@playwright/test'

const execFileAsync = promisify(execFile)

/** 后端 venv Python 与 E2E 数据库（场景 G 直查 SQLite 断言压缩产物） */
const BACKEND_DIR = path.resolve(import.meta.dirname, '..', '..', 'backend')
const PYTHON = path.join(BACKEND_DIR, '.venv', 'Scripts', 'python.exe')
const E2E_DB = path.join(BACKEND_DIR, 'data', 'e2e', 'article.sqlite3')

/** 通过 API 新建文章，返回文章 ID */
export async function createArticleViaApi(page: Page): Promise<string> {
  const response = await page.request.post('/api/articles')
  expect(response.ok()).toBeTruthy()
  return ((await response.json()) as { id: string }).id
}

/** UI：在当前工作台发送一条消息，等待运行结束（状态回到「准备就绪」） */
export async function sendAndAwaitIdle(page: Page, content: string): Promise<void> {
  await page.locator('.composer textarea').fill(content)
  await page.locator(SEND_BUTTON).click()
  await expect(page.locator('.status-pill')).toHaveText('正在生成', { timeout: 20_000 })
  await expect(page.locator('.status-pill')).toHaveText('准备就绪', { timeout: 90_000 })
}

/**
 * 发送/停止按钮用 CSS 类定位（而非可访问名）：
 * - AntD 两字按钮自动插空格（「发送」→「发 送」）；
 * - 生成结束后 loading 图标的离场动画在 disabled 期间冻结（rc-motion 收不到
 *   transitionEnd），图标残留会让可访问名长期变为「loading 发 送」。
 * 发送为 primary、停止为 dangerous，类名稳定且不受上述两种渲染细节影响。
 */
export const SEND_BUTTON = '.composer-actions .ant-btn-primary'
export const STOP_BUTTON = '.composer-actions .ant-btn-dangerous'

/** 弹窗内「保存」按钮（AntD 自动插空格「保 存」），用正则兼容两种形态 */
export const SAVE_BUTTON = /^保\s*存$/

/**
 * API：发送消息并轮询 workspace 直到版本数达到期望值（运行已落版本）。
 * 不依赖浏览器 SSE 消费——后端运行与事件持久化独立完成。
 */
export async function sendViaApiAndAwaitVersion(
  page: Page,
  articleId: string,
  content: string,
  expectedVersionCount: number,
): Promise<void> {
  const response = await page.request.post(`/api/articles/${articleId}/messages`, {
    data: { content },
  })
  expect(response.ok()).toBeTruthy()
  await expect
    .poll(
      async () => {
        const workspace = await (
          await page.request.get(`/api/articles/${articleId}/workspace`)
        ).json()
        return (workspace.versions as unknown[]).length
      },
      { timeout: 90_000 },
    )
    .toBeGreaterThanOrEqual(expectedVersionCount)
}

/** 直查 E2E SQLite：文章的上下文压缩产物（conversation_summary / summary_until_message_id） */
export async function readConversationSummary(
  articleId: string,
): Promise<{ summary: string | null; until: string | null }> {
  const code = [
    'import json,sqlite3,sys',
    `c=sqlite3.connect(r"${E2E_DB}")`,
    'row=c.execute("SELECT conversation_summary,summary_until_message_id FROM articles WHERE id=?", (sys.argv[1],)).fetchone()',
    'print(json.dumps({"summary": row[0], "until": row[1]}))',
  ].join(';')
  const { stdout } = await execFileAsync(PYTHON, ['-c', code, articleId])
  return JSON.parse(stdout) as { summary: string | null; until: string | null }
}
