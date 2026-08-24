# 技术设计：Article Studio 正式项目

## 1. 文档信息

- 版本：v1.2
- 状态：已实施（T001–T010 全部完成；v1.1 补记 T007–T010 公众号发布线设计；v1.2 补记 T012–T013 发布向导交互演进——封面/作者前置、正文画布块级锚点插图与 `after_block_{i}` 位置契约）
- 创建日期：2026-08-23
- 关联文档：`docs/prd/prd.md`（产品需求）、`docs/task/`（任务拆分：T001–T013）
- 迁移源：`prototype/article-agent-mvp/backend`（契约基准：`backend/tests/test_frontend_contract.py`）

## 2. 总体架构

### 2.1 架构图

```text
┌────────────────────────────────────────────────────────────┐
│                       浏览器（SPA）                        │
│  React 19 + Vite + TS + Ant Design 5                       │
│  TanStack Query（服务端状态） + Zustand（客户端状态）       │
│  React Router（5 路由：仪表盘/文章列表/文章工作台/          │
│               配图工作台/素材库）                           │
└───────────────┬────────────────────────────────────────────┘
                │ HTTP REST（JSON） + SSE（流式事件）
                │ 开发：Vite dev proxy → 127.0.0.1:8000
                │ 生产：同源（FastAPI 托管前端构建产物）
┌───────────────▼────────────────────────────────────────────┐
│                     FastAPI（单进程）                       │
│  app/       路由 / 服务 / 仓储 / 安全（迁移自 MVP）         │
│  article_agent/  LangGraph 核心（迁移自 MVP src/）          │
│                                                            │
│  ModelRegistry：DeepSeek（ChatDeepSeek）                    │
│                 Kimi（OpenAI 兼容 ChatOpenAI）              │
│  ImageProviderRegistry：通义万相 / 即梦                     │
│  StaticFiles：生产模式托管 frontend/dist + SPA fallback     │
└───────┬──────────────────────┬─────────────────────────────┘
        │                      │
┌───────▼──────────┐  ┌────────▼─────────────┐  ┌────────────┐
│ data/article.    │  │ data/checkpoints.    │  │ data/assets│
│ sqlite3（业务库）│  │ sqlite3（checkpoint） │  │ （图片文件）│
└──────────────────┘  └──────────────────────┘  └────────────┘
```

### 2.2 核心原则

1. **后端契约不变**：API 路径、请求/响应结构、SSE 事件协议原样保留，以 MVP `test_frontend_contract.py` 为对接基准。
2. **前端等价重写**：按 PRD 功能语义用 React 重写，不引入新功能。
3. **单进程生产部署**：FastAPI 同时服务 API 与前端静态资源。

## 3. 已确认技术决策

| 决策项 | 结论 |
|---|---|
| 前端框架 | React 19 + Vite + TypeScript（严格模式） |
| UI 组件库 | Ant Design 5 |
| 服务端状态 | TanStack Query（缓存/重取/失效） |
| 客户端状态 | Zustand（仅运行态、UI 态等轻状态） |
| 路由 | React Router（BrowserRouter） |
| 包管理器 | pnpm |
| Markdown 渲染 | react-markdown + rehype 白名单（禁用 raw HTML） |
| SSE | 原生 `EventSource` 封装 hook（沿用 MVP 事件协议） |
| 仓库结构 | 单仓双目录：`frontend/` + `backend/` |
| 生产部署 | FastAPI 托管 `frontend/dist`，单进程（uvicorn） |
| 后端栈 | Python 3.11+ / FastAPI / LangGraph / LangChain / SQLite（不变） |
| 数据库 | SQLite 双库（业务 + checkpoint），不迁移 MVP 数据 |
| 后端改动范围 | 仅包结构统一 + 生产静态托管 + SPA fallback，不改业务逻辑 |

## 4. 仓库与目录结构

