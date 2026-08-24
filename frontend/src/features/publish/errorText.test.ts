import { describe, expect, it } from 'vitest'
import { publishErrorText } from './errorText'

describe('publishErrorText', () => {
  it('已知错误码映射为可读文案', () => {
    expect(publishErrorText('PUBLISH_CREDENTIALS_MISSING', 'x')).toContain('WECHAT_APP_ID')
    expect(publishErrorText('PUBLISH_TIMEOUT', 'x')).toContain('超时')
    expect(publishErrorText('PUBLISH_MCP_ERROR', 'x')).toContain('IP 不在白名单')
    expect(publishErrorText('PUBLISH_ASSET_MISSING', 'x')).toContain('图片素材')
  })

  it('未知错误码与空错误码回退到后端 message', () => {
    expect(publishErrorText('SOMETHING_ELSE', '后端原始信息')).toBe('后端原始信息')
    expect(publishErrorText(null, '后端原始信息')).toBe('后端原始信息')
  })
})
