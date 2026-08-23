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
 * 图片 URL 归一化：
 * - http(s)/data: 开头原样返回；
 * - 其余视为后端同源相对路径（dev 经 Vite proxy /static 转发，prod 与后端同源）。
 */
export function resolveImageUrl(url: string | null | undefined): string {
  if (!url) return ''
  if (/^(https?:|data:)/i.test(url)) return url
  return url.startsWith('/') ? url : `/${url}`
}