```text
article-studio/
├─ docs/                      # 正式项目文档
│  ├─ prd/prd.md
│  ├─ tech/tech-design.md
│  └─ task/T001…T006（任务拆分，6 个文件）
├─ prototype/                 # MVP 原型（冻结归档，不再开发）
├─ frontend/                  # 前端工程
│  ├─ index.html
│  ├─ package.json / pnpm-lock.yaml
│  ├─ vite.config.ts          # dev proxy：/api → 127.0.0.1:8000
│  ├─ tsconfig.json（strict）
│  ├─ eslint.config.js / .prettierrc
│  ├─ playwright.config.ts
│  └─ src/
│     ├─ main.tsx             # 入口：Provider 装配（Query/Router/Theme）
│     ├─ App.tsx              # 路由表
│     ├─ api/                 # API 层（唯一 fetch 出口）
│     │  ├─ client.ts         # request 封装 + ApiError
│     │  ├─ types.ts          # 后端契约 TS 类型（单一事实源）
│     │  ├─ articles.ts       # 文章线接口
│     │  ├─ imageSessions.ts  # 配图线接口
│     │  └─ assets.ts         # 素材接口
│     ├─ lib/
│     │  ├─ sse.ts            # SSE 连接封装（EventSource，事件分发）
│     │  ├─ format.ts         # 相对时间等格式化
│     │  └─ queryClient.ts
│     ├─ stores/              # Zustand（如：全局 UI 错误提示）
│     ├─ layouts/
│     │  └─ AppLayout.tsx     # 侧边导航壳（首页/文章/素材）
│     ├─ pages/               # 路由级页面（组装 features）
│     │  ├─ DashboardPage.tsx
│     │  ├─ ArticleListPage.tsx
│     │  ├─ ArticleWorkspacePage.tsx
│     │  ├─ ImageWorkspacePage.tsx
│     │  └─ AssetLibraryPage.tsx
│     ├─ features/            # 业务模块（组件 + hooks + store）
│     │  ├─ article-workspace/
│     │  ├─ image-workspace/
│     │  ├─ asset-library/
│     │  └─ dashboard/
│     ├─ components/          # 跨模块通用组件
│     │  ├─ MessageList/      # 消息流（分型样式、失败卡片）
│     │  ├─ MarkdownView/     # 安全 Markdown 渲染
│     │  ├─ ModelSelect/      # 模型选择
│     │  ├─ VersionPanel/     # 版本列表
│     │  └─ StatusBanner/     # 全局错误/提示
│     └─ styles/              # 主题 tokens、全局样式
└─ backend/                   # 后端工程（迁移自 prototype）
   ├─ pyproject.toml
   ├─ .env.example / .env
   ├─ scripts/                # smoke_models.py 等真实 API 探针
   ├─ app/                    # FastAPI 应用层
   │  ├─ main.py              # 应用工厂 + 路由（迁移，新增静态托管）
   │  ├─ service.py / image_service.py
   │  ├─ database.py / security.py
   ├─ article_agent/          # LangGraph 核心（原 src/article_agent）
   │  ├─ agent.py / graph.py / state.py / models.py
   │  ├─ registry.py / config.py / budget.py
   │  ├─ prompts.py / callbacks.py / cancellation.py
   │  └─ image_providers.py
   └─ tests/                  # pytest 全量迁移（含契约测试）
```

后端结构变化说明：MVP 的 `backend/app` 与 `backend/src/article_agent` 双层 src 布局合并为 `app/` + `article_agent/` 两个平级包；import 路径相应调整，业务代码逻辑不动。

## 5. 后端设计

### 5.1 迁移策略

