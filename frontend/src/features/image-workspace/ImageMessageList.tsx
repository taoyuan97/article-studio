import { memo, useEffect, useRef } from 'react'
import type { ImageMessage } from '../../api/types'
import { resolveImageUrl } from '../../lib/format'

export interface ImageFailureInfo {
  /** 持久化的失败消息 ID（用于避免与消息列表重复渲染） */
  failedMessageId: string | null
  message: string
  providerDetail: string | null
}

export interface ImageMessageListProps {
  messages: ImageMessage[]
  /** SSE 失败事件携带的失败卡片（简短错误 + 脱敏详情） */
  failure?: ImageFailureInfo | null
  /** 点击缩略图选中当前图片 */
  onSelectImage?: (message: ImageMessage) => void
  selectedImageId?: string | null
}

function ImageMessageItem({
  message,
  selected,
  onSelectImage,
}: {
  message: ImageMessage
  selected: boolean
  onSelectImage?: (message: ImageMessage) => void
}) {
  const isUser = message.role === 'user'
  const classes = [
    'message',
    isUser ? 'message-user' : 'message-assistant',
    message.status === 'failed' ? 'message-error' : '',
    selected ? 'message-image-selected' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section className={classes} data-message-id={message.id}>
      <span className="message-label">{isUser ? '你' : message.status === 'failed' ? '生成失败' : '智能体'}</span>
      <p className="message-body">{message.content}</p>
      {message.image_url && (
        <button
          type="button"
          className="image-message-thumb"
          onClick={() => onSelectImage?.(message)}
          aria-label="查看这张图片"
        >
          <img src={resolveImageUrl(message.image_url)} alt="生成的配图" loading="lazy" />
        </button>
      )}
    </section>
  )
}

/**
 * 配图会话消息流：用户 prompt / 生成结果（含缩略图）/ 失败卡片。
 * 失败卡片渲染 SSE 失败事件中的脱敏详情，并隐藏同一条持久化失败消息避免重复。
 */
const ImageMessageList = memo(function ImageMessageList({
  messages,
  failure,
  onSelectImage,
  selectedImageId,
}: ImageMessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [messages.length, failure])

  const visibleMessages = failure?.failedMessageId
    ? messages.filter((message) => message.id !== failure.failedMessageId)
    : messages

  return (
    <div className="message-list" ref={containerRef} aria-live="polite">
      {visibleMessages.map((message) => (
        <ImageMessageItem
          key={message.id}
          message={message}
          selected={message.id === selectedImageId}
          onSelectImage={onSelectImage}
        />
      ))}
      {failure && (
        <section className="message message-assistant message-error">
          <span className="message-label">生成失败</span>
          <p className="message-body">{failure.message}</p>
          <details className="message-error-details">
            <summary>查看脱敏错误详情</summary>
            <pre>{failure.providerDetail || '没有更多错误详情。'}</pre>
          </details>
        </section>
      )}
      {visibleMessages.length === 0 && !failure && (
        <p className="message-empty">还没有对话。描述你想要的画面，生成结果会显示在右侧。</p>
      )}
    </div>
  )
})

export default ImageMessageList
