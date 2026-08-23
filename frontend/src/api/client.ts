/**
 * 前端唯一 fetch 出口。
 *
 * 错误归一化为 ApiError { status, code, message }：
 * - 网络异常（后端未启动/断网）→ status=0, code=BACKEND_UNREACHABLE；
 * - 非 2xx → 读取 payload.error || payload.detail，透出后端 detail.code 与 detail.message
 *   （如 ARTICLE_RUN_ACTIVE、MODEL_NOT_CONFIGURED、IMAGE_PROVIDER_NOT_CONFIGURED）；
 * - 无业务错误码时 code=REQUEST_FAILED。
 *
 * 路径均为相对路径：开发模式经 Vite proxy 转发到 127.0.0.1:8000，
 * 生产模式与后端同源（FastAPI 托管 frontend/dist）。
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string = 'REQUEST_FAILED') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
}

interface ErrorDetail {
  code?: string
  message?: string
}

interface ErrorPayload {
  error?: ErrorDetail
  detail?: ErrorDetail
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  } catch {
    throw new ApiError(
      '无法连接到后端服务，请确认后端已启动（uvicorn 是否在 127.0.0.1:8000 运行）。',
      0,
      'BACKEND_UNREACHABLE',
    )
  }

  const payload = (await response.json().catch(() => ({}))) as ErrorPayload
  if (!response.ok) {
    const detail = payload.error ?? payload.detail ?? {}
    throw new ApiError(detail.message ?? '请求失败，请稍后重试。', response.status, detail.code)
  }
  return payload as T
}
