import { useEffect, useRef } from 'react'
import { connectArticleRunStream, type ArticleRunEventType, type RunEventData } from '../lib/sse'

export interface ArticleRunStreamCallbacks {
  onEvent: (type: ArticleRunEventType, data: RunEventData) => void
  onNetworkError?: () => void
  onOpen?: () => void
}

/**
 * 文章运行事件流 hook：
 * - runId 变化（或从 null 变为有效值）时建立连接；
 * - 组件卸载自动 close()，无泄漏；
 * - callbacks 通过 ref 透传，回调标识变化不会导致重连；
 * - onOpen 在（重）连接建立时触发，调用方应重置临时流式内容以配合事件重放。
 *
 * 页面重新进入且 workspace 返回 active_run_id 时，调用方只需把该 runId
 * 传入本 hook 即可自动重连。
 */
export function useArticleRunStream(runId: string | null | undefined, callbacks: ArticleRunStreamCallbacks): void {
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  useEffect(() => {
    if (!runId) return
    const handle = connectArticleRunStream(runId, {
      onEvent: (type, data) => callbacksRef.current.onEvent(type, data),
      onNetworkError: () => callbacksRef.current.onNetworkError?.(),
      onOpen: () => callbacksRef.current.onOpen?.(),
    })
    return () => handle.close()
  }, [runId])
}
