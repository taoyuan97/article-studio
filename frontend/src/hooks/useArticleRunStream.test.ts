import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useArticleRunStream } from './useArticleRunStream'
import { FakeEventSource } from '../test/fakeEventSource'

describe('useArticleRunStream', () => {
  beforeEach(() => {
    FakeEventSource.reset()
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('runId 为空时不建立连接', () => {
    renderHook(() => useArticleRunStream(null, { onEvent: vi.fn() }))
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it('runId 存在时连接 /api/runs/{id}/events', () => {
    renderHook(() => useArticleRunStream('run-1', { onEvent: vi.fn() }))
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0].url).toBe('/api/runs/run-1/events')
  })

  it('事件分发：解析 JSON 载荷并透传事件类型与数据', () => {
    const onEvent = vi.fn()
    renderHook(() => useArticleRunStream('run-1', { onEvent }))

    const source = FakeEventSource.instances[0]
    source.emit('assistant.delta', { delta: '你好' })
    expect(onEvent).toHaveBeenCalledWith('assistant.delta', { delta: '你好' })

    source.emit('run.started', { run_id: 'run-1' })
    expect(onEvent).toHaveBeenCalledWith('run.started', { run_id: 'run-1' })
  })

  it('事件分发：非法 JSON 兜底为 { run_id }', () => {
    const onEvent = vi.fn()
    renderHook(() => useArticleRunStream('run-1', { onEvent }))

    FakeEventSource.instances[0].emitRaw('article.delta', '{not-json')
    expect(onEvent).toHaveBeenCalledWith('article.delta', { run_id: 'run-1' })
  })

  it('收到 run.completed 后自动关闭连接', () => {
    renderHook(() => useArticleRunStream('run-1', { onEvent: vi.fn() }))
    const source = FakeEventSource.instances[0]

    source.emit('run.completed', {})
    expect(source.closed).toBe(true)
  })

  it('组件卸载时关闭连接（无泄漏）', () => {
    const { unmount } = renderHook(() => useArticleRunStream('run-1', { onEvent: vi.fn() }))
    const source = FakeEventSource.instances[0]
    expect(source.closed).toBe(false)

    unmount()
    expect(source.closed).toBe(true)
  })

  it('runId 变化：旧连接关闭、新连接建立', () => {
    const { rerender } = renderHook(
      ({ runId }: { runId: string }) => useArticleRunStream(runId, { onEvent: vi.fn() }),
      { initialProps: { runId: 'run-1' } },
    )
    rerender({ runId: 'run-2' })

    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[0].closed).toBe(true)
    expect(FakeEventSource.instances[1].url).toBe('/api/runs/run-2/events')
  })

  it('onOpen 与 onNetworkError 回调：断线提示触发；已关闭后的残余 onerror 不触发', () => {
    const onOpen = vi.fn()
    const onNetworkError = vi.fn()
    renderHook(() =>
      useArticleRunStream('run-1', { onEvent: vi.fn(), onOpen, onNetworkError }),
    )
    const source = FakeEventSource.instances[0]

    source.open()
    expect(onOpen).toHaveBeenCalledTimes(1)

    // 连接中出错 → 触发网络错误回调
    source.readyState = 1
    source.error()
    expect(onNetworkError).toHaveBeenCalledTimes(1)

    // 已关闭后的残余 onerror → 忽略
    source.readyState = FakeEventSource.CLOSED
    source.error()
    expect(onNetworkError).toHaveBeenCalledTimes(1)
  })
})
