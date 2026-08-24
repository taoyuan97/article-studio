import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { App, Button, Card, Skeleton } from 'antd'
import { articlesApi } from '../api/articles'
import type { ApiError } from '../api/client'
import { imageSessionsApi } from '../api/imageSessions'
import StatusBanner from '../components/StatusBanner'
import { relativeTime, resolveImageUrl } from '../lib/format'

/**
 * 首页仪表盘：
 * - 统计卡片（GET /api/stats）：文章总数 / 素材总数，"查看全部"跳转列表；
 * - 快捷入口：新建文章（POST /api/articles → 工作台）、新建配图（POST /api/image-sessions → 配图工作台）；
 * - 最近 5 篇文章（标题 + 相对时间，点击进入工作台）与最近 5 个素材（缩略图 + 相对时间）；
 * - 错误不打断已加载区块：stats 失败时仍展示快捷入口。
 */
export default function DashboardPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { message } = App.useApp()

  const statsQuery = useQuery({
    queryKey: ['stats'],
    queryFn: () => articlesApi.stats(),
  })

  const createArticleMutation = useMutation({
    mutationFn: () => articlesApi.createArticle(),
    onSuccess: (article) => {
      queryClient.invalidateQueries({ queryKey: ['articles'] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
      navigate(`/articles/${encodeURIComponent(article.id)}`)
    },
    onError: (error: ApiError) => {
      message.error(error.message)
    },
  })

  const createSessionMutation = useMutation({
    mutationFn: () => imageSessionsApi.createImageSession(null),
    onSuccess: (session) => {
      navigate(`/image-sessions/${encodeURIComponent(session.id)}`)
    },
    onError: (error: ApiError) => {
      message.error(error.message)
    },
  })

  const stats = statsQuery.data
  const recentArticles = stats?.recent_articles ?? []
  const recentAssets = stats?.recent_assets ?? []
  const loading = statsQuery.isPending && !statsQuery.data
  const error = statsQuery.error as ApiError | null

  return (
    <div className="dashboard-page">
      <div className="page-toolbar">
        <div>
          <h1 className="page-title">首页</h1>
          <p className="dashboard-subtitle">
            从这里开始：写一篇新文章，或为现有内容生成配图。
          </p>
        </div>
      </div>

      <div className="dashboard-actions">
        <button
          type="button"
          className="dashboard-action-card"
          onClick={() => createArticleMutation.mutate()}
          disabled={createArticleMutation.isPending}
        >
          <span className="dashboard-action-title">新建文章</span>
          <span className="dashboard-action-desc">
            {createArticleMutation.isPending ? '正在创建……' : '描述主题与读者，智能体生成完整正文'}
          </span>
        </button>
        <button
          type="button"
          className="dashboard-action-card"
          onClick={() => createSessionMutation.mutate()}
          disabled={createSessionMutation.isPending}
        >
          <span className="dashboard-action-title">新建配图</span>
          <span className="dashboard-action-desc">
            {createSessionMutation.isPending ? '正在创建……' : '输入画面描述，生成配图并保存素材'}
          </span>
        </button>
      </div>

      {error ? (
        <StatusBanner
          kind="error"
          message={error.message ?? '加载统计失败'}
          description={`错误码：${error.code ?? 'UNKNOWN'}（状态：${error.status ?? '-'}）`}
        />
      ) : null}

      <div className="dashboard-stats">
        <Card className="dashboard-stat-card" loading={loading}>
          <div className="dashboard-stat">
            <span className="dashboard-stat-value">{stats ? stats.article_count : '—'}</span>
            <span className="dashboard-stat-label">文章</span>
            <Button
              type="link"
              className="dashboard-stat-link"
              onClick={() => navigate('/articles')}
            >
              查看全部 →
            </Button>
          </div>
        </Card>
        <Card className="dashboard-stat-card" loading={loading}>
          <div className="dashboard-stat">
            <span className="dashboard-stat-value">{stats ? stats.asset_count : '—'}</span>
            <span className="dashboard-stat-label">素材</span>
            <Button
              type="link"
              className="dashboard-stat-link"
              onClick={() => navigate('/assets')}
            >
              查看全部 →
            </Button>
          </div>
        </Card>
      </div>

      <div className="dashboard-recent">
        <Card
          title="最近文章"
          className="dashboard-recent-card"
          extra={
            <Button type="link" onClick={() => navigate('/articles')}>
              查看全部
            </Button>
          }
        >
          {loading ? (
            <Skeleton active paragraph={{ rows: 4 }} />
          ) : recentArticles.length === 0 ? (
            <div className="table-empty dashboard-empty">
              <h3>还没有文章</h3>
              <p>点击"新建文章"开始第一篇创作。</p>
            </div>
          ) : (
            <ul className="dashboard-recent-list">
              {recentArticles.map((article) => (
                <li key={article.id}>
                  <button
                    type="button"
                    className="dashboard-recent-item"
                    onClick={() => navigate(`/articles/${encodeURIComponent(article.id)}`)}
                  >
                    <span className="dashboard-recent-title">{article.title}</span>
                    <span className="dashboard-recent-time">
                      {relativeTime(article.updated_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="最近素材"
          className="dashboard-recent-card"
          extra={
            <Button type="link" onClick={() => navigate('/assets')}>
              查看全部
            </Button>
          }
        >
          {loading ? (
            <Skeleton active paragraph={{ rows: 4 }} />
          ) : recentAssets.length === 0 ? (
            <div className="table-empty dashboard-empty">
              <h3>还没有素材</h3>
              <p>点击"新建配图"，生成后保存到素材库。</p>
            </div>
          ) : (
            <ul className="dashboard-recent-list">
              {recentAssets.map((asset) => (
                <li key={asset.id}>
                  <button
                    type="button"
                    className="dashboard-recent-item"
                    onClick={() => navigate('/assets')}
                  >
                    <span className="dashboard-recent-thumb">
                      <img
                        src={resolveImageUrl(asset.storage_url)}
                        alt={asset.title}
                        loading="lazy"
                      />
                    </span>
                    <span className="dashboard-recent-title">{asset.title}</span>
                    <span className="dashboard-recent-time">
                      {relativeTime(asset.updated_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
