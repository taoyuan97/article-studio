import { useEffect, useState } from 'react'
import { Alert, Button, Typography } from 'antd'
import type { Asset, ImagePlacement, PublishBlock } from '../../api/types'
import ArticleCanvas from './ArticleCanvas'
import ImagePickerModal from './ImagePickerModal'

interface ImagePlacementEditorProps {
  /** 本文配图：当前文章关联配图会话下已保存的素材（置顶分组，仅非空时展示） */
  articleAssets: Asset[]
  /** 素材库图片：其余全部图片素材（独立配图会话等，不关联当前文章） */
  libraryAssets: Asset[]
  /** 已插入正文的素材（与 placements 的 asset_id 集合一致） */
  selectedAssetIds: string[]
  placements: ImagePlacement[]
  /** 后端切分的正文顶层块（画布渲染与插入锚点的单一事实源） */
  blocks: PublishBlock[]
  /** 版本切换后失效锚点退到文末的图片数量（>0 时提示重新定位） */
  degradedCount: number
  onDismissDegraded: () => void
  /** 在锚点块之后按顺序插入素材 */
  onInsertAssets: (anchorBlockIndex: number, assetIds: string[]) => void
  onRemoveAsset: (assetId: string) => void
}

/**
 * 步骤 2「配图与位置」编辑器（主流编辑器范式）：
 * - 顶部工具栏：固定「插入配图」按钮 + 锚点状态提示；
 * - 正文画布：点击任意块设置插入锚点（插入指示线），已插图内联展示、hover 删除；
 * - 「插入配图」弹窗多选（分组缩略图墙，已插入素材置灰），确定后插入当前锚点。
 */
export default function ImagePlacementEditor({
  articleAssets,
  libraryAssets,
  selectedAssetIds,
  placements,
  blocks,
  degradedCount,
  onDismissDegraded,
  onInsertAssets,
  onRemoveAsset,
}: ImagePlacementEditorProps) {
  const [anchorBlockIndex, setAnchorBlockIndex] = useState<number | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  // 块变化（文章/版本切换）后重置锚点（旧锚点可能指向不同内容）
  useEffect(() => {
    setAnchorBlockIndex(null)
  }, [blocks])

  const assets = [...articleAssets, ...libraryAssets]
  const emptyBody = blocks.length === 0
  const insertDisabled = emptyBody || anchorBlockIndex === null

  const hintText = emptyBody
    ? '正文为空，请先撰写正文后再插入配图。'
    : anchorBlockIndex === null
      ? '点击正文任意位置选择插入点，再插入配图。'
      : `将在第 ${anchorBlockIndex} 块之后插入。`

  return (
    <div className="publish-placement-editor">
      {degradedCount > 0 && (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={onDismissDegraded}
          message={`版本切换后正文变短，${degradedCount} 张图片的插入位置已失效，已移至文末，请重新定位。`}
        />
      )}
      <div className="publish-canvas-toolbar">
        <Button type="primary" disabled={insertDisabled} onClick={() => setPickerOpen(true)}>
          插入配图
        </Button>
        <Typography.Text type="secondary" className="publish-canvas-toolbar-hint">
          {hintText}
        </Typography.Text>
        {placements.length === 0 && !emptyBody && (
          <Typography.Text type="secondary">
            未插图时发布纯文字版本，需在「版本和信息」步骤选择封面。
          </Typography.Text>
        )}
      </div>
      <ArticleCanvas
        blocks={blocks}
        placements={placements}
        assets={assets}
        anchorBlockIndex={anchorBlockIndex}
        onBlockClick={(index) =>
          setAnchorBlockIndex((prev) => (prev === index ? null : index))
        }
        onRemoveAsset={onRemoveAsset}
      />
      <ImagePickerModal
        open={pickerOpen}
        articleAssets={articleAssets}
        libraryAssets={libraryAssets}
        selectedAssetIds={selectedAssetIds}
        onConfirm={(assetIds) => {
          if (anchorBlockIndex !== null) onInsertAssets(anchorBlockIndex, assetIds)
          setPickerOpen(false)
        }}
        onCancel={() => setPickerOpen(false)}
      />
    </div>
  )
}
