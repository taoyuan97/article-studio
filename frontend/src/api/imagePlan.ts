import { apiRequest } from './client'
import type { ImagePlanDefaults, ImagePlanGenerateRequest, ImagePlanResponse } from './types'

/** 配图计划线接口（3 个）：默认值 / 一键编排 / 最近方案恢复 */
export const imagePlanApi = {
  getDefaults: () => apiRequest<ImagePlanDefaults>('/api/image-plan/defaults'),

  generate: (sessionId: string, payload: ImagePlanGenerateRequest) =>
    apiRequest<ImagePlanResponse>(
      `/api/image-sessions/${encodeURIComponent(sessionId)}/image-plan`,
      {
        method: 'POST',
        body: payload,
        // 同步编排与后端 120s 超时对齐（决策 ①）
        timeoutMs: 125_000,
      },
    ),

  getLatest: (sessionId: string) =>
    apiRequest<ImagePlanResponse>(
      `/api/image-sessions/${encodeURIComponent(sessionId)}/image-plan`,
    ),
}
