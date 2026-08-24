/**
 * 展示格式化工具（对齐 MVP js/common/format.js 语义）。
 */

const STATUS_LABELS: Record<string, string> = {
  draft: '尚未生成',
  generated: '已生成',
  running: '生成中',
  failed: '上次失败',
}

const PROVIDER_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  moonshot: 'Kimi',
  aliyun_wanxiang: '通义万相',
  dreamina: '即梦',
}

export function statusLabel(value: string): string {
  return STATUS_LABELS[value] ?? value
}

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider
}

export function modelLabel(provider: string | null, model: string | null): string {
  if (!provider && !model) return '—'
  return `${providerLabel(provider ?? '')} · ${model ?? ''}`
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

/**
 * 相对时间格式化（统一全站口径）：
 * - 1 分钟内 → "刚刚"；
 * - 1 小时内 → "N 分钟前"；
 * - 24 小时内 → "N 小时前"；
 * - 7 天内 → "N 天前"；
 * - 更早 → 退化绝对短日期（如 "8月23日"）。
 */
export function relativeTime(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const diffMs = now.getTime() - date.getTime()
  if (diffMs < 0) return formatDate(value)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diffMs < minute) return '刚刚'
  if (diffMs < hour) return `${Math.floor(diffMs / minute)} 分钟前`
  if (diffMs < day) return `${Math.floor(diffMs / hour)} 小时前`
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)} 天前`
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(date)
}

/**
 * 图片 URL 归一化：
 * - http(s)/data: 开头原样返回；
 * - 其余视为后端同源相对路径（dev 经 Vite proxy /static 转发，prod 与后端同源）。
 */
export function resolveImageUrl(url: string | null | undefined): string {
  if (!url) return ''
  if (/^(https?:|data:)/i.test(url)) return url
  return url.startsWith('/') ? url : `/${url}`
}
