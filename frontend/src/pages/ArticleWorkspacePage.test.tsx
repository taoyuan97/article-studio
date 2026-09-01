import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App as AntApp } from 'antd'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArticleVersion, ArticleWorkspace } from '../api/types'

const getWorkspace = vi.fn()
const getVersion = vi.fn()
const sendMessage = vi.fn()

vi.mock('../api/articles', () => ({
  articlesApi: {
    getWorkspace: (...args: unknown[]) => getWorkspace(...args),
    getVersion: (...args: unknown[]) => getVersion(...args),
    sendMessage: (...args: unknown[]) => sendMessage(...args),
    retryMessage: vi.fn(),
    updateModel: vi.fn(),
    cancelRun: vi.fn(),
  },
}))

vi.mock('../hooks/useArticleRunStream', () => ({
  useArticleRunStream: vi.fn(),
}))

import ArticleWorkspacePage from './ArticleWorkspacePage'

const CURRENT_VERSION: ArticleVersion = {
  id: 'v2',
  article_id: 'a1',
  parent_version_id: 'v1',
  version_number: 2,
  title: '当前版本',
  provider: 'fake',
  model: 'fake-model',
  run_id: 'r2',
  created_at: '2026-08-27T11:00:00Z',
  content_markdown: '# 当前版本\n\n正文',
  instruction: '修改',
}

const HISTORY_VERSION: ArticleVersion = {
  ...CURRENT_VERSION,
  id: 'v1',
  parent_version_id: null,
  version_number: 1,
  title: '历史版本',
  run_id: 'r1',
  created_at: '2026-08-27T10:00:00Z',
  content_markdown: '# 历史版本\n\n旧正文',
  instruction: '初稿',
}

function makeWorkspace(withVersion = true): ArticleWorkspace {
  return {
    article: {
      id: 'a1',
      conversation_id: 'c1',
      thread_id: 't1',
      title: '测试文章',
      brief: {
        topic: null,
        audience: null,
        purpose: null,
        tone: null,
        platform: null,
        target_length: null,
        constraints: [],
      },
      conversation_summary: null,
      summary_until_message_id: null,
      status: withVersion ? 'generated' : 'draft',
      current_version_id: withVersion ? 'v2' : null,
      provider: 'fake',
      model: 'fake-model',
      created_at: '2026-08-27T10:00:00Z',
      updated_at: '2026-08-27T11:00:00Z',
      has_active_run: false,
    },
    current_version: withVersion ? CURRENT_VERSION : null,
    messages: [],
    versions: withVersion ? [CURRENT_VERSION, HISTORY_VERSION] : [],
    conversation_id: 'c1',
    thread_id: 't1',
    active_run_id: null,
    available_models: [{ provider: 'fake', model: 'fake-model', context_window: 100_000 }],
    unavailable_models: [],
  }
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter initialEntries={['/articles/a1']}>
          <Routes>
            <Route path="/articles/:articleId" element={<ArticleWorkspacePage />} />
          </Routes>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  )
}

describe('ArticleWorkspacePage export entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getVersion.mockResolvedValue(HISTORY_VERSION)
    sendMessage.mockResolvedValue({
      run_id: 'run-attachment',
      article_id: 'a1',
      user_message_id: 'user-attachment',
      status: 'queued',
      events_url: '/api/runs/run-attachment/events',
    })
  })

  it('导出按钮位于发布入口之前，弹窗默认选中当前展示版本', async () => {
    const user = userEvent.setup()
    getWorkspace.mockResolvedValue(makeWorkspace())
    renderPage()

    const exportButton = await screen.findByRole('button', { name: /^导\s*出$/ })
    const publishLink = screen.getByRole('link', { name: '发布到公众号' })
    expect(
      exportButton.compareDocumentPosition(publishLink) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    await user.click(exportButton)
    expect(
      screen.getByRole('combobox', { name: '导出版本' }).closest('.ant-select'),
    ).toHaveTextContent('v2 · 当前版本')
  })

  it('工作台切换到历史版本后，导出弹窗默认选择该历史版本', async () => {
    const user = userEvent.setup()
    getWorkspace.mockResolvedValue(makeWorkspace())
    renderPage()

    await screen.findByText('当前：v2 · 当前版本')
    await user.click(screen.getByRole('combobox', { name: '选择版本' }))
    await user.click(await screen.findByText('v1 · 历史版本'))
    await waitFor(() => expect(getVersion).toHaveBeenCalledWith('a1', 'v1'))
    await screen.findByText('历史版本：v1 · 历史版本')

    await user.click(screen.getByRole('button', { name: /^导\s*出$/ }))
    expect(
      screen.getByRole('combobox', { name: '导出版本' }).closest('.ant-select'),
    ).toHaveTextContent('v1 · 历史版本')
  })

  it('无正式版本时禁用导出并显示说明', async () => {
    const user = userEvent.setup()
    getWorkspace.mockResolvedValue(makeWorkspace(false))
    renderPage()

    const exportButton = await screen.findByRole('button', { name: /^导\s*出$/ })
    expect(exportButton).toBeDisabled()
    await user.hover(exportButton.parentElement!)
    expect(await screen.findByText('请先生成文章内容')).toBeInTheDocument()
  })

  it('附件不能替代文字指令，发送时提交附件快照并在 202 后清空', async () => {
    const user = userEvent.setup()
    getWorkspace.mockResolvedValue(makeWorkspace())
    renderPage()

    await screen.findByText('当前：v2 · 当前版本')
    const input = await screen.findByLabelText('选择参考资料')
    await user.upload(input, new File(['# 参考\n独有内容'], 'reference.md', { type: 'text/markdown' }))
    expect(await screen.findByText('reference.md')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^发\s*送$/ })).toBeDisabled()

    await user.type(
      screen.getByPlaceholderText(/直接写一篇面向职场新人/),
      '请根据附件写文章',
    )
    await user.click(screen.getByRole('button', { name: /^发\s*送$/ }))
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith('a1', {
        content: '请根据附件写文章',
        attachments: [{ name: 'reference.md', content: '# 参考\n独有内容' }],
      }),
    )
    await waitFor(() => expect(screen.queryByText('reference.md')).not.toBeInTheDocument())
    expect(screen.getByPlaceholderText(/直接写一篇面向职场新人/)).toHaveValue('')
  })

  it('生成期间仍可准备下一轮附件但发送保持禁用', async () => {
    const user = userEvent.setup()
    getWorkspace.mockResolvedValue(makeWorkspace())
    renderPage()
    await screen.findByText('当前：v2 · 当前版本')
    await user.type(screen.getByPlaceholderText(/直接写一篇面向职场新人/), '第一轮')
    await user.click(screen.getByRole('button', { name: /^发\s*送$/ }))
    await screen.findByText('正在生成')

    const input = screen.getByLabelText('选择参考资料')
    await user.upload(input, new File(['下一轮'], 'next.txt', { type: 'text/plain' }))
    expect(await screen.findByText('next.txt')).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText(/直接写一篇面向职场新人/), '下一轮指令')
    expect(screen.getByRole('button', { name: /^发\s*送$/ })).toBeDisabled()
  })
})
