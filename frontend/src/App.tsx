import { Route, Routes } from 'react-router-dom'
import AppLayout from './layouts/AppLayout'
import FocusLayout from './layouts/FocusLayout'
import DashboardPage from './pages/DashboardPage'
import ArticleListPage from './pages/ArticleListPage'
import AssetLibraryPage from './pages/AssetLibraryPage'
import ArticleWorkspacePage from './pages/ArticleWorkspacePage'
import ImageWorkspacePage from './pages/ImageWorkspacePage'
import PublishPage from './pages/PublishPage'
import PublishRecordsPage from './pages/PublishRecordsPage'
import PublishRecordDetailPage from './pages/PublishRecordDetailPage'

/**
 * 路由表（8 条）：
 * - 带壳（AppLayout）：/ 首页、/articles 文章列表、/assets 素材库、/publish-records 发布记录；
 * - 专注模式（FocusLayout）：/articles/:articleId 文章工作台（返回文章列表）、
 *   /image-sessions/:sessionId 配图工作台（返回素材列表）、
 *   /publish 发布向导（返回文章列表）、/publish-records/:recordId 快照详情（返回发布记录）。
 */
export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/articles" element={<ArticleListPage />} />
        <Route path="/assets" element={<AssetLibraryPage />} />
        <Route path="/publish-records" element={<PublishRecordsPage />} />
      </Route>
      <Route element={<FocusLayout backTo="/articles" backLabel="返回文章列表" />}>
        <Route path="/articles/:articleId" element={<ArticleWorkspacePage />} />
        <Route path="/publish" element={<PublishPage />} />
      </Route>
      <Route element={<FocusLayout backTo="/assets" backLabel="返回素材列表" />}>
        <Route path="/image-sessions/:sessionId" element={<ImageWorkspacePage />} />
      </Route>
      <Route
        element={<FocusLayout backTo="/publish-records" backLabel="返回发布记录" />}
      >
        <Route path="/publish-records/:recordId" element={<PublishRecordDetailPage />} />
      </Route>
    </Routes>
  )
}
