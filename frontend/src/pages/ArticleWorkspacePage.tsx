import { Card, Typography } from 'antd'
import { useParams } from 'react-router-dom'

/** 文章工作台页（占位）：T003 实现对话流、正文面板、版本面板与运行态。 */
export default function ArticleWorkspacePage() {
  const { articleId } = useParams<{ articleId: string }>()
  return (
    <Card title="文章工作台">
      <Typography.Paragraph type="secondary">
        文章工作台（对话 + 正文 + 版本）将在 T003 实现。
      </Typography.Paragraph>
      <Typography.Text type="secondary">当前文章 ID：{articleId}</Typography.Text>
    </Card>
  )
}
