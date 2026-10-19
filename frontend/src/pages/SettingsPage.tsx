import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  ExperimentOutlined,
  EyeOutlined,
  LockOutlined,
  SaveOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Skeleton,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
} from 'antd'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { settingsApi } from '../api/settings'
import type {
  SettingsProviderId,
  SettingsProviderStatus,
  SettingsRuntime,
  SettingsStatus,
} from '../api/types'

const PROVIDERS: Array<{
  id: SettingsProviderId
  title: string
  kind: string
  contextWindow?: boolean
}> = [
  { id: 'llm_deepseek', title: 'DeepSeek', kind: 'LLM', contextWindow: true },
  { id: 'llm_moonshot', title: 'Kimi', kind: 'LLM', contextWindow: true },
  { id: 'image_wanxiang', title: '通义万相', kind: 'IMAGE' },
  { id: 'image_dreamina', title: '即梦 / 火山引擎', kind: 'IMAGE' },
]

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '操作失败，请稍后重试'
}

function sourceLabel(source: SettingsProviderStatus['credential_source']): string {
  return source === 'runtime'
    ? '浏览器配置'
    : source === 'env'
      ? '.env'
      : source === 'mixed'
        ? '混合来源'
        : '未配置'
}

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function providerParamsChanged(
  values: Partial<ProviderValues>,
  status: SettingsProviderStatus,
  hasContextWindow: boolean,
): boolean {
  if (normalizedText(values.base_url) !== normalizedText(status.base_url)) return true
  if (normalizedText(values.model_id) !== normalizedText(status.model_id)) return true
  return hasContextWindow && Number(values.context_window) !== Number(status.context_window)
}

function runtimeParamsChanged(values: Partial<SettingsRuntime>, baseline: SettingsRuntime): boolean {
  return (Object.keys(baseline) as Array<keyof SettingsRuntime>).some(
    (field) => Number(values[field]) !== Number(baseline[field]),
  )
}

function useRefreshSettings() {
  const queryClient = useQueryClient()
  return () => {
    queryClient.invalidateQueries({ queryKey: ['settings-status'] })
    queryClient.invalidateQueries({ queryKey: ['workspace'] })
    queryClient.invalidateQueries({ queryKey: ['image-workspace'] })
    queryClient.invalidateQueries({ queryKey: ['image-plan-defaults'] })
  }
}

interface ProviderValues {
  base_url: string
  model_id: string
  context_window?: number
}

