/**
 * 后端契约 TS 类型（单一事实源）。
 *
 * 与 backend/app/database.py、backend/app/main.py 的响应结构一一对应，
 * 契约基准见 backend/tests/test_frontend_contract.py。
 * 后续如引入 openapi-typescript 可替换本文件，但字段名保持后端蛇形命名。
 */

// ---------- 通用 ----------

export interface HealthResponse {
  status: string
}

export interface CancelRunResponse {
  run_id: string
  cancelled: boolean
}

// ---------- 文章线 ----------

export type ArticleStatus = 'draft' | 'generated' | 'running' | 'failed'

export interface ArticleBrief {
  topic: string | null
  audience: string | null
  purpose: string | null
  tone: string | null
  platform: string | null
  target_length: number | null
  constraints: string[]
}

/** GET /api/articles/{id}、POST /api/articles、PATCH .../model 响应（enrich 后含 has_active_run） */
export interface Article {
  id: string
  conversation_id: string
  thread_id: string
  title: string
  brief: ArticleBrief
  conversation_summary: string | null
  summary_until_message_id: string | null
  status: ArticleStatus
  current_version_id: string | null
  provider: string
  model: string
  created_at: string
  updated_at: string
  has_active_run: boolean
}

/** GET /api/articles 列表项（含聚合字段） */
export interface ArticleListItem {
  id: string
  title: string
  status: ArticleStatus
  provider: string
  model: string
  created_at: string
  updated_at: string
  version_count: number
  summary: string
}

export interface ArticleListResponse {
  items: ArticleListItem[]
}

export type MessageRole = 'user' | 'assistant'

export type MessageType = 'chat' | 'clarification' | 'redirect' | 'generation' | 'revision' | 'error'

export type MessageStatus = 'completed' | 'failed'

/** GET /api/articles/{id}/messages 消息项（assistant 失败消息附带 run JOIN 字段） */
export interface Message {
  id: string
  conversation_id: string
  run_id: string | null
  sequence_number: number
  role: MessageRole
  message_type: MessageType
  content: string
  status: MessageStatus
  provider: string
  model: string
  created_at: string
  completed_at: string | null
  error_code?: string | null
  error_message?: string | null
  provider_detail?: string | null
  retryable?: boolean
  user_message_id?: string
}

export interface MessageListResponse {
  items: Message[]
  next_cursor: string | null
}

export interface ArticleVersionSummary {
  id: string
  article_id: string
  parent_version_id: string | null
  version_number: number
  title: string
  provider: string
  model: string
  run_id: string
  created_at: string
}

export interface ArticleVersionListResponse {
  items: ArticleVersionSummary[]
}

/** 版本详情（GET .../versions/{vid}）含正文 */
export interface ArticleVersion extends ArticleVersionSummary {
  content_markdown: string
  instruction: string
}

export interface AvailableModel {
  provider: string
  model: string
  context_window: number
}

export interface UnavailableModel {
  provider: string
  reason: string
}

/** GET /api/articles/{id}/workspace 聚合 */
export interface ArticleWorkspace {
  article: Article
  current_version: ArticleVersion | null
  messages: Message[]
  versions: ArticleVersionSummary[]
  conversation_id: string
  thread_id: string
  active_run_id: string | null
  available_models: AvailableModel[]
  unavailable_models: UnavailableModel[]
}

/** POST messages / retry → 202 响应 */
export interface ArticleRunResponse {
  run_id: string
  article_id: string
  user_message_id: string
  status: string
  events_url: string
}

// ---------- 配图线 ----------

export type ImageSessionStatus = 'idle' | 'running' | 'failed' | 'completed'

/** POST/GET /api/image-sessions 详情（含关联文章标题） */
export interface ImageSession {
  id: string
  article_id: string | null
  article_title: string | null
  title: string
  provider: string
  model: string
  status: ImageSessionStatus
  created_at: string
  updated_at: string
}

export interface ImageSessionListItem {
  id: string
  article_id: string | null
  article_title: string | null
  title: string
  provider: string
  model: string
  status: ImageSessionStatus
  updated_at: string
}

export interface ImageSessionListResponse {
  items: ImageSessionListItem[]
}

export interface ImageMessage {
  id: string
  session_id: string
  sequence_number: number
  role: MessageRole
  content: string
  image_url: string | null
  image_prompt: string | null
  status: MessageStatus
  provider: string
  model: string
  created_at: string
}

export interface ImageProviderInfo {
  provider: string
  model: string
}

/** GET /api/image-sessions/{id}/workspace 聚合 */
export interface ImageWorkspace {
  session: ImageSession
  messages: ImageMessage[]
  available_providers: ImageProviderInfo[]
  active_run_id: string | null
}

/** POST image-sessions/{id}/messages → 202 响应 */
export interface ImageRunResponse {
  run_id: string
  session_id: string
  user_message_id: string
  status: string
  events_url: string
}

// ---------- 素材线 ----------

export interface AssetMetadata {
  prompt?: string
  image_prompt?: string
  width?: number | null
  height?: number | null
  seed?: number | null
}

export interface Asset {
  id: string
  kind: 'image' | 'audio'
  source: 'image_generation' | 'upload'
  source_session_id: string | null
  source_message_id: string | null
  title: string
  storage_url: string
  provider: string | null
  model: string | null
  metadata: AssetMetadata
  created_at: string
  updated_at: string
}

export interface AssetListResponse {
  items: Asset[]
}

// ---------- 统计 ----------

export interface RecentArticle {
  id: string
  title: string
  updated_at: string
  version_count: number
}

export interface RecentAsset {
  id: string
  title: string
  storage_url: string
  updated_at: string
}

export interface Stats {
  article_count: number
  asset_count: number
  recent_articles: RecentArticle[]
  recent_assets: RecentAsset[]
}
