# T002：前端骨架（布局导航、API 层与 SSE 封装）

## 1. 任务信息

- 状态：待实施
- 优先级：P0
- 类型：正式任务 2/6
- 前置任务：T001
- 后续任务：T003、T004、T005
- 目标目录：`frontend/src/`
- 创建日期：2026-08-23
- 关联文档：`docs/prd/prd.md`、`docs/tech/tech-design.md`

## 2. 目标

搭建前端应用骨架：导航壳与路由、统一 API 层与类型定义、SSE 客户端封装、通用安全渲染组件。完成后各业务页面（T003–T005）只做组装，不再触碰基础设施。

## 3. 已确认的全局决策

- 布局两种形态：带侧边导航壳（首页/文章列表/素材库）+ 专注模式（两个工作台，顶部返回链接），与 MVP 信息架构一致。
- 服务端状态统一 TanStack Query；客户端状态统一 Zustand；不缓存服务端数据副本到 Zustand。
- API 层是前端唯一 fetch 出口，错误归一为 `ApiError { status, code, message }`。
- SSE 基于原生 `EventSource` 封装，沿用 MVP 事件协议，不引入 WebSocket。
- Markdown 渲染：react-markdown + rehype 白名单，禁用原始 HTML。

## 4. 范围

### 4.1 必须实现

- `layouts/AppLayout.tsx`：AntD Layout + Sider，导航项"首页 / 文章 / 素材"，当前项高亮（`aria-current`）。
- 专注模式布局：顶部返回链接 + 全宽内容区。
- 主题 tokens：品牌色、间距等基础定制；桌面端优先。
- 路由表 `App.tsx`：5 条路由（`/`、`/articles`、`/assets`、`/articles/:articleId`、`/image-sessions/:sessionId`），暂以占位页填充。
- `api/client.ts`：fetch 封装 + `ApiError`（网络失败映射 `BACKEND_UNREACHABLE`）。
- `api/types.ts`：文章线/配图线/素材线全部契约类型。
- `api/articles.ts`、`api/imageSessions.ts`、`api/assets.ts`：技术设计 5.2 全部接口函数。
- `lib/queryClient.ts`：QueryClient 实例与默认配置。
- `lib/sse.ts`：EventSource 封装（事件名监听、`run.completed` 自动关闭、断网回调、手动关闭句柄）。
- `useArticleRunStream` / `useImageRunStream` hooks：事件分发 + 卸载清理。
- `components/MarkdownView`：安全 Markdown 渲染（标题/列表/代码块/段落/行内强调）。
- `components/StatusBanner`：全局错误/提示组件。

### 4.2 不实现

- 业务页面真实内容（占位页即可）。
- Zustand 具体业务 store（随 T003/T004 按需创建）。
- 移动端适配。

## 5. 路由与布局设计

| 路由 | 布局 | 页面（本任务为占位） |
|---|---|---|
| `/` | AppLayout | DashboardPage |
| `/articles` | AppLayout | ArticleListPage |
| `/assets` | AppLayout | AssetLibraryPage |
| `/articles/:articleId` | 专注模式 | ArticleWorkspacePage |
| `/image-sessions/:sessionId` | 专注模式 | ImageWorkspacePage |

侧边导航项与 MVP `shell.js` 对齐：首页（`/`）、文章（`/articles`）、素材（`/assets`）。

## 6. API 层设计

`client.ts` 语义与 MVP `api.js` 一致：

- 网络异常 → `ApiError(message, 0, "BACKEND_UNREACHABLE")`。
- 非 2xx → 读取 `payload.error || payload.detail`，透出 `detail.code` 与 `detail.message`（如 `ARTICLE_RUN_ACTIVE`、`MODEL_NOT_CONFIGURED`、`IMAGE_PROVIDER_NOT_CONFIGURED`）。
- 统一 `Content-Type: application/json`。

接口清单（完整列表见技术设计 5.2）：文章线 13 个、配图线 6 个、素材线 3 个。

`types.ts` 覆盖：Article、Workspace 聚合、Message（含分型字段）、Version、Run 响应、ImageSession、ImageWorkspace、Asset、Stats、可用/不可用模型列表。

## 7. SSE 封装设计

文章线事件（8 种）：`run.started`、`assistant.delta`、`article.delta`、`message.completed`、`article.completed`、`run.cancelled`、`run.failed`、`run.completed`。

配图线事件（6 种）：`run.started`、`image.progress`、`image.completed`、`image.failed`、`run.cancelled`、`run.completed`。

行为要求：

- JSON 解析失败兜底为 `{ run_id }`。
- `run.completed` 后自动 `close()`。
- `onerror` 时区分 `EventSource.CLOSED`，避免重复触发网络错误回调。
- hooks 组件卸载自动关闭连接。
- 页面重新进入且 workspace 返回 `active_run_id` 时由调用方触发重连（本任务只提供能力）。

## 8. 测试

- `pnpm build` 与 lint 通过。
- 5 条路由可达，导航高亮正确，AntD 中文文案生效。
- 以 `GET /api/health`、`GET /api/stats` 冒烟验证 API 封装；后端未启动时得到统一 `ApiError`。
- MarkdownView 渲染标题/列表/代码块/段落正常；输入含 `<script>` 的内容不执行（作为文本展示）。

## 9. 验收标准

- [ ] 5 条路由可达，带壳与专注模式两种布局形态正确。
- [ ] 导航高亮与 `aria-current` 正确。
- [ ] 所有契约接口有类型化封装，无裸 fetch 散落。
- [ ] `ApiError` 错误路径（网络失败、业务错误码）验证通过。
- [ ] SSE 封装事件解析与 MVP `stream.js` 行为一致。
- [ ] `run.completed` 后连接关闭；组件卸载无泄漏；断网回调不重复触发。
- [ ] MarkdownView 安全渲染验证通过。

## 10. 完成定义

上述验收全部通过后，T002 完成。此时才能进入 T003 的业务页面开发。
