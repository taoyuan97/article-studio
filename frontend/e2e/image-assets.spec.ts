import { expect, test, type Page } from '@playwright/test'
import { SAVE_BUTTON, SEND_BUTTON, createArticleViaApi, sendViaApiAndAwaitVersion } from './helpers'

/**
 * 配图与素材主路径（假生图 provider，无真实 API Key）：
 * 新建会话 → 发送 → SSE 进度 → 完成 → 保存素材 → 素材库可见 → 详情回链。
 * 附加覆盖：生图失败卡片（脱敏详情）；计划/行动双模式（一键编排、复制、
 * 刷新恢复、编排失败）。
 */

test.describe('配图与素材主路径', () => {
  test('新建配图会话 → 生成 → 保存素材 → 素材库可见', async ({ page }) => {
    // 从素材库入口新建配图会话
    await page.goto('/assets')
    await page.getByRole('button', { name: '新建配图' }).first().click()
    await expect(page).toHaveURL(/\/image-sessions\/[0-9a-f-]{36}$/)

    // 空态
    await expect(page.getByText('还没有对话。', { exact: false })).toBeVisible()
    await expect(page.getByText('图片会在这里出现')).toBeVisible()

    // 发送 prompt：SSE 进度 → 完成（假生图延迟 3s）
    await page.locator('.composer textarea').fill('一张清晨咖啡馆的插画，暖色调')
    await page.locator(SEND_BUTTON).click()
    await expect(page.locator('.status-pill')).toHaveText('正在生成', { timeout: 20_000 })
    await expect(page.locator('.image-progress')).toBeVisible()
    await expect(page.locator('.status-pill')).toHaveText('准备就绪', { timeout: 90_000 })

    // 消息区：用户 prompt + 生成结果（含缩略图）
    await expect(page.locator('.message-user')).toHaveCount(1)
    const thumb = page.locator('.image-message-thumb img')
    await expect(thumb.first()).toBeVisible()
    // 右侧当前图片与缩略图同源
    await expect(page.locator('.image-preview img')).toBeVisible()

    // 保存素材（弹窗确认）
    await page.getByRole('button', { name: '保存素材', exact: true }).click()
    const saveModal = page.getByRole('dialog')
    await expect(saveModal).toBeVisible()
    await saveModal.getByRole('button', { name: SAVE_BUTTON }).click()
    await expect(page.getByText('已保存到素材库')).toBeVisible()
    // 用文本断言（loading 图标残留会污染按钮可访问名，见 helpers.ts 说明）
    await expect(page.getByText('已保存', { exact: true })).toBeVisible()

    // 素材库可见，详情可打开并回链来源会话
    await page.goto('/assets')
    const assetCard = page.locator('.asset-card').first()
    await expect(assetCard).toBeVisible()
    await assetCard.click()
    const detailModal = page.getByRole('dialog')
    await expect(detailModal).toBeVisible()
    await expect(detailModal).toContainText('生成提示词：')
    await expect(detailModal).toContainText('清晨咖啡馆')
    await detailModal.getByRole('link', { name: '查看来源配图会话' }).click()
    await expect(page).toHaveURL(/\/image-sessions\/[0-9a-f-]{36}$/)
    await expect(page.locator('.message-user')).toHaveCount(1)
  })

  test('生图失败：失败卡片与脱敏详情', async ({ page }) => {
    await page.goto('/assets')
    await page.getByRole('button', { name: '新建配图' }).first().click()
    await expect(page).toHaveURL(/\/image-sessions\/[0-9a-f-]{36}$/)

    // 假生图约定：提示词包含「触发失败」→ 延迟 0.5s 后生成失败
    await page.locator('.composer textarea').fill('请让这次触发失败')
    await page.locator(SEND_BUTTON).click()
    await expect(page.locator('.status-pill')).toHaveText('正在生成', { timeout: 20_000 })
    await expect(page.locator('.status-pill')).toHaveText('准备就绪', { timeout: 90_000 })

    // 失败卡片：简短错误 + 折叠的脱敏详情
    await expect(page.locator('.message-error')).toHaveCount(1)
    await expect(page.locator('.message-error')).toContainText('图片生成失败，请稍后重试。')
    await page.locator('.message-error summary').click()
    await expect(page.locator('.message-error-details pre')).toContainText('SIMULATED_FAILURE')
    // 失败不产生图片
    await expect(page.locator('.image-message-thumb')).toHaveCount(0)
    await expect(page.getByText('图片会在这里出现')).toBeVisible()
  })
})

test.describe('配图工作台：计划/行动双模式', () => {
  // Chromium 下 navigator.clipboard.writeText 需要授权，否则复制按钮走兜底路径
  test.use({ permissions: ['clipboard-write'] })

  /** 准备一篇有版本的文章（计划模式编排对象），并新建配图会话进入工作台 */
  async function prepareSessionWithArticle(page: Page) {
    const articleId = await createArticleViaApi(page)
    await sendViaApiAndAwaitVersion(page, articleId, '写一篇短文', 1)

    await page.goto('/assets')
    await page.getByRole('button', { name: '新建配图' }).first().click()
    await expect(page).toHaveURL(/\/image-sessions\/[0-9a-f-]{36}$/)
    // 默认行动模式：图片参数按钮可见
    await expect(page.getByRole('button', { name: /图片参数/ })).toBeVisible()
  }

  test('计划模式：一键编排 → 方案卡片 → 复制提示词 → 刷新恢复', async ({ page }) => {
    await prepareSessionWithArticle(page)

    // 切换到计划模式：图片参数按钮隐藏，表单出现
    await page.getByText('计划', { exact: true }).click()
    await expect(page.locator('.image-plan-form')).toBeVisible()
    await expect(page.getByRole('button', { name: /图片参数/ })).toHaveCount(0)

    // 文章（最新创建者自动预选）→ 一键编排（罐头方案：3 张配图、三种排版）
    await page.getByRole('button', { name: '一键编排' }).click()
    await expect(page.locator('.image-plan-card')).toHaveCount(3, { timeout: 30_000 })
    await expect(page.getByText('温暖治愈', { exact: true })).toBeVisible()
    await expect(page.getByText('假模型方案一', { exact: false })).toBeVisible()
    await expect(page.getByText('假模型方案三', { exact: false })).toBeVisible()

    // 复制提示词：按钮反馈「已复制」
    await page.getByRole('button', { name: '复制提示词 1' }).click()
    await expect(page.getByText('已复制', { exact: true })).toBeVisible()

    // 决策 ②：结果入库保留最近一条，刷新后方案与模式均恢复
    await page.reload()
    await expect(page.locator('.image-plan-card')).toHaveCount(3, { timeout: 30_000 })
    await expect(page.getByText('温暖治愈', { exact: true })).toBeVisible()

    // 切回行动模式：恢复生图工作流
    await page.getByText('行动', { exact: true }).click()
    await expect(page.getByRole('button', { name: /图片参数/ })).toBeVisible()
  })

  test('计划模式：编排失败 → 错误提示（脱敏）', async ({ page }) => {
    await prepareSessionWithArticle(page)

    await page.getByText('计划', { exact: true }).click()
    await expect(page.locator('.image-plan-form')).toBeVisible()

    // 假模型约定：编排指令含「触发失败」→ 延迟 0.5s 后抛错
    await page.getByLabel('编排指令').fill('请让这次触发失败')
    await page.getByRole('button', { name: '一键编排' }).click()

    await expect(page.getByText(/配图编排失败/)).toBeVisible({ timeout: 30_000 })
    // 失败不产生方案卡片
    await expect(page.locator('.image-plan-card')).toHaveCount(0)
  })
})
