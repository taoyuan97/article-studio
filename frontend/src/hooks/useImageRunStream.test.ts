import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useImageRunStream } from './useImageRunStream'
import { FakeEventSource } from '../test/fakeEventSource'

describe('useImageRunStream', () => {
  beforeEach(() => {
    FakeEventSource.reset()
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('runId 为空时不建立连接；存在时连接 /api/image-runs/{id}/events', () => {
    const { rerender } = renderHook(
      ({ runId }: { runId: string | null }) => useImageRunStream(runId, { onEvent: vi.fn() }),
      { initialProps: { runId: null as string | null } },
    )
    expect(FakeEventSource.instances).toHaveLength(0)

    rerender({ runId: 'img-run-1' })
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0].url).toBe('/api/image-runs/img-run-1/events')
  })

  it('配图事件分发：progress / completed / failed 透传解析后的数据', () => {
    const onEvent = vi.fn()
    renderHook(() => useImageRunStream('img-run-1', { onEvent }))
    const source = FakeEventSource.instances[0]

    source.emit('image.progress', { percent: 42 })
    expect(onEvent).toHaveBeenCalledWith('image.progress', { percent: 42 })

    source.emit('image.completed', { message: { id: 'm-1' } })
    expect(onEvent).toHaveBeenCalledWith('image.completed', { message: { id: 'm-1' } })

    source.emit('image.failed', { message: '生成失败', provider_detail: '脱敏详情' })
    expect(onEvent).toHaveBeenCalledWith('image.failed', {
      message: '生成失败',
      provider_detail: '脱敏详情',
    })
  })

  it('run.cancelled 与 run.completed 路径：completed 自动关闭、卸载清理', () => {
    const onEvent = vi.fn()
    const { unmount } = renderHook(() => useImageRunStream('img-run-1', { onEvent }))
    const source = FakeEventSource.instances[0]

    source.emit('run.cancelled', {})
    expect(onEvent).toHaveBeenCalledWith('run.cancelled', {})
    expect(source.closed).toBe(false)

    source.emit('run.completed', {})
    expect(source.closed).toBe(true)
    expect(onEvent).toHaveBeenCalledWith('run.completed', {})

    // 已手动关闭后重复 emit 不再产生副作用（模拟关闭后的残余事件）
    expect(() => source.emit('run.completed', {})).not.toThrow()

    unmount()
    expect(source.closed).toBe(true)
  })
})
