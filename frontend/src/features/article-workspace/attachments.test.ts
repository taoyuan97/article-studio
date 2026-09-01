import { describe, expect, it } from 'vitest'
import {
  MAX_ATTACHMENT_BYTES,
  attachmentKey,
  formatFileSize,
  mergeSelectedFiles,
  type PendingAttachment,
} from './attachments'

function file(name: string, content: string, lastModified = 1): File {
  return new File([content], name, { type: 'text/plain', lastModified })
}

describe('article message attachments', () => {
  it('accepts md/txt, strips BOM, and formats sizes', async () => {
    const result = await mergeSelectedFiles([], [file('notes.MD', '\uFEFF参考资料')])
    expect(result.errors).toEqual([])
    expect(result.accepted[0]).toMatchObject({ name: 'notes.MD', content: '参考资料' })
    expect(formatFileSize(1536)).toBe('1.5 KB')
  })

  it('keeps valid files when other selected files fail validation', async () => {
    const result = await mergeSelectedFiles([], [file('ok.txt', 'ok'), file('bad.pdf', 'bad')])
    expect(result.accepted.map((item) => item.name)).toEqual(['ok.txt'])
    expect(result.errors).toEqual([expect.stringContaining('仅支持 .md 和 .txt')])
  })

  it('deduplicates current list and enforces five-file limit', async () => {
    const first = file('same.txt', 'A', 10)
    const current: PendingAttachment[] = [
      {
        key: attachmentKey(first),
        name: first.name,
        size: first.size,
        lastModified: first.lastModified,
        content: 'A',
      },
    ]
    const selected = [first, ...[1, 2, 3, 4, 5].map((index) => file(`${index}.txt`, 'x'))]
    const result = await mergeSelectedFiles(current, selected)
    expect(result.accepted).toHaveLength(5)
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]).toContain('已在待发送列表中')
    expect(result.errors[1]).toContain('单次最多 5 个文件')
  })

  it('rejects oversized, empty, invalid UTF-8 and excessive character content', async () => {
    const oversized = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], 'large.txt')
    const invalidUtf8 = new File([new Uint8Array([0xc3, 0x28])], 'invalid.txt')
    const result = await mergeSelectedFiles([], [
      oversized,
      file('empty.txt', ''),
      invalidUtf8,
      file('chars.txt', 'a'.repeat(120_001)),
    ])
    expect(result.accepted).toEqual([])
    expect(result.errors.join('\n')).toContain('单文件不能超过 200 KB')
    expect(result.errors.join('\n')).toContain('文件内容为空或无效')
    expect(result.errors.join('\n')).toContain('请转换为 UTF-8 编码')
    expect(result.errors.join('\n')).toContain('附件正文合计不能超过 120000 字符')
  })
})
