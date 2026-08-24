import type { Asset } from '../../api/types'

/**
 * 发布快照 Markdown 处理工具：
 * - 组装产物带 wenyan frontmatter（--- title/cover/author ---），只读渲染前须剥离；
 * - 图片在组装时被解析成本地绝对路径（wenyan-mcp 要求），渲染前需映射回
 *   /static/assets/... Web 路径——按「末两段路径」（session 目录 + 文件名）匹配素材库。
 */

export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown
  const end = markdown.indexOf('\n---', 3)
  if (end === -1) return markdown
  return markdown.slice(end + 4).replace(/^\s*\n/, '')
}

/** 取路径末两段（兼容 Windows 反斜杠），如 images/{dir}/{file} → {dir}/{file} */
function tailSegments(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return segments.slice(-2).join('/')
}

/** 将快照中的本地绝对路径图片改写为素材库 storage_url（匹配不到的保持原样） */
export function mapImagePathsToUrls(markdown: string, assets: Asset[]): string {
  const urlByTail = new Map<string, string>()
  for (const asset of assets) {
    urlByTail.set(tailSegments(asset.storage_url), asset.storage_url)
  }
  return markdown.replace(/(!\[[^\]]*\]\()([^)\s]+)(\))/g, (whole, head: string, path: string, tail: string) => {
    const url = urlByTail.get(tailSegments(path))
    return url ? `${head}${url}${tail}` : whole
  })
}
