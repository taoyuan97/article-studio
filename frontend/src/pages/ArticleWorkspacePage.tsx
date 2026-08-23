import { useCallback, useEffect, useReducer, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { App, Button, Input, Spin } from 'antd'
import { articlesApi } from '../api/articles'
import type { ApiError } from '../api/client'
import type { ArticleWorkspace } from '../api/types'
import MarkdownView from '../components/MarkdownView'
import MessageList from '../components/MessageList'
import ModelSelect from '../components/ModelSelect'
import StatusBanner from '../components/StatusBanner'
import VersionPanel from '../components/VersionPanel'
import { useArticleRunStream } from '../hooks/useArticleRunStream'
import type { ArticleRunEventType, RunEventData } from '../lib/sse'

/** 运行态（组件局部，见 T003 状态与数据流设计） */
interface RunState {
  activeRunId: string | null
  temporaryAssistant: string
  temporaryArticle: string
}

type RunAction =
  | { type: 'start'; runId: string }
  | { type: 'assistantDelta'; text: string }
  | { type: 'articleDelta'; text: string }
  | { type: 'clearTemporaryAssistant' }
  | { type: 'clearTemporaryArticle' }
  | { type: 'discardTemporary' }
  | { type: 'resetStream' }
  | { type: 'end' }

const initialRunState: RunState = {
  activeRunId: null,
  temporaryAssistant: '',
  temporaryArticle: '',
}

function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'start':
      return { activeRunId: action.runId, temporaryAssistant: '', temporaryArticle: '' }
    case 'assistantDelta':
      return { ...state, temporaryAssistant: state.temporaryAssistant + action.text }
    case 'articleDelta':
      return { ...state, temporaryArticle: state.temporaryArticle + action.text }
    case 'clearTemporaryAssistant':
      return { ...state, temporaryAssistant: '' }
    case 'clearTemporaryArticle':
      return { ...state, temporaryArticle: '' }
    case 'discardTemporary':
      return { ...state, temporaryAssistant: '', temporaryArticle: '' }
    case 'resetStream':
      // 断线重连：清空临时内容，由服务端事件重放重建
      return { ...state, temporaryAssistant: '', temporaryArticle: '' }
    case 'end':
      return { activeRunId: null, temporaryAssistant: '', temporaryArticle: '' }
  }
}

/**
 * 文章工作台（专注模式双栏）：
 * - 左：历史对话（消息流 + 输入区 + 模型切换 + 运行控制）；
 * - 右：当前正文（标题 + Markdown + 版本面板）；
 * - workspace 聚合一次加载全部初始数据，SSE 事件驱动临时内容与查询失效；
 * - 重新进入时 active_run_id 存在则自动连接事件流并展示运行中。
 */
