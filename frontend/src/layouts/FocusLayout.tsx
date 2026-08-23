import { Link, Outlet } from 'react-router-dom'

interface FocusLayoutProps {
  /** 顶部返回链接目标（文章工作台 → /articles，配图工作台 → /assets） */
  backTo: string
  backLabel: string
}

/**
 * 专注模式布局：顶部返回链接 + 全宽内容区（两个工作台使用）。
 */
export default function FocusLayout({ backTo, backLabel }: FocusLayoutProps) {
  return (
    <div className="focus-layout">
      <header className="focus-header">
        <Link className="focus-back" to={backTo} aria-label={backLabel}>
          ← {backLabel}
        </Link>
      </header>
      <main className="focus-content">
        <Outlet />
      </main>
    </div>
  )
}
