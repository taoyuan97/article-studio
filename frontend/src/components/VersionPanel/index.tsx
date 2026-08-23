import { memo } from 'react'
import { Button, Select, Tag } from 'antd'
import type { SelectProps } from 'antd'
import { formatDate, modelLabel } from '../../lib/format'
import type { ArticleVersion, ArticleVersionSummary } from '../../api/types'

export interface VersionPanelProps {
  versions: ArticleVersionSummary[]
  currentVersion: ArticleVersion | null
  /** 正在查看的历史版本详情（null = 当前版本） */
  selectedVersion: ArticleVersion | null
  /** 选择版本：传 null 返回当前版本 */
  onSelect: (versionId: string) => void
  onReturnCurrent: () => void
  loading?: boolean
}

/**
 * 版本面板：
 * - 当前版本 / 历史版本分组展示（版本号、标题、模型、时间）；
 * - 历史版本只读查看（标记"历史版本，只读"），可返回当前版本；
 * - 不提供恢复 / 删除 / 编辑。
 */
const VersionPanel = memo(function VersionPanel({
  versions,
  currentVersion,
  selectedVersion,
  onSelect,
  onReturnCurrent,
  loading,
}: VersionPanelProps) {
  const currentId = currentVersion?.id ?? null
  const displayedId = selectedVersion?.id ?? currentId
  const history = versions.filter((version) => version.id !== currentId)
  const displayed = selectedVersion ?? currentVersion

  const options: SelectProps['options'] =
    versions.length === 0
      ? [{ value: '__none__', label: '暂无版本', disabled: true }]
      : [
          ...(currentVersion
            ? [
                {
                  key: 'current',
                  label: '当前版本',
                  options: [
                    {
                      value: currentVersion.id,
                      label: `v${currentVersion.version_number} · ${currentVersion.title}`,
                    },
                  ],
                },
              ]
            : []),
          ...(history.length > 0
            ? [
                {
                  key: 'history',
                  label: '历史版本',
                  options: history.map((version) => ({
                    value: version.id,
                    label: `v${version.version_number} · ${version.title}`,
                  })),
                },
              ]
            : []),
        ]

  return (
    <div className="version-panel">
      <Select
        className="version-select"
        aria-label="选择版本"
        value={versions.length === 0 ? '__none__' : (displayedId ?? undefined)}
        options={options}
        disabled={versions.length === 0 || loading}
        onChange={(value: string) => onSelect(value)}
        style={{ minWidth: 180, maxWidth: 280 }}
        popupMatchSelectWidth={false}
      />
      {selectedVersion && (
        <>
          <Tag className="version-history-tag" color="orange">
            历史版本，只读
          </Tag>
          <Button size="small" onClick={onReturnCurrent}>
            返回当前版本
          </Button>
        </>
      )}
      {displayed && (
        <span className="version-meta">
          {modelLabel(displayed.provider, displayed.model)} · {formatDate(displayed.created_at)}
        </span>
      )}
    </div>
  )
})

export default VersionPanel
