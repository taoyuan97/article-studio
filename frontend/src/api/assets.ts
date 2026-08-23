import { apiRequest } from './client'
import type { Asset, AssetListResponse } from './types'

/** 素材线接口（3 个） */
export const assetsApi = {
  saveAsset: (sessionId: string, messageId: string, title: string) =>
    apiRequest<Asset>('/api/assets', {
      method: 'POST',
      body: {
        source_session_id: sessionId,
        source_message_id: messageId,
        title,
      },
    }),

  listAssets: (kind: 'image' | 'audio' = 'image', limit = 100) =>
    apiRequest<AssetListResponse>(
      `/api/assets?kind=${encodeURIComponent(kind)}&limit=${limit}`,
    ),

  getAsset: (assetId: string) =>
    apiRequest<Asset>(`/api/assets/${encodeURIComponent(assetId)}`),
}
