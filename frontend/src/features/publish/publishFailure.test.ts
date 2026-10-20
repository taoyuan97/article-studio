import { describe, expect, it } from 'vitest'
import { describePublishFailure, formatPublishDiagnostic } from './publishFailure'

const RAW_IP_ERROR =
  '执行工具失败: 40164: invalid ip 120.85.124.127 ipv6 ::ffff:120.85.124.127, not in whitelist rid: 6ad64346-7b905a56-63b1f38f'

describe('describePublishFailure', () => {
  it('40164 识别为 IP 白名单问题并展示 IP / rid / 步骤', () => {
    const info = describePublishFailure('PUBLISH_IP_NOT_WHITELIST', RAW_IP_ERROR)
    expect(info.title).toContain('IP 白名单')
    expect(info.summary).toContain('120.85.124.127')
    expect(info.summary).toContain('::ffff:120.85.124.127')
    expect(info.steps.join('\n')).toContain('120.85.124.127')
    expect(info.diagnostics.wechatCode).toBe('40164')
    expect(info.diagnostics.ipv4).toBe('120.85.124.127')
    expect(info.diagnostics.rid).toBe('6ad64346-7b905a56-63b1f38f')
    expect(info.recognized).toBe(true)
  })

  it('旧版 PUBLISH_MCP_ERROR 也能从原文识别 40164（向后兼容）', () => {
    const info = describePublishFailure('PUBLISH_MCP_ERROR', RAW_IP_ERROR)
    expect(info.code).toBe('PUBLISH_IP_NOT_WHITELIST')
    expect(info.title).toContain('IP 白名单')
  })

  it('40125 识别为凭据问题并引导公众号设置', () => {
    const info = describePublishFailure(
      'PUBLISH_CREDENTIALS_INVALID',
      '执行工具失败: 40125 invalid appsecret rid: abc',
    )
    expect(info.title).toContain('AppSecret')
    expect(info.settingsHint).toBe(true)
    expect(info.diagnostics.wechatCode).toBe('40125')
  })

  it('未知错误不误报具体原因', () => {
    const info = describePublishFailure(
      'PUBLISH_MCP_ERROR',
      '执行工具失败: 99999 unknown upstream error rid: xyz',
    )
    expect(info.recognized).toBe(false)
    expect(info.title).toContain('未识别')
    expect(info.summary).not.toContain('白名单')
    expect(info.diagnostics.ipv4).toBeNull()
  })

  it('生成可复制的诊断信息', () => {
    const info = describePublishFailure('PUBLISH_IP_NOT_WHITELIST', RAW_IP_ERROR)
    const text = formatPublishDiagnostic(info, RAW_IP_ERROR)
    expect(text).toContain('错误码：PUBLISH_IP_NOT_WHITELIST')
    expect(text).toContain('微信错误码：40164')
    expect(text).toContain('来源 IP：120.85.124.127')
    expect(text).toContain('请求 rid：6ad64346-7b905a56-63b1f38f')
    expect(text).toContain(RAW_IP_ERROR)
  })
})