function ProviderCard({
  id,
  title,
  kind,
  contextWindow,
  status,
  revision,
}: {
  id: SettingsProviderId
  title: string
  kind: string
  contextWindow?: boolean
  status: SettingsProviderStatus
  revision: number
}) {
  const { message } = App.useApp()
  const refresh = useRefreshSettings()
  const [credential, setCredential] = useState('')
  const [credentialBaseline, setCredentialBaseline] = useState<string | null>(null)
  const [credentialVisible, setCredentialVisible] = useState(false)
  const [credentialLoading, setCredentialLoading] = useState(false)
  const [paramsChanged, setParamsChanged] = useState(false)
  const credentialChanged = credential.trim().length > 0
    && (credentialBaseline === null || credential !== credentialBaseline)

  const saveMutation = useMutation({
    mutationFn: (values: ProviderValues) =>
      settingsApi.updateProvider(id, {
        revision,
        ...values,
        ...(credentialChanged ? { credential } : {}),
      }),
    onSuccess: () => {
      setCredential('')
      setCredentialBaseline(null)
      setCredentialVisible(false)
      setParamsChanged(false)
      refresh()
      message.success(`${title} 配置已保存并生效`)
    },
    onError: (error) => {
      refresh()
      message.error(errorMessage(error))
    },
  })
  const clearMutation = useMutation({
    mutationFn: () => settingsApi.clearProviderCredentials(id, revision),
    onSuccess: () => {
      refresh()
      message.success(`${title} 浏览器 API Key 已清除`)
    },
    onError: (error) => {
      refresh()
      message.error(errorMessage(error))
    },
  })
  const probeMutation = useMutation({
    mutationFn: () => settingsApi.probe(id),
    onSuccess: (result) =>
      result.ok
        ? message.success(`${title}：${result.message}（${result.latency_ms} ms）`)
        : message.error(`${title}：${result.message}`),
    onError: (error) => message.error(errorMessage(error)),
  })

  const revealCredential = async () => {
    if (credential) {
      setCredentialVisible(true)
      return
    }
    if (!status.runtime_credential_fields.includes('credential')) return
    setCredentialLoading(true)
    try {
      const result = await settingsApi.revealProviderCredential(id, revision)
      setCredential(result.value)
      setCredentialBaseline(result.value)
      setCredentialVisible(true)
    } catch (error) {
      refresh()
      message.error(`${title} API Key 查看失败：${errorMessage(error)}`)
    } finally {
      setCredentialLoading(false)
    }
  }

  if (!status.editable) {
    return (
      <Card
        className="settings-provider-card settings-provider-placeholder"
        title={<Space><span>{title}</span><Tag>{kind}</Tag></Space>}
        extra={<Tag>敬请期待</Tag>}
      >
        <p>即梦配置入口正在准备中，本期暂不支持页面编辑与连通测试。</p>
      </Card>
    )
  }

  const probeButton = (
    <Button
      icon={<ExperimentOutlined />}
      loading={probeMutation.isPending}
      onClick={() => probeMutation.mutate()}
    >
      测试连通
    </Button>
  )

  return (
    <Card
      className="settings-provider-card"
      title={<Space><span>{title}</span><Tag>{kind}</Tag></Space>}
      extra={status.configured
        ? <Tag color="success" icon={<CheckCircleOutlined />}>已配置</Tag>
        : <Tag color="error" icon={<CloseCircleOutlined />}>未配置</Tag>}
    >
      <div className="settings-meta">
        <span><LockOutlined /> {status.credential_masked ?? '无 API Key'}</span>
        <Tag>{sourceLabel(status.credential_source)}</Tag>
      </div>
      <Form<ProviderValues>
        key={`${id}-${revision}`}
        layout="vertical"
        initialValues={{
          base_url: status.base_url,
          model_id: status.model_id,
          context_window: status.context_window,
        }}
        onValuesChange={(_changed, values) =>
          setParamsChanged(providerParamsChanged(values, status, Boolean(contextWindow)))}
        onFinish={(values) => saveMutation.mutate(values)}
      >
        <Form.Item
          name="base_url"
          label="Base URL"
          extra={id === 'image_wanxiang' ? '填写阿里云百炼业务空间域名' : undefined}
          rules={[
            { required: true, whitespace: true, message: '请输入 Base URL' },
            { type: 'url', message: '请输入完整的 HTTP(S) 地址' },
          ]}
        >
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="model_id"
          label="模型 ID"
          rules={[{ required: true, whitespace: true, message: '请输入模型 ID' }]}
        >
          <Input autoComplete="off" />
        </Form.Item>
        {contextWindow ? (
          <Form.Item
            name="context_window"
            label="Context Window"
            rules={[{ required: true, message: '请输入上下文窗口大小' }]}
          >
            <InputNumber min={1} max={2_000_000} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        ) : null}
        <Form.Item label="API Key">
          <Input.Password
            aria-label={`${title} API Key`}
            value={credential}
            placeholder={status.runtime_credential_fields.includes('credential')
              ? `${status.credential_masked ?? '已保存'}，点击眼睛查看`
              : '来自 .env 时不可查看；输入新值可覆盖'}
            autoComplete="new-password"
            disabled={credentialLoading}
            visibilityToggle={status.runtime_credential_fields.includes('credential') || credential
              ? {
                  visible: credentialVisible,
                  onVisibleChange: (visible) =>
                    visible ? void revealCredential() : setCredentialVisible(false),
                }
              : false}
            onChange={(event) => {
              setCredential(event.target.value)
            }}
          />
        </Form.Item>
        <Space wrap>
          <Button
            type="primary"
            htmlType="submit"
            icon={<SaveOutlined />}
            loading={saveMutation.isPending}
            disabled={!paramsChanged && !credentialChanged}
          >
            保存
          </Button>
          <Popconfirm
            title="清除浏览器 API Key？"
            description="清除后如 .env 有值将自动回退。"
            okText="清除"
            cancelText="取消"
            onConfirm={() => clearMutation.mutate()}
          >
            <Button
              danger
              disabled={!['runtime', 'mixed'].includes(status.credential_source ?? '')}
              loading={clearMutation.isPending}
            >
              清除 API Key
            </Button>
          </Popconfirm>
          {id === 'image_wanxiang' ? (
            <Popconfirm
              title="执行真实生图测试？"
              description="测试会调用通义万相，可能产生最低额度费用。"
              okText="继续测试"
              cancelText="取消"
              onConfirm={() => probeMutation.mutate()}
            >
              <Button icon={<ExperimentOutlined />} loading={probeMutation.isPending}>测试连通</Button>
            </Popconfirm>
          ) : probeButton}
        </Space>
      </Form>
    </Card>
  )
}

