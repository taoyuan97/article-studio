import { Card, Typography } from 'antd'
import { useParams } from 'react-router-dom'

/** 配图工作台页（占位）：T004 实现 prompt 输入、参数面板、图片流与保存素材。 */
export default function ImageWorkspacePage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  return (
    <Card title="配图工作台">
      <Typography.Paragraph type="secondary">
        配图工作台（prompt + 参数 + 图片流）将在 T004 实现。
      </Typography.Paragraph>
      <Typography.Text type="secondary">当前会话 ID：{sessionId}</Typography.Text>
    </Card>
  )
}
