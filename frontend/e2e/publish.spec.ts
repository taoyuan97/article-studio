import { expect, test, type Page } from '@playwright/test'
import { createArticleViaApi, sendViaApiAndAwaitVersion } from './helpers'

/** AntD 两字按钮自动插空格（「下一步」→「下 一 步」），用正则兼容 */
const NEXT_STEP = /^下\s*一\s*步$/
const PREV_STEP = /^上\s*一\s*步$/
const RETRY_BUTTON = /^重\s*试\s*发\s*布$/

interface ImageMessageLike {
  id: string
  role: string
  image_url: string | null
}

/**
 * 通过 API 为文章生成一张配图并保存为素材（假生图约 3s，不走浏览器 UI）。
 * 会话以 article_id 关联文章——素材在发布向导中归入「本文配图」分组置顶展示。
 */
async function createImageAssetViaApi(
  page: Page,
  articleId: string,
  prompt: string,
  title: string,
): Promise<void> {
  const session = (await (
    await page.request.post('/api/image-sessions', { data: { article_id: articleId } })
  ).json()) as { id: string; provider: string; model: string }
  const run = await page.request.post(`/api/image-sessions/${session.id}/messages`, {
    data: { content: prompt, provider: session.provider, model: session.model },
  })
  expect(run.ok()).toBeTruthy()

  // 轮询 workspace 直到带图片的助手消息出现（生成完成）
  await expect
    .poll(
      async () => {
        const workspace = (await (
          await page.request.get(`/api/image-sessions/${session.id}/workspace`)
        ).json()) as { messages: ImageMessageLike[] }
        return workspace.messages.some((m) => m.role === 'assistant' && m.image_url)
      },
      { timeout: 90_000 },
    )
    .toBe(true)

  const workspace = (await (
    await page.request.get(`/api/image-sessions/${session.id}/workspace`)
  ).json()) as { messages: ImageMessageLike[] }
  const assistant = workspace.messages.find((m) => m.role === 'assistant' && m.image_url)!
  const save = await page.request.post('/api/assets', {
    data: { source_session_id: session.id, source_message_id: assistant.id, title },
  })
  expect(save.ok()).toBeTruthy()
}

/**
 * 发布线 E2E（fake 模式：假模型/假生图 + PUBLISH_FAKE_MODE，不触真实微信接口）：
 * - 主路径：工作台入口 → 四步向导（配图/位置/封面/作者）→ 预览组装 → 发布成功
 *   （FAKE media_id）→ 发布记录列表与快照详情；
 * - 校验路径：未选主题时发布按钮禁用；正文含「触发发布失败」标记时发布失败
 *   （PUBLISH_MCP_ERROR，40164 文案），失败记录可展开错误详情。
 */
