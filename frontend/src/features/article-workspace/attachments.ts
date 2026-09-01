export const MAX_ATTACHMENT_COUNT = 5
export const MAX_ATTACHMENT_BYTES = 200 * 1024
export const MAX_ATTACHMENTS_BYTES_TOTAL = 1000 * 1024
export const MAX_ATTACHMENT_CHARS_TOTAL = 120_000

export interface PendingAttachment {
  key: string
  name: string
  size: number
  lastModified: number
  content: string
}

export interface AttachmentSelectionResult {
  accepted: PendingAttachment[]
  errors: string[]
}

export async function mergeSelectedFiles(
  current: PendingAttachment[],
  selected: File[],
): Promise<AttachmentSelectionResult> {
  const accepted = [...current]
  const errors: string[] = []
  let totalBytes = current.reduce((sum, item) => sum + item.size, 0)
  let totalChars = current.reduce((sum, item) => sum + unicodeCharacterCount(item.content), 0)

  for (const file of selected) {
    const key = attachmentKey(file)
    if (accepted.some((item) => item.key === key)) {
      errors.push(`${file.name} 已在待发送列表中`)
      continue
    }
    if (accepted.length >= MAX_ATTACHMENT_COUNT) {
      errors.push(`${file.name} 未加入：单次最多 5 个文件`)
      continue
    }
    if (!/\.(md|txt)$/i.test(file.name)) {
      errors.push(`${file.name} 未加入：仅支持 .md 和 .txt`)
      continue
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      errors.push(`${file.name} 未加入：单文件不能超过 200 KB`)
      continue
    }
    if (totalBytes + file.size > MAX_ATTACHMENTS_BYTES_TOTAL) {
      errors.push(`${file.name} 未加入：附件合计不能超过 1000 KB`)
      continue
    }

    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true })
        .decode(await file.arrayBuffer())
        .replace(/^\uFEFF/, '')
    } catch {
      errors.push(`${file.name} 未加入：请转换为 UTF-8 编码`)
      continue
    }
    if (!content || content.includes('\0')) {
      errors.push(`${file.name} 未加入：文件内容为空或无效`)
      continue
    }
    const contentChars = unicodeCharacterCount(content)
    if (totalChars + contentChars > MAX_ATTACHMENT_CHARS_TOTAL) {
      errors.push(`${file.name} 未加入：附件正文合计不能超过 120000 字符`)
      continue
    }

    accepted.push({
      key,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      content,
    })
    totalBytes += file.size
    totalChars += contentChars
  }

  return { accepted, errors }
}

export function attachmentKey(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}\0${file.size}\0${file.lastModified}`
}

export function formatFileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
}

function unicodeCharacterCount(value: string): number {
  return Array.from(value).length
}
