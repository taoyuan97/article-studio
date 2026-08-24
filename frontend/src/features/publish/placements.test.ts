import { describe, expect, it } from 'vitest'
import { computeDefaultPlacements, movePlacement, positionLabel, positionOptions } from './placements'
import type { PublishSection } from '../../api/types'

const sections: PublishSection[] = [
  { index: 1, heading: '引子', body: '开头' },
  { index: 2, heading: '正文', body: '内容' },
  { index: 3, heading: null, body: '收尾' },
]

describe('computeDefaultPlacements', () => {
  it('按勾选顺序均分到各小节（round-robin），order 为勾选顺序', () => {
    const placements = computeDefaultPlacements(['a', 'b', 'c', 'd'], sections)
    expect(placements).toEqual([
      { asset_id: 'a', position: 'after_section_1', order: 0 },
      { asset_id: 'b', position: 'after_section_2', order: 1 },
      { asset_id: 'c', position: 'after_section_3', order: 2 },
      { asset_id: 'd', position: 'after_section_1', order: 3 },
    ])
  })

  it('无小节时全部置于文末', () => {
    expect(computeDefaultPlacements(['a', 'b'], [])).toEqual([
      { asset_id: 'a', position: 'bottom', order: 0 },
      { asset_id: 'b', position: 'bottom', order: 1 },
    ])
  })

  it('空列表返回空', () => {
    expect(computeDefaultPlacements([], sections)).toEqual([])
  })
})

describe('movePlacement', () => {
  const placements = [
    { asset_id: 'a', position: 'after_section_1', order: 0 },
    { asset_id: 'b', position: 'after_section_1', order: 1 },
    { asset_id: 'c', position: 'bottom', order: 2 },
  ]

  it('同位置内上移：与相邻同位置项交换 order', () => {
    const next = movePlacement(placements, 'b', 'up')
    expect(next.find((item) => item.asset_id === 'b')?.order).toBe(0)
    expect(next.find((item) => item.asset_id === 'a')?.order).toBe(1)
    // 其他位置不受影响
    expect(next.find((item) => item.asset_id === 'c')).toEqual(placements[2])
  })

  it('同位置内下移', () => {
    const next = movePlacement(placements, 'a', 'down')
    expect(next.find((item) => item.asset_id === 'a')?.order).toBe(1)
    expect(next.find((item) => item.asset_id === 'b')?.order).toBe(0)
  })

  it('已是同位置第一张时上移不动；唯一一张时下移不动', () => {
    expect(movePlacement(placements, 'a', 'up')).toEqual(placements)
    expect(movePlacement(placements, 'c', 'down')).toEqual(placements)
  })

  it('跨位置相邻不影响：c（bottom）上移不会与 b（after_section_1）交换', () => {
    expect(movePlacement(placements, 'c', 'up')).toEqual(placements)
  })
})

describe('positionLabel / positionOptions', () => {
  it('位置标签：文首/文末/第 N 节之后（附小节标题摘要，超长截断）', () => {
    expect(positionLabel('top', sections)).toBe('文首')
    expect(positionLabel('bottom', sections)).toBe('文末')
    expect(positionLabel('after_section_2', sections)).toBe('第 2 节之后 · 「正文」')
    expect(positionLabel('after_section_3', sections)).toBe('第 3 节之后')
    const long = [{ index: 1, heading: '一个特别特别特别特别特别特别长的小节标题', body: '' }]
    expect(positionLabel('after_section_1', long)).toBe('第 1 节之后 · 「一个特别特别特别特别特别…」')
  })

  it('位置选项覆盖 文首 + 各小节 + 文末', () => {
    const options = positionOptions(sections)
    expect(options.map((option) => option.value)).toEqual([
      'top',
      'after_section_1',
      'after_section_2',
      'after_section_3',
      'bottom',
    ])
  })
})
