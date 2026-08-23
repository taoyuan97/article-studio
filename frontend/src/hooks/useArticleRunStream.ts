import { useEffect, useRef } from 'react'
import { connectArticleRunStream, type ArticleRunEventType, type RunEventData } from '../lib/sse'

export interface ArticleRunStreamCallbacks {
  onEvent: (type: ArticleRunEventType, data: RunEventData) => void
  onNetworkError?: () => void
}

/**
 * 文章运行事件流 hook：
 * - runId 变化（或从 null 变为有效值）时建立连接；
 * - 组件卸载自动 close()，无泄漏；
 * - callbacks 通过 ref 透传，回调标识变化不会导致重连。
 *
 * 页面重新进入且 workspace 返回 active_run_id 时，调用方只需把该 runId
 * 传入本 hook 即可自动重连（本任务只提供能力，业务接线在 T003）。
 */
export function useArticleRunStream(runId: string | null | undefined, callbacks: ArticleRunStreamCallbacks): void {
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  useEffect(() => {
    if (!runId) return
    const handle = connectArticleRunStream(runId, {
      onEvent: (type, data) => callbacksRef.current.onEvent(type, data),
      onNetworkError: () => callbacksRef.current.onNetworkError?.(),
    })
    return () => handle.close()
  }, [runId])
}
