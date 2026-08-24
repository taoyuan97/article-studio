import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { Alert, App, Button, Input, Select, Space, Spin, Steps, Typography } from 'antd'
import { articlesApi } from '../api/articles'
import { assetsApi } from '../api/assets'
import { imageSessionsApi } from '../api/imageSessions'
import { publishApi } from '../api/publish'
import type { ApiError } from '../api/client'
import type { ImagePlacement, PublishSection, PublishTheme } from '../api/types'
import StatusBanner from '../components/StatusBanner'
import CoverPickerModal from '../features/publish/CoverPickerModal'
import ImagePlacementEditor from '../features/publish/ImagePlacementEditor'
import { publishErrorText } from '../features/publish/errorText'
import { resolveImageUrl } from '../lib/format'

const STEP_ITEMS = [
  { title: '版本和信息' },
  { title: '配图与位置' },
  { title: '选主题' },
  { title: '预览与发布' },
]

type PublishPhase =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'succeeded'; mediaId: string }
  | { status: 'failed'; errorCode: string | null; errorMessage: string }

/**
 * 发布向导（专注模式，四步流）：
 * 选文章/版本 → 配图与插入位置（含封面/作者）→ 选主题 → 预览编辑并发布到公众号草稿箱。
 * 向导状态本地维护，步骤可回退且选择保持；发布成功后引导查看发布记录。
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
  const [sections, setSections] = useState<PublishSection[]>([])
  const [sectionsError, setSectionsError] = useState<string | null>(null)
  const [previewMarkdown, setPreviewMarkdown] = useState('')
  const [previewPending, setPreviewPending] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [markdownDirty, setMarkdownDirty] = useState(false)
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

  // 主题默认选中 default（仅首次数据到达时设置，用户手动取消后不再覆盖）
  const themeInitialized = useRef(false)
  useEffect(() => {
    const themes = themesQuery.data?.items ?? []
    if (!themeInitialized.current && themes.length > 0) {
      themeInitialized.current = true
      setThemeId(themes.find((theme) => theme.id === 'default')?.id ?? themes[0].id)
    }
  }, [themesQuery.data])

  // 文章/版本变化：清空图片选择与小节（小节数可能变化，旧位置会失效）
  useEffect(() => {
    setSelectedAssetIds([])
    setPlacements([])
    setSections([])
    setSectionsError(null)
  }, [articleId, resolvedVersionId])

  // 封面仅在切换文章时重置（本文配图语境变化；封面与版本内容无关）
  useEffect(() => {
    setCoverAssetId(null)
  }, [articleId])

  // 拉取正文小节（空 placements 的 preview，仅取 sections）
  useEffect(() => {
    if (!articleId) return
    let cancelled = false
    setSectionsError(null)
    publishApi
      .publishPreview(articleId, { version_id: resolvedVersionId, image_placements: [] })
      .then((result) => {
        if (!cancelled) setSections(result.sections)
      })
      .catch((error: ApiError) => {
        if (!cancelled) setSectionsError(error.message)
      })
    return () => {
      cancelled = true
    }
  }, [articleId, resolvedVersionId])

  const assemblyInput = useMemo(
    () => ({
      version_id: resolvedVersionId,
      image_placements: placements,
      cover_asset_id: coverAssetId,
      author: author.trim() || null,
    }),
    [resolvedVersionId, placements, coverAssetId, author],
  )

  // 进入预览步：重新组装（覆盖上次编辑），发布状态复位
  useEffect(() => {
    if (step !== 3 || !articleId) return
    let cancelled = false
    setPublishPhase({ status: 'idle' })
    setPreviewPending(true)
    setPreviewError(null)
    publishApi
      .publishPreview(articleId, assemblyInput)
      .then((result) => {
        if (!cancelled) {
          setPreviewMarkdown(result.markdown)
          setMarkdownDirty(false)
        }
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
    // assemblyInput 内容仅在 0-2 步变化，进入第 3 步时组装一次即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, articleId])

  // ---------- 交互 ----------
  const handleToggleAsset = useCallback(
    (assetId: string, checked: boolean) => {
      if (checked) {
        // 默认位置：按勾选顺序继续均分到各小节（round-robin）；封面在步骤 1 独立选择
        const position =
          sections.length > 0
            ? `after_section_${(selectedAssetIds.length % sections.length) + 1}`
            : 'bottom'
        const nextOrder = placements.reduce((max, item) => Math.max(max, item.order), -1) + 1
        setSelectedAssetIds((prev) => [...prev, assetId])
        setPlacements((prev) => [...prev, { asset_id: assetId, position, order: nextOrder }])
      } else {
        setSelectedAssetIds((prev) => prev.filter((id) => id !== assetId))
        setPlacements((prev) => prev.filter((item) => item.asset_id !== assetId))
      }
    },
    [placements, sections, selectedAssetIds.length],
  )

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
            {sectionsError && (
              <StatusBanner kind="error" message={sectionsError} />
            )}
          </section>
        )}

        {step === 1 && (
          <ImagePlacementEditor
            articleAssets={articleAssets}
            libraryAssets={libraryAssets}
            selectedAssetIds={selectedAssetIds}
            placements={placements}
            sections={sections}
            onToggleAsset={handleToggleAsset}
            onPlacementsChange={setPlacements}
          />
        )}

        {step === 2 && (
          <section className="publish-step" aria-label="选主题">
            {themesQuery.isPending ? (
              <div className="workspace-loading">
                <Spin />
              </div>
            ) : themesQuery.error ? (
              <StatusBanner kind="error" message={(themesQuery.error as ApiError).message} />
            ) : (
              <div className="publish-theme-grid" role="radiogroup" aria-label="发布主题">
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
            )}
          </section>
        )}

        {step === 3 && (
          <section className="publish-step publish-preview" aria-label="预览与发布">
            {previewPending ? (
              <div className="workspace-loading">
                <Spin /> <Typography.Text type="secondary">正在组装发布内容……</Typography.Text>
              </div>
            ) : previewError ? (
              <>
                <StatusBanner kind="error" message={previewError} />
                <Button onClick={() => setStep(2)}>返回上一步</Button>
              </>
            ) : (
              <>
                <Typography.Text type="secondary">
                  组装结果如下，可直接编辑 Markdown（发布时以编辑后内容为准）。
                </Typography.Text>
                <Input.TextArea
                  className="publish-markdown-editor"
                  value={previewMarkdown}
                  onChange={(event) => {
                    setPreviewMarkdown(event.target.value)
                    setMarkdownDirty(true)
                  }}
                  rows={16}
                  aria-label="发布 Markdown 编辑框"
                />
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
              </>
            )}
          </section>
        )}
      </div>

      <div className="publish-footer">
        <Space>
          {step > 0 && (
            <Button onClick={() => setStep(step - 1)} disabled={publishing}>
              上一步
            </Button>
          )}
          {step < 3 && (
            <Button
              type="primary"
              disabled={!canLeaveStep}
              onClick={() => setStep(step + 1)}
            >
              下一步
            </Button>
          )}
          {step === 3 && publishPhase.status !== 'succeeded' && (
            <Button
              type="primary"
              loading={publishing}
              disabled={!themeId || previewPending || Boolean(previewError)}
              onClick={confirmPublish}
            >
              发布到公众号草稿箱
            </Button>
          )}
          {step === 3 && publishPhase.status === 'failed' && (
            <Button onClick={executePublish} disabled={publishing}>
              重试发布
            </Button>
          )}
        </Space>
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
