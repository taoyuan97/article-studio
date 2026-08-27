import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { createArticleViaApi, sendViaApiAndAwaitVersion } from './helpers'

const EXPORT_BUTTON = /^导\s*出$/

test.describe('文章版本导出', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      // 原生系统“另存为”窗口无法由 Playwright 接管，本用例固定验证浏览器下载降级链路。
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value: undefined,
      })
    })
  })

  test('导出当前正式版本的 Markdown 原文与 TXT 纯文本', async ({ page }) => {
    const articleId = await createArticleViaApi(page)
    await sendViaApiAndAwaitVersion(page, articleId, '直接写一篇导出测试文章', 1)
    const workspace = (await (
      await page.request.get(`/api/articles/${articleId}/workspace`)
    ).json()) as {
      current_version: { title: string; version_number: number; content_markdown: string }
    }

    await page.goto(`/articles/${articleId}`)
    await page.getByRole('button', { name: EXPORT_BUTTON }).click()
    await expect(page.getByRole('dialog', { name: '导出文章' })).toBeVisible()

    const markdownDownloadPromise = page.waitForEvent('download')
    await page.getByRole('dialog').getByRole('button', { name: EXPORT_BUTTON }).click()
    const markdownDownload = await markdownDownloadPromise
    expect(markdownDownload.suggestedFilename()).toBe(
      `${workspace.current_version.title}-v${workspace.current_version.version_number}.md`,
    )
    const markdownPath = await markdownDownload.path()
    expect(markdownPath).not.toBeNull()
    expect(await readFile(markdownPath!, 'utf8')).toBe(workspace.current_version.content_markdown)
    await expect(
      page.getByText('当前浏览器不支持选择保存路径，文件已保存到浏览器下载目录'),
    ).toBeVisible()

    await page.getByRole('button', { name: EXPORT_BUTTON }).click()
    const dialog = page.getByRole('dialog', { name: '导出文章' })
    await dialog.getByRole('radio', { name: 'TXT 文本（.txt）' }).click()
    const textDownloadPromise = page.waitForEvent('download')
    await dialog.getByRole('button', { name: EXPORT_BUTTON }).click()
    const textDownload = await textDownloadPromise
    expect(textDownload.suggestedFilename()).toBe(
      `${workspace.current_version.title}-v${workspace.current_version.version_number}.txt`,
    )
    const textPath = await textDownload.path()
    expect(textPath).not.toBeNull()
    const text = await readFile(textPath!, 'utf8')
    expect(text).toContain('冒烟测试文章 v1')
    expect(text).toContain('消息分型（用户 / 智能体 / 失败）样式正常。')
    expect(text).not.toContain('# ')
    expect(text).not.toContain('- ')
  })
})
