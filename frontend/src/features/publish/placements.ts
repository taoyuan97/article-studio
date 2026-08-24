import type { ImagePlacement, PublishSection } from '../../api/types'

/**
 * 图片插入位置工具：
 * - position 形如 `top` / `bottom` / `after_section_{n}`（与后端校验规则一致）；
 * - 同一 position 内按 order 升序排列，上移/下移只影响同位置内的相对顺序。
 */

export function positionLabel(position: string, sections: PublishSection[]): string {
  if (position === 'top') return '文首'
  if (position === 'bottom') return '文末'
  const match = /^after_section_(\d+)$/.exec(position)
  if (match) {
    const index = Number(match[1])
    const section = sections.find((item) => item.index === index)
    const summary = section?.heading ? `「${truncate(section.heading, 12)}」` : ''
    return `第 ${index} 节之后${summary ? ` · ${summary}` : ''}`
  }
  return position
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 位置下拉选项：文首 / 各小节之后（附标题摘要）/ 文末 */
export function positionOptions(sections: PublishSection[]): { value: string; label: string }[] {
  return [
    { value: 'top', label: positionLabel('top', sections) },
    ...sections.map((section) => ({
      value: `after_section_${section.index}`,
      label: positionLabel(`after_section_${section.index}`, sections),
    })),
    { value: 'bottom', label: positionLabel('bottom', sections) },
  ]
}

/**
 * 默认位置：按勾选顺序均分到各小节（round-robin，第 i 张 → 第 (i % 小节数 + 1) 节之后）；
 * 无小节时（空正文）全部置于文末。
 */
export function computeDefaultPlacements(
  assetIds: string[],
  sections: PublishSection[],
): ImagePlacement[] {
  return assetIds.map((assetId, index) => ({
    asset_id: assetId,
    position:
      sections.length > 0
        ? `after_section_${(index % sections.length) + 1}`
        : 'bottom',
    order: index,
  }))
}

/** 上移/下移：与相邻的同位置项交换 order；无同位置邻居时不动 */
export function movePlacement(
  placements: ImagePlacement[],
  assetId: string,
  direction: 'up' | 'down',
): ImagePlacement[] {
  const sorted = [...placements].sort((a, b) => a.order - b.order)
  const current = sorted.find((item) => item.asset_id === assetId)
  if (!current) return placements
  const siblings = sorted.filter((item) => item.position === current.position)
  const siblingIndex = siblings.findIndex((item) => item.asset_id === assetId)
  const neighbor =
    direction === 'up' ? siblings[siblingIndex - 1] : siblings[siblingIndex + 1]
  if (!neighbor) return placements
  return placements.map((item) => {
    if (item.asset_id === current.asset_id) return { ...item, order: neighbor.order }
    if (item.asset_id === neighbor.asset_id) return { ...item, order: current.order }
    return item
  })
}
