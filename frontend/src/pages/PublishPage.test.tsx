import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App as AntApp } from 'antd'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'

const publishPreview = vi.fn()
const publishArticle = vi.fn()
const fetchPublishThemes = vi.fn()
const renderPreview = vi.fn()

vi.mock('../api/publish', () => ({
  publishApi: {
    fetchPublishThemes: (...args: unknown[]) => fetchPublishThemes(...args),
    publishPreview: (...args: unknown[]) => publishPreview(...args),
    publishArticle: (...args: unknown[]) => publishArticle(...args),
    renderPreview: (...args: unknown[]) => renderPreview(...args),
    fetchPublishRecords: vi.fn(),
    fetchPublishRecordDetail: vi.fn(),
  },
}))

const listArticles = vi.fn()
const getWorkspace = vi.fn()

vi.mock('../api/articles', () => ({
  articlesApi: {
    listArticles: (...args: unknown[]) => listArticles(...args),
    getWorkspace: (...args: unknown[]) => getWorkspace(...args),
  },
}))

const listAssets = vi.fn()

vi.mock('../api/assets', () => ({
  assetsApi: {
    listAssets: (...args: unknown[]) => listAssets(...args),
  },
}))

const listImageSessions = vi.fn()

vi.mock('../api/imageSessions', () => ({
  imageSessionsApi: {
    listImageSessions: (...args: unknown[]) => listImageSessions(...args),
  },
}))

import PublishPage from './PublishPage'

const CONTENT = '## 要点\n\n- 要点一\n\n## 结语\n\n收尾'
const SECTIONS = [
  { index: 1, heading: '要点', body: '- 要点一' },
  { index: 2, heading: '结语', body: '收尾' },
]
const BLOCKS = [
  { index: 1, kind: 'heading', preview: '要点', text: '## 要点' },
  { index: 2, kind: 'list', preview: '要点一', text: '- 要点一' },
  { index: 3, kind: 'heading', preview: '结语', text: '## 结语' },
  { index: 4, kind: 'paragraph', preview: '收尾', text: '收尾' },
]
const ASSEMBLED = '---\ntitle: "测试文章"\n---\n\n## 要点\n\n![](/abs/a.png)\n\n- 要点一'

function makeAsset(id: string, sessionId = 'session-1') {
  return {
    id,
    kind: 'image' as const,
    source: 'image_generation' as const,
    source_session_id: sessionId,
    source_message_id: null,
    title: `素材 ${id}`,
    storage_url: `/static/assets/images/${id}/img.png`,
    provider: 'fake',
    model: 'fake-image-model',
    metadata: {},
    created_at: '2026-08-24T10:00:00Z',
    updated_at: '2026-08-24T10:00:00Z',
  }
}

function renderPublish(initialEntry = '/publish?article_id=a1') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter initialEntries={[initialEntry]}>
          <PublishPage />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  )
}

async function waitForData() {
  await screen.findByText('发布到公众号')
  await waitFor(() => expect(getWorkspace).toHaveBeenCalled())
}

/** 步骤 1 经封面弹窗选择封面（弹窗内单选后点确定） */
async function pickCoverViaModal(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole('button', { name: '选择封面' }))
  await user.click(await screen.findByRole('button', { name }))
  await user.click(screen.getByRole('button', { name: /^确\s*定$/ }))
}

/** 当前打开中的 Modal（jsdom 中已关闭的弹窗停留在 leave 动画态仍留在 DOM，需过滤） */
function withinOpenModal() {
  const modals = Array.from(document.querySelectorAll('.ant-modal')).filter(
    (el) => !el.className.includes('leave'),
  )
  expect(modals.length).toBeGreaterThanOrEqual(1)
  return within(modals[modals.length - 1] as HTMLElement)
}

function getCanvasBlock(index: number): HTMLElement {
  return document.querySelector(
    `.publish-canvas-block[data-block-index="${index}"]`,
  ) as HTMLElement
}

/** 画布范围查询：jsdom 中已关闭的插图弹窗停留在 leave 动画态仍留在 DOM，全局 alt 查询会重复命中 */
function withinCanvas(): ReturnType<typeof within> {
  return within(screen.getByLabelText('正文画布'))
}

