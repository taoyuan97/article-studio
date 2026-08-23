import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { App, Button, Input, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { articlesApi } from '../api/articles'
import type { ApiError } from '../api/client'
import type { ArticleListItem } from '../api/types'
import StatusBanner from '../components/StatusBanner'
import { formatDate, modelLabel, statusLabel } from '../lib/format'

const STATUS_TAG_COLOR: Record<string, string> = {
  draft: 'default',
  generated: 'green',
  running: 'processing',
  failed: 'error',
}

/**
 * 文章列表页：
 * - TanStack Query 加载最近 100 篇（按更新时间倒序，后端排序）；
 * - 标题关键词前端过滤（忽略大小写、去首尾空白、空关键词恢复全部、只匹配标题）；
 * - 新建文章 → 跳转工作台；加载 / 空态 / 错误态完整处理。
 */
export default function ArticleListPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { message } = App.useApp()
  const [keyword, setKeyword] = useState('')

  const listQuery = useQuery({
    queryKey: ['articles'],
    queryFn: () => articlesApi.listArticles(100),
  })

  const createMutation = useMutation({
    mutationFn: () => articlesApi.createArticle(),
    onSuccess: (article) => {
      queryClient.invalidateQueries({ queryKey: ['articles'] })
      navigate(`/articles/${encodeURIComponent(article.id)}`)
    },
    onError: (error: ApiError) => {
      message.error(error.message)
    },
  })

  const articles = useMemo(() => listQuery.data?.items ?? [], [listQuery.data])
  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase()
    if (!query) return articles
    return articles.filter((article) => article.title.toLowerCase().includes(query))
  }, [articles, keyword])

  const columns: ColumnsType<ArticleListItem> = [
    {
      title: '标题',
      dataIndex: 'title',
      key: 'title',
      render: (_, record) => (
        <Button
          type="link"
          className="article-title-link"
          onClick={() => navigate(`/articles/${encodeURIComponent(record.id)}`)}
        >
          {record.title}
        </Button>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (status: string) => (
        <Tag color={STATUS_TAG_COLOR[status] ?? 'default'}>{statusLabel(status)}</Tag>
      ),
    },
    {
      title: '摘要',
      dataIndex: 'summary',
      key: 'summary',
      ellipsis: true,
      render: (summary: string) => (
        <Typography.Text type="secondary">
          {summary || '尚无写作需求或正文。'}
        </Typography.Text>
      ),
    },
    {
      title: '版本数',
      dataIndex: 'version_count',
      key: 'version_count',
      width: 90,
      render: (count: number) => `${count} 个版本`,
    },
    {
      title: '模型',
      key: 'model',
      width: 220,
      ellipsis: true,
      render: (_, record) => modelLabel(record.provider, record.model),
    },
    {
      title: '更新时间',
      dataIndex: 'updated_at',
      key: 'updated_at',
      width: 130,
      render: (value: string) => formatDate(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 110,
      render: (_, record) => (
        <Button
          type="link"
          onClick={() => navigate(`/articles/${encodeURIComponent(record.id)}`)}
        >
          继续创作
        </Button>
      ),
    },
  ]

  return (
    <div className="article-list-page">
      <div className="page-toolbar">
        <div>
          <h1 className="page-title">文章</h1>
          <Typography.Text type="secondary">
            {listQuery.isPending
              ? '正在载入……'
              : `显示 ${filtered.length} / ${articles.length} 篇`}
          </Typography.Text>
        </div>
        <Space>
          <Input.Search
            allowClear
            placeholder="按标题搜索"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            style={{ width: 240 }}
          />
          <Button onClick={() => listQuery.refetch()} loading={listQuery.isFetching}>
            刷新
          </Button>
          <Button
            type="primary"
            loading={createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            新建文章
          </Button>
        </Space>
      </div>

      {listQuery.error && (
        <StatusBanner
          kind="error"
          message={(listQuery.error as ApiError).message ?? '加载文章列表失败'}
          description={`错误码：${(listQuery.error as ApiError).code ?? 'UNKNOWN'}`}
        />
      )}

      <Table<ArticleListItem>
        rowKey="id"
        columns={columns}
        dataSource={filtered}
        loading={listQuery.isPending}
        pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 篇` }}
        locale={{
          emptyText: (
            <div className="table-empty">
              <h3>{keyword.trim() ? '没有匹配的文章' : '还没有文章'}</h3>
              <p>
                {keyword.trim()
                  ? '换个关键词试试，或清空搜索查看全部文章。'
                  : '新建文章后，写作需求、完整对话和每次版本都会被保留下来。'}
              </p>
              {!keyword.trim() && (
                <Button
                  type="primary"
                  loading={createMutation.isPending}
                  onClick={() => createMutation.mutate()}
                >
                  新建文章
                </Button>
              )}
            </div>
          ),
        }}
      />
    </div>
  )
}
