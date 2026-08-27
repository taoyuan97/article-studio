import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { Button, Image, Spin, Tag, Typography } from 'antd'
import { assetsApi } from '../api/assets'
import { publishApi } from '../api/publish'
import type { ApiError } from '../api/client'
import MarkdownView from '../components/MarkdownView'
import StatusBanner from '../components/StatusBanner'
import { mapImagePathsToUrls, stripFrontmatter } from '../features/publish/snapshot'
import { formatDate, resolveImageUrl } from '../lib/format'

/**
 * 发布快照详情页（专注模式，返回发布记录）：
 * - 元信息面板：文章标题、主题、状态、media_id、作者、发布时间、封面缩略图；
 * - 正文只读渲染：剥离 frontmatter 后经 MarkdownView 白名单渲染，
 *   快照中的本地绝对路径图片映射回 /static 素材路径并以缩略图呈现（可放大预览）。
 */
export default function PublishRecordDetailPage() {
  const { recordId } = useParams<{ recordId: string }>()

  const recordQuery = useQuery({
    queryKey: ['publish-record', recordId],
    queryFn: () => publishApi.fetchPublishRecordDetail(recordId!),
    enabled: Boolean(recordId),
    retry: false,
  })
  const assetsQuery = useQuery({
    queryKey: ['assets'],
    queryFn: () => assetsApi.listAssets('image', 100),
    enabled: Boolean(recordQuery.data),
  })

  const record = recordQuery.data
  const assets = useMemo(() => assetsQuery.data?.items ?? [], [assetsQuery.data])
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets])

  const coverAsset = record?.cover_asset_id ? assetById.get(record.cover_asset_id) : undefined

  const bodyMarkdown = useMemo(() => {
    if (!record) return ''
    return mapImagePathsToUrls(stripFrontmatter(record.content_snapshot), assets)
  }, [record, assets])

  if (recordQuery.isPending) {
    return (
      <div className="workspace-loading">
        <Spin />
      </div>
    )
  }

  if (recordQuery.error || !record) {
    return (
      <div className="workspace-error">
        <h2>发布记录不存在</h2>
        <p>{(recordQuery.error as ApiError | null)?.message ?? '记录可能已被删除。'}</p>
        <Button type="primary" onClick={() => history.back()}>
          返回发布记录
        </Button>
      </div>
    )
  }

  return (
    <div className="publish-record-detail">
      <div className="workspace-topbar">
        <div className="workspace-identity">
          <span className="workspace-eyebrow">SNAPSHOT</span>
          <h1 className="workspace-title">发布快照</h1>
        </div>
        {record.status === 'succeeded' ? (
          <Tag color="success">成功</Tag>
        ) : (
          <Tag color="error">失败</Tag>
        )}
      </div>

      {record.status === 'failed' && (
        <StatusBanner
          kind="error"
          message={record.error_message ?? '发布失败'}
          description={`错误码：${record.error_code ?? 'UNKNOWN'}`}
        />
      )}

      <div className="publish-snapshot-meta">
        <div className="publish-snapshot-fields">
          <p>
            <Typography.Text type="secondary">文章标题：</Typography.Text>
            {record.article_title ?? '（文章已删除）'}
          </p>
          <p>
            <Typography.Text type="secondary">主题：</Typography.Text>
            {record.theme_id}
          </p>
          <p>
            <Typography.Text type="secondary">media_id：</Typography.Text>
            {record.media_id ? <code>{record.media_id}</code> : '—'}
          </p>
          <p>
            <Typography.Text type="secondary">作者：</Typography.Text>
            {record.author || '—'}
          </p>
          <p>
            <Typography.Text type="secondary">发布时间：</Typography.Text>
            {formatDate(record.created_at)}
          </p>
        </div>
        {coverAsset && (
          <div className="publish-snapshot-cover">
            <Typography.Text type="secondary">封面</Typography.Text>
            <Image
              src={resolveImageUrl(coverAsset.storage_url)}
              alt={coverAsset.title}
              width={120}
            />
          </div>
        )}
      </div>

      <section className="publish-snapshot-body" aria-label="发布内容快照">
        <MarkdownView content={bodyMarkdown} />
      </section>
    </div>
  )
}
