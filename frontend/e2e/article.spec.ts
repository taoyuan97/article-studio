import { expect, test, type Page } from '@playwright/test'
import {
  createArticleViaApi,
  readConversationSummary,
  SEND_BUTTON,
  sendAndAwaitIdle,
  sendViaApiAndAwaitVersion,
  STOP_BUTTON,
} from './helpers'

/** 当前正文面板标题定位（「历史对话」面板共用同一 class，须按可访问名消歧） */
const manuscriptHeading = (page: Page, name: string) => page.getByRole('heading', { name })

/**
 * 文章线 MVP 验收场景（假模型，无真实 API Key）：
 * A 新文章与标题（含 SSE 流式无缓冲断言）；B 列表过滤；C 历史对话继续；
 * E 取消；F 失败与重试；G 上下文压缩（后端预算不变量 + 压缩产物断言）。
 * 场景 D（重启恢复）见 restart-recovery.spec.ts（独立端口自管理后端）。
 */

test.describe('文章线 MVP 场景', () => {
  test('场景 A：新建文章、首条消息流式生成标题与 v1（SSE 无缓冲）', async ({ page }) => {
    await page.goto('/articles')
    await page.getByRole('button', { name: '新建文章' }).first().click()
    await expect(page).toHaveURL(/\/articles\/[0-9a-f-]{36}$/)

    // 空态：无对话、无正文、无版本
    await expect(page.getByText('还没有对话。', { exact: false })).toBeVisible()
    await expect(page.locator('.article-empty')).toBeVisible()
    await expect(page.locator('.version-select')).toContainText('暂无版本')

    // 发送首条消息，断言流式期间正文增量到达（生产形态同进程 SSE 不缓冲）
    await page.locator('.composer textarea').fill('直接写一篇关于保持专注的文章')
    await page.locator(SEND_BUTTON).click()
    await expect(page.locator('.status-pill')).toHaveText('正在生成', { timeout: 20_000 })
    await expect(page.locator('.streaming-hint')).toBeVisible()
    await expect(page.locator('.markdown-view').first()).toBeVisible({ timeout: 20_000 })
    const partialText = await page.locator('.markdown-view').first().innerText()
    expect(partialText.length).toBeGreaterThan(0)
    // 运行尚未结束即已收到部分正文 → 事件是增量推送而非一次性缓冲下发
    expect(partialText).not.toContain('如果你能看到这段文字')
    await expect(page.locator('.status-pill')).toHaveText('准备就绪', { timeout: 90_000 })

    // 标题由模型产出更新；版本 v1 落库并渲染正文
    await expect(page.locator('.workspace-title')).toHaveText(/冒烟测试文章 v\d+/)
    await expect(manuscriptHeading(page, '当前：v1 ·')).toBeVisible()
    await expect(page.locator('.markdown-view')).toContainText('这是假模型第')
    await expect(page.locator('.markdown-view')).toContainText('如果你能看到这段文字')
    // 对话区：用户消息 + 智能体回复
    await expect(page.locator('.message-user')).toHaveCount(1)
    await expect(page.locator('.message-assistant')).toHaveCount(1)
  })

  test('场景 B：文章列表按标题关键词过滤', async ({ page }) => {
    // 自备数据：两篇未生成的文章（标题均为「未命名文章」，与场景 A 生成过的标题可区分）
    await createArticleViaApi(page)
    await createArticleViaApi(page)

    await page.goto('/articles')
    await expect(page.getByRole('button', { name: '未命名文章' })).toHaveCount(2)

    const search = page.getByPlaceholder('按标题搜索')
    // 命中：两篇「未命名文章」
    await search.fill('未命名')
    await expect(page.getByText(/^显示 2 \/ \d+ 篇$/)).toBeVisible()
    await expect(page.getByRole('button', { name: '未命名文章' })).toHaveCount(2)

    // 不命中：空态提示
    await search.fill('绝对不存在的关键词xyz')
    await expect(page.getByText('没有匹配的文章')).toBeVisible()

    // 清空关键词恢复全部
    await search.fill('')
    await expect(page.getByText(/^显示 \d+ \/ \d+ 篇$/)).toBeVisible()
    await expect(page.getByRole('button', { name: '未命名文章' })).toHaveCount(2)
  })

  test('场景 C：历史对话继续并产生 v2，可回看只读历史版本', async ({ page }) => {
    const articleId = await createArticleViaApi(page)
    await sendViaApiAndAwaitVersion(page, articleId, '直接写一篇', 1)

    // 深链进入已有文章：历史对话完整可见
    await page.goto(`/articles/${articleId}`)
    await expect(page.locator('.message-user')).toHaveCount(1)
    await expect(page.locator('.message-assistant')).toHaveCount(1)
    await expect(manuscriptHeading(page, '当前：v1 ·')).toBeVisible()

    // 继续对话 → v2
    await sendAndAwaitIdle(page, '把结尾改得更有力一点')
    await expect(manuscriptHeading(page, '当前：v2 ·')).toBeVisible()
    await expect(page.locator('.message-user')).toHaveCount(2)
    await expect(page.locator('.message-assistant')).toHaveCount(2)

    // 版本下拉回看 v1（只读），再返回当前版本
    await page.locator('.version-select').click()
    await page.getByRole('option', { name: /^v1 · / }).click()
    await expect(manuscriptHeading(page, '历史版本：v1 ·')).toBeVisible()
    await expect(page.locator('.version-history-tag')).toHaveText('历史版本，只读')
    await page.getByRole('button', { name: '返回当前版本' }).click()
    await expect(manuscriptHeading(page, '当前：v2 ·')).toBeVisible()
  })

  test('场景 E：运行中取消，不落版本、可立即再次发送', async ({ page }) => {
    const articleId = await createArticleViaApi(page)
    await page.goto(`/articles/${articleId}`)

    await page.locator('.composer textarea').fill('写一篇很长的文章')
    await page.locator(SEND_BUTTON).click()
    await expect(page.locator('.status-pill')).toHaveText('正在生成', { timeout: 20_000 })
    await expect(page.locator('.streaming-hint')).toBeVisible()

    // 取消：临时正文丢弃、无版本、用户指令已持久化
    await page.locator(STOP_BUTTON).click()
    await expect(page.locator('.status-pill')).toHaveText('准备就绪')
    await expect(page.getByText('已停止生成')).toBeVisible()
    await expect(page.locator('.article-empty')).toBeVisible()
    await expect(page.locator('.version-select')).toContainText('暂无版本')
    await expect(page.locator('.message-user')).toHaveCount(1)

    // 运行锁已释放，可继续生成 v1
    await sendAndAwaitIdle(page, '直接写')
    await expect(manuscriptHeading(page, '当前：v1 ·')).toBeVisible()
  })

  test('场景 F：失败卡片（脱敏详情）与重新发送', async ({ page }) => {
    const articleId = await createArticleViaApi(page)
    await page.goto(`/articles/${articleId}`)

    // 假模型约定：最新用户消息包含「触发失败」→ 该次运行抛错（模板正文含「失败」，
    // 用更长触发词避免压缩摘要误触发；失败注入前有 0.5s 延迟便于观测中间态）
    await sendAndAwaitIdle(page, '这次请触发失败')
    const failureCard = page.locator('.message-error')
    await expect(failureCard).toHaveCount(1)
    await expect(failureCard).toContainText('模型调用失败，请稍后重试。')

    // 脱敏详情默认折叠，展开可见（不含原始堆栈）
    await expect(failureCard.locator('.message-error-details pre')).toBeHidden()
    await failureCard.locator('summary').click()
    await expect(failureCard.locator('.message-error-details pre')).toBeVisible()
    await expect(failureCard.locator('.message-error-details pre')).toContainText(
      'SIMULATED_FAILURE',
    )

    // 重新发送：同一用户消息再次运行，仍失败（内容不变）
    await failureCard.getByRole('button', { name: '重新发送' }).click()
    await expect(page.locator('.status-pill')).toHaveText('正在生成', { timeout: 20_000 })
    await expect(page.locator('.status-pill')).toHaveText('准备就绪', { timeout: 90_000 })
    await expect(page.locator('.message-error').last()).toContainText('模型调用失败，请稍后重试。')
    // 重新发送不复制用户消息
    await expect(page.locator('.message-user')).toHaveCount(1)

    // 换一条正常指令可恢复生成
    await sendAndAwaitIdle(page, '正常写一篇')
    await expect(manuscriptHeading(page, '当前：v1 ·')).toBeVisible()
    await expect(page.locator('.markdown-view')).toContainText('如果你能看到这段文字')
  })

  test('场景 G：多轮对话触发上下文压缩，预算不变量保持', async ({ page }) => {
    const articleId = await createArticleViaApi(page)

    // 第 1 轮走 UI（同时验证压缩场景下的工作台流式路径）
    await page.goto(`/articles/${articleId}`)
    await sendAndAwaitIdle(page, '第1轮：直接写')
    await expect(manuscriptHeading(page, '当前：v1 ·')).toBeVisible()

    // 第 2-8 轮走 API（每轮 user+assistant 共 16 条消息 > recent_message_limit=12，
    // 触发较早对话摘要压缩；若预算不变量被破坏，后端将抛 AssertionError → run.failed）
    for (let round = 2; round <= 8; round += 1) {
      await sendViaApiAndAwaitVersion(page, articleId, `第${round}轮：继续修改`, round)
    }

    // 重新进入工作台：全部历史保留、当前 v8、无失败消息
    await page.goto(`/articles/${articleId}`)
    await expect(page.locator('.message')).toHaveCount(16)
    await expect(page.locator('.message-error')).toHaveCount(0)
    await expect(manuscriptHeading(page, '当前：v8 ·')).toBeVisible()

    // 直查数据库断言压缩产物已持久化（后端断言预算不变量 + 前端断言压缩生效）
    const { summary, until } = await readConversationSummary(articleId)
    expect(summary, '较早对话应已压缩为摘要').not.toBeNull()
    expect(summary).toContain('冒烟测试文章')
    expect(until).not.toBeNull()
  })
})
