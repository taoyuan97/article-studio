import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App as AntApp } from 'antd'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'

const getImageWorkspace = vi.fn()
const sendImagePrompt = vi.fn()
const cancelImageRun = vi.fn()

vi.mock('../api/imageSessions', () => ({
  imageSessionsApi: {
    getImageWorkspace: (...args: unknown[]) => getImageWorkspace(...args),
    sendImagePrompt: (...args: unknown[]) => sendImagePrompt(...args),
    cancelImageRun: (...args: unknown[]) => cancelImageRun(...args),
  },
}))

const getDefaults = vi.fn()
const generate = vi.fn()
const getLatest = vi.fn()

vi.mock('../api/imagePlan', () => ({
  imagePlanApi: {
    getDefaults: (...args: unknown[]) => getDefaults(...args),
    generate: (...args: unknown[]) => generate(...args),
    getLatest: (...args: unknown[]) => getLatest(...args),
  },
}))

const listArticles = vi.fn()
const getArticle = vi.fn()
const listVersions = vi.fn()

vi.mock('../api/articles', () => ({
  articlesApi: {
    listArticles: (...args: unknown[]) => listArticles(...args),
    getArticle: (...args: unknown[]) => getArticle(...args),
    listVersions: (...args: unknown[]) => listVersions(...args),
  },
}))

const saveAsset = vi.fn()

vi.mock('../api/assets', () => ({
  assetsApi: {
    saveAsset: (...args: unknown[]) => saveAsset(...args),
  },
}))

import ImageWorkspacePage from './ImageWorkspacePage'

const SESSION_ID = 'session-1'

const DEFAULTS = {
  role: '默认角色设定',
  instructions: '默认编排指令',
  models: [
    { provider: 'deepseek', model: 'deepseek-chat', context_window: 64000 },
    { provider: 'moonshot', model: 'kimi-chat', context_window: 128000 },
  ],
  default_model: { provider: 'deepseek', model: 'deepseek-chat', context_window: 64000 },
}

const PLAN_RESPONSE = {
  plan: {
    mood: '温暖治愈',
    style_summary: '暖色调水彩插画，统一治愈氛围',
    images: [
      {
        block_index: 1,
        position_hint: '开篇引入',
        layout: 'landscape',
        layout_reason: '开篇横版大图',
        prompt: '提示词一：清晨咖啡馆',
      },
      {
        block_index: 3,
        position_hint: '结语收束',
        layout: 'portrait',
        layout_reason: '竖版收尾',
        prompt: '提示词二：暮色天际线',
      },
    ],
  },
  article_title: '测试文章',
  article_id: 'a1',
  version_id: 'v1',
  word_count: 1200,
  section_count: 3,
  block_count: 6,
  role: '默认角色设定',
  instructions: '默认编排指令',
  provider: 'deepseek',
  model: 'deepseek-chat',
}

function makeWorkspace(articleId: string | null = 'a1') {
  return {
    session: {
      id: SESSION_ID,
      article_id: articleId,
      article_title: articleId ? '测试文章' : null,
      title: '测试配图会话',
      provider: 'fake',
      model: 'fake-image-model',
      status: 'idle',
      created_at: '2026-08-24T10:00:00Z',
      updated_at: '2026-08-24T10:00:00Z',
    },
    messages: [],
    available_providers: [
      { provider: 'fake', model: 'fake-image-model' },
    ],
    active_run_id: null,
  }
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter initialEntries={[`/image-sessions/${SESSION_ID}`]}>
          <Routes>
            <Route path="/image-sessions/:sessionId" element={<ImageWorkspacePage />} />
          </Routes>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  )
}

async function switchToPlan(user: ReturnType<typeof userEvent.setup>) {
  // antd Segmented 的 radio input 带 pointer-events:none，点击其 label 文本
  await user.click(screen.getByText('计划'))
}

async function waitForForm() {
  await screen.findByLabelText('编排角色设定')
}

