/**
 * 发布失败诊断：把后端错误码 + 原始 wenyan/微信错误文本，转换为
 * 首屏可读的原因、修复步骤与技术诊断信息。
 *
 * 兼容历史记录：旧版本把所有微信错误聚合为 PUBLISH_MCP_ERROR，
 * 因此即使 code 是泛化码，也会继续从原始 text 中提取 40164 / IP / rid。
 */

const WECHAT_CODE_TO_PUBLISH_CODE: Record<string, string> = {
  '40164': 'PUBLISH_IP_NOT_WHITELIST',
  '40125': 'PUBLISH_CREDENTIALS_INVALID',
  '40001': 'PUBLISH_CREDENTIALS_INVALID',
  '40013': 'PUBLISH_CREDENTIALS_INVALID',
  '48001': 'PUBLISH_API_UNAUTHORIZED',
  '45009': 'PUBLISH_RATE_LIMITED',
  '40007': 'PUBLISH_MEDIA_INVALID',
  '40009': 'PUBLISH_MEDIA_INVALID',
  '40006': 'PUBLISH_MEDIA_INVALID',
}

const WECHAT_CODES = Object.keys(WECHAT_CODE_TO_PUBLISH_CODE)

export interface PublishDiagnostics {
  wechatCode: string | null
  ipv4: string | null
  ipv6Mapped: string | null
  rid: string | null
}

export interface PublishFailureInfo {
  code: string
  title: string
  summary: string
  steps: string[]
  diagnostics: PublishDiagnostics
  /** 是否识别出具体原因（false 时使用通用兜底文案） */
  recognized: boolean
  /** 是否引导用户去公众号后台（IP/凭据/权限等） */
  wechatHint: boolean
  /** 是否引导用户去「设置 > 公众号配置」 */
  settingsHint: boolean
}

function extractIpv4(text: string): string | null {
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    const ip = match[0]
    if (ip.split('.').every((part) => Number(part) <= 255)) return ip
  }
  return null
}

function extractIpv6Mapped(text: string): string | null {
  const match = /::ffff:((?:\d{1,3}\.){3}\d{1,3})/i.exec(text)
  return match?.[0] ?? null
}

function extractRid(text: string): string | null {
  return /rid[:\s]+([A-Za-z0-9-]+)/i.exec(text)?.[1] ?? null
}

function extractWechatCode(text: string): string | null {
  for (const code of WECHAT_CODES) {
    if (new RegExp(`(^|\\D)${code}(\\D|$)`).test(text)) return code
  }
  return /errcode[:\s]*(\d{1,6})/i.exec(text)?.[1] ?? null
}

function describeIpWhitelist(diagnostics: PublishDiagnostics): PublishFailureInfo {
  const ip = diagnostics.ipv4 ?? diagnostics.ipv6Mapped
  const mapped =
    diagnostics.ipv4 && diagnostics.ipv6Mapped && diagnostics.ipv4 !== diagnostics.ipv6Mapped
      ? `（IPv6 映射：${diagnostics.ipv6Mapped}）`
      : ''
  return {
    code: 'PUBLISH_IP_NOT_WHITELIST',
    title: '发布失败：公众号 IP 白名单未包含当前出口 IP',
    summary: ip
      ? `微信接口返回 40164，拒绝来源 IP ${ip}${mapped}。`
      : '微信接口返回 40164，当前出口 IP 不在公众号白名单中；详情中未解析到具体 IP。',
    steps: [
      '登录 mp.weixin.qq.com → 设置与开发 → 基本配置 → IP 白名单',
      ip
        ? `添加 ${ip}${diagnostics.ipv6Mapped ? `（如使用 IPv6 映射，同时添加 ${diagnostics.ipv6Mapped}）` : ''}`
        : '添加当前出口 IP（可查看下方技术详情）',
      '保存后等待约 1 分钟，回到本页点「重试发布」',
    ],
    diagnostics,
    recognized: true,
    wechatHint: true,
    settingsHint: false,
  }
}