function DefaultsCard({ status }: { status: SettingsStatus }) {
  const { message } = App.useApp()
  const refresh = useRefreshSettings()
  const [dirty, setDirty] = useState(false)
  const mutation = useMutation({
    mutationFn: (values: {
      default_llm_provider: SettingsStatus['default_llm_provider']
      default_image_provider: SettingsStatus['default_image_provider']
    }) => settingsApi.updateDefaults({
      revision: status.revision,
      ...(values.default_llm_provider !== status.default_llm_provider
        ? { default_llm_provider: values.default_llm_provider }
        : {}),
      ...(values.default_image_provider !== status.default_image_provider
        ? { default_image_provider: values.default_image_provider }
        : {}),
    }),
    onSuccess: () => {
      setDirty(false)
      refresh()
      message.success('默认模型已保存并生效')
    },
    onError: (error) => {
      refresh()
      message.error(errorMessage(error))
    },
  })
  return (
    <Card title="默认模型">
      <Form
        key={`defaults-${status.revision}`}
        layout="vertical"
        initialValues={{
          default_llm_provider: status.default_llm_provider,
          default_image_provider: status.default_image_provider,
        }}
        onValuesChange={(_changed, values) => {
          setDirty(
            values.default_llm_provider !== status.default_llm_provider
              || (values.default_image_provider ?? null) !== (status.default_image_provider ?? null),
          )
        }}
        onFinish={(values) => mutation.mutate(values)}
      >
        <div className="settings-form-grid">
          <Form.Item name="default_llm_provider" label="默认语言模型" rules={[{ required: true }]}>
            <Select
              options={[
                { label: 'DeepSeek', value: 'deepseek', disabled: !status.providers.llm_deepseek.configured },
                { label: 'Kimi', value: 'moonshot', disabled: !status.providers.llm_moonshot.configured },
              ]}
            />
          </Form.Item>
          <Form.Item name="default_image_provider" label="默认生图模型">
            <Select
              placeholder="未设置"
              options={[
                {
                  label: '通义万相',
                  value: 'aliyun_wanxiang',
                  disabled: !status.providers.image_wanxiang.configured,
                },
                ...(status.default_image_provider === 'dreamina'
                  ? [{ label: '即梦（当前为 .env 只读配置）', value: 'dreamina', disabled: true }]
                  : []),
              ]}
            />
          </Form.Item>
        </div>
        <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={mutation.isPending} disabled={!dirty}>
          保存默认模型
        </Button>
      </Form>
    </Card>
  )
}

