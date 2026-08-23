import { apiRequest } from './client'
import type {
  CancelRunResponse,
  ImageRunResponse,
  ImageSession,
  ImageSessionListResponse,
  ImageWorkspace,
} from './types'

/** 配图线接口（6 个） */
export const imageSessionsApi = {
  createImageSession: (articleId?: string | null) =>
    apiRequest<ImageSession>('/api/image-sessions', {
      method: 'POST',
      body: { article_id: articleId ?? null },
    }),

  listImageSessions: (limit = 100) =>
    apiRequest<ImageSessionListResponse>(`/api/image-sessions?limit=${limit}`),

  getImageWorkspace: (sessionId: string) =>
    apiRequest<ImageWorkspace>(`/api/image-sessions/${encodeURIComponent(sessionId)}/workspace`),

  sendImagePrompt: (
    sessionId: string,
    content: string,
    provider: string,
    model: string,
    tier?: string,
    ratio?: string,
  ) =>
    apiRequest<ImageRunResponse>(`/api/image-sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body: { content, provider, model, tier, ratio },
    }),

  cancelImageRun: (runId: string) =>
    apiRequest<CancelRunResponse>(`/api/image-runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    }),
}

/** 配图运行 SSE 事件流地址 */
export function imageRunEventsUrl(runId: string): string {
  return `/api/image-runs/${encodeURIComponent(runId)}/events`
}
