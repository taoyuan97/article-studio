import { memo, useEffect, useRef } from 'react'
import { Button } from 'antd'
import type { Message } from '../../api/types'

/** 消息分型标签（与 MVP render-messages.js 一致） */
const TYPE_LABELS: Record<string, string> = {
  chat: '智能体回复',
  clarification: '需要确认',
  redirect: '回到文章',
  generation: '已生成文章',
  revision: '已修改文章',
  error: '运行失败',
}

export interface MessageListProps {
  messages: Message[]
  /** 流式期间的临时助手气泡（尚未定稿） */
  temporaryAssistant?: string
  /** 点击失败卡片"重新发送"时回调（参数为原用户消息 ID） */
  onRetry?: (userMessageId: string) => void
}

function MessageItem({
  message,
  onRetry,
}: {
  message: Message
  onRetry?: (userMessageId: string) => void
}) {
  const isUser = message.role === 'user'
  const failed = message.status === 'failed'
  const classes = [
    'message',
    isUser ? 'message-user' : 'message-assistant',
    failed ? 'message-error' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section className={classes} data-message-id={message.id}>
      <span className="message-label">
        {isUser ? '你' : (TYPE_LABELS[message.message_type] ?? '智能体')}
      </span>
      <p className="message-body">{message.content}</p>
      {failed && (
        <>
          <details className="message-error-details">
            <summary>查看脱敏错误详情</summary>
            <pre>{message.provider_detail || '没有更多错误详情。'}</pre>
          </details>
          {message.retryable && message.user_message_id && (
            <Button
              className="message-retry"
              size="small"
              onClick={() => onRetry?.(message.user_message_id!)}
            >
              重新发送
            </Button>
          )}
        </>
      )}
    </section>
  )
}

/**
 * 文章工作台消息流：
 * - 分型样式（用户 / 普通 / 追问 / 引导 / 生成 / 修改 / 失败）；
 * - 失败卡片：简短错误 + 可展开脱敏详情 + 重新发送（不复制用户消息文本）；
 * - 流式临时气泡降低透明度展示；
 * - 详情一律按纯文本渲染（React 自动转义，不注入 HTML）；
 */
const MessageList = memo(function MessageList({
  messages,
  temporaryAssistant,
  onRetry,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const temporaryRef = useRef('')
  temporaryRef.current = temporaryAssistant ?? ''

  // 自动滚动：靠近底部（<100px）或正在流式输出时吸底
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const shouldStick =
      temporaryRef.current.length > 0 ||
      container.scrollHeight - container.scrollTop - container.clientHeight < 100
    if (shouldStick) container.scrollTop = container.scrollHeight
  }, [messages, temporaryAssistant])

  const hasContent = messages.length > 0 || Boolean(temporaryAssistant)

  return (
    <div className="message-list" ref={containerRef} aria-live="polite">
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} onRetry={onRetry} />
      ))}
      {temporaryAssistant ? (
        <section className="message message-assistant message-temporary">
          <span className="message-label">智能体回复</span>
          <p className="message-body">{temporaryAssistant}</p>
        </section>
      ) : null}
      {!hasContent && (
        <p className="message-empty">
          还没有对话。描述你的写作目标，智能体会在必要时只追问一个关键问题。
        </p>
      )}
    </div>
  )
})

export default MessageList
