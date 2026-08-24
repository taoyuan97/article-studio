import { apiRequest } from './client'
import type {
  PublishArticleResponse,
  PublishAssemblyInput,
  PublishPreviewResponse,
  PublishRecord,
  PublishRecordListResponse,
  PublishThemeListResponse,
} from './types'

/** 与后端路由层 120s 超时对齐的前端同步等待上限 */
const PUBLISH_TIMEOUT_MS = 120_000

/** 发布线接口（5 个） */
export const publishApi = {
  fetchPublishThemes: () => apiRequest<PublishThemeListResponse>('/api/publish/themes'),

  publishPreview: (articleId: string, input: PublishAssemblyInput) =>
    apiRequest<PublishPreviewResponse>(
      `/api/publish/preview`,
      { method: 'POST', body: { article_id: articleId, ...input } },
    ),

  publishArticle: (
    articleId: string,
    input: PublishAssemblyInput & { theme_id: string; edited_markdown?: string | null },
  ) =>
    apiRequest<PublishArticleResponse>(
      `/api/publish/articles/${encodeURIComponent(articleId)}`,
      { method: 'POST', body: input, timeoutMs: PUBLISH_TIMEOUT_MS },
    ),

  fetchPublishRecords: (articleId?: string | null) =>
    apiRequest<PublishRecordListResponse>(
      articleId
        ? `/api/publish/records?article_id=${encodeURIComponent(articleId)}`
        : '/api/publish/records',
    ),

  fetchPublishRecordDetail: (recordId: string) =>
    apiRequest<PublishRecord>(`/api/publish/records/${encodeURIComponent(recordId)}`),
}
