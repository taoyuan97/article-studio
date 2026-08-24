import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App as AntApp } from 'antd'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchPublishRecordDetail = vi.fn()

vi.mock('../api/publish', () => ({
  publishApi: {
    fetchPublishRecordDetail: (...args: unknown[]) => fetchPublishRecordDetail(...args),
  },
}))

const listAssets = vi.fn()

vi.mock('../api/assets', () => ({
  assetsApi: {
    listAssets: (...args: unknown[]) => listAssets(...args),
  },
}))

import PublishRecordDetailPage from './PublishRecordDetailPage'

function makeAsset(id: string) {
  return {
    id,
    kind: 'image' as const,
    source: 'image_generation' as const,
    source_session_id: 'session-1',
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

const SNAPSHOT = [
  '---',
  'title: "测试文章"',
  'cover: "C:\\\\data\\\\assets\\\\images\\\\cover-dir\\\\cover.png"',
  'author: "作者甲"',
  '---',
  '',
  '<script>alert(1)</script>',
  '',
  '## 要点',
  '',
  '![](C:\\data\\assets\\images\\p1-dir\\p1.png)',
  '',
  '正文内容',
].join('\n')

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter initialEntries={['/publish-records/rec-1']}>
          <Routes>
            <Route path="/publish-records/:recordId" element={<PublishRecordDetailPage />} />
          </Routes>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  )
}

describe('PublishRecordDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listAssets.mockResolvedValue({
      items: [
        makeAsset('cover'),
        makeAsset('p1'),
      ].map((asset, index) =>
        index === 0
          ? { ...asset, storage_url: '/static/assets/images/cover-dir/cover.png' }
          : { ...asset, storage_url: '/static/assets/images/p1-dir/p1.png' },
      ),
    })
  })

  it('元信息面板完整：标题 / 主题 / media_id / 作者 / 时间 / 封面缩略图', async () => {
    fetchPublishRecordDetail.mockResolvedValue({
      id: 'rec-1',
      article_id: 'a1',
      version_id: 'v1',
      theme_id: 'default',
      cover_asset_id: 'cover',
      author: '作者甲',
      digest: null,
      image_placements: [{ asset_id: 'p1', position: 'after_section_1', order: 0 }],
      status: 'succeeded',
      media_id: 'FAKE_MEDIA_9999',
      error_code: null,
      error_message: null,
      content_snapshot: SNAPSHOT,
      created_at: '2026-08-24T10:00:00Z',
      article_title: '测试文章',
    })
    renderPage()

    expect(await screen.findByText('FAKE_MEDIA_9999')).toBeInTheDocument()
    expect(screen.getByText('测试文章')).toBeInTheDocument()
    expect(screen.getByText('作者甲')).toBeInTheDocument()
    expect(screen.getByText('default')).toBeInTheDocument()
    // 封面与配图缩略图在素材列表查询返回后渲染，需等待
    expect(await screen.findByAltText('素材 cover')).toHaveAttribute(
      'src',
      '/static/assets/images/cover-dir/cover.png',
    )
    expect(await screen.findByAltText('素材 p1')).toBeInTheDocument()
  })

  it('frontmatter 剥离后只读渲染：正文可见、frontmatter 不渲染、恶意 HTML 不执行', async () => {
    fetchPublishRecordDetail.mockResolvedValue({
      id: 'rec-1',
      article_id: 'a1',
      version_id: 'v1',
      theme_id: 'default',
      cover_asset_id: null,
      author: null,
      digest: null,
      image_placements: [],
      status: 'succeeded',
      media_id: 'FAKE_MEDIA_9999',
      error_code: null,
      error_message: null,
      content_snapshot: SNAPSHOT,
      created_at: '2026-08-24T10:00:00Z',
      article_title: '测试文章',
    })
    renderPage()

    expect(await screen.findByText('正文内容')).toBeInTheDocument()
    // frontmatter 字段不作为正文渲染
    expect(screen.queryByText('title: "测试文章"')).not.toBeInTheDocument()
    expect(screen.queryByText(/cover:/)).not.toBeInTheDocument()
    // 小节标题正常渲染（白名单）
    expect(screen.getByText('要点').tagName).toBe('H2')
    // 恶意 script 不产生元素、不执行
    expect(document.querySelectorAll('script')).toHaveLength(0)
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
  })

  it('记录不存在：错误态展示', async () => {
    fetchPublishRecordDetail.mockRejectedValue(
      new (class extends Error {
        status = 404
        code = 'NOT_FOUND'
      })('发布记录不存在'),
    )
    renderPage()
    // 标题与正文都含该文案，断言错误态标题（h2）
    expect(
      await screen.findByRole('heading', { name: '发布记录不存在', level: 2 }),
    ).toBeInTheDocument()
  })
})
