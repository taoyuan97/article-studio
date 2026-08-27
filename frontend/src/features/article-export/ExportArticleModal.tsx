import { useEffect, useState } from 'react'
import { App, Modal, Radio, Select } from 'antd'
import type { ArticleVersion, ArticleVersionSummary } from '../../api/types'
import { exportFile, type ExportFormat } from './exportFile'
import { markdownToPlainText } from './markdownToPlainText'

interface ExportArticleModalProps {
  open: boolean
  versions: ArticleVersionSummary[]
  defaultVersionId: string | null
  onCancel: () => void
  resolveVersion: (versionId: string) => Promise<ArticleVersion>
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '请稍后重试。'
}

export default function ExportArticleModal({
  open,
  versions,
  defaultVersionId,
  onCancel,
  resolveVersion,
}: ExportArticleModalProps) {
  const { message } = App.useApp()
  const [versionId, setVersionId] = useState<string | null>(defaultVersionId)
  const [format, setFormat] = useState<ExportFormat>('markdown')
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    if (!open) return
    setVersionId(defaultVersionId)
    setFormat('markdown')
  }, [defaultVersionId, open])

  const handleExport = async () => {
    if (!versionId || exporting) return
    const versionSummary = versions.find((version) => version.id === versionId)
    if (!versionSummary) {
      message.error('导出失败：所选文章版本不存在')
      return
    }
    setExporting(true)
    try {
      const result = await exportFile({
        title: versionSummary.title,
        versionNumber: versionSummary.version_number,
        format,
        content: async () => {
          const version = await resolveVersion(versionId)
          return format === 'markdown'
            ? version.content_markdown
            : markdownToPlainText(version.content_markdown)
        },
      })

      if (result === 'cancelled') return
      if (result === 'downloaded') {
        message.info('当前浏览器不支持选择保存路径，文件已保存到浏览器下载目录')
      } else {
        message.success('文章已导出')
      }
      onCancel()
    } catch (error) {
      message.error(`导出失败：${errorMessage(error)}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <Modal
      title="导出文章"
      open={open}
      onCancel={onCancel}
      onOk={handleExport}
      okText="导出"
      cancelText="取消"
      confirmLoading={exporting}
      cancelButtonProps={{ disabled: exporting }}
      closable={!exporting}
      maskClosable={!exporting}
      keyboard={!exporting}
      destroyOnHidden
    >
      <div className="article-export-form">
        <div className="article-export-field">
          <label htmlFor="article-export-version">文章版本</label>
          <Select
            id="article-export-version"
            aria-label="导出版本"
            value={versionId ?? undefined}
            onChange={setVersionId}
            options={versions.map((version) => ({
              value: version.id,
              label: `v${version.version_number} · ${version.title}`,
            }))}
            disabled={exporting}
          />
        </div>
        <div className="article-export-field">
          <span className="article-export-label">导出格式</span>
          <Radio.Group
            aria-label="导出格式"
            value={format}
            onChange={(event) => setFormat(event.target.value as ExportFormat)}
            disabled={exporting}
          >
            <Radio value="markdown">Markdown 文档（.md）</Radio>
            <Radio value="txt">TXT 文本（.txt）</Radio>
          </Radio.Group>
        </div>
        <p className="article-export-hint">点击导出后，可在系统窗口中选择保存位置和文件名。</p>
      </div>
    </Modal>
  )
}