function RuntimeCard({ status }: { status: SettingsStatus }) {
  const { message } = App.useApp()
  const refresh = useRefreshSettings()
  const [dirty, setDirty] = useState(false)
  const mutation = useMutation({
    mutationFn: (values: SettingsRuntime) =>
      settingsApi.updateRuntime({ revision: status.revision, ...values }),
    onSuccess: () => {
      setDirty(false)
      refresh()
      message.success('运行参数已保存并生效')
    },
    onError: (error) => {
      refresh()
      message.error(errorMessage(error))
    },
  })
  const fields: Array<{
    name: keyof SettingsRuntime
    label: string
    min: number
    max: number
    step?: number
    precision?: number
  }> = [
    { name: 'llm_timeout_seconds', label: 'LLM 超时（秒）', min: 1, max: 600 },
    { name: 'llm_max_retries', label: 'LLM 最大重试次数', min: 0, max: 10, precision: 0 },
    { name: 'llm_max_output_tokens', label: 'LLM 最大输出 Token', min: 1, max: 1_000_000, precision: 0 },
    { name: 'llm_context_usage_ratio', label: '上下文使用比例', min: 0.01, max: 0.8, step: 0.01 },
    { name: 'llm_recent_message_limit', label: '最近消息保留数', min: 1, max: 10_000, precision: 0 },
    { name: 'image_timeout_seconds', label: '生图超时（秒）', min: 1, max: 1200 },
  ]
  return (
    <Card title="运行参数">
      <Form<SettingsRuntime>
        key={`runtime-${status.revision}`}
        layout="vertical"
        initialValues={status.runtime}
        onValuesChange={(_changed, values) =>
          setDirty(runtimeParamsChanged(values, status.runtime))}
        onFinish={(values) => mutation.mutate(values)}
      >
        <div className="settings-runtime-grid">
          {fields.map((field) => (
            <Form.Item key={field.name} name={field.name} label={field.label} rules={[{ required: true }]}>
              <InputNumber {...field} style={{ width: '100%' }} />
            </Form.Item>
          ))}
        </div>
        <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={mutation.isPending} disabled={!dirty}>
          保存运行参数
        </Button>
      </Form>
    </Card>
  )
}