describe('ImageWorkspacePage 计划/行动双模式', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    getImageWorkspace.mockResolvedValue(makeWorkspace())
    getDefaults.mockResolvedValue(DEFAULTS)
    getLatest.mockResolvedValue({ plan: null })
    listArticles.mockResolvedValue({
      items: [{ id: 'a1', title: '测试文章', status: 'generated' }],
    })
    getArticle.mockResolvedValue({
      id: 'a1',
      title: '测试文章',
      current_version_id: 'v1',
    })
    listVersions.mockResolvedValue({
      items: [{ id: 'v1', article_id: 'a1', version_number: 1, title: '测试文章' }],
    })
  })

  it('默认行动模式：显示图片参数按钮，无计划表单', async () => {
    renderPage()
    await screen.findByText('历史对话')
    expect(screen.getByText(/图片参数/)).toBeInTheDocument()
    expect(screen.queryByLabelText('编排指令')).not.toBeInTheDocument()
    // 计划接口未被调用
    expect(getDefaults).not.toHaveBeenCalled()
  })

  it('切换到计划模式：隐藏图片参数按钮，渲染计划表单并回填默认值', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('历史对话')
    await switchToPlan(user)

    await waitForForm()
    expect(screen.queryByText(/图片参数/)).not.toBeInTheDocument()
    expect(getDefaults).toHaveBeenCalled()
    expect(getLatest).toHaveBeenCalledWith(SESSION_ID)

    const role = screen.getByLabelText('编排角色设定') as HTMLTextAreaElement
    expect(role.value).toBe('默认角色设定')
    const instructions = screen.getByLabelText('编排指令') as HTMLTextAreaElement
    expect(instructions.value).toBe('默认编排指令')

    // 模型选择器只显示模型名（决策 ③）
    // antd Select 会把 aria-label 同时挂到外层 div 和内部 input，取第一个（外层容器）
    const modelSelect = screen.getAllByLabelText('选择编排模型')[0]
    expect(modelSelect.textContent).toContain('deepseek-chat')
    expect(modelSelect.textContent).not.toContain('deepseek ·')

    // 文章已按会话关联预选
    const articleSelect = screen.getAllByLabelText('选择文章')[0]
    expect(articleSelect.textContent).toContain('测试文章')
  })

  it('一键编排：提交所选文章/版本/模型，渲染结果卡片并可复制', async () => {
    generate.mockResolvedValue(PLAN_RESPONSE)
    const user = userEvent.setup()
    // user-event setup() 会安装自己的 Clipboard stub，须在其之后覆盖
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    renderPage()
    await screen.findByText('历史对话')
    await switchToPlan(user)
    await waitForForm()

    await user.click(screen.getByRole('button', { name: '一键编排' }))

    await waitFor(() => expect(generate).toHaveBeenCalledWith(SESSION_ID, {
      article_id: 'a1',
      version_id: 'v1',
      role: '默认角色设定',
      instructions: '默认编排指令',
      provider: 'deepseek',
      model: 'deepseek-chat',
    }))

    // 统计条 + 卡片（'测试文章' 同时出现在文章选择器与统计条，用 getAllByText）
    await screen.findByText('温暖治愈')
    expect(screen.getAllByText('测试文章').length).toBeGreaterThan(0)
    expect(screen.getByText(/1200 字 · 3 章节 · 2 张配图/)).toBeInTheDocument()
    expect(screen.getByText('提示词一：清晨咖啡馆')).toBeInTheDocument()
    expect(screen.getByText('#1')).toBeInTheDocument()
    expect(screen.getByText('横版')).toBeInTheDocument()
    expect(screen.getByText('竖版')).toBeInTheDocument()

    // 复制
    await user.click(screen.getByRole('button', { name: '复制提示词 1' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('提示词一：清晨咖啡馆'))
    expect(await screen.findByText('已复制')).toBeInTheDocument()
  })

  it('进入计划模式时恢复最近一次方案', async () => {
    getLatest.mockResolvedValue(PLAN_RESPONSE)
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('历史对话')
    await switchToPlan(user)

    await screen.findByText('温暖治愈')
    expect(screen.getByText('提示词二：暮色天际线')).toBeInTheDocument()
    // 角色/指令回填为最近方案使用的值
    await waitForForm()
    const role = screen.getByLabelText('编排角色设定') as HTMLTextAreaElement
    expect(role.value).toBe('默认角色设定')
  })

  it('编排失败：错误 Banner + 重试重新提交', async () => {
    generate
      .mockRejectedValueOnce(new ApiError('配图编排失败：模拟错误', 502, 'PLAN_LLM_ERROR'))
      .mockResolvedValueOnce(PLAN_RESPONSE)
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('历史对话')
    await switchToPlan(user)
    await waitForForm()

    await user.click(screen.getByRole('button', { name: '一键编排' }))
    expect(await screen.findByText('配图编排失败：模拟错误')).toBeInTheDocument()

    // antd Button 对两个汉字自动插入空格（重试 → "重 试"）
    await user.click(screen.getByRole('button', { name: /重\s*试/ }))
    await screen.findByText('温暖治愈')
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('模式选择持久化：切回行动模式后重新进入仍为行动模式', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('历史对话')
    await switchToPlan(user)
    await waitForForm()
    expect(window.localStorage.getItem(`image-mode:${SESSION_ID}`)).toBe('plan')

    await user.click(screen.getByText('计划'))
    await waitForForm()
    expect(window.localStorage.getItem(`image-mode:${SESSION_ID}`)).toBe('plan')

    await user.click(screen.getByText('行动'))
    await screen.findByText('历史对话')
    expect(window.localStorage.getItem(`image-mode:${SESSION_ID}`)).toBe('action')
  })
})
