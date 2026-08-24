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

vi.mock('../api/publish', () => ({
  publishApi: {
    fetchPublishThemes: (...args: unknown[]) => fetchPublishThemes(...args),
    publishPreview: (...args: unknown[]) => publishPreview(...args),
    publishArticle: (...args: unknown[]) => publishArticle(...args),
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

const SECTIONS = [
  { index: 1, heading: '要点', body: '- 要点一' },
  { index: 2, heading: '结语', body: '收尾' },
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

/** 从步骤 1 走到预览步（可选封面/作者，步骤 2 勾选两张图，主题保持默认 default） */
async function goToPreview(
  user: ReturnType<typeof userEvent.setup>,
  opts: { pickCover?: RegExp | null; author?: string } = {},
) {
  const { pickCover = /素材 asset-1/, author } = opts
  await waitForData()
  if (pickCover) await pickCoverViaModal(user, pickCover)
  if (author !== undefined) await user.type(screen.getByLabelText('作者'), author)
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await screen.findByText('选择配图')
  // 已关闭的封面弹窗在 jsdom 中停留在 leave 动画态仍留在 DOM，
  // 其缩略图按钮与步骤 2 选择墙同名——查询限定在步骤体范围内
  const stepBody = within(document.querySelector('.publish-step-body') as HTMLElement)
  await user.click(stepBody.getByRole('button', { name: /素材 asset-1/ }))
  await user.click(stepBody.getByRole('button', { name: /素材 asset-2/ }))
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await screen.findByText('Default')
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await screen.findByLabelText('发布 Markdown 编辑框')
  await waitFor(() =>
    expect(screen.getByLabelText('发布 Markdown 编辑框')).toHaveValue(ASSEMBLED),
  )
}

describe('PublishPage 四步向导', () => {
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
      current_version: { id: 'v1', version_number: 1, title: '测试文章', content_markdown: '## 要点' },
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
    publishPreview.mockResolvedValue({ sections: SECTIONS, markdown: ASSEMBLED })
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

  it('预选文章后可进入步骤 2：勾选图片默认均分位置（勾选不再自动设封面）', async () => {
    const user = userEvent.setup()
    renderPublish()
    await waitForData()
    await user.click(screen.getByRole('button', { name: '下一步' }))

    await screen.findByText('选择配图')
    // 勾选两张图：默认均分到第 1/2 节之后
    await user.click(screen.getByRole('button', { name: /素材 asset-1/ }))
    await user.click(screen.getByRole('button', { name: /素材 asset-2/ }))
    expect(screen.getByText('插入位置：第 1 节之后 · 「要点」')).toBeInTheDocument()
    expect(screen.getByText('插入位置：第 2 节之后 · 「结语」')).toBeInTheDocument()
  })

  it('配图候选分组：本文配图置顶，素材库图片（非关联会话）可选', async () => {
    listAssets.mockResolvedValue({
      items: [makeAsset('asset-1'), makeAsset('asset-2'), makeAsset('asset-3', 'session-2')],
    })
    const user = userEvent.setup()
    renderPublish()
    await waitForData()
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByText('选择配图')

    // 两组分组标题均展示，「本文配图」在前
    const groupTitles = screen.getAllByText(/本文配图|素材库图片/)
    expect(groupTitles).toHaveLength(2)
    expect(groupTitles[0]).toHaveTextContent('本文配图（2）')
    expect(groupTitles[1]).toHaveTextContent('素材库图片（1）')

    // 勾选素材库图片（独立会话素材）：位置默认均分
    await user.click(screen.getByRole('button', { name: /素材 asset-3/ }))
    expect(screen.getByText('插入位置：第 1 节之后 · 「要点」')).toBeInTheDocument()
  })

  it('文章无关联配图会话时：仅展示「素材库图片」组，不渲染「本文配图」', async () => {
    listImageSessions.mockResolvedValue({
      items: [{ id: 'session-2', article_id: null, title: '独立配图会话' }],
    })
    listAssets.mockResolvedValue({ items: [makeAsset('asset-9', 'session-2')] })
    const user = userEvent.setup()
    renderPublish()
    await waitForData()
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByText('选择配图')

    expect(screen.queryByText(/本文配图/)).not.toBeInTheDocument()
    expect(screen.getByText('素材库图片（1）')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /素材 asset-9/ })).toBeInTheDocument()
  })

  it('素材库完全无图片素材时：显示空态引导', async () => {
    listAssets.mockResolvedValue({ items: [] })
    const user = userEvent.setup()
    renderPublish()
    await waitForData()
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByText('选择配图')

    expect(
      screen.getByText('素材库还没有图片素材，可先在配图工作台生成并保存素材。'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/素材库图片（/)).not.toBeInTheDocument()
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

  it('配图位置可切换与同位置排序（上移/下移）', async () => {
    const user = userEvent.setup()
    renderPublish()
    await waitForData()
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByText('选择配图')

    await user.click(screen.getByRole('button', { name: /素材 asset-1/ }))
    await user.click(screen.getByRole('button', { name: /素材 asset-2/ }))
    // 将 asset-2 的位置改为文末。
    // 注：rc-select 虚拟列表下可见选项无 role=option（role=option 的是无事件的
    // 屏幕阅读器隐藏列表），须按 title（即 option label）点击可见选项
    const clickVisibleOption = async (comboboxName: string, optionTitle: string) => {
      await user.click(screen.getByRole('combobox', { name: comboboxName }))
      // jsdom 中动画不推进：上一次关闭的下拉停留在 leave 态且未标 hidden，
      // 各 Select 生成的 list id 也相同，无法按 id 区分——
      // 取当前正处于 appear（打开中）态的下拉，其内按 title 点可见选项
      const dropdown = Array.from(document.querySelectorAll('.ant-select-dropdown')).find(
        (el) => !el.className.includes('leave') && !el.className.includes('hidden'),
      )!
      const option = within(dropdown as HTMLElement).getByTitle(optionTitle)
      // 下拉停在 appear-prepare 动画态（pointer-events: none），user.click 指针校验会拒绝，直接派发 click
      fireEvent.click(option)
    }
    await clickVisibleOption('素材 asset-2 插入位置', '文末')
    expect(screen.getByText('插入位置：文末')).toBeInTheDocument()

    // 再把 asset-1 也改为文末，然后将其下移（与 asset-2 交换顺序 → 排到后面）
    await clickVisibleOption('素材 asset-1 插入位置', '文末')
    const moveDown = screen.getByRole('button', { name: '素材 asset-1 下移' })
    await user.click(moveDown)
    // 两张同在文末：第一张卡片应为 asset-2
    const firstCard = document.querySelector('.publish-card .publish-card-title')
    expect(firstCard).toHaveTextContent('素材 asset-2')
  })

  it('主题默认选中 default，点击已选主题可取消；未选主题时发布按钮不可用', async () => {
    const user = userEvent.setup()
    renderPublish()
    await waitForData()
    await user.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByText('选择配图')
    await user.click(screen.getByRole('button', { name: '下一步' }))

    const defaultCard = await screen.findByRole('button', { name: /Default/ })
    expect(defaultCard).toHaveClass('is-selected')
    // 取消选择
    await user.click(defaultCard)
    expect(screen.getByRole('button', { name: /Default/ })).not.toHaveClass('is-selected')

    await user.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByLabelText('发布 Markdown 编辑框')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发布到公众号草稿箱' })).toBeDisabled(),
    )
  })

  it('发布成功：确认弹窗 → loading → 成功态展示 media_id 与查看发布记录链接；封面与作者随 payload 透传', async () => {
    const user = userEvent.setup()
    renderPublish()
    await goToPreview(user, { author: '测试作者' })

    expect(publishPreview).toHaveBeenLastCalledWith('a1', {
      version_id: 'v1',
      image_placements: [
        { asset_id: 'asset-1', position: 'after_section_1', order: 0 },
        { asset_id: 'asset-2', position: 'after_section_2', order: 1 },
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
        { asset_id: 'asset-1', position: 'after_section_1', order: 0 },
        { asset_id: 'asset-2', position: 'after_section_2', order: 1 },
      ],
      cover_asset_id: 'asset-1',
      author: '测试作者',
      theme_id: 'default',
      edited_markdown: null,
    })
  })

  it('未选封面时发布：cover_asset_id 为 null（勾选配图不自动设封面）', async () => {
    const user = userEvent.setup()
    renderPublish()
    await goToPreview(user, { pickCover: null })

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

  it('切换版本保留封面，切换文章重置封面', async () => {
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
              content_markdown: '## 要点',
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
              content_markdown: '## 要点',
            },
            versions: [{ id: 'v3', version_number: 1, title: '另一篇文章' }],
          },
    )
    const user = userEvent.setup()
    renderPublish()
    await waitForData()
    await pickCoverViaModal(user, /素材 asset-1/)
    await waitFor(() =>
      expect(document.querySelector('.publish-cover-selected-title')).toHaveTextContent(
        '素材 asset-1',
      ),
    )

    // rc-select 虚拟列表下按 title 点击当前 appear 态下拉中的可见选项
    const clickVisibleOption = async (comboboxName: string, optionTitle: string) => {
      await user.click(screen.getByRole('combobox', { name: comboboxName }))
      const dropdown = Array.from(document.querySelectorAll('.ant-select-dropdown')).find(
        (el) => !el.className.includes('leave') && !el.className.includes('hidden'),
      )!
      const option = within(dropdown as HTMLElement).getByTitle(optionTitle)
      fireEvent.click(option)
    }

    // 切换版本：封面保留（封面与版本内容无关）
    await clickVisibleOption('版本', 'v2 · 测试文章 v2')
    await waitFor(() =>
      expect(document.querySelector('.publish-cover-selected-title')).toHaveTextContent(
        '素材 asset-1',
      ),
    )

    // 切换文章：封面重置（本文配图语境变化）
    await clickVisibleOption('文章', '另一篇文章')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '选择封面' })).toBeInTheDocument(),
    )
    expect(document.querySelector('.publish-cover-selected-title')).toBeNull()
  })

  it('编辑 Markdown 后发布：edited_markdown 透传编辑内容', async () => {
    const user = userEvent.setup()
    renderPublish()
    await goToPreview(user)

    const editor = screen.getByLabelText('发布 Markdown 编辑框')
    await user.clear(editor)
    await user.type(editor, '---\ntitle: "手工编辑版"\n---\n\n编辑后的正文')

    await user.click(screen.getByRole('button', { name: '发布到公众号草稿箱' }))
    await user.click(await screen.findByRole('button', { name: '确认发布' }))
    await screen.findByText('已发布到公众号草稿箱')

    expect(publishArticle).toHaveBeenCalledWith(
      'a1',
      expect.objectContaining({ edited_markdown: '---\ntitle: "手工编辑版"\n---\n\n编辑后的正文' }),
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
    await goToPreview(user)

    await user.click(screen.getByRole('button', { name: '发布到公众号草稿箱' }))
    await user.click(await screen.findByRole('button', { name: '确认发布' }))

    expect(await screen.findByText('发布失败')).toBeInTheDocument()
    expect(screen.getByText(/IP 不在白名单/)).toBeInTheDocument()
    expect(screen.getByText('PUBLISH_MCP_ERROR')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重试发布' }))
    expect(await screen.findByText('已发布到公众号草稿箱')).toBeInTheDocument()
    expect(screen.getByText('FAKE_MEDIA_retry_ok')).toBeInTheDocument()
  })

  it('回退保持状态：预览步回退到配图步，已选图片仍在', async () => {
    const user = userEvent.setup()
    renderPublish()
    await goToPreview(user)
    await user.click(screen.getByRole('button', { name: '上一步' }))
    await user.click(screen.getByRole('button', { name: '上一步' }))
    await screen.findByText('选择配图')
    expect(screen.getByText('插入位置：第 1 节之后 · 「要点」')).toBeInTheDocument()
    expect(screen.getByText('插入位置：第 2 节之后 · 「结语」')).toBeInTheDocument()
  })
})
