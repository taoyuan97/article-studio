import { Button, Empty } from 'antd'
import type { Asset, ImagePlacement, PublishBlock } from '../../api/types'
import MarkdownView from '../../components/MarkdownView'
import { resolveImageUrl } from '../../lib/format'

interface ArticleCanvasProps {
  blocks: PublishBlock[]
  placements: ImagePlacement[]
  assets: Asset[]
  /** 当前插入锚点（null = 未设置） */
  anchorBlockIndex: number | null
  onBlockClick: (blockIndex: number) => void
  onRemoveAsset: (assetId: string) => void
}

/**
 * 正文画布（步骤 2「配图与位置」）：
 * - 按后端返回的顶层块渲染正文（Markdown 安全渲染，块编号与组装锚点一致）；
 * - 点击任意块设置插入锚点，锚点块高亮并显示插入指示线；
 * - 已插图内联显示在对应块之后，hover 浮出删除按钮；
 * - 同锚点多图按插入顺序（order 升序）排列；退化位置（文末）显示在画布末尾。
 */
export default function ArticleCanvas({
  blocks,
  placements,
  assets,
  anchorBlockIndex,
  onBlockClick,
  onRemoveAsset,
}: ArticleCanvasProps) {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]))

  const renderInlineImages = (position: string) => {
    const items = placements
      .filter((item) => item.position === position)
      .sort((a, b) => a.order - b.order)
    if (items.length === 0) return null
    return (
      <div className="publish-canvas-images">
        {items.map((item) => {
          const asset = assetById.get(item.asset_id)
          if (!asset) return null
          return (
            <figure className="publish-canvas-image" key={item.asset_id}>
              <img src={resolveImageUrl(asset.storage_url)} alt={asset.title} loading="lazy" />
              <figcaption>
                <span className="publish-canvas-image-title">{asset.title}</span>
                <Button
                  size="small"
                  danger
                  aria-label={`${asset.title} 删除`}
                  onClick={() => onRemoveAsset(item.asset_id)}
                >
                  删除
                </Button>
              </figcaption>
            </figure>
          )
        })}
      </div>
    )
  }

  if (blocks.length === 0) {
    return (
      <div className="publish-canvas" aria-label="正文画布">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="正文为空，请先撰写正文后再插入配图。"
        />
      </div>
    )
  }

  return (
    <div className="publish-canvas" aria-label="正文画布">
      {blocks.map((block) => (
        <div className="publish-canvas-block-wrap" key={block.index}>
          <div
            className={`publish-canvas-block${anchorBlockIndex === block.index ? ' is-anchor' : ''}`}
            data-block-index={block.index}
            onClick={() => onBlockClick(block.index)}
            title="点击选择插入位置"
          >
            <MarkdownView content={block.text} />
          </div>
          {renderInlineImages(`after_block_${block.index}`)}
          {anchorBlockIndex === block.index && (
            <div className="publish-canvas-anchor-line" aria-live="polite">
              ↳ 将插入到这里
            </div>
          )}
        </div>
      ))}
      {renderInlineImages('bottom')}
    </div>
  )
}