- **逐文件迁移**：MVP 后端源码复制到 `backend/`，仅调整包结构与 import；`.venv`、`data/`、缓存目录不迁移。
- **测试基准**：全量 pytest（含 `test_frontend_contract.py`、`test_api.py`、`test_graph.py`、`test_image_generation.py`、`test_assets.py` 等）在新目录全部通过即认定迁移成功。
- **新增改动（仅两处）**：
  1. `app/main.py`：生产模式挂载 `frontend/dist` 静态资源 + SPA fallback（非 `/api` 路径未命中时返回 `index.html`），通过环境变量开关（如 `SERVE_FRONTEND=true`）控制。
  2. 包结构调整带来的 import 路径修改。

### 5.2 API 契约（保持不变）

文章线：

```text
POST   /api/articles                                创建文章 → 201
GET    /api/articles?limit=100                      文章列表
GET    /api/articles/{id}                           文章详情
GET    /api/stats                                   统计（文章/素材数）
GET    /api/health                                  健康检查
GET    /api/articles/{id}/workspace                 工作台聚合接口
PATCH  /api/articles/{id}/model                     切换模型（运行中 409）
GET    /api/articles/{id}/messages?before&limit     消息列表（游标分页）
POST   /api/articles/{id}/messages                  发送消息 → 202 + run
POST   /api/articles/{id}/messages/{mid}/retry      重试 → 202 + run
GET    /api/articles/{id}/versions                  版本列表
GET    /api/articles/{id}/versions/{vid}            版本详情
GET    /api/runs/{run_id}/events                    文章运行 SSE
POST   /api/runs/{run_id}/cancel                    取消文章运行
```

配图线：

```text
POST   /api/image-sessions                          创建配图会话
GET    /api/image-sessions                          会话列表
GET    /api/image-sessions/{id}/workspace           配图工作台聚合
POST   /api/image-sessions/{id}/messages            发送配图 prompt → 202 + run
GET    /api/image-runs/{run_id}/events              配图运行 SSE
POST   /api/image-runs/{run_id}/cancel              取消配图运行
```

素材线：

```text
POST   /api/assets                                  保存素材
GET    /api/assets?kind=image&limit=100             素材列表
GET    /api/assets/{id}                             素材详情
```

发布线（T007–T009，同步请求、无 SSE；发布路由层超时 120s 与前端 `timeoutMs` 对齐）：

```text
GET    /api/publish/themes                          主题列表（wenyan 内置主题）
POST   /api/publish/preview                         组装预览（按 H2 切分 sections + 组装 markdown，不发布）
POST   /api/publish/articles/{article_id}           发布到公众号草稿箱 → 200 {publish_id, media_id, status}
GET    /api/publish/records?article_id=             发布记录列表（时间倒序，联表含 article_title）
GET    /api/publish/records/{record_id}             发布记录详情（含 content_snapshot）
```

发布线错误为结构化 `{code, message}`（如 `PUBLISH_CREDENTIALS_MISSING` / `PUBLISH_MCP_NOT_INSTALLED` / `PUBLISH_MCP_ERROR`（40164 等）/ `PUBLISH_TIMEOUT` / `PUBLISH_ASSET_MISSING`），失败同样落 `publish_records`（status=failed + 错误码/信息）供回看与排障。

run 响应结构（两条线同构）：

```json
{
  "run_id": "...",
  "article_id": "...",            // 或 "session_id"
  "user_message_id": "...",
  "status": "running",
  "events_url": "/api/runs/{run_id}/events"
}
```

### 5.3 SSE 事件协议（保持不变）

文章线事件（`GET /api/runs/{run_id}/events`）：

| 事件 | 语义 | 前端处理 |
|---|---|---|
| `run.started` | 运行开始 | 进入运行态，禁用发送/切换 |
| `assistant.delta` | 助手回复增量 | 更新临时对话气泡 |
| `article.delta` | 正文增量 | 更新正文临时预览 |
| `message.completed` | 消息定稿 | 临时消息转正式 |
| `article.completed` | 版本事务提交成功 | 替换当前正文，刷新版本列表 |
| `run.cancelled` | 取消 | 丢弃全部临时内容 |
| `run.failed` | 失败 | 丢弃临时正文，展示失败卡片 |
| `run.completed` | 运行结束 | 退出运行态，关闭连接 |

