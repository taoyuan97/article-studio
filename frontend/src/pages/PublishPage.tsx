import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { Alert, App, Button, Input, Select, Space, Spin, Steps, Typography } from 'antd'
import { articlesApi } from '../api/articles'
import { assetsApi } from '../api/assets'
import { imageSessionsApi } from '../api/imageSessions'
import { publishApi } from '../api/publish'
import type { ApiError } from '../api/client'
import type { ImagePlacement, PublishBlock, PublishTheme } from '../api/types'
import StatusBanner from '../components/StatusBanner'
import CoverPickerModal from '../features/publish/CoverPickerModal'
import ImagePlacementEditor from '../features/publish/ImagePlacementEditor'
import ThemePreviewPanel from '../features/publish/ThemePreviewPanel'
import { publishErrorText } from '../features/publish/errorText'
import { sanitizePlacements } from '../features/publish/placements'
import { resolveImageUrl } from '../lib/format'

const STEP_ITEMS = [
  { title: '版本和信息' },
  { title: '配图与位置' },
  { title: '选主题' },
]

type PublishPhase =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'succeeded'; mediaId: string }
  | { status: 'failed'; errorCode: string | null; errorMessage: string }

/**
 * 发布向导（专注模式，三步流）：
 * 版本和信息（文章/版本/封面/作者）→ 配图与位置（正文画布锚点插图）→ 选主题（主题预览 + 编辑 + 发布）。
 * 主题预览与发布使用同一渲染引擎（wenyan core），所见即所发；向导状态本地维护，步骤可回退且选择保持。
 */
