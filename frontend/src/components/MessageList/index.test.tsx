import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import MessageList from './index'
import type { Message } from '../../api/types'

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'm-1',
    conversation_id: 'c-1',
    run_id: null,
    sequence_number: 1,
    role: 'user',
    message_type: 'chat',
    content: '内容',
    status: 'completed',
    provider: 'deepseek',
    model: 'deepseek-model',
    created_at: '2026-08-23T10:00:00Z',
    completed_at: '2026-08-23T10:00:01Z',
    ...overrides,
  }
}

describe('MessageList', () => {
  it('空态：无消息时展示引导文案', () => {
    render(<MessageList messages={[]} />)
    expect(screen.getByText(/还没有对话/)).toBeInTheDocument()
  })

  it('用户消息与智能体消息样式分型', () => {
    render(
      <MessageList
        messages={[
          makeMessage({ id: 'u1', role: 'user', content: '写一篇文章' }),
          makeMessage({
            id: 'a1',
            role: 'assistant',
            message_type: 'generation',
            content: '已生成正文',
          }),
        ]}
      />,
    )

    const userItem = screen.getByText('写一篇文章').closest('section')
    expect(userItem).toHaveClass('message-user')

    const assistantItem = screen.getByText('已生成正文').closest('section')
    expect(assistantItem).toHaveClass('message-assistant')
    // 分型标签：generation → 已生成文章
    expect(assistantItem).toHaveTextContent('已生成文章')
  })

  it('追问 / 引导 / 修改分型标签正确', () => {
    render(
      <MessageList
        messages={[
          makeMessage({ id: 'a2', role: 'assistant', message_type: 'clarification' }),
          makeMessage({ id: 'a3', role: 'assistant', message_type: 'redirect' }),
          makeMessage({ id: 'a4', role: 'assistant', message_type: 'revision' }),
        ]}
      />,
    )
    expect(screen.getByText('需要确认')).toBeInTheDocument()
    expect(screen.getByText('回到文章')).toBeInTheDocument()
    expect(screen.getByText('已修改文章')).toBeInTheDocument()
  })

  it('失败卡片：脱敏详情默认折叠、展开可见、重新发送回调原用户消息 ID', async () => {
    const onRetry = vi.fn()
    render(
      <MessageList
        onRetry={onRetry}
        messages={[
          makeMessage({
            id: 'f1',
            role: 'assistant',
            message_type: 'error',
            status: 'failed',
            content: '生成失败，请稍后重试。',
            provider_detail: 'provider 内部错误细节（脱敏）',
            retryable: true,
            user_message_id: 'u1',
          }),
        ]}
      />,
    )

    const failedItem = screen.getByText('生成失败，请稍后重试。').closest('section')
    expect(failedItem).toHaveClass('message-error')

    const details = document.querySelector('details.message-error-details') as HTMLDetailsElement
    expect(details).not.toBeNull()
    expect(details.open).toBe(false)
    // 详情文本在 DOM 中但处于折叠面板内
    expect(details).toHaveTextContent('provider 内部错误细节（脱敏）')

    await userEvent.click(screen.getByText('查看脱敏错误详情'))
    expect(details.open).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: '重新发送' }))
    expect(onRetry).toHaveBeenCalledWith('u1')
  })

  it('失败卡片：不可重试或缺少原消息 ID 时不展示重新发送按钮', () => {
    const { rerender } = render(
      <MessageList
        messages={[
          makeMessage({
            id: 'f2',
            role: 'assistant',
            status: 'failed',
            content: '失败 A',
            retryable: false,
            user_message_id: 'u1',
          }),
        ]}
      />,
    )
    expect(screen.queryByRole('button', { name: '重新发送' })).not.toBeInTheDocument()

    rerender(
      <MessageList
        messages={[
          makeMessage({
            id: 'f3',
            role: 'assistant',
            status: 'failed',
            content: '失败 B',
            retryable: true,
            user_message_id: undefined,
          }),
        ]}
      />,
    )
    expect(screen.queryByRole('button', { name: '重新发送' })).not.toBeInTheDocument()
  })

  it('流式临时气泡以降透明度样式追加展示', () => {
    render(
      <MessageList
        messages={[makeMessage({ id: 'u1', role: 'user', content: '指令' })]}
        temporaryAssistant="正在生成中的临时回复"
      />,
    )

    const temporary = screen.getByText('正在生成中的临时回复').closest('section')
    expect(temporary).toHaveClass('message-temporary')
  })
})
