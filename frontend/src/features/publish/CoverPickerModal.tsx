import { useEffect, useState } from 'react'
import { Button, Empty, Modal } from 'antd'
import type { Asset } from '../../api/types'
import { resolveImageUrl } from '../../lib/format'

interface CoverPickerModalProps {
  open: boolean
  /** 本文配图：当前文章关联配图会话下已保存的素材（置顶分组，仅非空时展示） */
  articleAssets: Asset[]
  /** 素材库图片：其余全部图片素材（未选文章时为全部素材） */
  libraryAssets: Asset[]
  /** 当前已选封面（null = 未选） */
  selectedAssetId: string | null
  /** 确定或清除封面后提交（null 表示清除）并关闭弹窗 */
  onSelect: (assetId: string | null) => void
  onCancel: () => void
}

/**
 * 封面选择弹窗（步骤 1「版本和信息」）：
 * 全部图片素材分组单选——「本文配图」置顶（选文章后出现）+「素材库图片」。
 * 封面是微信草稿的独立字段，可选择不插入正文的图。
 */
export default function CoverPickerModal({
  open,
  articleAssets,
  libraryAssets,
  selectedAssetId,
  onSelect,
  onCancel,
}: CoverPickerModalProps) {
  const [draftId, setDraftId] = useState<string | null>(selectedAssetId)

  // 每次打开时以当前封面初始化草稿选择
  useEffect(() => {
    if (open) setDraftId(selectedAssetId)
  }, [open, selectedAssetId])

  const allAssets = [...articleAssets, ...libraryAssets]

  const renderItem = (asset: Asset) => {
    const selected = draftId === asset.id
    return (
      <button
        type="button"
        key={asset.id}
        className={`publish-picker-item${selected ? ' is-selected' : ''}`}
        aria-pressed={selected}
        onClick={() => setDraftId(selected ? null : asset.id)}
        title={asset.title}
      >
        <img src={resolveImageUrl(asset.storage_url)} alt={asset.title} loading="lazy" />
        <span className="publish-picker-title">{asset.title}</span>
        <span className="publish-picker-check" aria-hidden="true">
          {selected ? '✓' : '+'}
        </span>
      </button>
    )
  }

  return (
    <Modal
      open={open}
      title="选择封面"
      width={720}
      onCancel={onCancel}
      footer={[
        <Button key="clear" onClick={() => onSelect(null)}>
          清除封面
        </Button>,
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Button key="ok" type="primary" disabled={!draftId} onClick={() => onSelect(draftId)}>
          确定
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
              <div className="publish-picker-grid">
                {articleAssets.map(renderItem)}
              </div>
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
