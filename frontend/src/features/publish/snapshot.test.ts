import { describe, expect, it } from 'vitest'
import { mapImagePathsToUrls, stripFrontmatter } from './snapshot'
import type { Asset } from '../../api/types'

function makeAsset(id: string, storageUrl: string): Asset {
  return {
    id,
    kind: 'image',
    source: 'image_generation',
    source_session_id: 'session-1',
    source_message_id: null,
    title: `素材 ${id}`,
    storage_url: storageUrl,
    provider: 'fake',
    model: 'fake-image-model',
    metadata: {},
    created_at: '2026-08-24T10:00:00Z',
    updated_at: '2026-08-24T10:00:00Z',
  }
}

const assets = [
  makeAsset('a1', '/static/assets/images/dir-one/file-a.png'),
  makeAsset('a2', '/static/assets/images/dir-two/file-b.png'),
]

describe('stripFrontmatter', () => {
  it('剥离 --- 包裹的 frontmatter 块', () => {
    const markdown = '---\ntitle: "标题"\ncover: "C:\\\\data\\\\c.png"\nauthor: "作者"\n---\n\n## 正文\n\n内容'
    expect(stripFrontmatter(markdown)).toBe('## 正文\n\n内容')
  })

  it('无 frontmatter 时原样返回', () => {
    expect(stripFrontmatter('## 正文')).toBe('## 正文')
  })

  it('只有开头 --- 而无闭合时原样返回（防误删全文）', () => {
    const markdown = '---\ntitle: 未闭合'
    expect(stripFrontmatter(markdown)).toBe(markdown)
  })
})

describe('mapImagePathsToUrls', () => {
  it('本地绝对路径（含反斜杠）按末两段映射回 storage_url', () => {
    const markdown =
      '---\ntitle: "t"\n---\n\n![](C:\\projects\\backend\\data\\assets\\images\\dir-one\\file-a.png)\n\n正文\n\n![](/local/data/assets/images/dir-two/file-b.png)'
    const mapped = mapImagePathsToUrls(markdown, assets)
    expect(mapped).toContain('![](/static/assets/images/dir-one/file-a.png)')
    expect(mapped).toContain('![](/static/assets/images/dir-two/file-b.png)')
    // frontmatter 内的 cover 绝对路径不受图片语法改写影响（非 ![]() 形式）
    expect(mapped).not.toContain('cover')
  })

  it('匹配不到素材的图片保持原样；http 外链原样保留', () => {
    const markdown = '![](/unknown/dir/missing.png)\n\n![](https://example.com/x.png)'
    expect(mapImagePathsToUrls(markdown, assets)).toBe(markdown)
  })
})
