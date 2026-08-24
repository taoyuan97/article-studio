# Article Studio

单仓双工程：`frontend/`（React 19 + Vite + TS + AntD 5）+ `backend/`（FastAPI + LangGraph + SQLite）。

- 产品需求：`docs/prd/prd.md`
- 技术设计：`docs/tech/tech-design.md`
- 任务拆分：`docs/task/T001…T006`
- 运维/人工操作手册：`docs/ops/`
- MVP 原型（冻结归档，不再开发）：`prototype/`

## 目录结构

```text
frontend/   React SPA（5 路由：仪表盘 / 文章列表 / 文章工作台 / 配图工作台 / 素材库）
  src/        页面、组件、features、hooks、api 客户端、SSE 封装
  e2e/        Playwright E2E 用例（MVP 场景 A–G + 配图/素材主路径 + 部署形态）
backend/    FastAPI 单进程应用（API + SSE + SQLite 持久化 + 可选托管前端产物）
  app/        API 路由、数据库仓储、运行管理（文章线 service / 配图线 image_service）
  article_agent/  LangGraph 智能体（意图路由、上下文预算压缩、脱敏）
  scripts/    假模型开发服务器、E2E 服务器、真实 API 冒烟脚本
docs/       PRD / 技术设计 / 任务拆分 / 运维手册
data/       运行时数据（后端目录下生成，含 SQLite 与图片资产）
```

## 开发工作流

Windows 10+ 可直接双击 `scripts\start-all.cmd` / `stop-all.cmd` 一键启停前后端（详见 `scripts\README.md`），也可按下方手工流程操作。

先启动后端（终端 1）：

```powershell
cd backend
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

再启动前端（终端 2）：

```powershell
cd frontend
pnpm install
pnpm dev          # http://localhost:5173，/api 经 proxy 转发到 8000
```

pnpm 通过 corepack 使用（系统无需全局安装）：

```powershell
$env:COREPACK_HOME = "<repo>\.corepack"
corepack pnpm install
```

不消耗真实 API 额度的联调：`backend` 下运行 `uv run python scripts/dev_fake_server.py`（假模型后端，行为与真实后端一致）。

详见 `frontend/README.md` 与 `backend/README.md`。

## 测试

```powershell
cd backend  ; uv run pytest -p no:cacheprovider   # 全量后端测试（含前端契约测试）
cd frontend ; pnpm test                            # Vitest 组件测试（MarkdownView 安全渲染等）
cd frontend ; pnpm build                           # TS strict 编译 + 构建
cd frontend ; pnpm lint                            # ESLint
```

### E2E（Playwright，假模型，无真实 API Key）

```powershell
cd frontend
$env:PLAYWRIGHT_BROWSERS_PATH = "<repo>\.playwright-browsers"   # 仅首次安装浏览器时需要
pnpm exec playwright install chromium
pnpm e2e    # 先 build，再以生产形态（单进程托管 dist）跑全部 E2E
```

浏览器安装在项目本地 `.playwright-browsers/`（沙箱/受限环境无法写 `%LOCALAPPDATA%`）；运行时路径由 `playwright.config.ts` 自动注入，`pnpm e2e` 无需再设环境变量。

## 生产部署（单进程）

```powershell
cd frontend ; pnpm build                 # 产物 → frontend/dist
cd backend  ; $env:SERVE_FRONTEND = "true"
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

`SERVE_FRONTEND=true` 时 FastAPI 托管 `frontend/dist`，非 `/api` 未命中路径返回 `index.html`（SPA fallback）；静态资源、API、SSE 同进程同源。
