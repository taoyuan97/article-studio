import { expect, test, type Page } from '@playwright/test'
import { createArticleViaApi, sendViaApiAndAwaitVersion } from './helpers'

/** AntD 两字按钮自动插空格（「下一步」→「下 一 步」），用正则兼容 */
const NEXT_STEP = /^下\s*一\s*步$/
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
 * 发布线 E2E（fake 模式：假模型/假生图 + PUBLISH_FAKE_MODE，不触真实微信接口；
 * 主题预览为本地 node + wenyan core 真实渲染，无需微信凭据）：
 * - 主路径：工作台入口 → 三步向导（配图/位置/封面/作者）→ 选主题（预览 + 编辑）→ 发布成功
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

    // 步骤 2：正文画布锚点插图（假文章正文切成 6 块：标题/导语/要点标题/列表/结语标题/尾段）
    const canvas = page.locator('.publish-canvas')
    await expect(canvas).toBeVisible()
    await expect(canvas.locator('.publish-canvas-block')).toHaveCount(6)

    // 点击导语块（块 2）设锚点 → 锚点高亮 + 插入指示线 → 弹窗选配图一 → 内联回显
    // wrap 用块元素的父级定位（filter({has}) 的内层链式定位器会相对候选重根导致匹配失败）
    const canvasBlock = (i: number) =>
      canvas.locator(`.publish-canvas-block[data-block-index="${i}"]`)
    const blockWrap = (i: number) => canvasBlock(i).locator('xpath=..')
    const insertButton = page.getByRole('button', { name: '插入配图' })
    await expect(insertButton).toBeDisabled()
    await canvasBlock(2).click()
    await expect(page.locator('.publish-canvas-anchor-line')).toHaveText('↳ 将插入到这里')
    await expect(page.getByText('将在第 2 块之后插入。')).toBeVisible()
    await insertButton.click()
    const pickerDialog = page.getByRole('dialog')
    await expect(pickerDialog.getByText('本文配图（2）')).toBeVisible()
    // 已插入素材置灰不可重复选；未勾选时确定禁用
    await expect(pickerDialog.getByRole('button', { name: /^确\s*定/ })).toBeDisabled()
    await pickerDialog.getByRole('button', { name: /配图一/ }).click()
    await pickerDialog.getByRole('button', { name: /^确\s*定（已选 1 张）$/ }).click()
    await expect(blockWrap(2).locator('.publish-canvas-image-title')).toHaveText('配图一')

    // 点击尾段块（块 6）挪动锚点 → 弹窗选配图二（配图一已置灰）→ 内联回显
    await canvasBlock(6).click()
    await expect(page.getByText('将在第 6 块之后插入。')).toBeVisible()
    await insertButton.click()
    const pickerDialog2 = page.getByRole('dialog')
    await expect(pickerDialog2.getByRole('button', { name: /配图一/ })).toBeDisabled()
    await pickerDialog2.getByRole('button', { name: /配图二/ }).click()
    await pickerDialog2.getByRole('button', { name: /^确\s*定（已选 1 张）$/ }).click()
    await expect(blockWrap(6).locator('.publish-canvas-image-title')).toHaveText('配图二')

    // 步骤 3：选主题——未选主题时预览空态，发布按钮禁用
    await page.getByRole('button', { name: NEXT_STEP }).click()
    await expect(page.getByText('请选择主题查看排版效果')).toBeVisible()
    await expect(page.getByRole('button', { name: '发布到公众号草稿箱' })).toBeDisabled()

    // 点选 Default 主题 → 手机框预览渲染（真实 wenyan core 渲染，冷启动 1~3s）
    await page.locator('.publish-theme-card', { hasText: 'Default' }).click()
    const previewFrame = page.locator('iframe[title="主题预览"]')
    await expect(previewFrame).toBeVisible({ timeout: 30_000 })
    await expect(previewFrame).toHaveAttribute(
      'srcdoc',
      expect.stringContaining('<section id="wenyan"'),
    )

    // 编辑模式：查看组装结果源码（frontmatter + 两张图 + 图片位置），完成编辑回到预览
    await page.getByRole('button', { name: /^编\s*辑$/ }).click()
    const editor = page.getByLabel('发布 Markdown 编辑框')
    await expect(editor).toBeVisible()
    await expect(editor).toHaveValue(/title: "冒烟测试文章 v\d+"/)
    await expect(editor).toHaveValue(/cover: "/)
    await expect(editor).toHaveValue(/author: "测试作者"/)
    const markdown = await editor.inputValue()
    expect((markdown.match(/!\[\]\(/g) ?? []).length).toBe(2)
    expect(markdown).toContain('## 要点')
    expect(markdown).toContain('## 结语')
    // 配图一在导语块（块 2）之后、「## 要点」之前；配图二在尾段（块 6）之后（文末）
    expect(markdown.indexOf('![](')).toBeLessThan(markdown.indexOf('## 要点'))
    expect(markdown.lastIndexOf('![](')).toBeGreaterThan(markdown.indexOf('如果你能看到这段文字'))
    await page.getByRole('button', { name: /^完成编辑$/ }).click()
    await expect(editor).toBeHidden()

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
    // 本用例文章无关联配图；素材库图片分组可见与否取决于历史数据，仅断言画布步骤渲染
    await expect(page.locator('.publish-canvas-block').first()).toBeVisible()
    await expect(page.getByRole('button', { name: '插入配图' })).toBeVisible()
    await expect(page.getByText('点击正文任意位置选择插入点，再插入配图。')).toBeVisible()
    await page.getByRole('button', { name: NEXT_STEP }).click() // 主题步

    // 未选主题：预览空态 + 发布按钮禁用
    await expect(page.getByText('请选择主题查看排版效果')).toBeVisible()
    const publishButton = page.getByRole('button', { name: '发布到公众号草稿箱' })
    await expect(publishButton).toBeDisabled()

    // 选主题（default）→ 预览渲染 → 发布失败路径（正文含失败标记）
    await page.locator('.publish-theme-card').first().click()
    await expect(page.locator('iframe[title="主题预览"]')).toBeVisible({ timeout: 30_000 })
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