test.describe('发布线场景', () => {
  test('主路径：配图发布成功 → FAKE media_id → 发布记录与快照', async ({ page }) => {
    const articleId = await createArticleViaApi(page)
    await sendViaApiAndAwaitVersion(page, articleId, '直接写一篇关于保持专注的文章', 1)
    await createImageAssetViaApi(page, articleId, '一张清晨咖啡馆的插画', '配图一')
    await createImageAssetViaApi(page, articleId, '一张深夜书房的插画', '配图二')

    // 从文章工作台「发布到公众号」入口进入（文章已通过 query 预选）
    await page.goto(`/articles/${articleId}`)
    await page.getByRole('link', { name: '发布到公众号' }).click()
    await expect(page).toHaveURL(new RegExp(`/publish\\?article_id=${articleId}$`))

    // 步骤 1：文章预选、版本 v1；封面弹窗选配图二；填作者
    await expect(page.getByText(/^v1 · 冒烟测试文章 v\d+$/)).toBeVisible()
    await page.getByRole('button', { name: '选择封面' }).click()
    const coverDialog = page.getByRole('dialog')
    await coverDialog.getByRole('button', { name: /配图二/ }).click()
    await coverDialog.getByRole('button', { name: /^确\s*定$/ }).click()
    await expect(page.locator('.publish-cover-selected-title')).toHaveText('配图二')
    await page.getByLabel('作者').fill('测试作者')
    await page.getByRole('button', { name: NEXT_STEP }).click()

    // 步骤 2：勾选两张配图 → 默认 round-robin 位置；调整配图二到第 3 节之后
    await page.getByRole('button', { name: /配图一/ }).click()
    await page.getByRole('button', { name: /配图二/ }).click()
    await expect(page.getByText('已选图片（2）', { exact: true })).toBeVisible()
    await expect(page.locator('.publish-card', { hasText: '配图一' })).toContainText(
      '插入位置：第 1 节之后',
    )

    // 调整配图二位置到「第 3 节之后 · 「结语」」（第 3 节即最后一节，图插在结语之后）。
    // 下拉为虚拟列表只渲染激活项附近，input 又被选中文案遮挡 pointer-events：
    // focus + ArrowDown 打开后，逐次 ArrowDown 直到目标项激活（必在可视区），Enter 选中
    await page.getByRole('combobox', { name: '配图二 插入位置' }).focus()
    await page.keyboard.press('ArrowDown')
    const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
    await expect(dropdown).toBeVisible()
    const targetPosition = '第 3 节之后 · 「结语」'
    for (let i = 0; i < 8; i++) {
      const activeTitle = await dropdown
        .locator('.ant-select-item-option-active')
        .getAttribute('title')
      if (activeTitle === targetPosition) break
      await page.keyboard.press('ArrowDown')
    }
    await page.keyboard.press('Enter')
    await expect(page.locator('.publish-card', { hasText: '配图二' })).toContainText(
      '插入位置：第 3 节之后',
    )

    // 步骤 3：主题默认选中 default
    await page.getByRole('button', { name: NEXT_STEP }).click()
    await expect(page.locator('.publish-theme-card.is-selected')).toHaveCount(1)

    // 步骤 4：预览组装结果（frontmatter + 两张图 + 图片位置）
    await page.getByRole('button', { name: NEXT_STEP }).click()
    const editor = page.getByLabel('发布 Markdown 编辑框')
    await expect(editor).toBeVisible()
    await expect(editor).toHaveValue(/title: "冒烟测试文章 v\d+"/)
    await expect(editor).toHaveValue(/cover: "/)
    await expect(editor).toHaveValue(/author: "测试作者"/)
    const markdown = await editor.inputValue()
    expect((markdown.match(/!\[\]\(/g) ?? []).length).toBe(2)
    expect(markdown).toContain('## 要点')
    expect(markdown).toContain('## 结语')
    // 配图一在第 1 节（导语）之后、「要点」之前；配图二在第 3 节（结语）之后
    expect(markdown.indexOf('![](')).toBeLessThan(markdown.indexOf('## 要点'))
    expect(markdown.lastIndexOf('![](')).toBeGreaterThan(markdown.indexOf('## 结语'))

    // 发布 → 确认弹窗 → 成功态展示 FAKE media_id
    await page.getByRole('button', { name: '发布到公众号草稿箱' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: '确认发布' }).click()
    await expect(page.getByText('已发布到公众号草稿箱', { exact: true })).toBeVisible()
    await expect(page.locator('.publish-result code').first()).toHaveText(
      /^FAKE_MEDIA_[0-9a-f]{8}$/,
    )

    // 发布记录列表出现该记录（成功 + media_id）
    await page.getByRole('link', { name: '查看发布记录' }).click()
    await expect(page).toHaveURL(/\/publish-records$/)
    await expect(page.getByText(/共 \d+ 条记录/)).toBeVisible()
    const row = page.getByRole('row').filter({ hasText: /FAKE_MEDIA_/ })
    await expect(row).toBeVisible()
    await expect(row).toContainText('成功')

    // 快照详情：元信息 + 配图回显 + 正文渲染
    await row.getByRole('button', { name: '查看快照' }).click()
    await expect(page).toHaveURL(/\/publish-records\/[0-9a-f-]{36}$/)
    await expect(page.locator('.workspace-title')).toHaveText('发布快照')
    await expect(page.locator('.ant-tag-success')).toContainText('成功')
    await expect(page.locator('.publish-snapshot-fields')).toContainText(/冒烟测试文章 v\d+/)
    await expect(page.locator('.publish-snapshot-fields')).toContainText('测试作者')
    await expect(page.locator('.publish-snapshot-fields code')).toHaveText(
      /^FAKE_MEDIA_[0-9a-f]{8}$/,
    )
    await expect(page.locator('.publish-snapshot-cover img')).toBeVisible()
    await expect(page.locator('.publish-snapshot-gallery img')).toHaveCount(2)
    await expect(page.locator('.publish-snapshot-body')).toContainText('结语')
  })

  test('校验路径：未选主题禁用发布；发布失败展示错误可重试', async ({ page }) => {
    // 消息含触发词 → 假模型把「触发发布失败」嵌入正文，fake 发布据此抛 PUBLISH_MCP_ERROR
    const articleId = await createArticleViaApi(page)
    await sendViaApiAndAwaitVersion(page, articleId, '写一篇短文，触发发布失败', 1)

    await page.goto(`/publish?article_id=${articleId}`)
    await page.getByRole('button', { name: NEXT_STEP }).click() // 配图步：无图直接过
    // 本用例文章无关联配图；素材库图片分组可见与否取决于历史数据，仅断言步骤渲染
    await expect(page.getByText('选择配图')).toBeVisible()
    await page.getByRole('button', { name: NEXT_STEP }).click() // 主题步

    // 取消默认主题 → 预览步发布按钮禁用
    await page.locator('.publish-theme-card.is-selected').click()
    await page.getByRole('button', { name: NEXT_STEP }).click()
    await expect(page.getByLabel('发布 Markdown 编辑框')).toBeVisible()
    const publishButton = page.getByRole('button', { name: '发布到公众号草稿箱' })
    await expect(publishButton).toBeDisabled()

    // 回退重新选主题 → 发布失败路径（正文含失败标记）
    await page.getByRole('button', { name: PREV_STEP }).click()
    await page.locator('.publish-theme-card').first().click()
    await page.getByRole('button', { name: NEXT_STEP }).click()
    await expect(page.getByLabel('发布 Markdown 编辑框')).toBeVisible()
    await publishButton.click()
    await page.getByRole('dialog').getByRole('button', { name: '确认发布' }).click()

    await expect(page.getByText('发布失败', { exact: true })).toBeVisible()
    await expect(page.locator('.publish-failure-body code')).toHaveText('PUBLISH_MCP_ERROR')
    // 泛化文案与详情段均含 40164，断言详情段透出原始错误
    await expect(page.locator('.publish-failure-detail')).toContainText('40164')
    await expect(page.getByRole('button', { name: RETRY_BUTTON })).toBeEnabled()

    // 发布记录：失败记录可展开错误码与错误信息（antd 中文 locale 展开按钮为「展开行」）
    await page.goto('/publish-records')
    await expect(page.locator('.ant-tag-error').first()).toContainText('失败')
    const failedRow = page.locator('tr', { has: page.locator('.ant-tag-error') })
    await failedRow.getByRole('button', { name: '展开行' }).click()
    await expect(page.locator('.publish-record-error')).toContainText('PUBLISH_MCP_ERROR')
    await expect(page.locator('.publish-record-error')).toContainText('错误信息：')

    // 状态筛选（本地 Segmented，input 为视觉隐藏，点击 label 项）
    await page.locator('.ant-segmented-item', { hasText: '成功' }).click()
    await expect(page.locator('.ant-tag-error')).toHaveCount(0)
    await page.locator('.ant-segmented-item', { hasText: '失败' }).click()
    await expect(page.locator('.ant-tag-success')).toHaveCount(0)
    await expect(page.locator('.ant-tag-error')).toHaveCount(1)
  })
})
