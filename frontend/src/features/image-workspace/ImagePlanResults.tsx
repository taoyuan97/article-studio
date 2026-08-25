import { useRef, useState } from 'react'
import { Button, Spin } from 'antd'
import type { ApiError } from '../../api/client'
import type { ImagePlanResponse } from '../../api/types'
import StatusBanner from '../../components/StatusBanner'

const LAYOUT_LABELS: Record<string, string> = {
  landscape: '横版',
  square: '方图',
  portrait: '竖版',
}

/** 复制提示词：clipboard API + execCommand 兜底 */
async function copyPrompt(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(textarea)
    return copied
  }
}

export interface ImagePlanResultsProps {
  data: ImagePlanResponse | null
  pending: boolean
  error: ApiError | null
  onRetry: () => void
}

/**
 * 计划模式结果面板：统计条（字数/章节/情绪基调/风格）+ 配图卡片
 * （位置说明 / 排版建议 / 提示词 + 复制按钮）。
 */
export default function ImagePlanResults({ data, pending, error, onRetry }: ImagePlanResultsProps) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleCopy = async (index: number, prompt: string) => {
    const copied = await copyPrompt(prompt)
    if (!copied) return
    setCopiedIndex(index)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopiedIndex(null), 1_500)
  }

  if (pending) {
    return (
      <div className="workspace-loading image-plan-loading">
        <Spin />
        <p className="image-plan-loading-text">正在编排配图方案……</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="image-plan-results">
        <StatusBanner kind="error" message={error.message} />
        <Button onClick={onRetry}>重试</Button>
      </div>
    )
  }

  const plan = data?.plan ?? null
  if (!plan) {
    return (
      <div className="article-empty">
        <h3>配图方案会在这里出现</h3>
        <p>在左侧选择文章版本，点击「一键编排」生成配图提示词方案。</p>
      </div>
    )
  }

  return (
    <div className="image-plan-results">
      <div className="image-plan-stats">
        <div className="image-plan-stat-row">
          <span className="image-plan-stat-title">{data?.article_title}</span>
          <span className="image-plan-stat-meta">
            {data?.word_count} 字 · {data?.section_count} 章节 · {plan.images.length} 张配图
          </span>
        </div>
        <div className="image-plan-stat-mood">
          <span className="image-plan-mood-tag">{plan.mood}</span>
          <span className="image-plan-style">{plan.style_summary}</span>
        </div>
      </div>

      <div className="image-plan-cards">
        {plan.images.map((image, index) => (
          <article key={`${image.block_index}-${index}`} className="image-plan-card">
            <header className="image-plan-card-header">
              <span className="image-plan-card-index">#{index + 1}</span>
              <span className="image-plan-card-position">第 {image.block_index} 块后 · {image.position_hint}</span>
              <span className="image-plan-card-layout" data-layout={image.layout}>
                {LAYOUT_LABELS[image.layout] ?? image.layout}
              </span>
            </header>
            <pre className="image-plan-prompt">{image.prompt}</pre>
            <footer className="image-plan-card-footer">
              <span className="image-plan-layout-reason">{image.layout_reason}</span>
              <Button
                size="small"
                onClick={() => handleCopy(index, image.prompt)}
                aria-label={`复制提示词 ${index + 1}`}
              >
                {copiedIndex === index ? '已复制' : '复制'}
              </Button>
            </footer>
          </article>
        ))}
      </div>
    </div>
  )
}