function WechatCard({ status }: { status: SettingsStatus }) {
  const { message } = App.useApp()
  const refresh = useRefreshSettings()
  const wechat = status.wechat
  const [appId, setAppId] = useState('')
  const [appIdDirty, setAppIdDirty] = useState(false)
  const [appSecret, setAppSecret] = useState('')
  const [appSecretDirty, setAppSecretDirty] = useState(false)
  const [secretVisible, setSecretVisible] = useState(false)

  const reveal = async (field: 'app_id' | 'app_secret') => {
    if (!wechat.runtime_credential_fields.includes(field)) return
    try {
      const result = await settingsApi.revealWechatCredential(status.revision, field)
      if (field === 'app_id') setAppId(result.value)
      else {
        setAppSecret(result.value)
        setSecretVisible(true)
      }
    } catch (error) {
      refresh()
      message.error(`凭据查看失败：${errorMessage(error)}`)
    }
  }

  const saveMutation = useMutation({
    mutationFn: () => settingsApi.updateWechat({
      revision: status.revision,
      ...(appIdDirty ? { app_id: appId } : {}),
      ...(appSecretDirty ? { app_secret: appSecret } : {}),
    }),
    onSuccess: () => {
      setAppId(''); setAppIdDirty(false)
      setAppSecret(''); setAppSecretDirty(false); setSecretVisible(false)
      refresh()
      message.success('公众号配置已保存并生效')
    },
    onError: (error) => {
      refresh()
      message.error(errorMessage(error))
    },
  })
  const clearMutation = useMutation({
    mutationFn: () => settingsApi.clearWechatCredentials(status.revision),
    onSuccess: () => {
      refresh()
      message.success('公众号浏览器凭据已清除')
    },
    onError: (error) => {
      refresh()
      message.error(errorMessage(error))
    },
  })
  const probeMutation = useMutation({
    mutationFn: () => settingsApi.probe('wechat'),
    onSuccess: (result) => result.ok
      ? message.success(`${result.message}（${result.latency_ms} ms）`)
      : message.error(result.message),
    onError: (error) => message.error(errorMessage(error)),
  })

  return (
    <Card
      title="微信公众号"
      extra={wechat.configured
        ? <Tag color="success" icon={<CheckCircleOutlined />}>已配置</Tag>
        : <Tag color="error" icon={<CloseCircleOutlined />}>未配置</Tag>}
    >
      <div className="settings-meta">
        <span><LockOutlined /> {wechat.credential_masked ?? '无公众号凭据'}</span>
        <Tag>{sourceLabel(wechat.credential_source)}</Tag>
      </div>
      <Form layout="vertical" onFinish={() => saveMutation.mutate()}>
        <Form.Item label="AppID">
          <Input
            aria-label="微信公众号 AppID"
            value={appId}
            placeholder={wechat.runtime_credential_fields.includes('app_id')
              ? '已保存，可点击右侧查看'
              : '来自 .env 时不可查看；输入新值可覆盖'}
            suffix={wechat.runtime_credential_fields.includes('app_id')
              ? <Button type="text" size="small" aria-label="查看 AppID" icon={<EyeOutlined />} onClick={() => void reveal('app_id')} />
              : undefined}
            onChange={(event) => { setAppId(event.target.value); setAppIdDirty(true) }}
          />
        </Form.Item>
        <Form.Item label="AppSecret">
          <Input.Password
            aria-label="微信公众号 AppSecret"
            value={appSecret}
            placeholder={wechat.runtime_credential_fields.includes('app_secret')
              ? '已保存，点击眼睛查看'
              : '来自 .env 时不可查看；输入新值可覆盖'}
            autoComplete="new-password"
            visibilityToggle={wechat.runtime_credential_fields.includes('app_secret') || appSecret
              ? {
                  visible: secretVisible,
                  onVisibleChange: (visible) => visible ? void reveal('app_secret') : setSecretVisible(false),
                }
              : false}
            onChange={(event) => { setAppSecret(event.target.value); setAppSecretDirty(true) }}
          />
        </Form.Item>
        <Space wrap>
          <Button
            type="primary"
            htmlType="submit"
            icon={<SaveOutlined />}
            loading={saveMutation.isPending}
            disabled={!appIdDirty && !appSecretDirty}
          >
            保存
          </Button>
          <Popconfirm
            title="清除浏览器公众号凭据？"
            description="AppID 与 AppSecret 会同时清除；如 .env 有值将自动回退。"
            okText="清除"
            cancelText="取消"
            onConfirm={() => clearMutation.mutate()}
          >
            <Button
              danger
              disabled={!['runtime', 'mixed'].includes(wechat.credential_source ?? '')}
              loading={clearMutation.isPending}
            >
              清除凭据
            </Button>
          </Popconfirm>
          <Button icon={<ExperimentOutlined />} loading={probeMutation.isPending} onClick={() => probeMutation.mutate()}>
            测试配置
          </Button>
        </Space>
      </Form>
      <div className="settings-readonly-grid">
        <div><span>wenyan-mcp</span><Tag color={wechat.mcp_available ? 'success' : 'error'}>{wechat.mcp_available ? `可用 · ${wechat.mcp_executable}` : '不可用'}</Tag></div>
        <div><span>发布模式</span><Tag color={wechat.publish_fake_mode ? 'warning' : 'processing'}>{wechat.publish_fake_mode ? '假发布' : '真实发布'}</Tag></div>
      </div>
    </Card>
  )
}

