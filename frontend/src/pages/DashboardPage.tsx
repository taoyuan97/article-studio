import { useQuery } from '@tanstack/react-query'
import { Card, Skeleton, Statistic, Typography } from 'antd'
import StatusBanner from '../components/StatusBanner'
import { articlesApi } from '../api/articles'
import type { ApiError } from '../api/client'

/**
 * 首页（占位）：T005 实现完整仪表盘。
 * 当前仅以 GET /api/stats 冒烟验证 API 封装与统一 ApiError 错误路径。
 */
export default function DashboardPage() {
  const { data, isPending, error } = useQuery({
    queryKey: ['stats'],
    queryFn: () => articlesApi.stats(),
  })

  return (
    <Card title="首页">
      <Typography.Paragraph type="secondary">
        统计与最近内容（完整仪表盘在 T005 实现）。当前展示后端 stats 接口冒烟结果：
      </Typography.Paragraph>

      {error ? (
        <StatusBanner
          kind="error"
          message={(error as ApiError).message ?? '加载统计失败'}
          description={`错误码：${(error as ApiError).code ?? 'UNKNOWN'}（状态：${(error as ApiError).status ?? '-'}）`}
        />
      ) : isPending ? (
        <Skeleton active paragraph={{ rows: 1 }} />
      ) : (
        <div style={{ display: 'flex', gap: 48 }}>
          <Statistic title="文章数" value={data.article_count} />
          <Statistic title="素材数" value={data.asset_count} />
        </div>
      )}
    </Card>
  )
}
