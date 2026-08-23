import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'

interface MarkdownViewProps {
  content: string
  className?: string
}

/**
 * 安全 Markdown 渲染：
 * - react-markdown + rehype-sanitize 白名单（标题/列表/代码块/段落/行内强调等）；
 * - 禁用原始 HTML：markdown 中的 HTML 标签一律按文本展示，不执行；
 * - 失败详情等纯文本一律作为文本节点渲染（React 默认转义）。
 */
const MarkdownView = memo(function MarkdownView({ content, className }: MarkdownViewProps) {
  return (
    <div className={className ? `markdown-view ${className}` : 'markdown-view'}>
      <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{content}</ReactMarkdown>
    </div>
  )
})

export default MarkdownView
