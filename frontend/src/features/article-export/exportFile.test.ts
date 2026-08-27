import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildExportFileName, exportFile } from './exportFile'

type WindowWithPicker = typeof window & { showSaveFilePicker?: unknown }

afterEach(() => {
  delete (window as WindowWithPicker).showSaveFilePicker
  vi.restoreAllMocks()
})

describe('buildExportFileName', () => {
  it('清理非法字符并保留版本和扩展名', () => {
    expect(buildExportFileName('  标题<>:"/\\|?*  . ', 3, 'markdown')).toBe('标题-v3.md')
    expect(buildExportFileName('***', 1, 'txt')).toBe('文章-v1.txt')
  })

  it('限制标题长度', () => {
    const fileName = buildExportFileName('长'.repeat(200), 12, 'markdown')
    expect(fileName).toBe(`${'长'.repeat(120)}-v12.md`)
  })
})

describe('exportFile', () => {
  it('通过系统文件选择器写入 Markdown 原文', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const showSaveFilePicker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({ write, close }),
    })
    ;(window as WindowWithPicker).showSaveFilePicker = showSaveFilePicker

    await expect(
      exportFile({ title: '测试文章', versionNumber: 2, format: 'markdown', content: '# 原文\n' }),
    ).resolves.toBe('saved')
    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: '测试文章-v2.md',
      types: [
        {
          description: 'Markdown 文档',
          accept: { 'text/markdown': ['.md'] },
        },
      ],
    })
    const blob = write.mock.calls[0][0] as Blob
    expect(blob.type).toBe('text/markdown;charset=utf-8')
    expect(await blob.text()).toBe('# 原文\n')
    expect(close).toHaveBeenCalledOnce()
  })

  it('先打开系统文件选择器，再异步读取正文', async () => {
    const events: string[] = []
    const write = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    ;(window as WindowWithPicker).showSaveFilePicker = vi.fn(async () => {
      events.push('picker')
      return {
        createWritable: vi.fn().mockResolvedValue({ write, close }),
      }
    })

    await exportFile({
      title: '历史版本',
      versionNumber: 1,
      format: 'markdown',
      content: async () => {
        events.push('content')
        return '# 历史版本'
      },
    })

    expect(events).toEqual(['picker', 'content'])
    expect(await (write.mock.calls[0][0] as Blob).text()).toBe('# 历史版本')
  })

  it('用户取消系统窗口时静默返回 cancelled', async () => {
    const abortError = new DOMException('取消', 'AbortError')
    ;(window as WindowWithPicker).showSaveFilePicker = vi.fn().mockRejectedValue(abortError)

    await expect(
      exportFile({ title: '文章', versionNumber: 1, format: 'txt', content: '正文\n' }),
    ).resolves.toBe('cancelled')
  })

  it('不支持系统文件选择器时触发下载并清理资源', async () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:download')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await expect(
      exportFile({ title: '纯文本', versionNumber: 4, format: 'txt', content: '正文\n' }),
    ).resolves.toBe('downloaded')
    expect(click).toHaveBeenCalledOnce()
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe('text/plain;charset=utf-8')
    expect(await blob.text()).toBe('正文\n')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:download')
    expect(document.querySelector('a[download]')).not.toBeInTheDocument()
  })
})