function genericFailure(
  code: string,
  diagnostics: PublishDiagnostics,
): PublishFailureInfo {
  return {
    code,
    title: '发布失败：公众号接口返回未识别错误',
    summary:
      '未能自动识别具体原因。请复制诊断信息，核对下方错误码与原始错误后再排查。',
    steps: [
      '复制下方诊断信息，确认错误码、请求 rid 与原始返回',
      '检查公众号凭据、IP 白名单与账号接口权限',
      '修复后回到本页重试；仍失败时保留 rid 联系公众号平台或服务商',
    ],
    diagnostics,
    recognized: false,
    wechatHint: true,
    settingsHint: false,
  }
}

export function describePublishFailure(
  code: string | null | undefined,
  message: string,
): PublishFailureInfo {
  const raw = message ?? ''
  const diagnostics: PublishDiagnostics = {
    wechatCode: extractWechatCode(raw),
    ipv4: extractIpv4(raw),
    ipv6Mapped: extractIpv6Mapped(raw),
    rid: extractRid(raw),
  }
  let effectiveCode = code ?? ''
  if (diagnostics.wechatCode && WECHAT_CODE_TO_PUBLISH_CODE[diagnostics.wechatCode]) {
    effectiveCode = WECHAT_CODE_TO_PUBLISH_CODE[diagnostics.wechatCode]
  }

  switch (effectiveCode) {
    case 'PUBLISH_IP_NOT_WHITELIST':
      return describeIpWhitelist(diagnostics)
    case 'PUBLISH_CREDENTIALS_INVALID':
      return {
        code: effectiveCode,
        title: '发布失败：公众号 AppSecret 或凭据无效',
        summary: `微信接口返回 ${diagnostics.wechatCode ?? '凭据错误'}，公众号 AppID/AppSecret 校验未通过。`,
        steps: [
          '打开「设置 > 公众号配置」，核对 AppID 与 AppSecret（注意不要有多余空格）',
          '保存后点击「测试配置」，确认凭据可用',
          '回到发布页点「重试发布」',
        ],
        diagnostics,
        recognized: true,
        wechatHint: true,
        settingsHint: true,
      }
    case 'PUBLISH_CREDENTIALS_MISSING':
      return {
        code: effectiveCode,
        title: '发布失败：未配置公众号凭据',
        summary: '缺少公众号 AppID 或 AppSecret，无法调用微信接口。',
        steps: ['打开「设置 > 公众号配置」填写 AppID 与 AppSecret', '保存并测试配置', '回到发布页重试'],
        diagnostics,
        recognized: true,
        wechatHint: false,
        settingsHint: true,
      }
    case 'PUBLISH_API_UNAUTHORIZED':
      return {
        code: effectiveCode,
        title: '发布失败：公众号接口权限不足',
        summary: `微信接口返回 ${diagnostics.wechatCode ?? 'api unauthorized'}，当前账号可能没有草稿箱/发布接口权限。`,
        steps: [
          '确认公众号类型与认证状态，核对是否具备草稿箱/素材接口权限',
          '如账号权限受限，请更换公众号或按微信平台要求完成认证',
          '确认后在公众号后台或发布记录中核对结果',
        ],
        diagnostics,
        recognized: true,
        wechatHint: true,
        settingsHint: false,
      }
    case 'PUBLISH_RATE_LIMITED':
      return {
        code: effectiveCode,
        title: '发布失败：公众号接口调用频率受限',
        summary: `微信接口返回 ${diagnostics.wechatCode ?? '45009'}，短时间内调用过于频繁。`,
        steps: ['等待几分钟后重试', '避免连续发布多篇；如持续触发请检查公众号后台配额'],
        diagnostics,
        recognized: true,
        wechatHint: true,
        settingsHint: false,
      }
    case 'PUBLISH_COVER_REQUIRED':
      return {
        code: effectiveCode,
        title: '发布失败：缺少封面图或正文图片',
        summary: '公众号草稿要求封面或正文至少一张图，微信拒绝了本次发布。',
        steps: [
          '回到「版本和信息」选择封面图，或到「配图与位置」插入正文图',
          '确认图片素材存在且未过期',
          '回到主题步骤重新发布',
        ],
        diagnostics,
        recognized: true,
        wechatHint: false,
        settingsHint: false,
      }
    case 'PUBLISH_MEDIA_INVALID':
      return {
        code: effectiveCode,
        title: '发布失败：公众号图片素材不合法',
        summary: `微信接口返回 ${diagnostics.wechatCode ?? 'media error'}，封面或正文图片校验未通过。`,
        steps: [
          '检查封面/插图格式、大小与素材是否仍存在',
          '重新生成或重新选择图片素材',
          '回到发布页重试',
        ],
        diagnostics,
        recognized: true,
        wechatHint: false,
        settingsHint: false,
      }
    case 'PUBLISH_MCP_NOT_INSTALLED':
      return {
        code: effectiveCode,
        title: '发布失败：未找到 wenyan-mcp',
        summary: '本机未安装或无法解析 wenyan-mcp，无法调用公众号接口。',
        steps: ['执行 npm install -g @wenyan-md/mcp', '确认 wenyan-mcp 命令可用后重启后端', '重试发布'],
        diagnostics,
        recognized: true,
        wechatHint: false,
        settingsHint: false,
      }
    case 'PUBLISH_TIMEOUT':
    case 'REQUEST_TIMEOUT':
      return {
        code: effectiveCode,
        title: '发布失败：发布请求超时',
        summary: '发布请求超过等待时间，结果可能仍在后台处理。',
        steps: ['稍后到「发布记录」查看是否已创建草稿', '确认未创建后再重试，避免重复草稿'],
        diagnostics,
        recognized: true,
        wechatHint: true,
        settingsHint: false,
      }
    case 'PUBLISH_ASSET_MISSING':
      return {
        code: effectiveCode,
        title: '发布失败：图片素材缺失',
        summary: '封面或正文引用的图片素材不存在/文件已丢失。',
        steps: ['重新选择封面或插图素材', '确认素材文件仍存在', '重试发布'],
        diagnostics,
        recognized: true,
        wechatHint: false,
        settingsHint: false,
      }
    case 'PUBLISH_NO_CONTENT':
    case 'PUBLISH_TITLE_MISSING':
    case 'PUBLISH_THEME_MISSING':
      return {
        code: effectiveCode,
        title: '发布失败：发布内容不完整',
        summary: '文章版本、标题或主题缺失，无法组装发布内容。',
        steps: ['返回文章工作台生成/选择正式版本', '选择发布主题后重试'],
        diagnostics,
        recognized: true,
        wechatHint: false,
        settingsHint: false,
      }
    case 'BACKEND_UNREACHABLE':
      return {
        code: effectiveCode,
        title: '发布失败：无法连接后端服务',
        summary: '浏览器未能连接本地后端。',
        steps: ['确认后端已启动且端口为 8000', '刷新页面后重试'],
        diagnostics,
        recognized: true,
        wechatHint: false,
        settingsHint: false,
      }
    default:
      return genericFailure(effectiveCode || 'UNKNOWN', diagnostics)
  }
}

export function formatPublishDiagnostic(
  info: PublishFailureInfo,
  rawMessage = '',
): string {
  const lines = [
    `错误码：${info.code}`,
    `微信错误码：${info.diagnostics.wechatCode ?? '未识别'}`,
    `来源 IP：${info.diagnostics.ipv4 ?? info.diagnostics.ipv6Mapped ?? '未识别'}`,
    `请求 rid：${info.diagnostics.rid ?? '未识别'}`,
    `原始信息：${rawMessage || info.summary}`,
  ]
  return lines.join('\n')
}