配图线事件（`GET /api/image-runs/{run_id}/events`）：

| 事件 | 语义 |
|---|---|
| `run.started` | 运行开始 |
| `image.progress` | 生成进度 |
| `image.completed` | 图片生成完成 |
| `image.failed` | 生成失败 |
| `run.cancelled` / `run.completed` | 取消 / 结束 |

### 5.4 数据存储

- `data/article.sqlite3`：articles、conversations、messages、article_versions、generation_runs、image_generation_sessions、image_generation_messages、image_runs、assets、publish_records（T008：发布记录，含 theme/cover/author/image_placements/content_snapshot/status/media_id/error_code/error_message）。
- `data/checkpoints.sqlite3`：LangGraph AsyncSqliteSaver。
- `data/assets/`：图片文件。
- `data/publish_tmp/`：发布组装 Markdown 临时文件（发布结束即删，快照持久化于 publish_records）。
- 目录由 `DATA_DIR` 配置；正式项目数据从零开始。

### 5.5 环境配置

沿用 MVP `.env` 结构（LLM 供应商、超时重试、上下文预算、图片 provider、LangSmith、`DATA_DIR`），新增：

```dotenv
SERVE_FRONTEND=true   # 生产模式托管 frontend/dist；开发模式置 false

# 发布线（T007+）
WECHAT_APP_ID=            # 个人订阅号 AppID（mp.weixin.qq.com 基本配置）
WECHAT_APP_SECRET=        # AppSecret；需将本机公网 IP 加入白名单
WENYAN_MCP_COMMAND=wenyan-mcp   # 发布子进程命令（stdio MCP，按需拉起）
PUBLISH_FAKE_MODE=false   # true 时不启动子进程、不外呼（开发/测试默认 true）
```

### 5.6 发布线设计（T007–T013）

- **`app/wenyan_client.py`**：`WenyanMcpClient` 封装 wenyan-mcp（stdio 子进程，按需拉起用完即退）；`list_themes` / `publish_article` 两个工具调用，120s 超时；子进程环境注入凭据并将 wenyan-mcp 配置目录经 `XDG_CONFIG_HOME` 重定向到 `DATA_DIR/wenyan-md/`（规避沙箱/受限令牌下 `%APPDATA%` 不可写的 EPERM）；fake 模式返回内置主题与 `FAKE_MEDIA_xxx`，凭据校验仍生效（行为与真实一致）。假模式失败注入：正文含「触发发布失败」标记 → `PUBLISH_MCP_ERROR`（40164）。
- **`app/publish_service.py`**：组装（`_walk_blocks` 顶层块切分（fence/标题感知，与 `split_sections` 的 H2 计数对齐）→ 按 placements 插图 → wenyan frontmatter：title/cover/author）→ 临时文件 → 发布 → 落 `publish_records`（成功/失败均落，快照可回看）→ 临时文件即删。图片 `storage_url` 解析为本地绝对路径（wenyan-mcp 要求），缺失抛 `PUBLISH_ASSET_MISSING`。
- **插图位置契约（T013）**：`image_placements[].position` 支持 `top` / `bottom` / `after_section_{n}`（历史兼容）/ `after_block_{i}`（块级，全局 1 起编号）。`split_blocks` 供 `POST /api/publish/preview` 返回 `blocks`（`{index, kind, preview, text}`），是前端画布渲染与组装锚点的**单一事实源**（与 `build_publish_markdown` 共用 `_walk_blocks`，编号不漂移）；`after_block_{i}` 越界返回 `PUBLISH_PLACEMENT_INVALID`。
- **前端**：`PublishPage` 四步向导（版本和信息（文章/版本下拉、`CoverPickerModal` 封面弹窗单选（封面独立于正文配图，切文章重置/切版本保留）、作者）→ 配图与位置（`ArticleCanvas` 正文画布块级渲染 + 点击块设锚点（插入指示线），`ImagePickerModal` 插图弹窗多选（本文配图置顶 + 素材库图片，已插入置灰），确定后按勾选顺序内联插入锚点后；已插图内联展示 hover 删除；切版本失效锚点 sanitize 退到文末并提示）→ 选主题（默认 default）→ 预览编辑与发布（同步等待 120s、成功 media_id / 失败错误码映射文案可重试））；`PublishRecordsPage` 列表（状态筛选、失败展开错误、按文章过滤）；快照详情页只读渲染（frontmatter 剥离 + 本地路径图片映射回 /static + MarkdownView 白名单）。

