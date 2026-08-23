import { Alert } from 'antd'

export type StatusBannerKind = 'error' | 'warning' | 'info' | 'success'

interface StatusBannerProps {
  kind: StatusBannerKind
  message: string
  description?: string
  onClose?: () => void
}

/** 全局错误/提示横幅（基于 AntD Alert，业务页面按需复用） */
export default function StatusBanner({ kind, message, description, onClose }: StatusBannerProps) {
  return (
    <Alert
      type={kind}
      showIcon
      message={message}
      description={description}
      closable={Boolean(onClose)}
      onClose={onClose}
    />
  )
}