function McpCard({ status }: { status: SettingsStatus }) {
  const { message, modal } = App.useApp()
  const refresh = useRefreshSettings()
  const mcp = status.mcp
  const [enabled, setEnabled] = useState(mcp.enabled)
  const [authEnabled, setAuthEnabled] = useState(mcp.auth.enabled)
  const [authToken, setAuthToken] = useState('')
  const [tokenDirty, setTokenDirty] = useState(false)
  const [tokenVisible, setTokenVisible] = useState(false)
  const [hostsText, setHostsText] = useState(mcp.allowed_hosts.join('\n'))
  const [waitTimeout, setWaitTimeout] = useState(mcp.wait_timeout_seconds)

  const hostsDraft = hostsText
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
  const hostsChanged = hostsDraft.join(',') !== mcp.allowed_hosts.join(',')
  const dirty =
    enabled !== mcp.enabled ||
    authEnabled !== mcp.auth.enabled ||
    tokenDirty ||
    hostsChanged ||
    Number(waitTimeout) !== Number(mcp.wait_timeout_seconds)
  const authNeedsToken =
    authEnabled && (tokenDirty ? !authToken.trim() : !mcp.auth.token_masked)

  const saveMutation = useMutation({
    mutationFn: () =>
      settingsApi.updateMcp({
        revision: status.revision,
        enabled,
        auth_enabled: authEnabled,
        ...(tokenDirty ? { auth_token: authToken.trim() } : {}),
        allowed_hosts: hostsDraft,
        wait_timeout_seconds: Number(waitTimeout),
      }),
    onSuccess: () => {
      setAuthToken('')
      setTokenDirty(false)
      setTokenVisible(false)
      refresh()
      message.success('MCP 配置已保存，下一次 MCP 请求生效')
    },
    onError: (error) => {
      refresh()
      message.error(errorMessage(error))
    },
  })
  const clearMutation = useMutation({
    mutationFn: () => settingsApi.clearMcpToken(status.revision),
    onSuccess: () => {
      refresh()
      message.success('浏览器 Token 已清除，已回退到 .env 配置')
    },
    onError: (error) => {
      refresh()
      message.error(errorMessage(error))
    },
  })
  const probeMutation = useMutation({
    mutationFn: () => settingsApi.probe('mcp'),
    onSuccess: (result) =>
      result.ok
        ? message.success(`${result.message}（${result.latency_ms} ms）`)
        : message.error(result.message),
    onError: (error) => message.error(errorMessage(error)),
  })

  const handleEnabledChange = (next: boolean) => {
    if (next && !mcp.enabled) {
      modal.confirm({
        title: '启用 MCP 服务？',
        content:
          '启用后本机智能体可通过 /mcp/ 调用文章工作台。请确认后端仅监听 127.0.0.1；未启用鉴权时，任何能访问该端口的客户端都可调用。',
        okText: '启用',
        cancelText: '取消',
        onOk: () => setEnabled(true),
      })
      return
    }
    setEnabled(next)
  }

  const revealToken = async () => {
    if (!mcp.auth.runtime_token) return
    try {
      const result = await settingsApi.revealMcpToken(status.revision)
      setAuthToken(result.value)
      setTokenVisible(true)
    } catch (error) {
      refresh()
      message.error(`Token 查看失败：${errorMessage(error)}`)
    }
  }

  const generateToken = () => {
    const random =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().replace(/-/g, '')
        : Math.random().toString(36).slice(2)
    setAuthToken(`as_${random}${random}`.slice(0, 64))
    setTokenDirty(true)
    setTokenVisible(true)
    setAuthEnabled(true)
  }

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      message.success(`${label}已复制`)
    } catch {
      message.warning('复制失败，请手动选择')
    }
  }

  const dshYaml = [
    '- insert:',
    '    - id: mcp-article-studio',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: article-studio',
    '        transport: streamable-http',
    `        url: ${mcp.endpoint}`,
    ...(mcp.auth.enabled
      ? ['        headers:', '          Authorization: "Bearer <token>"']
      : []),
    '        toolCallTimeoutMs: 300000',
  ].join('\n')

  return (
    <Card
      title="MCP 服务"
      extra={
        enabled ? (
          <Tag color="success" icon={<CheckCircleOutlined />}>
            已启用
          </Tag>
        ) : (
          <Tag icon={<CloseCircleOutlined />}>已关闭</Tag>
        )
      }
    >
      <Alert
        type={mcp.enabled ? 'warning' : 'info'}
        showIcon
        style={{ marginBottom: 16 }}
        message={mcp.enabled ? 'MCP 端点已开启' : 'MCP 默认关闭'}
        description={
          mcp.enabled
            ? '请确认后端仅监听 127.0.0.1。修改 Token/Hosts 后已连接客户端会立即 401/403，属预期；保存无需重启后端。'
            : '开启后本地智能体可连接 /mcp/ 调用文章工作台；建议先启用 Bearer 鉴权，再对外提供访问。'
        }
      />

      <div className="settings-mcp-meta">
        <div className="settings-mcp-meta-row">
          <span>端点</span>
          <Typography.Text code>{mcp.endpoint}</Typography.Text>
          <Button
            size="small"
            icon={<CopyOutlined />}
            onClick={() => void copy(mcp.endpoint, '端点')}
          >
            复制
          </Button>
        </div>
        <div className="settings-mcp-meta-row">
          <span>传输</span>
          <Tag>{mcp.transport}</Tag>
          <span>工具</span>
          <Tag>{mcp.tool_count} 个</Tag>
          <span>开关来源</span>
          <Tag>{sourceLabel(mcp.enabled_source)}</Tag>
        </div>
        <div className="settings-mcp-meta-row">
          <LockOutlined />
          <span>{mcp.auth.token_masked ?? '未配置 Bearer Token'}</span>
          <Tag>{sourceLabel(mcp.auth.token_source)}</Tag>
          {mcp.auth.enabled ? <Tag color="processing">鉴权已启用</Tag> : <Tag>未鉴权</Tag>}
        </div>
      </div>

      <Form layout="vertical" onFinish={() => saveMutation.mutate()}>
        <Form.Item label="服务开关">
          <Space align="center" wrap>
            <Switch
              checked={enabled}
              onChange={handleEnabledChange}
              aria-label="启用 MCP 服务"
            />
            <span>{enabled ? '已启用（保存后生效）' : '已关闭（保存后生效）'}</span>
          </Space>
        </Form.Item>

        <Form.Item label="Bearer 鉴权">
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <Space align="center" wrap>
              <Switch
                checked={authEnabled}
                onChange={setAuthEnabled}
                aria-label="启用 Bearer 鉴权"
              />
              <span>启用后客户端须携带 Authorization: Bearer &lt;token&gt;</span>
            </Space>
            <Space.Compact style={{ width: '100%' }}>
              <Input.Password
                aria-label="MCP Auth Token"
                value={authToken}
                placeholder={
                  mcp.auth.runtime_token
                    ? '已保存浏览器 Token，点击眼睛查看；输入新值可覆盖'
                    : '留空表示不启用鉴权；输入新 Token 或点“生成随机”'
                }
                autoComplete="new-password"
                visibilityToggle={{
                  visible: tokenVisible,
                  onVisibleChange: (visible) => {
                    if (visible) void revealToken()
                    else setTokenVisible(false)
                  },
                }}
                onChange={(event) => {
                  setAuthToken(event.target.value)
                  setTokenDirty(true)
                }}
              />
              <Button
                icon={<EyeOutlined />}
                disabled={!mcp.auth.runtime_token}
                onClick={() => void revealToken()}
              >
                查看
              </Button>
              <Button onClick={generateToken}>生成随机</Button>
              <Popconfirm
                title="清除浏览器 Token？"
                description="清除后回退到 .env 配置；如 .env 也没有 Token，需同时关闭鉴权。"
                okText="清除"
                cancelText="取消"
                onConfirm={() => clearMutation.mutate()}
              >
                <Button
                  danger
                  loading={clearMutation.isPending}
                  disabled={!mcp.auth.runtime_token}
                >
                  清除
                </Button>
              </Popconfirm>
            </Space.Compact>
            {authNeedsToken && (
              <Alert
                type="warning"
                showIcon
                message="启用鉴权需要非空 Token：请填写/生成 Token，或关闭鉴权开关。"
              />
            )}
          </Space>
        </Form.Item>

        <Form.Item
          label="Allowed Hosts"
          help="精确主机名，逗号或换行分隔，忽略端口；不支持通配/IP 段。默认仅本机回环。"
        >
          <Input.TextArea
            aria-label="MCP Allowed Hosts"
            rows={3}
            value={hostsText}
            onChange={(event) => setHostsText(event.target.value)}
          />
          <Button
            size="small"
            style={{ marginTop: 8 }}
            onClick={() => setHostsText('127.0.0.1\nlocalhost\n::1')}
          >
            恢复本机默认
          </Button>
        </Form.Item>

        <Form.Item
          label="生成工具默认等待（秒）"
          help="文章/配图工具默认等待上限；超过后返回 running，可再调用 wait_for_run 续等。"
        >
          <InputNumber
            aria-label="MCP 生成工具默认等待秒数"
            min={30}
            max={600}
            value={waitTimeout}
            onChange={(value) => setWaitTimeout(Number(value ?? 180))}
            style={{ width: 180 }}
          />
        </Form.Item>

        <Space wrap>
          <Button
            type="primary"
            htmlType="submit"
            icon={<SaveOutlined />}
            loading={saveMutation.isPending}
            disabled={!dirty || authNeedsToken}
          >
            保存
          </Button>
          <Button
            icon={<ExperimentOutlined />}
            loading={probeMutation.isPending}
            onClick={() => probeMutation.mutate()}
          >
            测试配置
          </Button>
          <Typography.Text type="secondary">保存即生效，无需重启后端。</Typography.Text>
        </Space>
      </Form>

      <Card
        type="inner"
        title="DSH 接入片段"
        style={{ marginTop: 20 }}
        extra={
          <Button
            size="small"
            icon={<CopyOutlined />}
            onClick={() => void copy(dshYaml, 'DSH 配置片段')}
          >
            复制
          </Button>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          写入 <Typography.Text code>~/.dsh/profiles/desktop/cordis.patch.yml</Typography.Text>
          （不自动修改）；Token 用实际值替换 <Typography.Text code>&lt;token&gt;</Typography.Text>。长文生成建议
          <Typography.Text code>toolCallTimeoutMs</Typography.Text> 不低于 300000。
        </Typography.Paragraph>
        <pre className="settings-mcp-code">{dshYaml}</pre>
      </Card>
    </Card>
  )
}