CORS：开发模式继续允许 `http://localhost:5173` / `http://127.0.0.1:5173`（Vite dev server 默认端口，兜底直连场景）；开发主路径走 Vite proxy（同源，不触发 CORS）。

## 6. 前端设计

### 6.1 工程脚手架

- Vite + React 19 + TypeScript，`tsconfig` 开启 `strict`。
- ESLint（typescript-eslint + react hooks 规则）+ Prettier。
- pnpm 作为包管理器，提交 `pnpm-lock.yaml`。

### 6.2 路由设计（React Router，BrowserRouter）

| 路由 | 布局 | 页面 |
|---|---|---|
| `/` | AppLayout（侧边导航） | DashboardPage |
| `/articles` | AppLayout | ArticleListPage |
| `/assets` | AppLayout | AssetLibraryPage |
| `/publish-records` | AppLayout（侧边栏第 4 项） | PublishRecordsPage |
| `/articles/:articleId` | 专注模式（顶部返回） | ArticleWorkspacePage |
| `/image-sessions/:sessionId` | 专注模式（顶部返回） | ImageWorkspacePage |
| `/publish` | 专注模式（返回文章列表） | PublishPage（四步发布向导，`?article_id=` 预选） |
| `/publish-records/:recordId` | 专注模式（返回发布记录） | PublishRecordDetailPage（快照详情） |

生产模式下 BrowserRouter 需后端 SPA fallback 配合（见 5.1）。

### 6.3 数据层

**TanStack Query（服务端状态）**：

- workspace 聚合、文章列表、版本列表、素材列表、stats 均走 Query（按 key 缓存）。
- 发送消息、重试、取消、切换模型、保存素材走 Mutation，成功后按 key 精确失效/重取。
- `article.completed` 等事件触发的数据刷新，统一通过 `queryClient.invalidateQueries` 收口。

**Zustand（客户端状态）**：

- 仅存运行态（activeRunId、临时流式内容、stream 状态）与全局 UI 态（错误提示）。
- 不缓存服务端数据副本，避免双事实源。

**API 层（`src/api/`）**：

- `client.ts` 统一封装 fetch：JSON 序列化、错误归一化为 `ApiError { status, code, message }`（与 MVP `api.js` 语义一致：`BACKEND_UNREACHABLE`、`ARTICLE_RUN_ACTIVE`、`MODEL_NOT_CONFIGURED` 等 code 原样透出）。
- `types.ts` 与后端契约一一对应，作为类型单一事实源；后续可评估 openapi-typescript 自动生成，本期手工维护。

### 6.4 SSE 客户端

`lib/sse.ts` 封装：

- 基于 `EventSource`，按事件名注册监听（沿用 MVP 事件清单：文章线 8 种、配图线 6 种）。
- `run.completed` 后自动关闭连接。
- `onerror` 网络断开回调（区分 `EventSource.CLOSED`）。
- 暴露为 hooks（`useArticleRunStream(runId, handlers)` / `useImageRunStream(runId, handlers)`），组件卸载自动清理。
- 页面重新进入且 workspace 返回 `active_run_id` 时自动重连该 run 的事件流（沿用 MVP 行为）。

不采用 WebSocket：后端仅提供 SSE，且单向流场景足够。