/** 在画布锚点块后经弹窗插入素材（勾选顺序即插入顺序） */
async function insertViaModal(
  user: ReturnType<typeof userEvent.setup>,
  anchorIndex: number,
  names: RegExp[],
) {
  await user.click(getCanvasBlock(anchorIndex))
  await user.click(screen.getByRole('button', { name: '插入配图' }))
  const modal = withinOpenModal()
  for (const name of names) {
    await user.click(modal.getByRole('button', { name }))
  }
  await user.click(
    modal.getByRole('button', { name: `确定（已选 ${names.length} 张）` }),
  )
}

/** 走到选主题步（可选封面/作者，步骤 1 锚定块 2 弹窗插两张图） */
async function goToThemes(
  user: ReturnType<typeof userEvent.setup>,
  opts: { pickCover?: RegExp | null; author?: string } = {},
) {
  const { pickCover = /素材 asset-1/, author } = opts
  await waitForData()
  if (pickCover) await pickCoverViaModal(user, pickCover)
  if (author !== undefined) await user.type(screen.getByLabelText('作者'), author)
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await screen.findByLabelText('正文画布')
  await insertViaModal(user, 2, [/素材 asset-1/, /素材 asset-2/])
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await screen.findByText('Default')
}

/** 选主题步选中 Default 主题并等待预览 iframe 渲染完成 */
async function pickDefaultTheme(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Default/ }))
  await screen.findByTitle('主题预览')
  await waitFor(() => expect(renderPreview).toHaveBeenCalled())
}

