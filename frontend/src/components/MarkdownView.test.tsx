import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import MarkdownView from './MarkdownView'

describe('MarkdownView', () => {
  it('按白名单渲染标题 / 列表 / 代码块 / 行内强调', () => {
    render(
      <MarkdownView
        content={'# 标题\n\n- 要点一\n- 要点二\n\n**加粗** 与 *斜体* 与 `code`\n\n```\nblock\ncode\n```'}
      />,
    )

    expect(screen.getByText('标题').tagName).toBe('H1')
    expect(screen.getByText('要点一').closest('li')).toBeInTheDocument()
    expect(screen.getByText('要点二').closest('li')).toBeInTheDocument()
    expect(screen.getByText('加粗').tagName).toBe('STRONG')
    expect(screen.getByText('斜体').tagName).toBe('EM')
    expect(screen.getByText('code').tagName).toBe('CODE')
    // 代码块整体在 pre 中
    expect(document.querySelector('.markdown-view pre code')).toHaveTextContent('block')
  })

  it('恶意 HTML 标签不产生对应元素、不执行（react-markdown 默认丢弃原始 HTML 节点）', () => {
    render(
      <MarkdownView
        content={
          '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)" />\n\n<a href="javascript:alert(3)">链接</a>'
        }
      />,
    )

    // script / img / a 均未成为真实元素
    expect(document.querySelectorAll('script')).toHaveLength(0)
    expect(document.querySelectorAll('img')).toHaveLength(0)
    expect(document.querySelectorAll('a')).toHaveLength(0)
    // 行内 HTML 标签被丢弃后，其内部纯文本仍按段落展示（非链接元素）
    const text = screen.getByText('链接')
    expect(text.closest('a')).toBeNull()
  })

  it('script 内容不执行：不向 window 挂载任何标记', () => {
    render(<MarkdownView content={'<script>window.__pwned = true</script>'} />)

    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
  })
})
