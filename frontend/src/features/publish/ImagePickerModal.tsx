import { useEffect, useState } from 'react'
import { Button, Empty, Modal } from 'antd'
import type { Asset } from '../../api/types'
import { resolveImageUrl } from '../../lib/format'

interface ImagePickerModalProps {
  open: boolean
  /** 本文配图：当前文章关联配图会话下已保存的素材（置顶分组，仅非空时展示） */
  articleAssets: Asset[]
  /** 素材库图片：其余全部图片素材 */
  libraryAssets: Asset[]
  /** 已插入正文的素材（同一素材不可重复插入，置灰不可选） */
  selectedAssetIds: string[]
  /** 确定插入（按勾选顺序）并关闭弹窗 */
  onConfirm: (assetIds: string[]) => void
  onCancel: () => void
}

/**
 * 插图选择弹窗（步骤 2「配图与位置」，交互参照步骤 1 封面弹窗）：
 * 分组缩略图墙多选——「本文配图」置顶 +「素材库图片」；
 * 已插入的素材置灰并标「已插入」；确定后按勾选顺序插入当前锚点。
 */
export default function ImagePickerModal({
  open,
  articleAssets,
  libraryAssets,
  selectedAssetIds,
  onConfirm,
  onCancel,
}: ImagePickerModalProps) {
  const [draftIds, setDraftIds] = useState<string[]>([])

  // 每次打开重置草稿勾选（不预选）
  useEffect(() => {
    if (open) setDraftIds([])
  }, [open])

  const insertedSet = new Set(selectedAssetIds)
  const allAssets = [...articleAssets, ...libraryAssets]

  const renderItem = (asset: Asset) => {
    const inserted = insertedSet.has(asset.id)
    const checked = draftIds.includes(asset.id)
    const className = [
      'publish-picker-item',
      checked ? 'is-selected' : '',
      inserted ? 'is-disabled' : '',
    ]
      .filter(Boolean)
      .join(' ')
    return (
      <button
        type="button"
        key={asset.id}
        className={className}
        aria-pressed={checked}
        disabled={inserted}
        onClick={() =>
          setDraftIds((prev) =>
            prev.includes(asset.id) ? prev.filter((id) => id !== asset.id) : [...prev, asset.id],
          )
        }
        title={inserted ? `${asset.title}（已插入）` : asset.title}
      >
        <img src={resolveImageUrl(asset.storage_url)} alt={asset.title} loading="lazy" />
        <span className="publish-picker-title">{asset.title}</span>
        {inserted ? (
          <span className="publish-picker-badge">已插入</span>
        ) : (
          <span className="publish-picker-check" aria-hidden="true">
            {checked ? '✓' : '+'}
          </span>
        )}
      </button>
    )
  }

  return (
    <Modal
      open={open}
      title="插入配图"
      width={720}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Button
          key="ok"
          type="primary"
          disabled={draftIds.length === 0}
          onClick={() => onConfirm(draftIds)}
        >
          确定{draftIds.length > 0 ? `（已选 ${draftIds.length} 张）` : ''}
        </Button>,
      ]}
    >
      {allAssets.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="素材库还没有图片素材，可先在配图工作台生成并保存素材。"
        />
      ) : (
        <div className="publish-cover-modal-body">
          {articleAssets.length > 0 && (
            <div className="publish-picker-group">
              <h4 className="publish-picker-group-title">本文配图（{articleAssets.length}）</h4>
              <div className="publish-picker-grid">{articleAssets.map(renderItem)}</div>
            </div>
          )}
          {libraryAssets.length > 0 && (
            <div className="publish-picker-group">
              <h4 className="publish-picker-group-title">素材库图片（{libraryAssets.length}）</h4>
              <div className="publish-picker-grid">{libraryAssets.map(renderItem)}</div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
