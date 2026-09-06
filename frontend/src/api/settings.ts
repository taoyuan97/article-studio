import { apiRequest } from './client'
import type {
  CredentialRevealResponse,
  ProbeResult,
  SettingsProviderId,
  SettingsStatus,
} from './types'

export interface ProviderUpdatePayload {
  revision: number
  credential?: string
  base_url?: string
  model_id?: string
  context_window?: number
}

export const settingsApi = {
  getStatus: () => apiRequest<SettingsStatus>('/api/settings/status'),

  updateProvider: (provider: SettingsProviderId, payload: ProviderUpdatePayload) =>
    apiRequest(`/api/settings/providers/${provider}`, { method: 'PATCH', body: payload }),

  clearProviderCredentials: (provider: SettingsProviderId, revision: number) =>
    apiRequest(`/api/settings/providers/${provider}/credentials`, {
      method: 'DELETE',
      body: { revision },
    }),

  revealProviderCredential: (provider: SettingsProviderId, revision: number) =>
    apiRequest<CredentialRevealResponse>(`/api/settings/providers/${provider}/credentials/reveal`, {
      method: 'POST',
      body: { revision, field: 'credential' },
    }),

  updateDefaults: (
    payload: Partial<Pick<SettingsStatus, 'default_llm_provider' | 'default_image_provider'>> & {
      revision: number
    },
  ) => apiRequest<SettingsStatus>('/api/settings/defaults', { method: 'PATCH', body: payload }),

  updateRuntime: (payload: SettingsStatus['runtime'] & { revision: number }) =>
    apiRequest<SettingsStatus>('/api/settings/runtime', { method: 'PATCH', body: payload }),

  updateWechat: (payload: { revision: number; app_id?: string; app_secret?: string }) =>
    apiRequest<SettingsStatus>('/api/settings/wechat', { method: 'PATCH', body: payload }),

  clearWechatCredentials: (revision: number) =>
    apiRequest<SettingsStatus>('/api/settings/wechat/credentials', {
      method: 'DELETE',
      body: { revision },
    }),

  revealWechatCredential: (revision: number, field: 'app_id' | 'app_secret') =>
    apiRequest<CredentialRevealResponse>('/api/settings/wechat/credentials/reveal', {
      method: 'POST',
      body: { revision, field },
    }),

  probe: (provider: SettingsProviderId | 'wechat') =>
    apiRequest<ProbeResult>(`/api/settings/probe/${provider}`, {
      method: 'POST',
      timeoutMs: provider === 'image_wanxiang' ? 190_000 : 35_000,
    }),
}
