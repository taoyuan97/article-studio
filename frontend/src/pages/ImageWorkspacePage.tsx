import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { App, Button, Input, Modal, Progress, Segmented, Select, Spin } from 'antd'
import { assetsApi } from '../api/assets'
import type { ApiError } from '../api/client'
import { imagePlanApi } from '../api/imagePlan'
import { imageSessionsApi } from '../api/imageSessions'
import type { ImagePlanGenerateRequest, ImagePlanResponse, ImageWorkspace } from '../api/types'
import StatusBanner from '../components/StatusBanner'
import ImageMessageList, { type ImageFailureInfo } from '../features/image-workspace/ImageMessageList'
import ImageParamsPopover from '../features/image-workspace/ImageParamsPopover'
import ImagePlanForm from '../features/image-workspace/ImagePlanForm'
import ImagePlanResults from '../features/image-workspace/ImagePlanResults'
import {
  loadSessionMode,
  loadSessionParams,
  normalizeParams,
  saveSessionMode,
  saveSessionParams,
  type ImageParams,
  type ImageWorkspaceMode,
} from '../features/image-workspace/params'
import { useImageRunStream } from '../hooks/useImageRunStream'
import { formatDate, providerLabel, resolveImageUrl } from '../lib/format'
import type { ImageRunEventType, RunEventData } from '../lib/sse'

/**
 * 配图工作台（专注模式）：
 * - 「计划/行动」双模式（默认行动，决策 ⑤）：
 *   - 行动：会话对话 + 输入区（provider / 图片参数 / 停止 / 发送）+ 图片预览；
 *   - 计划：文章版本选择 + 角色/指令编排 → LLM 一键编排配图提示词方案（可复制）；
 * - SSE：image.progress / image.completed / image.failed / run.*；
 * - 参数（tier / ratio / mode）随会话持久化回显；重新进入自动恢复历史与活动运行。
 */
