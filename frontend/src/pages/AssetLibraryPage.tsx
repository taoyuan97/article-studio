import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { App, Button, Modal, Skeleton, Space, Spin, Typography } from 'antd'
import { assetsApi } from '../api/assets'
import type { ApiError } from '../api/client'
import { imageSessionsApi } from '../api/imageSessions'
import StatusBanner from '../components/StatusBanner'
import { formatDate, modelLabel, resolveImageUrl } from '../lib/format'

/**
 * 素材库页：
 * - 素材列表（limit=100）：缩略图、标题、来源信息（生成模型）、更新时间；
 * - 点击查看详情（GET /api/assets/{id}），可跳回来源配图会话；
 * - "新建配图"入口 → POST /api/image-sessions → 跳转配图工作台；
 * - 加载 / 空态 / 错误态完整处理。
 */
export default function AssetLibraryPage() {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const [detailId, setDetailId] = useState<string | null>(null)

  const listQuery = useQuery({
    queryKey: ['assets'],
    queryFn: () => assetsApi.listAssets('image', 100),
  })

  const detailQuery = useQuery({
    queryKey: ['asset', detailId],
    queryFn: () => assetsApi.getAsset(detailId!),
    enabled: Boolean(detailId),
    retry: false,
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

  const assets = listQuery.data?.items ?? []

  return (
    <div className="asset-library-page">
      <div className="page-toolbar">
        <div>
          <h1 className="page-title">素材</h1>
          <Typography.Text type="secondary">
            {listQuery.isPending ? '正在载入……' : `显示 ${assets.length} 个素材`}
          </Typography.Text>
        </div>
        <Space>
          <Button onClick={() => listQuery.refetch()} loading={listQuery.isFetching}>
            刷新
          </Button>
          <Button
            type="primary"
            loading={createSessionMutation.isPending}
            onClick={() => createSessionMutation.mutate()}
          >
            新建配图
          </Button>
        </Space>
      </div>

      {listQuery.error && (
        <StatusBanner
          kind="error"
          message={(listQuery.error as ApiError).message ?? '加载素材列表失败'}
          description={`错误码：${(listQuery.error as ApiError).code ?? 'UNKNOWN'}`}
        />
      )}

      {listQuery.isPending ? (
        <div className="asset-grid">
          {Array.from({ length: 6 }, (_, index) => (
            <div className="asset-card asset-card-skeleton" key={index}>
              <Skeleton.Image active />
              <Skeleton active paragraph={{ rows: 1 }} title={{ width: '60%' }} />
            </div>
          ))}
        </div>
      ) : assets.length === 0 ? (
        <div className="table-empty">
          <h3>还没有素材</h3>
          <p>在配图工作台生成图片并保存到素材库。</p>
          <Button
            type="primary"
            loading={createSessionMutation.isPending}
            onClick={() => createSessionMutation.mutate()}
          >
            去新增配图
          </Button>
        </div>
      ) : (
        <div className="asset-grid">
          {assets.map((asset) => (
            <button
              type="button"
              className="asset-card"
              key={asset.id}
              onClick={() => setDetailId(asset.id)}
              title={asset.title}
            >
              <span className="asset-thumb">
                <img src={resolveImageUrl(asset.storage_url)} alt={asset.title} loading="lazy" />
              </span>
              <span className="asset-info">
                <span className="asset-title">{asset.title}</span>
                <span className="asset-meta">
                  {modelLabel(asset.provider, asset.model)} · {formatDate(asset.updated_at)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      <Modal
        title="素材详情"
        open={Boolean(detailId)}
        footer={null}
        onCancel={() => setDetailId(null)}
        width={720}
        destroyOnHidden
      >
        {detailQuery.isPending ? (
          <div className="workspace-loading">
            <Spin />
          </div>
        ) : detailQuery.error ? (
          <StatusBanner kind="error" message={(detailQuery.error as ApiError).message} />
        ) : detailQuery.data ? (
          <div className="asset-detail">
            <div className="asset-detail-image">
              <img src={resolveImageUrl(detailQuery.data.storage_url)} alt={detailQuery.data.title} />
            </div>
            <div className="asset-detail-meta">
              <Typography.Title level={5}>{detailQuery.data.title}</Typography.Title>
              <p>
                <Typography.Text type="secondary">生成模型：</Typography.Text>
                {modelLabel(detailQuery.data.provider, detailQuery.data.model)}
              </p>
              <p>
                <Typography.Text type="secondary">更新时间：</Typography.Text>
                {formatDate(detailQuery.data.updated_at)}
              </p>
              {detailQuery.data.metadata.image_prompt && (
                <p>
                  <Typography.Text type="secondary">生成提示词：</Typography.Text>
                  {detailQuery.data.metadata.image_prompt}
                </p>
              )}
              {detailQuery.data.metadata.width != null && detailQuery.data.metadata.height != null && (
                <p>
                  <Typography.Text type="secondary">尺寸：</Typography.Text>
                  {detailQuery.data.metadata.width} × {detailQuery.data.metadata.height}
                </p>
              )}
              {detailQuery.data.metadata.seed != null && (
                <p>
                  <Typography.Text type="secondary">种子：</Typography.Text>
                  {String(detailQuery.data.metadata.seed)}
                </p>
              )}
              {detailQuery.data.source_session_id && (
                <Link to={`/image-sessions/${encodeURIComponent(detailQuery.data.source_session_id)}`}>
                  查看来源配图会话 →
                </Link>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