export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const activeTab = tabParam === 'wechat' ? 'wechat' : tabParam === 'mcp' ? 'mcp' : 'models'
  const query = useQuery({ queryKey: ['settings-status'], queryFn: settingsApi.getStatus })

  if (query.isPending) return <Skeleton active paragraph={{ rows: 12 }} />
  if (!query.data) {
    return (
      <Alert
        type="error"
        showIcon
        message="设置加载失败"
        description={errorMessage(query.error)}
        action={<Button onClick={() => query.refetch()}>重试</Button>}
      />
    )
  }
  const status = query.data
  return (
    <div className="settings-page">
      <div className="page-toolbar">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="settings-subtitle">管理文章模型、生图模型、微信公众号发布与 MCP 接入配置。</p>
        </div>
        <Tag>配置版本 {status.revision}</Tag>
      </div>
      <Alert
        type="warning"
        showIcon
        message="仅限可信本机用户"
        description="运行时密钥会保存到本机数据目录；设置接口没有登录鉴权，请勿将服务暴露到局域网或公网。"
      />
      <Tabs
        activeKey={activeTab}
        onChange={(key) =>
          setSearchParams(
            key === 'wechat' || key === 'mcp' ? { tab: key } : {},
            { replace: true },
          )
        }
        items={[
          {
            key: 'models',
            label: '模型配置',
            children: (
              <div className="settings-tab-stack">
                <DefaultsCard status={status} />
                <div className="settings-provider-grid">
                  {PROVIDERS.map((provider) => (
                    <ProviderCard
                      key={`${provider.id}-${status.revision}`}
                      {...provider}
                      status={status.providers[provider.id]}
                      revision={status.revision}
                    />
                  ))}
                </div>
                <RuntimeCard status={status} />
              </div>
            ),
          },
          {
            key: 'wechat',
            label: '公众号配置',
            children: <div className="settings-tab-stack"><WechatCard key={`wechat-${status.revision}`} status={status} /></div>,
          },
          {
            key: 'mcp',
            label: 'MCP 配置',
            children: <div className="settings-tab-stack"><McpCard key={`mcp-${status.revision}`} status={status} /></div>,
          },
        ]}
      />
    </div>
  )
}
