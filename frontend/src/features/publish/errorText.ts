/**
 * 发布错误码 → 用户可读文案映射（后端结构化错误码见 wenyan_client / publish_service）。
 * 未识别的错误码透传后端 message。
 */
const PUBLISH_ERROR_TEXTS: Record<string, string> = {
  PUBLISH_CREDENTIALS_MISSING: '未配置公众号凭据：请在 backend/.env 中设置 WECHAT_APP_ID 与 WECHAT_APP_SECRET 后重启后端。',
  PUBLISH_MCP_NOT_INSTALLED: '未找到 wenyan-mcp：请先执行 npm install -g @wenyan-md/mcp 安装。',
  PUBLISH_TIMEOUT: '发布超时（120s）：请稍后在发布记录中查看结果，或重试。',
  PUBLISH_MCP_ERROR:
    '公众号接口调用失败：常见原因有 IP 不在白名单（错误码 40164）、AppSecret 有误、未选择封面图（公众号草稿要求封面或正文至少一张图），具体原因见下方详情。',
  PUBLISH_ASSET_MISSING: '图片素材不存在或文件缺失：请重新保存配图素材后再发布。',
  PUBLISH_NO_CONTENT: '该文章尚无可用版本：请先生成文章内容。',
  PUBLISH_TITLE_MISSING: '文章标题为空，无法发布。',
  PUBLISH_THEME_MISSING: '发布主题不能为空，请选择主题。',
  REQUEST_TIMEOUT: '发布请求超时（120s）：请稍后在发布记录中查看结果，或重试。',
  BACKEND_UNREACHABLE: '无法连接到后端服务，请确认后端已启动后重试。',
}

export function publishErrorText(code: string | null | undefined, fallback: string): string {
  if (!code) return fallback
  return PUBLISH_ERROR_TEXTS[code] ?? fallback
}
