import { useEffect, useState } from 'react'
import { Button, Input, Space, Spin, Typography } from 'antd'

export interface ThemePreviewPanelProps {
  /** 是否已选主题（未选时显示空态引导，不发起渲染） */
  themeSelected: boolean
  /** 渲染后的主题 HTML（iframe srcDoc 注入，sandbox 禁脚本） */
  html: string | undefined
  /** 渲染中（组装 + 主题渲染，覆盖加载态） */
  rendering: boolean
  /** 组装 / 渲染错误信息 */
  error: string | null
  onRetry: () => void
  /** 编辑模式（预览区原位切换 Markdown 编辑框） */
  editing: boolean
  /** 当前源 Markdown（组装结果或编辑终稿） */
  editedMarkdown: string
  onStartEdit: () => void
  onFinishEdit: (markdown: string) => void
  onCancelEdit: () => void
}

/**
 * 主题预览面板（选主题步骤右侧）：
 * - 手机框 iframe（sandbox 禁脚本）以 srcDoc 注入主题渲染 HTML，宽度模拟公众号阅读版式；
 * - 默认只读渲染，点【编辑】原位切换 Markdown 编辑框，【完成编辑】后重新渲染（所见即所发）；
 * - 未选主题显示空态引导；渲染失败显示错误与重试。
 */
export default function ThemePreviewPanel({
  themeSelected,
  html,
  rendering,
  error,
  onRetry,
  editing,
  editedMarkdown,
  onStartEdit,
  onFinishEdit,
  onCancelEdit,
}: ThemePreviewPanelProps) {
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (editing) setDraft(editedMarkdown)
    // editedMarkdown 不入依赖：进入编辑时快照一次，编辑期间不随外部重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  return (
    <div className="publish-theme-preview" aria-label="主题预览">
      <div className="publish-theme-preview-toolbar">
        <Typography.Text type="secondary" className="publish-theme-preview-hint">
          {editing
            ? '编辑 Markdown（发布以编辑后内容为准），完成编辑后重新渲染预览。'
            : '预览与发布使用同一渲染引擎，效果一致。'}
        </Typography.Text>
        {editing ? (
          <Space>
            <Button size="small" onClick={onCancelEdit}>
              取消编辑
            </Button>
            <Button
              size="small"
              type="primary"
              onClick={() => onFinishEdit(draft)}
              aria-label="完成编辑"
            >
              完成编辑
            </Button>
          </Space>
        ) : (
          <Button size="small" onClick={onStartEdit}>
            编辑
          </Button>
        )}
      </div>

      {editing ? (
        <Input.TextArea
          className="publish-markdown-editor"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={20}
          aria-label="发布 Markdown 编辑框"
        />
      ) : error ? (
        <div className="publish-theme-preview-state">
          <p className="publish-theme-preview-error">{error}</p>
          <Button onClick={onRetry}>重试</Button>
        </div>
      ) : !themeSelected ? (
        <div className="publish-theme-preview-state">
          <p className="publish-theme-preview-empty">请选择主题查看排版效果</p>
        </div>
      ) : (
        <div className="publish-theme-preview-frame">
          {html ? (
            <iframe title="主题预览" sandbox="" srcDoc={html} />
          ) : null}
          {rendering && (
            <div className="publish-theme-preview-loading">
              <Spin />
              <Typography.Text type="secondary">正在渲染主题预览……</Typography.Text>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
