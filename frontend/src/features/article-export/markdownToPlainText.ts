import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

interface MarkdownNode {
  type: string
  value?: string
  alt?: string | null
  children?: MarkdownNode[]
}

function htmlToText(html: string): string {
  const withoutExecutableContent = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')

  if (typeof DOMParser === 'undefined') {
    return withoutExecutableContent.replace(/<[^>]*>/g, '')
  }

  const parsed = new DOMParser().parseFromString(withoutExecutableContent, 'text/html')
  return parsed.body.textContent ?? ''
}

function renderInline(node: MarkdownNode): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
      return node.value ?? ''
    case 'break':
      return '\n'
    case 'image':
    case 'imageReference':
      return node.alt ?? ''
    case 'html':
      return htmlToText(node.value ?? '')
    default:
      return (node.children ?? []).map(renderInline).join('')
  }
}

function renderListItem(node: MarkdownNode): string {
  return (node.children ?? []).map(renderBlock).filter(Boolean).join('\n')
}

function renderBlock(node: MarkdownNode): string {
  switch (node.type) {
    case 'root':
      return (node.children ?? []).map(renderBlock).filter(Boolean).join('\n\n')
    case 'heading':
    case 'paragraph':
      return (node.children ?? []).map(renderInline).join('')
    case 'blockquote':
      return (node.children ?? []).map(renderBlock).filter(Boolean).join('\n\n')
    case 'list':
      return (node.children ?? []).map(renderListItem).filter(Boolean).join('\n')
    case 'listItem':
      return renderListItem(node)
    case 'code':
      return node.value ?? ''
    case 'html':
      return htmlToText(node.value ?? '')
    case 'thematicBreak':
    case 'definition':
      return ''
    default:
      if (node.children) return node.children.map(renderBlock).filter(Boolean).join('\n\n')
      return node.value ?? ''
  }
}

/** 将 Markdown 转为适合 TXT 导出的可读纯文本。 */
export function markdownToPlainText(markdown: string): string {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as MarkdownNode
  const plainText = renderBlock(tree)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return plainText ? `${plainText}\n` : ''
}
