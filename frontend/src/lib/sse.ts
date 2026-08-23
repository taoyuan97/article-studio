/**
 * SSE 客户端封装（基于原生 EventSource，沿用 MVP 事件协议）。
 *
 * 行为与 MVP js/workspace/stream.js、js/image-workspace/stream.js 一致：
 * - 按事件名注册监听；JSON 解析失败兜底为 { run_id }；
 * - 收到 run.completed 后自动 close()；
 * - onerror 时区分 EventSource.CLOSED（已关闭则不再触发网络错误回调，避免重复提示）；
 * - 返回手动关闭句柄。
 */

export type ArticleRunEventType =
  | 'run.started'
  | 'assistant.delta'
  | 'article.delta'
  | 'message.completed'
  | 'article.completed'
  | 'run.cancelled'
  | 'run.failed'
  | 'run.completed'

export type ImageRunEventType =
  | 'run.started'
  | 'image.progress'
  | 'image.completed'
  | 'image.failed'
  | 'run.cancelled'
  | 'run.completed'

/** 事件 data 载荷（各事件字段见技术设计 5.3；此处保持宽松以便调用方按需读取） */
export type RunEventData = Record<string, unknown>

export interface RunStreamHandlers<TEventType extends string> {
  onEvent: (type: TEventType, data: RunEventData, source: EventSource) => void
  /** 网络断开回调（连接已主动/正常关闭时不触发） */
  onNetworkError?: () => void
  /**
   * 连接建立回调（含断线自动重连）。
   * 后端事件流从头部重放，重连时应先清空临时流式内容再由重放事件重建。
   */
  onOpen?: () => void
}

export interface RunStreamHandle {
  close: () => void
}

export const ARTICLE_RUN_EVENTS: readonly ArticleRunEventType[] = [
  'run.started',
  'assistant.delta',
  'article.delta',
  'message.completed',
  'article.completed',
  'run.cancelled',
  'run.failed',
  'run.completed',
]

export const IMAGE_RUN_EVENTS: readonly ImageRunEventType[] = [
  'run.started',
  'image.progress',
  'image.completed',
  'image.failed',
  'run.cancelled',
  'run.completed',
]

function connectRunStream<TEventType extends string>(
  url: string,
  runId: string,
  eventTypes: readonly TEventType[],
  handlers: RunStreamHandlers<TEventType>,
): RunStreamHandle {
  const source = new EventSource(url)

  for (const type of eventTypes) {
    source.addEventListener(type, (event: MessageEvent<string>) => {
      let data: RunEventData
      try {
        data = JSON.parse(event.data) as RunEventData
      } catch {
        data = { run_id: runId }
      }
      handlers.onEvent(type, data, source)
      if (type === 'run.completed') {
        source.close()
      }
    })
  }

  source.onopen = () => handlers.onOpen?.()

  source.onerror = () => {
    // readyState === CLOSED 说明连接已被关闭（正常结束或手动 close()），
    // 此时浏览器可能仍会触发一次 onerror，忽略以免重复报网络错误。
    if (source.readyState === EventSource.CLOSED) return
    handlers.onNetworkError?.()
  }

  return {
    close: () => source.close(),
  }
}

/** 连接文章运行事件流：GET /api/runs/{run_id}/events */
export function connectArticleRunStream(
  runId: string,
  handlers: RunStreamHandlers<ArticleRunEventType>,
): RunStreamHandle {
  return connectRunStream(`/api/runs/${encodeURIComponent(runId)}/events`, runId, ARTICLE_RUN_EVENTS, handlers)
}

/** 连接配图运行事件流：GET /api/image-runs/{run_id}/events */
export function connectImageRunStream(
  runId: string,
  handlers: RunStreamHandlers<ImageRunEventType>,
): RunStreamHandle {
  return connectRunStream(
    `/api/image-runs/${encodeURIComponent(runId)}/events`,
    runId,
    IMAGE_RUN_EVENTS,
    handlers,
  )
}
