import type { ImagePlacement, PublishBlock } from '../../api/types'

/**
 * 图片插入位置工具（块级锚点模型）：
 * - position 形如 `after_block_{n}`（第 n 块之后，正文画布锚点）；
 * - `bottom` 为版本切换后失效锚点的退化位置（决策：保留图片、退到文末）；
 * - 同一 position 内按 order 升序排列（即插入顺序）；
 * - `top` / `after_section_{n}` 为历史兼容值，新向导不再产生。
 */

const AFTER_BLOCK_PATTERN = /^after_block_(\d+)$/

/** 位置可读标签：`第 n 块之后 · 摘要` / `文末` / `文首`；历史值原样返回 */
export function positionLabel(position: string, blocks: PublishBlock[]): string {
  if (position === 'top') return '文首'
  if (position === 'bottom') return '文末'
  const match = AFTER_BLOCK_PATTERN.exec(position)
  if (match) {
    const index = Number(match[1])
    const block = blocks.find((item) => item.index === index)
    const summary = block?.preview ? ` · ${block.preview}` : ''
    return `第 ${index} 块之后${summary}`
  }
  return position
}

/**
 * 版本切换后块数变化时的退化处理（决策 ⑥）：
 * `after_block_{i}` 超出新块数的位置重置为 `bottom`（图片保留），返回退化数量供界面提示。
 */
export function sanitizePlacements(
  placements: ImagePlacement[],
  blocks: PublishBlock[],
): { placements: ImagePlacement[]; degradedCount: number } {
  const maxIndex = blocks.length
  let degradedCount = 0
  const next = placements.map((placement) => {
    const match = AFTER_BLOCK_PATTERN.exec(placement.position)
    if (match && Number(match[1]) > maxIndex) {
      degradedCount += 1
      return { ...placement, position: 'bottom' }
    }
    return placement
  })
  return { placements: next, degradedCount }
}
