import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Input, Select, Spin } from 'antd'
import { articlesApi } from '../../api/articles'
import { imagePlanApi } from '../../api/imagePlan'
import type { ImagePlanGenerateRequest, ImagePlanResponse } from '../../api/types'

export interface ImagePlanFormProps {
  /** 会话已关联的文章（预选） */
  sessionArticleId: string | null
  /** 最近一次方案的 role / instructions（恢复回显）；无方案时用后端默认值 */
  latestPlan: ImagePlanResponse | null
  latestPlanLoaded: boolean
  /** 编排请求进行中（loading 覆盖 + 表单禁用） */
  pending: boolean
  onGenerate: (payload: ImagePlanGenerateRequest) => void
}

/**
 * 计划模式配置表单：文章 → 版本联动，LLM 模型选择（仅显示模型名，决策 ③），
 * 角色 / 编排指令可编辑（默认值来自后端，可被最近一次方案回填）。
 */
export default function ImagePlanForm({
  sessionArticleId,
  latestPlan,
  latestPlanLoaded,
  pending,
  onGenerate,
}: ImagePlanFormProps) {
  const defaultsQuery = useQuery({
    queryKey: ['image-plan-defaults'],
    queryFn: () => imagePlanApi.getDefaults(),
    staleTime: Infinity,
    retry: false,
  })
  const articlesQuery = useQuery({
    queryKey: ['articles'],
    queryFn: () => articlesApi.listArticles(),
    retry: false,
  })

  const [articleId, setArticleId] = useState<string | null>(null)
  const [versionId, setVersionId] = useState<string | null>(null)
  const [modelKey, setModelKey] = useState<string | null>(null)

  const defaults = defaultsQuery.data ?? null
  const [role, setRole] = useState('')
  const [instructions, setInstructions] = useState('')
  const [prefilled, setPrefilled] = useState(false)

  const versionsQuery = useQuery({
    queryKey: ['article-versions', articleId],
    queryFn: () => articlesApi.listVersions(articleId!),
    enabled: Boolean(articleId),
    retry: false,
  })
  const articleQuery = useQuery({
    queryKey: ['article', articleId],
    queryFn: () => articlesApi.getArticle(articleId!),
    enabled: Boolean(articleId),
    retry: false,
  })

  // 文章默认值：会话关联文章 → 唯一文章；角色/指令：最近方案 → 后端默认值
  useEffect(() => {
    if (articleId !== null || !articlesQuery.data) return
    const initial = sessionArticleId ?? articlesQuery.data.items[0]?.id ?? null
    if (initial) setArticleId(initial)
  }, [articlesQuery.data, articleId, sessionArticleId])

  useEffect(() => {
    if (prefilled || !defaults || !latestPlanLoaded) return
    setRole(latestPlan?.role ?? defaults.role)
    setInstructions(latestPlan?.instructions ?? defaults.instructions)
    setPrefilled(true)
  }, [defaults, latestPlan, latestPlanLoaded, prefilled])

  // 默认模型：后端 default_model → 列表首项
  useEffect(() => {
    if (modelKey !== null || !defaults) return
    const fallback = defaults.default_model ?? defaults.models[0]
    if (fallback) setModelKey(`${fallback.provider}|${fallback.model}`)
  }, [defaults, modelKey])

  const currentVersionId = articleQuery.data?.current_version_id ?? null
  const effectiveVersionId = versionId ?? currentVersionId
  const canGenerate = Boolean(articleId && effectiveVersionId && modelKey) && !pending

  const modelOptions = useMemo(
    () =>
      (defaults?.models ?? []).map((item) => ({
        value: `${item.provider}|${item.model}`,
        // 决策 ③：只显示模型名称，隐藏供应商名称
        label: item.model,
      })),
    [defaults?.models],
  )

  const handleGenerate = () => {
    if (!articleId || !effectiveVersionId || !modelKey) return
    const [provider, model] = modelKey.split('|')
    onGenerate({
      article_id: articleId,
      version_id: effectiveVersionId,
      role: role.trim() || undefined,
      instructions: instructions.trim() || undefined,
      provider,
      model,
    })
  }

  if (!defaults || !latestPlanLoaded) {
    return (
      <div className="image-plan-form-loading">
        <Spin />
      </div>
    )
  }

  return (
    <div className="image-plan-form" aria-busy={pending}>
      <div className="image-plan-field">
        <span className="image-plan-label">文章</span>
        <Select
          className="image-plan-select"
          aria-label="选择文章"
          placeholder="选择要编排配图的文章"
          value={articleId ?? undefined}
          options={(articlesQuery.data?.items ?? []).map((item) => ({
            value: item.id,
            label: item.title,
          }))}
          loading={articlesQuery.isPending}
          disabled={pending}
          onChange={(value: string) => {
            setArticleId(value)
            setVersionId(null)
          }}
          notFoundContent="暂无文章"
          showSearch
          optionFilterProp="label"
        />
      </div>

      <div className="image-plan-field">
        <span className="image-plan-label">版本</span>
        <Select
          className="image-plan-select"
          aria-label="选择文章版本"
          placeholder="选择文章版本"
          value={effectiveVersionId ?? undefined}
          options={(versionsQuery.data?.items ?? []).map((item) => ({
            value: item.id,
            label: `V${item.version_number} · ${item.title}`,
          }))}
          loading={versionsQuery.isPending}
          disabled={pending || !articleId}
          onChange={(value: string) => setVersionId(value)}
          notFoundContent="该文章暂无版本"
        />
      </div>

      <div className="image-plan-field">
        <span className="image-plan-label">模型</span>
        <Select
          className="image-plan-select"
          aria-label="选择编排模型"
          placeholder="选择编排模型"
          value={modelKey ?? undefined}
          options={modelOptions}
          disabled={pending}
          onChange={(value: string) => setModelKey(value)}
          notFoundContent="未配置可用的文本模型"
        />
      </div>

      <div className="image-plan-field">
        <span className="image-plan-label">角色设定</span>
        <Input.TextArea
          aria-label="编排角色设定"
          value={role}
          onChange={(event) => setRole(event.target.value)}
          rows={2}
          maxLength={2_000}
          disabled={pending}
          placeholder="默认使用后端内置角色设定"
        />
      </div>

      <div className="image-plan-field">
        <span className="image-plan-label">编排指令</span>
        <Input.TextArea
          aria-label="编排指令"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          rows={6}
          maxLength={20_000}
          disabled={pending}
          placeholder="默认使用后端内置编排指令（数量映射 / 四项评分 / 风格统一）"
        />
      </div>

      <Button type="primary" loading={pending} disabled={!canGenerate} onClick={handleGenerate}>
        一键编排
      </Button>
    </div>
  )
}