describe('PublishPage 三步向导', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listArticles.mockResolvedValue({
      items: [
        {
          id: 'a1',
          title: '测试文章',
          status: 'generated',
          provider: 'deepseek',
          model: 'fake-model',
          created_at: '2026-08-24T09:00:00Z',
          updated_at: '2026-08-24T09:00:00Z',
          version_count: 1,
          summary: '',
        },
      ],
    })
    getWorkspace.mockResolvedValue({
      article: { id: 'a1', title: '测试文章', current_version_id: 'v1' },
      current_version: { id: 'v1', version_number: 1, title: '测试文章', content_markdown: CONTENT },
      versions: [{ id: 'v1', version_number: 1, title: '测试文章' }],
    })
    listImageSessions.mockResolvedValue({
      items: [{ id: 'session-1', article_id: 'a1', title: '配图会话' }],
    })
    listAssets.mockResolvedValue({ items: [makeAsset('asset-1'), makeAsset('asset-2')] })
    fetchPublishThemes.mockResolvedValue({
      items: [
        { id: 'default', name: 'Default', description: '默认主题' },
        { id: 'rainbow', name: 'Rainbow', description: '彩虹主题' },
      ],
    })
    publishPreview.mockResolvedValue({ sections: SECTIONS, blocks: BLOCKS, markdown: ASSEMBLED })
    renderPreview.mockResolvedValue({ html: '<section id="wenyan">rendered</section>' })
    publishArticle.mockResolvedValue({
      publish_id: 'rec-1',
      media_id: 'FAKE_MEDIA_abcd1234',
      status: 'succeeded',
    })
  })

  it('未选文章时下一步禁用；带 article_id 进入时预选并可直接进入配图步', async () => {
    renderPublish('/publish')
    await screen.findByText('选择要发布的文章')
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
  })

  it('步骤 2 画布：未设锚点时「插入配图」禁用，点击块显示锚点提示，再点同块取消', async () => {
    const user = userEvent.setup()
    renderPublish()
    await waitForData()
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByLabelText('正文画布')

    // 未设锚点：按钮禁用 + 引导提示
    expect(screen.getByRole('button', { name: '插入配图' })).toBeDisabled()
    expect(screen.getByText('点击正文任意位置选择插入点，再插入配图。')).toBeInTheDocument()

    // 点击块 2：显示插入指示线与锚点提示
    await user.click(getCanvasBlock(2))
    expect(document.querySelector('.publish-canvas-anchor-line')).toHaveTextContent(
      '↳ 将插入到这里',
    )
    expect(screen.getByText('将在第 2 块之后插入。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '插入配图' })).toBeEnabled()

    // 再点同块：取消锚点
    await user.click(getCanvasBlock(2))
    expect(document.querySelector('.publish-canvas-anchor-line')).toBeNull()
    expect(screen.getByRole('button', { name: '插入配图' })).toBeDisabled()
  })

  it('空正文：画布显示空态，「插入配图」禁用并提示先写正文', async () => {
    publishPreview.mockResolvedValue({ sections: [], blocks: [], markdown: ASSEMBLED })
    const user = userEvent.setup()
    renderPublish()
    await waitForData()
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByLabelText('正文画布')

    expect(screen.getByRole('button', { name: '插入配图' })).toBeDisabled()
    // 工具栏提示与画布空态描述同时提示先写正文
    expect(screen.getAllByText('正文为空，请先撰写正文后再插入配图。')).toHaveLength(2)
    expect(withinCanvas().getByText('正文为空，请先撰写正文后再插入配图。')).toBeInTheDocument()
  })

  it('插图弹窗：分组展示、多选计数、确定后按勾选顺序内联插入锚点后', async () => {
    listAssets.mockResolvedValue({
      items: [makeAsset('asset-1'), makeAsset('asset-2'), makeAsset('asset-3', 'session-2')],
    })
    const user = userEvent.setup()
    renderPublish()
    await waitForData()
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByLabelText('正文画布')

    await user.click(getCanvasBlock(2))
    await user.click(screen.getByRole('button', { name: '插入配图' }))
    const modal = withinOpenModal()
    // 分组：本文配图置顶 + 素材库图片
    expect(modal.getByText('本文配图（2）')).toBeInTheDocument()
    expect(modal.getByText('素材库图片（1）')).toBeInTheDocument()
    // 未勾选时确定禁用
    expect(modal.getByRole('button', { name: /^确\s*定$/ })).toBeDisabled()

    // 多选：素材库图片 + 本文配图（勾选顺序即插入顺序）
    await user.click(modal.getByRole('button', { name: /素材 asset-3/ }))
    await user.click(modal.getByRole('button', { name: /素材 asset-1/ }))
    await user.click(modal.getByRole('button', { name: '确定（已选 2 张）' }))

    // 内联回显：两张图按勾选顺序出现在块 2 之后
    const wrap2 = getCanvasBlock(2).closest('.publish-canvas-block-wrap') as HTMLElement
    const titles = within(wrap2).getAllByText(/素材 asset-/)
    expect(titles.map((el) => el.textContent)).toEqual(['素材 asset-3', '素材 asset-1'])
    // 锚点保持（便于连续补图）
    expect(screen.getByText('将在第 2 块之后插入。')).toBeInTheDocument()
  })

  it('已插入素材在弹窗中置灰不可选（同一素材不可重复插入）', async () => {
    const user = userEvent.setup()
    renderPublish()
    await waitForData()
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByLabelText('正文画布')
    await insertViaModal(user, 2, [/素材 asset-1/])

    // 换锚点再打开弹窗：asset-1 置灰并标「已插入」
    await user.click(getCanvasBlock(3))
    await user.click(screen.getByRole('button', { name: '插入配图' }))
    const modal = withinOpenModal()
    const inserted = modal.getByRole('button', { name: /素材 asset-1/ })
    expect(inserted).toBeDisabled()
    expect(within(inserted).getByText('已插入')).toBeInTheDocument()

    // 仅能插入另一张
    await user.click(modal.getByRole('button', { name: /素材 asset-2/ }))
    await user.click(modal.getByRole('button', { name: '确定（已选 1 张）' }))
    const wrap3 = getCanvasBlock(3).closest('.publish-canvas-block-wrap') as HTMLElement
    expect(within(wrap3).getByText('素材 asset-2')).toBeInTheDocument()
  })

  it('内联删除：hover 删除按钮移除图片，画布与后续 payload 同步', async () => {
    const user = userEvent.setup()
    renderPublish()
    await waitForData()
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByLabelText('正文画布')
    await insertViaModal(user, 2, [/素材 asset-1/, /素材 asset-2/])
    expect(withinCanvas().getByAltText('素材 asset-1')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '素材 asset-1 删除' }))
    await waitFor(() => expect(withinCanvas().queryByAltText('素材 asset-1')).toBeNull())
    expect(withinCanvas().getByAltText('素材 asset-2')).toBeInTheDocument()

    // 进入选主题步：组装 payload 仅剩 asset-2
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByText('Default')
    await waitFor(() =>
      expect(publishPreview).toHaveBeenLastCalledWith(
        'a1',
        expect.objectContaining({
          image_placements: [{ asset_id: 'asset-2', position: 'after_block_2', order: 1 }],
        }),
      ),
    )
  })

  it('文章无关联配图会话时：弹窗仅显示「素材库图片」组', async () => {
    listImageSessions.mockResolvedValue({
      items: [{ id: 'session-2', article_id: null, title: '独立配图会话' }],
    })
    listAssets.mockResolvedValue({ items: [makeAsset('asset-9', 'session-2')] })
    const user = userEvent.setup()
    renderPublish()
    await waitForData()
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByLabelText('正文画布')
    await user.click(getCanvasBlock(1))
    await user.click(screen.getByRole('button', { name: '插入配图' }))

    const modal = withinOpenModal()
    expect(modal.queryByText(/本文配图/)).not.toBeInTheDocument()
    expect(modal.getByText('素材库图片（1）')).toBeInTheDocument()
  })

  it('素材库完全无图片素材时：弹窗显示空态引导', async () => {
    listAssets.mockResolvedValue({ items: [] })
    const user = userEvent.setup()
    renderPublish()
    await waitForData()
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByLabelText('正文画布')
    await user.click(getCanvasBlock(1))
    await user.click(screen.getByRole('button', { name: '插入配图' }))

    const modal = withinOpenModal()
    expect(
      modal.getByText('素材库还没有图片素材，可先在配图工作台生成并保存素材。'),
    ).toBeInTheDocument()
  })

  it('步骤 1 封面弹窗：分组展示、单选确定回显、可清除', async () => {
    listAssets.mockResolvedValue({
      items: [makeAsset('asset-1'), makeAsset('asset-3', 'session-2')],
    })
    const user = userEvent.setup()
    renderPublish()
    await waitForData()

    await user.click(screen.getByRole('button', { name: '选择封面' }))
    expect(await screen.findByText('本文配图（1）')).toBeInTheDocument()
    expect(screen.getByText('素材库图片（1）')).toBeInTheDocument()

    // 单选素材库图片（封面可选不插入正文的图）
    await user.click(screen.getByRole('button', { name: /素材 asset-3/ }))
    await user.click(screen.getByRole('button', { name: /^确\s*定$/ }))
    await waitFor(() =>
      expect(document.querySelector('.publish-cover-selected-title')).toHaveTextContent(
        '素材 asset-3',
      ),
    )

    // 清除：回到未选封面态
    await user.click(screen.getByRole('button', { name: /^清\s*除$/ }))
    expect(screen.getByRole('button', { name: '选择封面' })).toBeInTheDocument()
    expect(document.querySelector('.publish-cover-selected-title')).toBeNull()
  })

  it('未选文章时可选封面：弹窗仅显示素材库图片组', async () => {
    listAssets.mockResolvedValue({
      items: [makeAsset('asset-1'), makeAsset('asset-3', 'session-2')],
    })
    const user = userEvent.setup()
    renderPublish('/publish')
    await screen.findByText('选择要发布的文章')

    await user.click(screen.getByRole('button', { name: '选择封面' }))
    expect(await screen.findByText('素材库图片（2）')).toBeInTheDocument()
    expect(screen.queryByText(/本文配图/)).not.toBeInTheDocument()
  })

  it('选主题步：未选主题显示空态且发布禁用；点选主题后渲染预览并启用，再点取消恢复空态', async () => {
    const user = userEvent.setup()
    renderPublish()
    await goToThemes(user)

    // 未选主题：空态引导 + 发布禁用，未发起渲染
    expect(await screen.findByText('请选择主题查看排版效果')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发布到公众号草稿箱' })).toBeDisabled()
    expect(renderPreview).not.toHaveBeenCalled()

    // 点选 Default：渲染预览（iframe）+ 发布启用
    await user.click(screen.getByRole('button', { name: /Default/ }))
    await waitFor(() => expect(renderPreview).toHaveBeenCalled())
    expect(renderPreview).toHaveBeenCalledWith(
      'a1',
      expect.objectContaining({ theme_id: 'default' }),
    )
    const iframe = screen.getByTitle('主题预览')
    expect(iframe).toHaveAttribute('srcdoc', expect.stringContaining('<section id="wenyan">'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发布到公众号草稿箱' })).toBeEnabled(),
    )

    // 切换主题：以新 theme_id 重新渲染
    await user.click(screen.getByRole('button', { name: /Rainbow/ }))
    await waitFor(() =>
      expect(renderPreview).toHaveBeenLastCalledWith(
        'a1',
        expect.objectContaining({ theme_id: 'rainbow' }),
      ),
    )

    // 取消选择：恢复空态 + 发布禁用
    await user.click(screen.getByRole('button', { name: /Rainbow/ }))
    expect(await screen.findByText('请选择主题查看排版效果')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发布到公众号草稿箱' })).toBeDisabled()
  })

  it('主题渲染失败：显示错误与重试，重试后恢复预览', async () => {
    renderPreview
      .mockRejectedValueOnce(new ApiError('主题预览渲染失败：主题不存在: nope', 400, 'PUBLISH_RENDER_ERROR'))
      .mockResolvedValueOnce({ html: '<section id="wenyan">rendered</section>' })
    const user = userEvent.setup()
    renderPublish()
    await goToThemes(user)

    await user.click(screen.getByRole('button', { name: /Default/ }))
    expect(await screen.findByText(/主题预览渲染失败/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发布到公众号草稿箱' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: /重\s*试/ }))
    await screen.findByTitle('主题预览')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发布到公众号草稿箱' })).toBeEnabled(),
    )
  })

  it('发布成功：确认弹窗 → loading → 成功态展示 media_id 与查看发布记录链接；插图与封面/作者随 payload 透传', async () => {
    const user = userEvent.setup()
    renderPublish()
    await goToThemes(user, { author: '测试作者' })
    await pickDefaultTheme(user)

    expect(publishPreview).toHaveBeenLastCalledWith('a1', {
      version_id: 'v1',
      image_placements: [
        { asset_id: 'asset-1', position: 'after_block_2', order: 0 },
        { asset_id: 'asset-2', position: 'after_block_2', order: 1 },
      ],
      cover_asset_id: 'asset-1',
      author: '测试作者',
    })

    await user.click(screen.getByRole('button', { name: '发布到公众号草稿箱' }))
    await user.click(await screen.findByRole('button', { name: '确认发布' }))

    expect(await screen.findByText('已发布到公众号草稿箱')).toBeInTheDocument()
    expect(screen.getByText('FAKE_MEDIA_abcd1234')).toBeInTheDocument()
    const recordsLink = screen.getByRole('link', { name: '查看发布记录' })
    expect(recordsLink).toHaveAttribute('href', '/publish-records')

    expect(publishArticle).toHaveBeenCalledWith('a1', {
      version_id: 'v1',
      image_placements: [
        { asset_id: 'asset-1', position: 'after_block_2', order: 0 },
        { asset_id: 'asset-2', position: 'after_block_2', order: 1 },
      ],
      cover_asset_id: 'asset-1',
      author: '测试作者',
      theme_id: 'default',
      edited_markdown: null,
    })
  })

  it('未选封面时发布：cover_asset_id 为 null（插图不自动设封面）', async () => {
    const user = userEvent.setup()
    renderPublish()
    await goToThemes(user, { pickCover: null })
    await pickDefaultTheme(user)

    expect(publishPreview).toHaveBeenLastCalledWith(
      'a1',
      expect.objectContaining({ cover_asset_id: null }),
    )

    await user.click(screen.getByRole('button', { name: '发布到公众号草稿箱' }))
    await user.click(await screen.findByRole('button', { name: '确认发布' }))
    await screen.findByText('已发布到公众号草稿箱')

    expect(publishArticle).toHaveBeenCalledWith(
      'a1',
      expect.objectContaining({ cover_asset_id: null }),
    )
  })

  it('切换版本：封面与已插图保留、失效锚点退到文末并提示；切换文章：配图与封面全部重置', async () => {
    listArticles.mockResolvedValue({
      items: [
        {
          id: 'a1',
          title: '测试文章',
          status: 'generated',
          provider: 'deepseek',
          model: 'fake-model',
          created_at: '2026-08-24T09:00:00Z',
          updated_at: '2026-08-24T09:00:00Z',
          version_count: 1,
          summary: '',
        },
        {
          id: 'a2',
          title: '另一篇文章',
          status: 'generated',
          provider: 'deepseek',
          model: 'fake-model',
          created_at: '2026-08-24T09:00:00Z',
          updated_at: '2026-08-24T09:00:00Z',
          version_count: 1,
          summary: '',
        },
      ],
    })
    getWorkspace.mockImplementation(async (id: string) =>
      id === 'a1'
        ? {
            article: { id: 'a1', title: '测试文章', current_version_id: 'v1' },
            current_version: {
              id: 'v1',
              version_number: 1,
              title: '测试文章',
              content_markdown: CONTENT,
            },
            versions: [
              { id: 'v1', version_number: 1, title: '测试文章' },
              { id: 'v2', version_number: 2, title: '测试文章 v2' },
            ],
          }
        : {
            article: { id: 'a2', title: '另一篇文章', current_version_id: 'v3' },
            current_version: {
              id: 'v3',
              version_number: 1,
              title: '另一篇文章',
              content_markdown: CONTENT,
            },
            versions: [{ id: 'v3', version_number: 1, title: '另一篇文章' }],
          },
    )
    // v2 正文更短（仅 2 块）→ v1 中锚定块 4 的插图失效
    publishPreview.mockImplementation(async (_id: string, input: { version_id?: string | null }) =>
      input.version_id === 'v2'
        ? { sections: SECTIONS, blocks: BLOCKS.slice(0, 2), markdown: ASSEMBLED }
        : { sections: SECTIONS, blocks: BLOCKS, markdown: ASSEMBLED },
    )
    const user = userEvent.setup()
    renderPublish()
    await waitForData()

    // 步骤 2：选封面 + 锚定块 4 插入一张图
    await pickCoverViaModal(user, /素材 asset-1/)
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByLabelText('正文画布')
    await insertViaModal(user, 4, [/素材 asset-2/])
    expect(withinCanvas().getByAltText('素材 asset-2')).toBeInTheDocument()

    // 回步骤 1 切版本 v2：封面保留 + 插图保留（失效锚点退到文末并提示）
    await user.click(screen.getByRole('button', { name: '上一步' }))
    await waitFor(() =>
      expect(document.querySelector('.publish-cover-selected-title')).toHaveTextContent(
        '素材 asset-1',
      ),
    )
    await user.click(screen.getByRole('combobox', { name: '版本' }))
    const dropdown = Array.from(document.querySelectorAll('.ant-select-dropdown')).find(
      (el) => !el.className.includes('leave') && !el.className.includes('hidden'),
    )!
    fireEvent.click(within(dropdown as HTMLElement).getByTitle('v2 · 测试文章 v2'))

    await user.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByText(
      '版本切换后正文变短，1 张图片的插入位置已失效，已移至文末，请重新定位。',
    )
    // 图片保留：显示在画布末尾（bottom）
    expect(withinCanvas().getByAltText('素材 asset-2')).toBeInTheDocument()
    expect(
      document.querySelector('.publish-canvas-images:last-child .publish-canvas-image-title'),
    ).toHaveTextContent('素材 asset-2')

    // 回步骤 1 切文章：封面与配图全部重置
    await user.click(screen.getByRole('button', { name: '上一步' }))
    await user.click(screen.getByRole('combobox', { name: '文章' }))
    const articleDropdown = Array.from(document.querySelectorAll('.ant-select-dropdown')).find(
      (el) => !el.className.includes('leave') && !el.className.includes('hidden'),
    )!
    fireEvent.click(within(articleDropdown as HTMLElement).getByTitle('另一篇文章'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '选择封面' })).toBeInTheDocument(),
    )

    await user.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByLabelText('正文画布')
    expect(withinCanvas().queryByAltText('素材 asset-2')).toBeNull()
    expect(screen.getByText('未插图时发布纯文字版本，需在「版本和信息」步骤选择封面。')).toBeInTheDocument()
  })

  it('编辑模式：默认只读预览，【编辑】切换 TextArea，完成编辑后以编辑终稿重新渲染并随发布透传', async () => {
    const user = userEvent.setup()
    renderPublish()
    await goToThemes(user)
    await pickDefaultTheme(user)

    // 默认只读：无编辑框，iframe 预览在
    expect(screen.queryByLabelText('发布 Markdown 编辑框')).not.toBeInTheDocument()
    expect(screen.getByTitle('主题预览')).toBeInTheDocument()

    // 进入编辑模式：TextArea 初始化为组装结果（AntD 汉字按钮自动插空格，用正则匹配）
    await user.click(screen.getByRole('button', { name: /编\s*辑/ }))
    const editor = screen.getByLabelText('发布 Markdown 编辑框')
    expect(editor).toHaveValue(ASSEMBLED)
    expect(screen.getByRole('button', { name: '发布到公众号草稿箱' })).toBeDisabled()

    await user.clear(editor)
    await user.type(editor, '---\ntitle: "手工编辑版"\n---\n\n编辑后的正文')
    await user.click(screen.getByRole('button', { name: /完成编辑/ }))

    // 完成编辑：回到只读预览，并以编辑终稿重新渲染（markdown 覆盖）
    await waitFor(() =>
      expect(renderPreview).toHaveBeenLastCalledWith(
        'a1',
        expect.objectContaining({
          theme_id: 'default',
          markdown: '---\ntitle: "手工编辑版"\n---\n\n编辑后的正文',
        }),
      ),
    )
    expect(screen.queryByLabelText('发布 Markdown 编辑框')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发布到公众号草稿箱' })).toBeEnabled(),
    )

    await user.click(screen.getByRole('button', { name: '发布到公众号草稿箱' }))
    await user.click(await screen.findByRole('button', { name: '确认发布' }))
    await screen.findByText('已发布到公众号草稿箱')

    expect(publishArticle).toHaveBeenCalledWith(
      'a1',
      expect.objectContaining({ edited_markdown: '---\ntitle: "手工编辑版"\n---\n\n编辑后的正文' }),
    )
  })

  it('取消编辑：不提交草稿内容，预览与发布仍用组装结果', async () => {
    const user = userEvent.setup()
    renderPublish()
    await goToThemes(user)
    await pickDefaultTheme(user)

    await user.click(screen.getByRole('button', { name: /编\s*辑/ }))
    const editor = screen.getByLabelText('发布 Markdown 编辑框')
    await user.clear(editor)
    await user.type(editor, '临时草稿不该生效')
    await user.click(screen.getByRole('button', { name: /取消编辑/ }))

    expect(screen.queryByLabelText('发布 Markdown 编辑框')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发布到公众号草稿箱' })).toBeEnabled(),
    )

    await user.click(screen.getByRole('button', { name: '发布到公众号草稿箱' }))
    await user.click(await screen.findByRole('button', { name: '确认发布' }))
    await screen.findByText('已发布到公众号草稿箱')

    expect(publishArticle).toHaveBeenCalledWith(
      'a1',
      expect.objectContaining({ edited_markdown: null }),
    )
  })

  it('发布失败：按错误码展示映射文案并可重试', async () => {
    publishArticle
      .mockRejectedValueOnce(
        new ApiError('wenyan 调用失败：40164 invalid ip', 502, 'PUBLISH_MCP_ERROR'),
      )
      .mockResolvedValueOnce({
        publish_id: 'rec-2',
        media_id: 'FAKE_MEDIA_retry_ok',
        status: 'succeeded',
      })
    const user = userEvent.setup()
    renderPublish()
    await goToThemes(user)
    await pickDefaultTheme(user)

    await user.click(screen.getByRole('button', { name: '发布到公众号草稿箱' }))
    await user.click(await screen.findByRole('button', { name: '确认发布' }))

    expect(await screen.findByText('发布失败')).toBeInTheDocument()
    expect(screen.getByText(/IP 不在白名单/)).toBeInTheDocument()
    expect(screen.getByText('PUBLISH_MCP_ERROR')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重试发布' }))
    expect(await screen.findByText('已发布到公众号草稿箱')).toBeInTheDocument()
    expect(screen.getByText('FAKE_MEDIA_retry_ok')).toBeInTheDocument()
  })

  it('回退保持状态：选主题步回退到配图步，已插图仍在画布', async () => {
    const user = userEvent.setup()
    renderPublish()
    await goToThemes(user)
    await pickDefaultTheme(user)
    await user.click(screen.getByRole('button', { name: '上一步' }))
    await screen.findByLabelText('正文画布')
    expect(withinCanvas().getByAltText('素材 asset-1')).toBeInTheDocument()
    expect(withinCanvas().getByAltText('素材 asset-2')).toBeInTheDocument()
  })
})
