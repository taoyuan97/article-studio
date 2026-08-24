import { describe, expect, it } from 'vitest'
import type { PublishBlock } from '../../api/types'
import { positionLabel, sanitizePlacements } from './placements'

function makeBlock(index: number, preview: string): PublishBlock {
  return { index, kind: 'paragraph', preview, text: preview }
}

describe('positionLabel', () => {
  const blocks = [makeBlock(1, '导语'), makeBlock(2, '一段比较长比较长的正文摘要')]

  it('文首/文末返回固定标签', () => {
    expect(positionLabel('top', blocks)).toBe('文首')
    expect(positionLabel('bottom', blocks)).toBe('文末')
  })

  it('after_block 返回「第 n 块之后 · 摘要」', () => {
    expect(positionLabel('after_block_1', blocks)).toBe('第 1 块之后 · 导语')
    expect(positionLabel('after_block_2', blocks)).toBe(
      '第 2 块之后 · 一段比较长比较长的正文摘要',
    )
  })

  it('越界块号与历史兼容值原样返回', () => {
    expect(positionLabel('after_block_9', blocks)).toBe('第 9 块之后')
    expect(positionLabel('after_section_2', blocks)).toBe('after_section_2')
  })
})

describe('sanitizePlacements', () => {
  const blocks = [makeBlock(1, 'a'), makeBlock(2, 'b'), makeBlock(3, 'c')]

  it('有效位置保持不变', () => {
    const placements = [
      { asset_id: 'p1', position: 'after_block_1', order: 0 },
      { asset_id: 'p2', position: 'after_block_3', order: 1 },
      { asset_id: 'p3', position: 'bottom', order: 2 },
    ]
    const result = sanitizePlacements(placements, blocks)
    expect(result.placements).toEqual(placements)
    expect(result.degradedCount).toBe(0)
  })

  it('越界 after_block 退化为 bottom 并计数', () => {
    const placements = [
      { asset_id: 'p1', position: 'after_block_2', order: 0 },
      { asset_id: 'p2', position: 'after_block_5', order: 1 },
      { asset_id: 'p3', position: 'after_block_9', order: 2 },
    ]
    const result = sanitizePlacements(placements, blocks)
    expect(result.placements).toEqual([
      { asset_id: 'p1', position: 'after_block_2', order: 0 },
      { asset_id: 'p2', position: 'bottom', order: 1 },
      { asset_id: 'p3', position: 'bottom', order: 2 },
    ])
    expect(result.degradedCount).toBe(2)
  })

  it('历史兼容值不参与退化', () => {
    const placements = [{ asset_id: 'p1', position: 'after_section_9', order: 0 }]
    const result = sanitizePlacements(placements, blocks)
    expect(result.placements).toEqual(placements)
    expect(result.degradedCount).toBe(0)
  })

  it('空列表与空块安全', () => {
    expect(sanitizePlacements([], blocks)).toEqual({ placements: [], degradedCount: 0 })
    expect(sanitizePlacements([{ asset_id: 'p1', position: 'bottom', order: 0 }], [])).toEqual({
      placements: [{ asset_id: 'p1', position: 'bottom', order: 0 }],
      degradedCount: 0,
    })
  })
})