### 6.5 安全渲染

- `MarkdownView`：react-markdown + `rehype-sanitize`（白名单），不启用 `rehype-raw`；支持标题、列表、代码块、段落、行内强调。
- 失败详情等纯文本内容一律作为文本节点渲染（React 默认转义），禁止 `dangerouslySetInnerHTML`。
- 图片 URL 仅允许后端同源 assets 路径。

### 6.6 关键组件映射（MVP → React）

| MVP 模块 | React 目标 |
|---|---|
| `js/common/shell.js` + `css/shell.css` | `layouts/AppLayout.tsx`（AntD Layout/Sider/Menu） |
| `js/api.js` | `src/api/*`（client + 领域模块） |
| `js/workspace/stream.js` | `lib/sse.ts` + `features/article-workspace/hooks/useRunStream.ts` |
| `js/workspace/render-messages.js` | `components/MessageList`（含失败卡片、重试按钮） |
| `js/workspace/render-article.js` | 正文面板 + `components/MarkdownView` |
| `js/workspace/render-versions.js` | `components/VersionPanel` |
| `js/image-workspace/params.js` | `features/image-workspace/components/ImageParamsPopover`（AntD Popover） |
| `js/common/markdown.js` | react-markdown 替代（能力对齐：标题/列表/代码块/段落） |
| 各页 `state.js`/`render.js`/`app.js` | TanStack Query + 组件树 + feature hooks |

## 7. 开发工作流

```powershell
# 后端（终端 1）
cd backend
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload

# 前端（终端 2）
cd frontend
pnpm install
pnpm dev            # http://localhost:5173，/api 经 proxy 转发到 8000

# 测试
cd backend && uv run pytest -p no:cacheprovider
cd frontend && pnpm test        # Vitest
cd frontend && pnpm e2e         # Playwright（需后端运行）
```

`vite.config.ts` 代理：

```ts
server: {
  proxy: {
    '/api': {
      target: 'http://127.0.0.1:8000',
      changeOrigin: true,
    },
  },
}
```

## 8. 测试策略

| 层级 | 工具 | 范围 |
|---|---|---|
| 后端单元/契约 | pytest（迁移） | 全量迁移 MVP 测试，保证契约不变 |
| 前端组件 | Vitest + Testing Library | MarkdownView 安全渲染、MessageList 分型与失败卡片、SSE hooks 事件分发、模型切换禁用逻辑 |
| E2E | Playwright | MVP T003 场景 A–G 主路径 + 配图/素材主路径，跑在生产构建 + 后端托管形态上 |

E2E 环境复用后端假模型（`tests/fakes.py`）机制，不依赖真实 API Key。

## 9. 构建与部署

```powershell
# 生产构建
cd frontend && pnpm build        # 产物 → frontend/dist
cd backend && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

- `SERVE_FRONTEND=true` 时，FastAPI 挂载 `dist` 静态资源；`/api` 之外的未命中路径返回 `index.html`（SPA fallback）。
- 单进程同时服务 API、SSE 与前端静态资源；数据库与资产文件落在本机 `DATA_DIR`。
- 不做 Docker 化与云部署（本期范围外，结构上不阻碍后续接入）。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 前端重写引入行为回归 | 以 PRD + MVP 契约测试为基线；E2E 复用 MVP 验收场景逐条复验 |
| SSE 经 Vite proxy 的流式兼容 | dev 用 proxy、直连两种方式各验证一次；proxy 配置 `changeOrigin` 并确认无缓冲 |
| AntD 默认样式与工作台专注布局冲突 | 工作台页使用自定义布局，AntD 主要用于列表/表单/浮层/反馈组件 |
| 手工维护 TS 契约类型漂移 | 契约测试 + `types.ts` 注释锚定后端 schema；后续可引入 openapi-typescript |
| 包结构合并导致隐性破坏 | 迁移后全量 pytest 通过作为唯一迁移完成标准 |