export default function PublishPage() {
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { modal } = App.useApp()

  // ---------- 向导状态 ----------
  const [step, setStep] = useState(0)
  const [articleId, setArticleId] = useState<string | null>(searchParams.get('article_id'))
  const [versionId, setVersionId] = useState<string | null>(null) // null = 当前版本
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([])
  const [placements, setPlacements] = useState<ImagePlacement[]>([])
  const [coverAssetId, setCoverAssetId] = useState<string | null>(null)
  const [coverPickerOpen, setCoverPickerOpen] = useState(false)
  const [author, setAuthor] = useState('')
  const [themeId, setThemeId] = useState<string | null>(null)
  const [blocks, setBlocks] = useState<PublishBlock[]>([])
  const [blocksError, setBlocksError] = useState<string | null>(null)
  const [degradedCount, setDegradedCount] = useState(0)
  const [previewMarkdown, setPreviewMarkdown] = useState('')
  const [previewPending, setPreviewPending] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [markdownDirty, setMarkdownDirty] = useState(false)
  const [editing, setEditing] = useState(false)
  const [publishPhase, setPublishPhase] = useState<PublishPhase>({ status: 'idle' })

  // ---------- 数据加载 ----------
  const articlesQuery = useQuery({
    queryKey: ['articles'],
    queryFn: () => articlesApi.listArticles(),
  })
  const workspaceQuery = useQuery({
    queryKey: ['workspace', articleId],
    queryFn: () => articlesApi.getWorkspace(articleId!),
    enabled: Boolean(articleId),
    retry: false,
  })
  const themesQuery = useQuery({ queryKey: ['publish-themes'], queryFn: publishApi.fetchPublishThemes })
  const assetsQuery = useQuery({
    queryKey: ['assets'],
    queryFn: () => assetsApi.listAssets('image', 100),
  })
  const sessionsQuery = useQuery({
    queryKey: ['image-sessions'],
    queryFn: () => imageSessionsApi.listImageSessions(100),
  })

  const versions = workspaceQuery.data?.versions ?? []
  const currentVersionId = workspaceQuery.data?.article.current_version_id ?? null
  const resolvedVersionId = versionId ?? currentVersionId

  /** 本文配图：当前文章关联配图会话下已保存的图片素材 */
  const articleAssets = useMemo(() => {
    if (!articleId) return []
    const sessionIds = new Set(
      (sessionsQuery.data?.items ?? [])
        .filter((session) => session.article_id === articleId)
        .map((session) => session.id),
    )
    return (assetsQuery.data?.items ?? []).filter(
      (asset) => asset.source_session_id && sessionIds.has(asset.source_session_id),
    )
  }, [articleId, sessionsQuery.data, assetsQuery.data])

  /** 素材库图片：其余全部图片素材（独立配图会话等，不关联当前文章） */
  const libraryAssets = useMemo(() => {
    const articleAssetIds = new Set(articleAssets.map((asset) => asset.id))
    return (assetsQuery.data?.items ?? []).filter((asset) => !articleAssetIds.has(asset.id))
  }, [articleAssets, assetsQuery.data])

  /** 当前选中的封面素材（可来自任一分组；素材已删除时视为未选） */
  const coverAsset = useMemo(() => {
    if (!coverAssetId) return null
    return (
      [...articleAssets, ...libraryAssets].find((asset) => asset.id === coverAssetId) ?? null
    )
  }, [articleAssets, libraryAssets, coverAssetId])

  // 切换文章：清空图片选择与画布（本文配图语境变化）
  useEffect(() => {
    setSelectedAssetIds([])
    setPlacements([])
    setBlocks([])
    setBlocksError(null)
    setDegradedCount(0)
  }, [articleId])

  // 封面仅在切换文章时重置（本文配图语境变化；封面与版本内容无关）
  useEffect(() => {
    setCoverAssetId(null)
  }, [articleId])

  // 拉取正文块（空 placements 的 preview，仅取 blocks；切版本保留已插图，见下方 sanitize）
  useEffect(() => {
    if (!articleId) return
    let cancelled = false
    setBlocksError(null)
    publishApi
      .publishPreview(articleId, { version_id: resolvedVersionId, image_placements: [] })
      .then((result) => {
        if (!cancelled) setBlocks(result.blocks)
      })
      .catch((error: ApiError) => {
        if (!cancelled) setBlocksError(error.message)
      })
    return () => {
      cancelled = true
    }
  }, [articleId, resolvedVersionId])

  // 块变化（版本切换）后评估已插图位置：失效锚点退到文末并提示（决策 ⑥）
  useEffect(() => {
    if (blocks.length === 0) return
    const { placements: next, degradedCount: count } = sanitizePlacements(placements, blocks)
    setPlacements(next)
    setDegradedCount(count)
    // placements 不入依赖：仅在块变化时评估，避免插图触发循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks])

  const assemblyInput = useMemo(
    () => ({
      version_id: resolvedVersionId,
      image_placements: placements,
      cover_asset_id: coverAssetId,
      author: author.trim() || null,
    }),
    [resolvedVersionId, placements, coverAssetId, author],
  )

  // 进入选主题步或组装输入变化：重新组装源 Markdown（编辑模式与终稿同步失效），发布状态复位
  const [assemblyNonce, setAssemblyNonce] = useState(0)
  useEffect(() => {
    if (step !== 2 || !articleId) return
    let cancelled = false
    setPublishPhase({ status: 'idle' })
    setEditing(false)
    setMarkdownDirty(false)
    setPreviewPending(true)
    setPreviewError(null)
    publishApi
      .publishPreview(articleId, assemblyInput)
      .then((result) => {
        if (!cancelled) setPreviewMarkdown(result.markdown)
      })
      .catch((error: ApiError) => {
        if (!cancelled) setPreviewError(error.message)
      })
      .finally(() => {
        if (!cancelled) setPreviewPending(false)
      })
    return () => {
      cancelled = true
    }
  }, [step, articleId, assemblyInput, assemblyNonce])

  // 主题渲染查询：选中主题即渲染；编辑终稿以 markdown 覆盖（所见即所发）；
  // 组装输入/主题/终稿任一变化自动重新渲染，React Query 按 key 缓存复用
  const markdownOverride = !editing && markdownDirty ? previewMarkdown : null
  const renderQuery = useQuery({
    queryKey: [
      'publish-render-preview',
      articleId,
      resolvedVersionId,
      placements,
      coverAssetId,
      author,
      themeId,
      markdownOverride,
    ],
    queryFn: () =>
      publishApi.renderPreview(articleId!, {
        version_id: resolvedVersionId,
        image_placements: placements,
        cover_asset_id: coverAssetId,
        author: author.trim() || null,
        theme_id: themeId!,
        markdown: markdownOverride,
      }),
    enabled: step === 2 && Boolean(articleId && themeId) && !editing && !previewPending,
    retry: false,
    placeholderData: (previous) => previous,
  })

  const renderError = (renderQuery.error as ApiError | null)?.message ?? null
  const rendering =
    themeId !== null && (previewPending || (renderQuery.isFetching && !renderQuery.data))

  // ---------- 交互 ----------
  const handleInsertAssets = useCallback((anchorBlockIndex: number, assetIds: string[]) => {
    const anchor = `after_block_${anchorBlockIndex}`
    setPlacements((prev) => {
      // 同锚点内 order 接续现有最大值，多图按勾选顺序连续编号
      const startOrder = prev
        .filter((item) => item.position === anchor)
        .reduce((max, item) => Math.max(max, item.order), -1) + 1
      const additions = assetIds.map((assetId, i) => ({
        asset_id: assetId,
        position: anchor,
        order: startOrder + i,
      }))
      return [...prev, ...additions]
    })
    setSelectedAssetIds((prev) => [...prev, ...assetIds])
  }, [])

  const handleRemoveAsset = useCallback((assetId: string) => {
    setSelectedAssetIds((prev) => prev.filter((id) => id !== assetId))
    setPlacements((prev) => prev.filter((item) => item.asset_id !== assetId))
  }, [])

  const executePublish = useCallback(async () => {
    if (!articleId || !themeId) return
    setPublishPhase({ status: 'loading' })
    try {
      const result = await publishApi.publishArticle(articleId, {
        ...assemblyInput,
        theme_id: themeId,
        edited_markdown: markdownDirty ? previewMarkdown : null,
      })
      setPublishPhase({ status: 'succeeded', mediaId: result.media_id })
      queryClient.invalidateQueries({ queryKey: ['publish-records'] })
    } catch (error) {
      const apiError = error as ApiError
      setPublishPhase({
        status: 'failed',
        errorCode: apiError.code ?? null,
        errorMessage: apiError.message,
      })
    }
  }, [articleId, themeId, assemblyInput, markdownDirty, previewMarkdown, queryClient])

  const confirmPublish = useCallback(() => {
    modal.confirm({
      title: '发布到公众号草稿箱？',
      content: '将以当前主题排版并推送到公众号草稿箱（仅创建草稿，不会群发）。',
      okText: '确认发布',
      cancelText: '再想想',
      onOk: executePublish,
    })
  }, [modal, executePublish])

  const canLeaveStep =
    step === 0 ? Boolean(articleId && resolvedVersionId) : true
  const publishing = publishPhase.status === 'loading'
  const themes = themesQuery.data?.items ?? []

  return (
    <div className="publish-page">
      <div className="workspace-topbar">
        <div className="workspace-identity">
          <span className="workspace-eyebrow">PUBLISH</span>
          <h1 className="workspace-title">发布到公众号</h1>
        </div>
        <Space className="publish-topbar-actions">
          {step > 0 && (
            <Button onClick={() => setStep(step - 1)} disabled={publishing}>
              上一步
            </Button>
          )}
          {step < 2 && (
            <Button
              type="primary"
              disabled={!canLeaveStep}
              onClick={() => setStep(step + 1)}
            >
              下一步
            </Button>
          )}
          {step === 2 && publishPhase.status !== 'succeeded' && (
            <Button
              type="primary"
              loading={publishing}
              disabled={
                !themeId ||
                editing ||
                previewPending ||
                Boolean(previewError ?? renderError)
              }
              onClick={confirmPublish}
            >
              发布到公众号草稿箱
            </Button>
          )}
          {step === 2 && publishPhase.status === 'failed' && (
            <Button onClick={executePublish} disabled={publishing}>
              重试发布
            </Button>
          )}
        </Space>
      </div>

      <Steps
        className="publish-steps"
        current={step}
        items={STEP_ITEMS}
        onChange={(next) => {
          // 点击步骤条仅允许回退（前进须走「下一步」以校验必选项）
          if (next < step && !publishing) setStep(next)
        }}
      />

      <div className="publish-step-body">
        {step === 0 && (
          <section className="publish-step" aria-label="版本和信息">
            <div className="publish-form-row">
              <label htmlFor="publish-article">文章</label>
              <Select
                id="publish-article"
                placeholder="选择要发布的文章"
                showSearch
                optionFilterProp="label"
                loading={articlesQuery.isPending}
                value={articleId ?? undefined}
                onChange={(value) => {
                  setArticleId(value)
                  setVersionId(null)
                }}
                options={(articlesQuery.data?.items ?? []).map((item) => ({
                  value: item.id,
                  label: item.title,
                }))}
                className="publish-form-select"
              />
            </div>
            <div className="publish-form-row">
              <label htmlFor="publish-version">版本</label>
              <Select
                id="publish-version"
                placeholder={versions.length === 0 ? '暂无版本' : '默认当前版本'}
                disabled={!articleId || versions.length === 0}
                value={resolvedVersionId ?? undefined}
                onChange={(value) => setVersionId(value)}
                options={versions.map((version) => ({
                  value: version.id,
                  label: `v${version.version_number} · ${version.title}`,
                }))}
                className="publish-form-select"
              />
            </div>
            <div className="publish-form-row publish-cover-row">
              <span className="publish-form-label">封面</span>
              <div className="publish-cover-field">
                {coverAsset ? (
                  <div className="publish-cover-selected">
                    <img src={resolveImageUrl(coverAsset.storage_url)} alt={coverAsset.title} />
                    <span className="publish-cover-selected-title">{coverAsset.title}</span>
                    <Button size="small" onClick={() => setCoverPickerOpen(true)}>
                      更换
                    </Button>
                    <Button size="small" danger onClick={() => setCoverAssetId(null)}>
                      清除
                    </Button>
                  </div>
                ) : (
                  <Button onClick={() => setCoverPickerOpen(true)}>选择封面</Button>
                )}
                <Typography.Text type="secondary" className="publish-cover-field-hint">
                  不选封面时，发布将自动使用正文第一张图；微信要求封面或正文至少一张图。
                </Typography.Text>
              </div>
            </div>
            <div className="publish-form-row">
              <label htmlFor="publish-author">作者</label>
              <Input
                id="publish-author"
                value={author}
                onChange={(event) => setAuthor(event.target.value)}
                placeholder="选填，展示在公众号文章作者栏"
                maxLength={50}
              />
            </div>
            {articleId && workspaceQuery.error && (
              <StatusBanner
                kind="error"
                message={(workspaceQuery.error as ApiError).message}
              />
            )}
            {articleId && !workspaceQuery.isPending && versions.length === 0 && (
              <Alert
                type="warning"
                showIcon
                message="该文章还没有生成内容版本，请先在文章工作台生成后再发布。"
              />
            )}
            {blocksError && <StatusBanner kind="error" message={blocksError} />}
          </section>
        )}

        {step === 1 && (
          <ImagePlacementEditor
            articleAssets={articleAssets}
            libraryAssets={libraryAssets}
            selectedAssetIds={selectedAssetIds}
            placements={placements}
            blocks={blocks}
            degradedCount={degradedCount}
            onDismissDegraded={() => setDegradedCount(0)}
            onInsertAssets={handleInsertAssets}
            onRemoveAsset={handleRemoveAsset}
          />
        )}

        {step === 2 && (
          <section className="publish-step publish-theme-step" aria-label="选主题">
            {themesQuery.isPending ? (
              <div className="workspace-loading">
                <Spin />
              </div>
            ) : themesQuery.error ? (
              <StatusBanner kind="error" message={(themesQuery.error as ApiError).message} />
            ) : (
              <div className="publish-theme-step-body">
                <div className="publish-theme-list" role="radiogroup" aria-label="发布主题">
                  {themes.map((theme: PublishTheme) => {
                    const selected = themeId === theme.id
                    return (
                      <button
                        type="button"
                        key={theme.id}
                        className={`publish-theme-card${selected ? ' is-selected' : ''}`}
                        aria-pressed={selected}
                        onClick={() => setThemeId(selected ? null : theme.id)}
                      >
                        <span className="publish-theme-name">{theme.name}</span>
                        <span className="publish-theme-desc">{theme.description}</span>
                      </button>
                    )
                  })}
                </div>
                <ThemePreviewPanel
                  themeSelected={Boolean(themeId)}
                  html={renderQuery.data?.html}
                  rendering={rendering}
                  error={previewError ?? renderError}
                  onRetry={() => {
                    if (previewError) setAssemblyNonce((nonce) => nonce + 1)
                    else void renderQuery.refetch()
                  }}
                  editing={editing}
                  editedMarkdown={previewMarkdown}
                  onStartEdit={() => setEditing(true)}
                  onFinishEdit={(markdown) => {
                    setPreviewMarkdown(markdown)
                    setMarkdownDirty(true)
                    setEditing(false)
                  }}
                  onCancelEdit={() => setEditing(false)}
                />
              </div>
            )}
            {publishPhase.status === 'succeeded' ? (
              <Alert
                type="success"
                showIcon
                className="publish-result"
                message="已发布到公众号草稿箱"
                description={
                  <div className="publish-success-body">
                    <p>
                      media_id：<code>{publishPhase.mediaId}</code>
                    </p>
                    <p>本系统仅创建草稿、不群发；请前往公众号后台「草稿箱」查看与群发。</p>
                    <Space>
                      <a href="https://mp.weixin.qq.com/" target="_blank" rel="noreferrer">
                        去公众号后台草稿箱查看
                      </a>
                      <Link to="/publish-records">查看发布记录</Link>
                    </Space>
                  </div>
                }
              />
            ) : publishPhase.status === 'failed' ? (
              <Alert
                type="error"
                showIcon
                className="publish-result"
                message="发布失败"
                description={
                  <div className="publish-failure-body">
                    <p>{publishErrorText(publishPhase.errorCode, publishPhase.errorMessage)}</p>
                    {publishPhase.errorCode === 'PUBLISH_MCP_ERROR' &&
                    publishPhase.errorMessage ? (
                      <p className="publish-failure-detail">
                        详情：{publishPhase.errorMessage}
                      </p>
                    ) : null}
                    {publishPhase.errorCode && (
                      <p>
                        错误码：<code>{publishPhase.errorCode}</code>
                      </p>
                    )}
                  </div>
                }
              />
            ) : null}
          </section>
        )}
      </div>

      <CoverPickerModal
        open={coverPickerOpen}
        articleAssets={articleAssets}
        libraryAssets={libraryAssets}
        selectedAssetId={coverAssetId}
        onSelect={(assetId) => {
          setCoverAssetId(assetId)
          setCoverPickerOpen(false)
        }}
        onCancel={() => setCoverPickerOpen(false)}
      />
    </div>
  )
}
