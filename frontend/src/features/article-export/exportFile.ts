export type ExportFormat = 'markdown' | 'txt'

export interface ExportFileInput {
  title: string
  versionNumber: number
  format: ExportFormat
  /** 可延迟读取，确保 showSaveFilePicker 在用户点击的同步调用链中优先执行。 */
  content: string | (() => Promise<string>)
}

export type ExportFileResult = 'saved' | 'downloaded' | 'cancelled'

interface WritableFileHandle {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>
    close: () => Promise<void>
  }>
}

interface SaveFilePickerOptions {
  suggestedName?: string
  types?: Array<{
    description?: string
    accept: Record<string, string[]>
  }>
}

type SaveFilePicker = (options?: SaveFilePickerOptions) => Promise<WritableFileHandle>

const FORMAT_META: Record<
  ExportFormat,
  { extension: '.md' | '.txt'; blobMimeType: string; pickerMimeType: string; description: string }
> = {
  markdown: {
    extension: '.md',
    blobMimeType: 'text/markdown;charset=utf-8',
    pickerMimeType: 'text/markdown',
    description: 'Markdown 文档',
  },
  txt: {
    extension: '.txt',
    blobMimeType: 'text/plain;charset=utf-8',
    pickerMimeType: 'text/plain',
    description: 'TXT 文本',
  },
}

export function buildExportFileName(
  title: string,
  versionNumber: number,
  format: ExportFormat,
): string {
  const meta = FORMAT_META[format]
  const withoutInvalidCharacters = Array.from(title, (character) =>
    character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? ' ' : character,
  ).join('')
  const sanitized = withoutInvalidCharacters
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120)
    .replace(/[. ]+$/g, '')
  const baseName = sanitized || '文章'
  return `${baseName}-v${versionNumber}${meta.extension}`
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError'
}

/** 使用系统“另存为”保存；能力不可用时退化为浏览器下载。 */
export async function exportFile(input: ExportFileInput): Promise<ExportFileResult> {
  const meta = FORMAT_META[input.format]
  const fileName = buildExportFileName(input.title, input.versionNumber, input.format)
  const resolveContent = async () =>
    typeof input.content === 'function' ? input.content() : input.content
  const picker = (
    window as typeof window & {
      showSaveFilePicker?: SaveFilePicker
    }
  ).showSaveFilePicker

  if (picker) {
    try {
      const handle = await picker.call(window, {
        suggestedName: fileName,
        types: [
          {
            description: meta.description,
            accept: { [meta.pickerMimeType]: [meta.extension] },
          },
        ],
      })
      const content = await resolveContent()
      const blob = new Blob([content], { type: meta.blobMimeType })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return 'saved'
    } catch (error) {
      if (isAbortError(error)) return 'cancelled'
      throw error
    }
  }

  const content = await resolveContent()
  const blob = new Blob([content], { type: meta.blobMimeType })
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = fileName
  link.hidden = true
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    URL.revokeObjectURL(objectUrl)
  }
  return 'downloaded'
}
