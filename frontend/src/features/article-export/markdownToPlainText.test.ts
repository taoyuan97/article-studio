import { describe, expect, it } from 'vitest'
import { markdownToPlainText } from './markdownToPlainText'

describe('markdownToPlainText', () => {
  it('移除常用 Markdown 标记并保留可读结构', () => {
    const markdown = [
      '# 标题',
      '',
      '这是 **粗体**、*斜体*、~~删除~~ 与 [链接](https://example.com)。  ',
      '下一行含 `const x = 1`。',
      '',
      '> 一段引用',
      '',
      '- 第一项',
      '- 第二项',
      '  - 嵌套项',
      '',
      '1. 有序一',
      '2. 有序二',
      '',
      '---',
    ].join('\n')

    expect(markdownToPlainText(markdown)).toBe(
      [
        '标题',
        '',
        '这是 粗体、斜体、删除 与 链接。',
        '下一行含 const x = 1。',
        '',
        '一段引用',
        '',
        '第一项',
        '第二项',
        '嵌套项',
        '',
        '有序一',
        '有序二',
        '',
      ].join('\n'),
    )
  })

  it('保留图片 alt、代码内容和实体字符，去掉 HTML 标签及脚本', () => {
    const markdown = [
      '![示意图](image.png)',
      '',
      '```ts',
      'const value = 1 < 2',
      '',
      'console.log(value)',
      '```',
      '',
      '<span>安全文本 &amp; 更多</span>',
      '',
      '<script>window.__pwned = true</script>',
    ].join('\n')

    expect(markdownToPlainText(markdown)).toBe(
      [
        '示意图',
        '',
        'const value = 1 < 2',
        '',
        'console.log(value)',
        '',
        '安全文本 & 更多',
        '',
      ].join('\n'),
    )
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
  })

  it('空内容不产生额外换行，并规整首尾与连续空行', () => {
    expect(markdownToPlainText('')).toBe('')
    expect(markdownToPlainText('\n\n正文   \n\n\n\n结尾\n')).toBe('正文\n\n结尾\n')
  })
})
