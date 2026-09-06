import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App as AntApp } from 'antd'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  updateProvider: vi.fn(),
  clearProviderCredentials: vi.fn(),
  revealProviderCredential: vi.fn(),
  updateDefaults: vi.fn(),
  updateRuntime: vi.fn(),
  updateWechat: vi.fn(),
  clearWechatCredentials: vi.fn(),
  revealWechatCredential: vi.fn(),
  probe: vi.fn(),
}))

vi.mock('../api/settings', () => ({ settingsApi: mocks }))

import SettingsPage from './SettingsPage'

const status = {
  revision: 2,
  default_llm_provider: 'deepseek',
  default_image_provider: 'aliyun_wanxiang',
  providers: {
    llm_deepseek: {
      configured: true,
      editable: true,
      credential_masked: 'env***cret',
      credential_source: 'env',
      runtime_credential_fields: [],
      base_url: 'https://api.deepseek.com',
      model_id: 'deepseek-chat',
      context_window: 64000,
    },
    llm_moonshot: {
      configured: false,
      editable: true,
      credential_masked: null,
      credential_source: null,
      runtime_credential_fields: [],
      base_url: 'https://api.moonshot.cn/v1',
      model_id: null,
      context_window: null,
    },
    image_wanxiang: {
      configured: true,
      editable: true,
      credential_masked: 'wan***cret',
      credential_source: 'runtime',
      runtime_credential_fields: ['credential'],
      base_url: 'https://workspace.example.com',
      model_id: 'wanx2.1-t2i-turbo',
    },
    image_dreamina: {
      configured: false,
      editable: false,
      credential_masked: null,
      credential_source: null,
      runtime_credential_fields: [],
      unavailable_reason: '敬请期待',
    },
  },
  runtime: {
    llm_timeout_seconds: 180,
    llm_max_retries: 2,
    llm_max_output_tokens: 16384,
    llm_context_usage_ratio: 0.8,
    llm_recent_message_limit: 12,
    image_timeout_seconds: 180,
  },
  wechat: {
    configured: false,
    credential_masked: null,
    credential_source: null,
    runtime_credential_fields: [],
    mcp_command_configured: true,
    mcp_available: false,
    mcp_executable: null,
    publish_fake_mode: false,
  },
}

function renderPage(entry = '/settings') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter initialEntries={[entry]}>
          <SettingsPage />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  )
}

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getStatus.mockResolvedValue(status)
    mocks.revealProviderCredential.mockResolvedValue({
      revision: 2,
      field: 'credential',
      value: 'wanxiang-runtime-secret',
    })
  })

  it('展示模型配置、运行参数和即梦占位', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: '设置' })).toBeInTheDocument()
    expect(screen.getByText('配置版本 2')).toBeInTheDocument()
    expect(screen.getAllByText('DeepSeek').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Kimi').length).toBeGreaterThan(0)
    expect(screen.getAllByText('通义万相').length).toBeGreaterThan(0)
    expect(screen.getByText('即梦 / 火山引擎')).toBeInTheDocument()
    expect(screen.getByText('即梦配置入口正在准备中，本期暂不支持页面编辑与连通测试。')).toBeInTheDocument()
    expect(screen.getByText('运行参数')).toBeInTheDocument()
  })

  it('可切换到公众号配置 Tab', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findAllByText('DeepSeek')
    await user.click(screen.getByRole('tab', { name: '公众号配置' }))
    expect(screen.getByText('微信公众号')).toBeInTheDocument()
    expect(screen.getByText('真实发布')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /测试配置/ })).toBeInTheDocument()
  })

  it('查询参数可直接打开公众号配置', async () => {
    renderPage('/settings?tab=wechat')
    expect(await screen.findByText('微信公众号')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '公众号配置' })).toHaveAttribute('aria-selected', 'true')
  })

  it('模型参数未变更时禁用保存，修改后启用，恢复原值后再次禁用', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findAllByText('DeepSeek')

    const saveButtons = screen.getAllByRole('button', { name: /保存/ })
    expect(saveButtons).toHaveLength(5)
    saveButtons.forEach((button) => expect(button).toBeDisabled())

    const modelInput = screen.getByDisplayValue('deepseek-chat')
    const providerCard = modelInput.closest('.ant-card')
    expect(providerCard).not.toBeNull()
    const providerSave = within(providerCard as HTMLElement).getByRole('button', { name: /保存/ })

    await user.clear(modelInput)
    await user.type(modelInput, 'deepseek-reasoner')
    expect(providerSave).toBeEnabled()

    await user.clear(modelInput)
    await user.type(modelInput, 'deepseek-chat')
    expect(providerSave).toBeDisabled()
  })

  it('运行参数恢复原值、查看已保存密钥均不算变更', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findAllByText('DeepSeek')

    const retriesInput = screen.getByRole('spinbutton', { name: 'LLM 最大重试次数' })
    const runtimeCard = retriesInput.closest('.ant-card')
    expect(runtimeCard).not.toBeNull()
    const runtimeSave = within(runtimeCard as HTMLElement).getByRole('button', { name: /保存运行参数/ })
    expect(runtimeSave).toBeDisabled()

    await user.clear(retriesInput)
    await user.type(retriesInput, '3')
    expect(runtimeSave).toBeEnabled()
    await user.clear(retriesInput)
    await user.type(retriesInput, '2')
    expect(runtimeSave).toBeDisabled()

    const wanxiangInput = screen.getByLabelText('通义万相 API Key')
    const wanxiangCard = wanxiangInput.closest('.ant-card')
    expect(wanxiangCard).not.toBeNull()
    const wanxiangSave = within(wanxiangCard as HTMLElement).getByRole('button', { name: /保存/ })
    await user.click(within(wanxiangCard as HTMLElement).getByRole('img', { name: 'eye-invisible' }))
    await waitFor(() => expect(mocks.revealProviderCredential).toHaveBeenCalledWith('image_wanxiang', 2))
    expect(wanxiangInput).toHaveValue('wanxiang-runtime-secret')
    expect(wanxiangSave).toBeDisabled()
  })
})
