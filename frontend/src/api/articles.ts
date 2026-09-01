import { apiRequest } from './client'
import type {
  Article,
  ArticleListResponse,
  ArticleRunResponse,
  ArticleVersion,
  ArticleVersionListResponse,
  ArticleWorkspace,
  CancelRunResponse,
  HealthResponse,
  MessageListResponse,
  SendArticleMessageRequest,
  Stats,
} from './types'

/** 文章线接口（13 个）+ 健康检查/统计 */
export const articlesApi = {
  healthCheck: () => apiRequest<HealthResponse>('/api/health'),

  stats: () => apiRequest<Stats>('/api/stats'),

  listArticles: (limit = 100) =>
    apiRequest<ArticleListResponse>(`/api/articles?limit=${limit}`),

  createArticle: () => apiRequest<Article>('/api/articles', { method: 'POST' }),

  getArticle: (articleId: string) =>
    apiRequest<Article>(`/api/articles/${encodeURIComponent(articleId)}`),

  getWorkspace: (articleId: string) =>
    apiRequest<ArticleWorkspace>(`/api/articles/${encodeURIComponent(articleId)}/workspace`),

  updateModel: (articleId: string, provider: string, model: string) =>
    apiRequest<Article>(`/api/articles/${encodeURIComponent(articleId)}/model`, {
      method: 'PATCH',
      body: { provider, model },
    }),

  listMessages: (articleId: string, before?: string, limit = 100) => {
    const params = new URLSearchParams()
    if (before) params.set('before', before)
    params.set('limit', String(limit))
    return apiRequest<MessageListResponse>(
      `/api/articles/${encodeURIComponent(articleId)}/messages?${params.toString()}`,
    )
  },

  sendMessage: (articleId: string, payload: SendArticleMessageRequest) =>
    apiRequest<ArticleRunResponse>(`/api/articles/${encodeURIComponent(articleId)}/messages`, {
      method: 'POST',
      body: payload,
    }),

  retryMessage: (articleId: string, messageId: string) =>
    apiRequest<ArticleRunResponse>(
      `/api/articles/${encodeURIComponent(articleId)}/messages/${encodeURIComponent(messageId)}/retry`,
      { method: 'POST' },
    ),

  listVersions: (articleId: string) =>
    apiRequest<ArticleVersionListResponse>(
      `/api/articles/${encodeURIComponent(articleId)}/versions`,
    ),

  getVersion: (articleId: string, versionId: string) =>
    apiRequest<ArticleVersion>(
      `/api/articles/${encodeURIComponent(articleId)}/versions/${encodeURIComponent(versionId)}`,
    ),

  cancelRun: (runId: string) =>
    apiRequest<CancelRunResponse>(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    }),
}

/** 文章运行 SSE 事件流地址（相对路径，dev 经 proxy / prod 同源） */
export function articleRunEventsUrl(runId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/events`
}
