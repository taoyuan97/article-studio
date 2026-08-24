import { Button, Empty, Select, Typography } from 'antd'
import type { Asset, ImagePlacement, PublishSection } from '../../api/types'
import { resolveImageUrl } from '../../lib/format'
import { movePlacement, positionLabel, positionOptions } from './placements'

interface ImagePlacementEditorProps {
  /** 本文配图：当前文章关联配图会话下已保存的素材（置顶分组，仅非空时展示） */
  articleAssets: Asset[]
  /** 素材库图片：其余全部图片素材（独立配图会话等，不关联当前文章） */
  libraryAssets: Asset[]
  /** 勾选顺序（与 placements 的 asset_id 集合一致） */
  selectedAssetIds: string[]
  placements: ImagePlacement[]
  sections: PublishSection[]
  onToggleAsset: (assetId: string, checked: boolean) => void
  onPlacementsChange: (placements: ImagePlacement[]) => void
}

/**
 * 步骤 2「配图与位置」编辑器（封面与作者已前移至步骤 1「版本和信息」）：
 * - 上：可选图片缩略图墙，分「本文配图」（文章关联会话素材）与「素材库图片」
 *   （其余全部素材）两组，点击勾选/取消，勾选顺序即默认插入顺序；
 * - 下：已选图片卡片（缩略图、标题、上移/下移、独立位置选择器）。
 */
export default function ImagePlacementEditor({
  articleAssets,
  libraryAssets,
  selectedAssetIds,
  placements,
  sections,
  onToggleAsset,
  onPlacementsChange,
}: ImagePlacementEditorProps) {
  const selectedSet = new Set(selectedAssetIds)
  const allAssets = [...articleAssets, ...libraryAssets]
  const assetById = new Map(allAssets.map((asset) => [asset.id, asset]))
  const orderedPlacements = [...placements].sort((a, b) => a.order - b.order)
  const options = positionOptions(sections)

  const renderPickerItem = (asset: Asset) => {
    const checked = selectedSet.has(asset.id)
    return (
      <button
        type="button"
        key={asset.id}
        className={`publish-picker-item${checked ? ' is-selected' : ''}`}
        aria-pressed={checked}
        onClick={() => onToggleAsset(asset.id, !checked)}
        title={asset.title}
      >
        <img src={resolveImageUrl(asset.storage_url)} alt={asset.title} loading="lazy" />
        <span className="publish-picker-title">{asset.title}</span>
        <span className="publish-picker-check" aria-hidden="true">
          {checked ? '✓' : '+'}
        </span>
      </button>
    )
  }

  return (
    <div className="publish-placement-editor">
      <section className="publish-picker" aria-label="可选配图">
        <h3 className="publish-step-heading">选择配图</h3>
        {allAssets.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="素材库还没有图片素材，可先在配图工作台生成并保存素材。"
          />
        ) : (
          <>
            {articleAssets.length > 0 && (
              <div className="publish-picker-group">
                <h4 className="publish-picker-group-title">本文配图（{articleAssets.length}）</h4>
                <div className="publish-picker-grid">
                  {articleAssets.map(renderPickerItem)}
                </div>
              </div>
            )}
            {libraryAssets.length > 0 && (
              <div className="publish-picker-group">
                <h4 className="publish-picker-group-title">
                  素材库图片（{libraryAssets.length}）
                </h4>
                <div className="publish-picker-grid">{libraryAssets.map(renderPickerItem)}</div>
              </div>
            )}
          </>
        )}
      </section>

      <section className="publish-selected" aria-label="已选图片与插入位置">
        <h3 className="publish-step-heading">已选图片（{orderedPlacements.length}）</h3>
        {orderedPlacements.length === 0 ? (
          <Typography.Text type="secondary">
            未选择图片时发布纯文字版本；微信要求封面或正文至少一张图，纯文字发布需先在「版本和信息」步骤选择封面。
          </Typography.Text>
        ) : (
          <ul className="publish-card-list">
            {orderedPlacements.map((placement, index) => {
              const asset = assetById.get(placement.asset_id)
              if (!asset) return null
              return (
                <li className="publish-card" key={placement.asset_id}>
                  <span className="publish-card-thumb">
                    <img src={resolveImageUrl(asset.storage_url)} alt={asset.title} />
                  </span>
                  <span className="publish-card-info">
                    <span className="publish-card-title">{asset.title}</span>
                    <span className="publish-card-position">
                      插入位置：{positionLabel(placement.position, sections)}
                    </span>
                  </span>
                  <span className="publish-card-actions">
                    <Select
                      size="small"
                      value={placement.position}
                      options={options}
                      onChange={(position) =>
                        onPlacementsChange(
                          placements.map((item) =>
                            item.asset_id === placement.asset_id ? { ...item, position } : item,
                          ),
                        )
                      }
                      aria-label={`${asset.title} 插入位置`}
                      className="publish-position-select"
                    />
                    <Button
                      size="small"
                      disabled={index === 0}
                      onClick={() =>
                        onPlacementsChange(movePlacement(placements, placement.asset_id, 'up'))
                      }
                      aria-label={`${asset.title} 上移`}
                    >
                      上移
                    </Button>
                    <Button
                      size="small"
                      disabled={index === orderedPlacements.length - 1}
                      onClick={() =>
                        onPlacementsChange(movePlacement(placements, placement.asset_id, 'down'))
                      }
                      aria-label={`${asset.title} 下移`}
                    >
                      下移
                    </Button>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