export default function ImageWorkspacePage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const queryClient = useQueryClient()
  const { message } = App.useApp()

  const workspaceQuery = useQuery({
    queryKey: ['image-workspace', sessionId],
    queryFn: () => imageSessionsApi.getImageWorkspace(sessionId!),
    enabled: Boolean(sessionId),
    retry: false,
  })

  const workspace = workspaceQuery.data
  const session = workspace?.session ?? null
  const messages = useMemo(() => workspace?.messages ?? [], [workspace])

  // ---------- 运行态（组件局部） ----------
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [failure, setFailure] = useState<ImageFailureInfo | null>(null)
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null)
  const [inputValue, setInputValue] = useState('')

  // 重新进入时自动恢复运行中的事件流
  const runId = activeRunId ?? workspace?.active_run_id ?? null
  const running = Boolean(runId)

  // ---------- provider 选择 ----------
  const providers = workspace?.available_providers ?? []
  const [providerKey, setProviderKey] = useState<string | null>(null)
  const sessionKey = session ? `${session.provider}|${session.model}` : null
  const effectiveKey = providerKey ?? sessionKey
  const effectiveProvider =
    providers.find((item) => `${item.provider}|${item.model}` === effectiveKey) ??
    providers[0] ??
    null

  // ---------- 图片参数（持久化回显 + 按供应商规范化） ----------
  const [rawParams, setRawParams] = useState<ImageParams>(() => {
    if (!sessionId) return { tier: '2K', ratio: '1:1' }
    return loadSessionParams(sessionId) ?? { tier: '2K', ratio: '1:1' }
  })
  const params = useMemo(
    () =>
      normalizeParams(
        effectiveProvider?.provider ?? 'aliyun_wanxiang',
        rawParams.tier,
        rawParams.ratio,
      ),
    [effectiveProvider?.provider, rawParams],
  )

  // ---------- 计划/行动模式（持久化回显，默认行动） ----------
  const [mode, setMode] = useState<ImageWorkspaceMode>(() =>
    sessionId ? loadSessionMode(sessionId) : 'action',
  )

  // ---------- 计划模式：最近方案恢复 + 一键编排 ----------
  const latestPlanQuery = useQuery({
    queryKey: ['image-plan-latest', sessionId],
    queryFn: () => imagePlanApi.getLatest(sessionId!),
    enabled: mode === 'plan' && Boolean(sessionId),
    staleTime: Infinity,
    retry: false,
  })
  // 最近一次生成结果（优先于已恢复方案展示）
  const [generatedPlan, setGeneratedPlan] = useState<ImagePlanResponse | null>(null)

  const planMutation = useMutation({
    mutationFn: (payload: ImagePlanGenerateRequest) =>
      imagePlanApi.generate(sessionId!, payload),
    onSuccess: (data) => {
      setGeneratedPlan(data)
      message.success('配图方案已生成')
    },
  })

  const planData = generatedPlan ?? latestPlanQuery.data ?? null
  const modeDisabled = running || planMutation.isPending
  const statusRunning = running || (mode === 'plan' && planMutation.isPending)

  const handleModeChange = useCallback(
    (next: ImageWorkspaceMode) => {
      if (modeDisabled || next === mode) return
      setMode(next)
      if (sessionId) saveSessionMode(sessionId, next)
    },
    [mode, modeDisabled, sessionId],
  )

  const invalidateWorkspace = useCallback(() => {
    if (!sessionId) return
    queryClient.invalidateQueries({ queryKey: ['image-workspace', sessionId] })
  }, [sessionId, queryClient])

  const handleEvent = useCallback(
    (type: ImageRunEventType, data: RunEventData) => {
      switch (type) {
        case 'run.started':
          if (typeof data.run_id === 'string') setActiveRunId(data.run_id)
          setProgress(0)
          setFailure(null)
          break
        case 'image.progress':
          setProgress(Number(data.percent ?? 0))
          break
        case 'image.completed': {
          setProgress(null)
          const completed = data.message as { id?: string } | undefined
          if (completed && typeof completed.id === 'string') {
            setSelectedImageId(completed.id)
          }
          invalidateWorkspace()
          break
        }
        case 'image.failed': {
          // 失败卡片：简短错误 + 脱敏详情（来自 SSE 载荷）
          setProgress(null)
          const failedMessage = data.error_message as { id?: string } | undefined
          setFailure({
            failedMessageId: failedMessage && typeof failedMessage.id === 'string' ? failedMessage.id : null,
            message: typeof data.message === 'string' && data.message ? data.message : '图片生成失败，请稍后重试。',
            providerDetail: typeof data.provider_detail === 'string' ? data.provider_detail : null,
          })
          invalidateWorkspace()
          break
        }
        case 'run.cancelled':
          // 取消：不产生图片资产（后端保证），退出进度展示
          setProgress(null)
          message.info('已停止生成')
          break
        case 'run.completed':
          setActiveRunId(null)
          setProgress(null)
          queryClient.setQueryData<ImageWorkspace>(['image-workspace', sessionId], (old) =>
            old ? { ...old, active_run_id: null } : old,
          )
          invalidateWorkspace()
          break
      }
    },
    [invalidateWorkspace, message, queryClient, sessionId],
  )

  useImageRunStream(runId, {
    onEvent: handleEvent,
    onOpen: () => setProgress(null),
    onNetworkError: () => {
      message.warning('流式连接暂时中断；刷新页面可恢复最终状态。正在尝试重新连接……')
    },
  })

  // ---------- 发送 / 停止 ----------
  const sendMutation = useMutation({
    mutationFn: (payload: {
      content: string
      provider: string
      model: string
      tier: string
      ratio: string
    }) =>
      imageSessionsApi.sendImagePrompt(
        sessionId!,
        payload.content,
        payload.provider,
        payload.model,
        payload.tier,
        payload.ratio,
      ),
    onSuccess: (run) => {
      setActiveRunId(run.run_id)
      setProgress(0)
      setFailure(null)
      setInputValue('')
      saveSessionParams(sessionId!, { tier: params.tier, ratio: params.ratio })
      invalidateWorkspace()
    },
    onError: (error: ApiError) => {
      message.error(
        error.code === 'IMAGE_RUN_ACTIVE' ? '当前有生成任务正在运行。' : error.message,
      )
    },
  })

  const handleSend = useCallback(() => {
    const content = inputValue.trim()
    if (!content || running || !sessionId || !effectiveProvider) return
    sendMutation.mutate({
      content,
      provider: effectiveProvider.provider,
      model: effectiveProvider.model,
      tier: params.tier,
      ratio: params.ratio,
    })
  }, [effectiveProvider, inputValue, params, running, sendMutation, sessionId])

  const handleCancel = useCallback(() => {
    if (!runId) return
    imageSessionsApi.cancelImageRun(runId).catch((error: ApiError) => {
      message.error(error.message)
    })
  }, [runId, message])

  // ---------- 当前图片与保存素材 ----------
  const imageMessages = useMemo(() => messages.filter((item) => item.image_url), [messages])
  const selectedImage =
    messages.find((item) => item.id === selectedImageId && item.image_url) ??
    imageMessages[imageMessages.length - 1] ??
    null

  const [saveModalOpen, setSaveModalOpen] = useState(false)
  const [saveTitle, setSaveTitle] = useState('')
  const [savedMessageIds, setSavedMessageIds] = useState<ReadonlySet<string>>(new Set())

  const saveMutation = useMutation({
    mutationFn: () => assetsApi.saveAsset(sessionId!, selectedImage!.id, saveTitle),
    onSuccess: () => {
      message.success('已保存到素材库')
      setSavedMessageIds((prev) => new Set(prev).add(selectedImage!.id))
      setSaveModalOpen(false)
      queryClient.invalidateQueries({ queryKey: ['assets'] })
    },
    onError: (error: ApiError) => {
      message.error(error.message)
    },
  })

  const openSaveModal = useCallback(() => {
    if (!selectedImage?.image_url) return
    setSaveTitle(session?.title || '未命名素材')
    setSaveModalOpen(true)
  }, [selectedImage, session?.title])

  // ---------- 错误路径 ----------
  const loadError = (workspaceQuery.error as ApiError | null) ?? null
  const notFound = loadError?.status === 404

  if (notFound) {
    return (
      <div className="workspace-error">
        <h2>配图会话不存在</h2>
        <p>配图会话不存在，请返回素材列表。</p>
        <Link to="/assets">
          <Button type="primary">返回素材列表</Button>
        </Link>
      </div>
    )
  }

  const alreadySaved = selectedImage ? savedMessageIds.has(selectedImage.id) : false

  const modeSegmented = (
    <Segmented
      aria-label="工作模式"
      value={mode}
      options={[
        { label: '计划', value: 'plan' },
        { label: '行动', value: 'action' },
      ]}
      onChange={(value) => handleModeChange(value as ImageWorkspaceMode)}
      disabled={modeDisabled}
    />
  )

  return (
    <div className="image-workspace" aria-busy={workspaceQuery.isPending}>
      <div className="workspace-topbar">
        <div className="workspace-identity">
          <span className="workspace-eyebrow">IMAGE GENERATION</span>
          <h1 className="workspace-title">
            {session?.title || (workspaceQuery.isPending ? '载入中……' : '未命名配图')}
          </h1>
        </div>
        <span className="status-pill" data-running={String(statusRunning)} aria-live="polite">
          {running ? '正在生成' : statusRunning ? '正在编排' : '准备就绪'}
        </span>
      </div>

      {loadError && (
        <div className="workspace-banner-row">
          <StatusBanner kind="error" message={loadError.message} />
          <Button onClick={() => workspaceQuery.refetch()} loading={workspaceQuery.isFetching}>
            重试
          </Button>
        </div>
      )}

      <div className="workspace-grid workspace-grid-image">
        {mode === 'plan' ? (
          <>
            <section className="workspace-panel" aria-label="计划配置">
              <div className="workspace-panel-heading">
                <h2 className="workspace-panel-title">计划配置</h2>
              </div>
              {workspaceQuery.isPending ? (
                <div className="workspace-panel-body workspace-loading">
                  <Spin />
                </div>
              ) : (
                <div className="workspace-panel-body image-plan-form-body">
                  <ImagePlanForm
                    sessionArticleId={session?.article_id ?? null}
                    latestPlan={latestPlanQuery.data ?? null}
                    latestPlanLoaded={latestPlanQuery.isSuccess || latestPlanQuery.isError}
                    pending={planMutation.isPending}
                    onGenerate={(payload) => planMutation.mutate(payload)}
                  />
                </div>
              )}
              <div className="composer">
                <div className="composer-actions">
                  {modeSegmented}
                  <span className="image-plan-mode-hint">计划：编排文章配图与提示词</span>
                </div>
              </div>
            </section>
            <section className="workspace-panel" aria-label="配图方案">
              <div className="workspace-panel-heading">
                <h2 className="workspace-panel-title">配图方案</h2>
              </div>
              <div className="workspace-panel-body image-plan-results-body">
                <ImagePlanResults
                  data={planData}
                  pending={planMutation.isPending}
                  error={(planMutation.error as ApiError | null) ?? null}
                  onRetry={() => {
                    if (planMutation.variables) planMutation.mutate(planMutation.variables)
                  }}
                />
              </div>
            </section>
          </>
        ) : (
          <>
            <section className="workspace-panel" aria-label="会话对话">
              <div className="workspace-panel-heading">
                <h2 className="workspace-panel-title">历史对话</h2>
              </div>
              {workspaceQuery.isPending ? (
                <div className="workspace-panel-body workspace-loading">
                  <Spin />
                </div>
              ) : (
                <ImageMessageList
                  messages={messages}
                  failure={failure}
                  selectedImageId={selectedImage?.id ?? null}
                  onSelectImage={(item) => setSelectedImageId(item.id)}
                />
              )}
              <div className="composer">
                <Input.TextArea
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                  disabled={workspaceQuery.isPending}
                  rows={4}
                  maxLength={100_000}
                  placeholder="描述你想要的画面，例如：一张清晨咖啡馆的插画，暖色调……"
                />
                <div className="composer-actions">
                  {modeSegmented}
                  <ImageParamsPopover
                    provider={effectiveProvider?.provider ?? 'aliyun_wanxiang'}
                    tier={params.tier}
                    ratio={params.ratio}
                    disabled={workspaceQuery.isPending || running}
                    onChange={(next) => setRawParams(next)}
                  />
                  <Select
                    className="provider-select"
                    aria-label="选择生图模型"
                    value={effectiveProvider ? `${effectiveProvider.provider}|${effectiveProvider.model}` : undefined}
                    options={providers.map((item) => ({
                      value: `${item.provider}|${item.model}`,
                      label: `${providerLabel(item.provider)} · ${item.model}`,
                    }))}
                    disabled={workspaceQuery.isPending || running || providers.length === 0}
                    onChange={(value: string) => setProviderKey(value)}
                    style={{ minWidth: 200 }}
                    notFoundContent="未配置可用的生图模型"
                  />
                  <div className="composer-spacer" />
                  {running && (
                    <Button danger onClick={handleCancel}>
                      停止
                    </Button>
                  )}
                  <Button
                    type="primary"
                    loading={sendMutation.isPending}
                    disabled={running || !inputValue.trim() || !effectiveProvider}
                    onClick={handleSend}
                  >
                    发送
                  </Button>
                </div>
              </div>
            </section>

            <section className="workspace-panel" aria-label="当前图片">
              <div className="workspace-panel-heading">
                <h2 className="workspace-panel-title">当前图片</h2>
                {selectedImage?.image_url && !running && (
                  <Button
                    size="small"
                    disabled={alreadySaved}
                    onClick={openSaveModal}
                    loading={saveMutation.isPending}
                  >
                    {alreadySaved ? '已保存' : '保存素材'}
                  </Button>
                )}
              </div>
              <div className="workspace-panel-body image-preview-body">
                {running && (
                  <div className="image-progress">
                    <span className="image-progress-label">生成中……</span>
                    <Progress percent={progress ?? 0} status="active" />
                  </div>
                )}
                {selectedImage?.image_url ? (
                  <figure className="image-preview">
                    <img src={resolveImageUrl(selectedImage.image_url)} alt="当前图片" />
                    <figcaption>生成于 {formatDate(selectedImage.created_at)}</figcaption>
                  </figure>
                ) : (
                  !running && (
                    <div className="article-empty">
                      <h3>图片会在这里出现</h3>
                      <p>输入画面描述并发送，生成完成后可保存到素材库。</p>
                    </div>
                  )
                )}
              </div>
            </section>
          </>
        )}
      </div>

      <Modal
        title="保存到素材库"
        open={saveModalOpen}
        onCancel={() => setSaveModalOpen(false)}
        onOk={() => saveMutation.mutate()}
        okText="保存"
        cancelText="取消"
        confirmLoading={saveMutation.isPending}
        destroyOnHidden
      >
        <Input
          value={saveTitle}
          onChange={(event) => setSaveTitle(event.target.value)}
          maxLength={200}
          placeholder="素材标题"
          onPressEnter={() => saveMutation.mutate()}
        />
      </Modal>
    </div>
  )
}