export default function ArticleWorkspacePage() {
  const { articleId } = useParams<{ articleId: string }>()
  const queryClient = useQueryClient()
  const { message } = App.useApp()

  const workspaceQuery = useQuery({
    queryKey: ['workspace', articleId],
    queryFn: () => articlesApi.getWorkspace(articleId!),
    enabled: Boolean(articleId),
    retry: false,
  })

  const [runState, dispatch] = useReducer(runReducer, initialRunState)
  const [inputValue, setInputValue] = useState('')
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)

  const workspace = workspaceQuery.data
  const article = workspace?.article ?? null
  const currentVersion = workspace?.current_version ?? null

  // 重新进入时自动恢复运行中的事件流
  const activeRunId = runState.activeRunId ?? workspace?.active_run_id ?? null
  const running = Boolean(activeRunId)

  const invalidateWorkspace = useCallback(() => {
    if (!articleId) return
    queryClient.invalidateQueries({ queryKey: ['workspace', articleId] })
    queryClient.invalidateQueries({ queryKey: ['articles'] })
  }, [articleId, queryClient])

  const handleEvent = useCallback(
    (type: ArticleRunEventType, data: RunEventData) => {
      switch (type) {
        case 'run.started':
          if (typeof data.run_id === 'string') dispatch({ type: 'start', runId: data.run_id })
          break
        case 'assistant.delta':
          dispatch({ type: 'assistantDelta', text: String(data.delta ?? '') })
          break
        case 'article.delta':
          dispatch({ type: 'articleDelta', text: String(data.delta ?? '') })
          break
        case 'message.completed':
          // 临时消息转正式：清空临时气泡并失效查询
          dispatch({ type: 'clearTemporaryAssistant' })
          invalidateWorkspace()
          break
        case 'article.completed':
          // 版本事务已提交：清空临时预览，替换正文并刷新版本列表
          dispatch({ type: 'clearTemporaryArticle' })
          invalidateWorkspace()
          break
        case 'run.cancelled':
          // 取消：丢弃全部临时内容，正文与版本列表不变（用户指令已持久化）
          dispatch({ type: 'discardTemporary' })
          message.info('已停止生成')
          break
        case 'run.failed':
          // 失败：丢弃临时内容，失败卡片由持久化消息渲染（含脱敏详情与重试）
          dispatch({ type: 'discardTemporary' })
          invalidateWorkspace()
          message.error(
            typeof data.message === 'string' && data.message ? data.message : '生成失败，请稍后重试。',
          )
          break
        case 'run.completed':
          dispatch({ type: 'end' })
          // 立即清除缓存中的 active_run_id，避免失效重取窗口内重复重连已结束的运行
          queryClient.setQueryData<ArticleWorkspace>(['workspace', articleId], (old) =>
            old ? { ...old, active_run_id: null } : old,
          )
          invalidateWorkspace()
          break
      }
    },
    [articleId, invalidateWorkspace, message, queryClient],
  )

  useArticleRunStream(activeRunId, {
    onEvent: handleEvent,
    onOpen: () => dispatch({ type: 'resetStream' }),
    onNetworkError: () => {
      message.warning('流式连接暂时中断；刷新页面可恢复最终状态。正在尝试重新连接……')
    },
  })

  // 发送 / 重试 / 取消 / 切换模型
  const sendMutation = useMutation({
    mutationFn: (content: string) => articlesApi.sendMessage(articleId!, content),
    onSuccess: (run) => {
      dispatch({ type: 'start', runId: run.run_id })
      setInputValue('')
      invalidateWorkspace()
    },
    onError: (error: ApiError) => {
      message.error(
        error.code === 'ARTICLE_RUN_ACTIVE' ? '这篇文章已有运行，请等待或先停止。' : error.message,
      )
    },
  })

  const retryMutation = useMutation({
    mutationFn: (messageId: string) => articlesApi.retryMessage(articleId!, messageId),
    onSuccess: (run) => {
      dispatch({ type: 'start', runId: run.run_id })
      invalidateWorkspace()
    },
    onError: (error: ApiError) => {
      message.error(error.message)
    },
  })

  const updateModelMutation = useMutation({
    mutationFn: (payload: { provider: string; model: string }) =>
      articlesApi.updateModel(articleId!, payload.provider, payload.model),
    onSuccess: () => {
      invalidateWorkspace()
    },
    onError: (error: ApiError) => {
      message.error(error.message)
      invalidateWorkspace()
    },
  })

  const handleSend = useCallback(() => {
    const content = inputValue.trim()
    if (!content || running || !articleId) return
    sendMutation.mutate(content)
  }, [articleId, inputValue, running, sendMutation])

  const handleCancel = useCallback(() => {
    if (!activeRunId) return
    // 乐观丢弃临时内容，随后 run.cancelled/run.completed 事件收尾
    dispatch({ type: 'discardTemporary' })
    articlesApi.cancelRun(activeRunId).catch((error: ApiError) => {
      message.error(error.message)
    })
  }, [activeRunId, message])

  // 版本查看：null = 当前版本
  const viewingHistorical = Boolean(
    selectedVersionId && selectedVersionId !== currentVersion?.id,
  )
  const versionDetailQuery = useQuery({
    queryKey: ['version', articleId, selectedVersionId],
    queryFn: () => articlesApi.getVersion(articleId!, selectedVersionId!),
    enabled: viewingHistorical,
    retry: false,
  })
  const selectedVersion = viewingHistorical ? versionDetailQuery.data ?? null : null

  // 新版本产生（当前版本变化）时回到当前版本，与 MVP 行为一致
  useEffect(() => {
    setSelectedVersionId(null)
  }, [currentVersion?.id])

  const displayedVersion = selectedVersion ?? currentVersion
  const articleMarkdown =
    selectedVersion?.content_markdown || runState.temporaryArticle || currentVersion?.content_markdown || ''
  const streaming = Boolean(runState.temporaryArticle && !selectedVersion)

  const loadError = (workspaceQuery.error as ApiError | null) ?? null
  const notFound = loadError?.status === 404

  if (notFound) {
    return (
      <div className="workspace-error">
        <h2>文章不存在</h2>
        <p>文章不存在，请返回文章列表。</p>
        <Link to="/articles">
          <Button type="primary">返回文章列表</Button>
        </Link>
      </div>
    )
  }

  const headingText = selectedVersion
    ? `历史版本：v${selectedVersion.version_number} · ${selectedVersion.title}`
    : displayedVersion
      ? `当前：v${displayedVersion.version_number} · ${displayedVersion.title}`
      : '当前文章'

  return (
    <div className="article-workspace" aria-busy={workspaceQuery.isPending}>
      <div className="workspace-topbar">
        <div className="workspace-identity">
          <span className="workspace-eyebrow">CURRENT ARTICLE</span>
          <h1 className="workspace-title">
            {article?.title || (workspaceQuery.isPending ? '载入中……' : '文章')}
          </h1>
        </div>
        <span className="status-pill" data-running={String(running)} aria-live="polite">
          {running ? '正在生成' : '准备就绪'}
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

      <div className="workspace-grid">
        <section className="workspace-panel" aria-label="历史对话">
          <div className="workspace-panel-heading">
            <h2 className="workspace-panel-title">历史对话</h2>
          </div>
          {workspaceQuery.isPending ? (
            <div className="workspace-panel-body workspace-loading">
              <Spin />
            </div>
          ) : (
            <MessageList
              messages={workspace?.messages ?? []}
              temporaryAssistant={runState.temporaryAssistant}
              onRetry={(userMessageId) => retryMutation.mutate(userMessageId)}
            />
          )}
          <div className="composer">
            <Input.TextArea
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              disabled={workspaceQuery.isPending}
              rows={4}
              maxLength={100_000}
              placeholder="例如：直接写一篇面向职场新人的文章，主题是如何保持专注……"
            />
            <div className="composer-actions">
              <ModelSelect
                available={workspace?.available_models ?? []}
                unavailable={workspace?.unavailable_models ?? []}
                value={article ? { provider: article.provider, model: article.model } : null}
                disabled={workspaceQuery.isPending || running || updateModelMutation.isPending}
                onChange={(provider, model) => updateModelMutation.mutate({ provider, model })}
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
                disabled={running || !inputValue.trim()}
                onClick={handleSend}
              >
                发送
              </Button>
            </div>
          </div>
        </section>

        <section className="workspace-panel" aria-label="当前正文">
          <div className="workspace-panel-heading article-heading-row">
            <div className="article-heading-main">
              <span className="workspace-eyebrow">MANUSCRIPT</span>
              <h2 className="workspace-panel-title">{headingText}</h2>
            </div>
            <VersionPanel
              versions={workspace?.versions ?? []}
              currentVersion={currentVersion}
              selectedVersion={selectedVersion}
              onSelect={(versionId) =>
                setSelectedVersionId(versionId === currentVersion?.id ? null : versionId)
              }
              onReturnCurrent={() => setSelectedVersionId(null)}
              loading={versionDetailQuery.isFetching}
            />
          </div>
          <div className="workspace-panel-body">
            {streaming && <div className="streaming-hint">生成中……</div>}
            {versionDetailQuery.isFetching && viewingHistorical ? (
              <div className="workspace-loading">
                <Spin />
              </div>
            ) : articleMarkdown ? (
              <MarkdownView
                content={articleMarkdown}
                className={streaming ? 'streaming-content' : undefined}
              />
            ) : (
              <div className="article-empty">
                <h3>正文会在这里出现</h3>
                <p>描述主题与读者，或直接说“直接写”，智能体会生成完整 Markdown 正文。</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
