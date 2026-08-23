/**
 * 图片参数（分辨率档位 + 尺寸比例）：
 * 与 MVP js/image-workspace/params.js 一致；换算由后端
 * resolve_image_size 完成（通义万相 * 分隔、即梦 x 分隔）。
 */

export interface ImageParams {
  tier: string
  ratio: string
}

export const PARAM_OPTIONS: Record<string, { tiers: string[]; ratios: string[] }> = {
  aliyun_wanxiang: {
    tiers: ['1K', '2K', '4K'],
    ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  },
  dreamina: {
    tiers: ['1K', '2K', '3K'],
    ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  },
}

export const DEFAULT_PARAMS: Record<string, ImageParams> = {
  aliyun_wanxiang: { tier: '2K', ratio: '1:1' },
  dreamina: { tier: '2K', ratio: '1:1' },
}

export function getProviderDefaults(provider: string): ImageParams {
  return DEFAULT_PARAMS[provider] ?? DEFAULT_PARAMS.aliyun_wanxiang
}

/** 规范化参数：非法组合回退到该供应商默认值 */
export function normalizeParams(provider: string, tier: string | null, ratio: string | null): ImageParams {
  const defaults = getProviderDefaults(provider)
  const available = PARAM_OPTIONS[provider] ?? PARAM_OPTIONS.aliyun_wanxiang
  return {
    tier: tier && available.tiers.includes(tier) ? tier : defaults.tier,
    ratio: ratio && available.ratios.includes(ratio) ? ratio : defaults.ratio,
  }
}

export function formatParamsSummary(tier: string, ratio: string): string {
  return `${tier} · ${ratio}`
}

const STORAGE_KEY_PREFIX = 'image-params:'

/** 读取会话上次提交的参数（重新进入会话回显）；无记录时返回 null */
export function loadSessionParams(sessionId: string): ImageParams | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_PREFIX + sessionId)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ImageParams>
    if (typeof parsed.tier !== 'string' || typeof parsed.ratio !== 'string') return null
    return { tier: parsed.tier, ratio: parsed.ratio }
  } catch {
    return null
  }
}

/** 参数随发送指令提交成功后持久化（同一浏览器内回显） */
export function saveSessionParams(sessionId: string, params: ImageParams): void {
  try {
    window.localStorage.setItem(STORAGE_KEY_PREFIX + sessionId, JSON.stringify(params))
  } catch {
    // 存储不可用时静默降级（仅影响回显）
  }
}
