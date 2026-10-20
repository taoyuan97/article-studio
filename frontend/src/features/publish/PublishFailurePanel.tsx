import { App, Alert, Button, Space } from 'antd'
import { Link } from 'react-router-dom'
import {
  describePublishFailure,
  formatPublishDiagnostic,
} from './publishFailure'

interface Props {
  code?: string | null
  message: string
  onRetry?: () => void
  showRecordsLink?: boolean
}

/**
 * 发布失败统一面板：原因优先，附修复步骤、操作按钮与可折叠技术详情。
 * 发布页、发布记录展开行、发布快照详情共用。
 */
export default function PublishFailurePanel({
  code,
  message,
  onRetry,
  showRecordsLink = true,
}: Props) {
  const { message: toast } = App.useApp()
  const info = describePublishFailure(code, message)

  const copyDiagnostic = async () => {
    const text = formatPublishDiagnostic(info, message)
    try {
      await navigator.clipboard.writeText(text)
      toast.success('诊断信息已复制')
    } catch {
      toast.warning('复制失败，请手动选择下方技术详情')
    }
  }

  return (
    <Alert
      type="error"
      showIcon
      message={info.title}
      description={
        <div className="publish-failure-body">
          <p>{info.summary}</p>
          {info.steps.length > 0 && (
            <ol className="publish-failure-steps">
              {info.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
          <Space wrap className="publish-failure-actions">
            {onRetry && (
              <Button type="primary" onClick={onRetry}>
                重试发布
              </Button>
            )}
            {info.wechatHint && (
              <Button href="https://mp.weixin.qq.com/" target="_blank" rel="noreferrer">
                打开公众平台
              </Button>
            )}
            {info.settingsHint && (
              <Link to="/settings?tab=wechat">
                <Button>公众号设置</Button>
              </Link>
            )}
            {showRecordsLink && (
              <Link to="/publish-records">
                <Button>查看发布记录</Button>
              </Link>
            )}
            <Button onClick={() => void copyDiagnostic()}>复制诊断信息</Button>
          </Space>
          <details className="publish-failure-technical">
            <summary>技术详情</summary>
            <p>
              错误码：<code>{info.code}</code>
              {info.diagnostics.wechatCode && (
                <>
                  {' '}
                  · 微信错误码：<code>{info.diagnostics.wechatCode}</code>
                </>
              )}
              {info.diagnostics.rid && <> · rid：<code>{info.diagnostics.rid}</code></>}
            </p>
            <pre>{message}</pre>
          </details>
        </div>
      }
    />
  )
}
