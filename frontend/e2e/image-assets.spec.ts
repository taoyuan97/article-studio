import { expect, test } from '@playwright/test'
import { SAVE_BUTTON, SEND_BUTTON } from './helpers'

/**
 * 配图与素材主路径（假生图 provider，无真实 API Key）：
 * 新建会话 → 发送 → SSE 进度 → 完成 → 保存素材 → 素材库可见 → 详情回链。
 * 附加覆盖：生图失败卡片（脱敏详情）。
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
