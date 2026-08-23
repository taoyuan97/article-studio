import { Layout } from 'antd'
import { Link, Outlet, useLocation } from 'react-router-dom'

const NAV_ITEMS = [
  { key: '/', label: '首页' },
  { key: '/articles', label: '文章' },
  { key: '/assets', label: '素材' },
] as const

/**
 * 带侧边导航的应用壳（首页 / 文章列表 / 素材库）。
 *
 * 导航项与 MVP shell.js 对齐；当前项通过 aria-current="page" 标记，
 * 使用语义化 <nav>/<ul>/<a> 结构（AntD Layout/Sider 提供壳与栅格）。
 */
export default function AppLayout() {
  const { pathname } = useLocation()
  const currentKey =
    NAV_ITEMS.find((item) => item.key !== '/' && pathname.startsWith(item.key))?.key ?? '/'

  return (
    <Layout className="app-layout" style={{ minHeight: '100vh' }}>
      <Layout.Sider className="app-layout-sider" theme="light" width={220}>
        <div className="app-brand">
          <span className="app-brand-eyebrow">ARTICLE STUDIO</span>
          <h2 className="app-brand-title">工作台</h2>
        </div>
        <nav className="app-nav" aria-label="主导航">
          <ul>
            {NAV_ITEMS.map((item) => {
              const isCurrent = item.key === currentKey
              return (
                <li key={item.key}>
                  <Link to={item.key} aria-current={isCurrent ? 'page' : 'false'}>
                    {item.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>
      </Layout.Sider>
      <Layout>
        <Layout.Content className="app-content">
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  )
}
