import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Segmented, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { articlesApi } from '../api/articles'
import { publishApi } from '../api/publish'
import type { ApiError } from '../api/client'
import type { PublishRecord } from '../api/types'
import StatusBanner from '../components/StatusBanner'
import { formatDate } from '../lib/format'

type StatusFilter = '全部' | '成功' | '失败'

/**
 * 发布记录页（侧边栏「发布记录」）：
 * - 时间倒序列表：发布时间、文章标题、主题、状态徽标、media_id；
 * - 支持按状态筛选（本地）与按文章过滤（URL ?article_id=，来自工作台/发布成功页跳转）；
 * - 失败记录可展开错误码与错误信息；行操作「查看快照」进详情页。
 */
export default function PublishRecordsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const articleFilter = searchParams.get('article_id')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('全部')

  const recordsQuery = useQuery({
    queryKey: ['publish-records', articleFilter],
    queryFn: () => publishApi.fetchPublishRecords(articleFilter),
  })
  const articlesQuery = useQuery({
    queryKey: ['articles'],
    queryFn: () => articlesApi.listArticles(),
  })

  const filterArticleTitle = useMemo(
    () =>
      articlesQuery.data?.items.find((item) => item.id === articleFilter)?.title ?? articleFilter,
    [articlesQuery.data, articleFilter],
  )

  const records = (recordsQuery.data?.items ?? []).filter((record) =>
    statusFilter === '全部'
      ? true
      : statusFilter === '成功'
        ? record.status === 'succeeded'
        : record.status === 'failed',
  )

  const columns: ColumnsType<PublishRecord> = [
    {
      title: '发布时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 150,
      render: (value: string) => formatDate(value),
    },
    {
      title: '文章标题',
      dataIndex: 'article_title',
      key: 'article_title',
      render: (value: string | null) => value ?? '（文章已删除）',
    },
    { title: '主题', dataIndex: 'theme_id', key: 'theme_id', width: 120 },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (status: PublishRecord['status']) =>
        status === 'succeeded' ? (
          <Tag color="success">成功</Tag>
        ) : (
          <Tag color="error">失败</Tag>
        ),
    },
    {
      title: 'media_id',
      dataIndex: 'media_id',
      key: 'media_id',
      render: (value: string | null) => (value ? <code>{value}</code> : '—'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 110,
      render: (_, record) => (
        <Button type="link" size="small" onClick={() => navigate(`/publish-records/${record.id}`)}>
          查看快照
        </Button>
      ),
    },
  ]

  return (
    <div className="publish-records-page">
      <div className="page-toolbar">
        <div>
          <h1 className="page-title">发布记录</h1>
          <Typography.Text type="secondary">
            {recordsQuery.isPending ? '正在载入……' : `共 ${records.length} 条记录`}
            {articleFilter && ` · 按文章过滤：${filterArticleTitle}`}
          </Typography.Text>
        </div>
        <Space>
          {articleFilter && (
            <Button onClick={() => setSearchParams({})}>清除文章过滤</Button>
          )}
          <Segmented<StatusFilter>
            value={statusFilter}
            onChange={setStatusFilter}
            options={['全部', '成功', '失败']}
          />
        </Space>
      </div>

      {recordsQuery.error && (
        <StatusBanner
          kind="error"
          message={(recordsQuery.error as ApiError).message ?? '加载发布记录失败'}
          description={`错误码：${(recordsQuery.error as ApiError).code ?? 'UNKNOWN'}`}
        />
      )}

      {recordsQuery.isPending ? (
        <div className="workspace-loading">
          <Button loading shape="circle" />
        </div>
      ) : records.length === 0 && statusFilter === '全部' && !articleFilter ? (
        <div className="table-empty">
          <h3>还没有发布记录</h3>
          <p>从文章工作台发布第一篇文章，发布结果会出现在这里。</p>
          <Link to="/articles">
            <Button type="primary">去文章列表</Button>
          </Link>
        </div>
      ) : (
        <Table<PublishRecord>
          rowKey="id"
          columns={columns}
          dataSource={records}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          size="middle"
          expandable={{
            rowExpandable: (record) => record.status === 'failed',
            expandedRowRender: (record) => (
              <div className="publish-record-error">
                <p>
                  错误码：<code>{record.error_code ?? 'UNKNOWN'}</code>
                </p>
                {record.error_message && <p>错误信息：{record.error_message}</p>}
              </div>
            ),
          }}
          locale={{ emptyText: '没有匹配的发布记录' }}
        />
      )}
    </div>
  )
}
