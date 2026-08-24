import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App as AntApp } from 'antd'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchPublishRecords = vi.fn()

vi.mock('../api/publish', () => ({
  publishApi: {
    fetchPublishRecords: (...args: unknown[]) => fetchPublishRecords(...args),
  },
}))

const listArticles = vi.fn()

vi.mock('../api/articles', () => ({
  articlesApi: {
    listArticles: (...args: unknown[]) => listArticles(...args),
  },
}))

import PublishRecordsPage from './PublishRecordsPage'

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rec-1',
    article_id: 'a1',
    version_id: 'v1',
    theme_id: 'default',
    cover_asset_id: null,
    author: null,
    digest: null,
    image_placements: [],
    status: 'succeeded',
    media_id: 'FAKE_MEDIA_1234',
    error_code: null,
    error_message: null,
    content_snapshot: '---\ntitle: "t"\n---\n\n正文',
    created_at: '2026-08-24T10:00:00Z',
    article_title: '测试文章',
    ...overrides,
  }
}

function renderPage(initialEntry = '/publish-records') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter initialEntries={[initialEntry]}>
          <PublishRecordsPage />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  )
}

describe('PublishRecordsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listArticles.mockResolvedValue({
      items: [{ id: 'a1', title: '测试文章' }],
    })
  })

  it('列表渲染：文章标题 / 主题 / 状态徽标 / media_id，并跳转详情', async () => {
    fetchPublishRecords.mockResolvedValue({
      items: [makeRecord(), makeRecord({ id: 'rec-2', status: 'failed', media_id: null })],
    })
    renderPage()

    // 两条记录同标题同主题，文本会出现多次
    expect(await screen.findAllByText('测试文章')).toHaveLength(2)
    expect(screen.getAllByText('default')).toHaveLength(2)
    expect(screen.getByText('FAKE_MEDIA_1234')).toBeInTheDocument()
    // 状态徽标限定在表格内（工具栏 Segmented 筛选项与 Tag 同名）
    const table = screen.getByRole('table')
    expect(within(table).getByText('成功')).toBeInTheDocument()
    expect(within(table).getByText('失败')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '查看快照' })).toHaveLength(2)
    expect(fetchPublishRecords).toHaveBeenCalledWith(null)
  })

  it('状态筛选：成功 / 失败 / 全部', async () => {
    const user = userEvent.setup()
    fetchPublishRecords.mockResolvedValue({
      items: [
        makeRecord(),
        makeRecord({ id: 'rec-2', status: 'failed', media_id: null }),
      ],
    })
    renderPage()
    await screen.findByText('FAKE_MEDIA_1234')

    // Segmented 的 radio input 设了 pointer-events: none，改点其 label 文本；
    // 状态 Tag 与筛选项同名，取位于 .ant-segmented-item 内的那个
    const segmentedOption = (label: string) =>
      screen.getAllByText(label).find((el) => el.closest('.ant-segmented-item'))!

    await user.click(segmentedOption('失败'))
    expect(screen.queryByText('FAKE_MEDIA_1234')).not.toBeInTheDocument()
    expect(screen.getAllByText('失败').length).toBeGreaterThanOrEqual(1)

    await user.click(segmentedOption('成功'))
    expect(screen.getByText('FAKE_MEDIA_1234')).toBeInTheDocument()

    await user.click(segmentedOption('全部'))
    expect(screen.getAllByText('成功').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('失败').length).toBeGreaterThanOrEqual(1)
  })

  it('失败记录可展开错误码与错误信息', async () => {
    const user = userEvent.setup()
    fetchPublishRecords.mockResolvedValue({
      items: [
        makeRecord({
          id: 'rec-f',
          status: 'failed',
          media_id: null,
          error_code: 'PUBLISH_MCP_ERROR',
          error_message: '40164 invalid ip ...',
        }),
      ],
    })
    renderPage()
    // 等表格渲染完成再展开失败行
    await screen.findAllByRole('button', { name: '查看快照' })

    await user.click(screen.getByRole('button', { name: 'Expand row' }))
    expect(await screen.findByText(/40164 invalid ip/)).toBeInTheDocument()
    expect(screen.getByText('PUBLISH_MCP_ERROR')).toBeInTheDocument()
  })

  it('空态：引导从文章工作台发布第一篇文章', async () => {
    fetchPublishRecords.mockResolvedValue({ items: [] })
    renderPage()
    expect(await screen.findByText('还没有发布记录')).toBeInTheDocument()
    expect(screen.getByText('去文章列表')).toBeInTheDocument()
  })

  it('按文章过滤：?article_id= 透传并展示过滤标题，可清除', async () => {
    const user = userEvent.setup()
    fetchPublishRecords.mockResolvedValue({ items: [makeRecord()] })
    renderPage('/publish-records?article_id=a1')

    await screen.findByText('FAKE_MEDIA_1234')
    expect(fetchPublishRecords).toHaveBeenCalledWith('a1')
    expect(screen.getByText(/按文章过滤：测试文章/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '清除文章过滤' }))
    // 清除后重新请求不带文章过滤（searchParams.get 返回 null）
    await waitFor(() => expect(fetchPublishRecords).toHaveBeenLastCalledWith(null))
  })
})
