import { useEffect, useRef } from 'react'
import { connectImageRunStream, type ImageRunEventType, type RunEventData } from '../lib/sse'

export interface ImageRunStreamCallbacks {
  onEvent: (type: ImageRunEventType, data: RunEventData) => void
  onNetworkError?: () => void
}

/**
 * 配图运行事件流 hook（行为同 useArticleRunStream，事件集为配图线 6 种）。
 * 业务接线在 T004。
 */
export function useImageRunStream(runId: string | null | undefined, callbacks: ImageRunStreamCallbacks): void {
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

  useEffect(() => {
    if (!runId) return
    const handle = connectImageRunStream(runId, {
      onEvent: (type, data) => callbacksRef.current.onEvent(type, data),
      onNetworkError: () => callbacksRef.current.onNetworkError?.(),
    })
    return () => handle.close()
  }, [runId])
}
