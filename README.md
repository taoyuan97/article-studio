# Article Studio

AI 驱动的文章创作与配图工作台：通过对话生成与修订长文（多版本管理），按提示词生成配图并沉淀素材库。

单仓双工程：`frontend/`（React 19 + Vite + TypeScript + AntD 5）+ `backend/`（FastAPI + LangGraph + SQLite），本地单机运行，数据不出本机。

## 功能一览

| 模块 | 能力 |
| --- | --- |
| 仪表盘 | 文章/素材统计、快捷入口、最近文章与素材 |
| 文章创作 | 对话式生成与修订（SSE 流式输出）、标题自动生成、双模型切换（DeepSeek / Moonshot）、运行中取消、失败重试 |
| 版本管理 | 每次生成落一个只读历史版本，可随时回看任意版本 |
| 配图工作台 | 提示词生图（通义万相 / 即梦）、生成进度实时展示、档位与比例参数持久化、取消、保存素材 |
| 素材库 | 图片素材列表、详情查看、回链来源配图会话 |

## 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 10+ | 启停脚本为 PowerShell；其余平台可用命令行方式 |
| Node.js | 20.19+ | 前端构建 |
| pnpm | 11（`pnpm@11.22.0`） | 经 corepack 使用，无需全局安装 |
| Python | 3.11+ | 后端运行时 |
| uv | 任意近期版本 | Python 依赖管理，见 [uv 安装](https://docs.astral.sh/uv/) |
| 模型 API Key | — | 文章线需 DeepSeek 或 Moonshot 至少一个；配图线可选（通义万相 / 即梦） |

## 快速开始

### 1. 首次配置

```powershell
copy backend\.env.example backend\.env
# 编辑 backend\.env，至少填写：
#   DEEPSEEK_API_KEY=sk-...        （文章线，默认供应商）
#   MOONSHOT_API_KEY=sk-...        （文章线，可选第二供应商）
#   ALIYUN_WANXIANG_API_KEY=...    （配图线，可选）
#   DREAMINA_API_KEY=...           （配图线，可选）
```

其余配置项（模型 ID、超时、上下文预算等）保持默认即可。

### 2. 启动服务

**方式 A：双击脚本（推荐）**

双击 `scripts\start-all.cmd`，首次运行会自动安装依赖（`uv sync` / `pnpm install`），随后弹出两个服务窗口：

- 后端 `http://127.0.0.1:8000`（API 文档 `/docs`）
- 前端 `http://localhost:5173` ← 浏览器访问这里

使用完毕双击 `scripts\stop-all.cmd` 停止。详见 `scripts/README.md`。

**方式 B：命令行**

```powershell
# 终端 1：后端
cd backend
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000

# 终端 2：前端
cd frontend
pnpm install
pnpm dev          # http://localhost:5173，/api 经 proxy 转发到 8000
```

pnpm 通过 corepack 使用（系统无全局 pnpm 时）：

```powershell
$env:COREPACK_HOME = "<repo>\.corepack"
corepack pnpm install
```

> 不想消耗真实 API 额度？后端改用假模型服务器：`cd backend; uv run python scripts/dev_fake_server.py`（API/SSE/持久化行为与真实后端完全一致）。

## 使用指南

- **仪表盘**：查看统计与最近内容；点「新建文章 / 新建配图」快捷创建并跳转。
- **文章列表**：搜索框按标题过滤；点「新建文章」进入工作台。
- **文章工作台**：左侧对话，右侧正文与版本。发送指令（如「写一篇关于 X 的文章」）后流式生成；继续对话产生 v2、v3…；版本下拉可回看任意历史版本（只读）；顶部可切换模型；生成中可点「停止」（不落版本）。
- **配图工作台**：输入画面描述 → 选择档位/比例 → 发送；进度条实时推进；完成后可「保存素材」。失败时会展示失败卡片，展开可见脱敏详情。
- **素材库**：浏览已保存素材；点击查看详情（提示词、尺寸等），可跳回来源配图会话。

## 开发者指南

### 目录结构

```text
frontend/           React SPA（5 路由：仪表盘 / 文章列表 / 文章工作台 / 配图工作台 / 素材库）
  src/                页面、组件、features、hooks、api 客户端、SSE 封装
  e2e/                Playwright E2E 用例（MVP 场景 A–G + 配图/素材 + 部署形态）
backend/            FastAPI 单进程应用（API + SSE + SQLite 持久化）
  app/                API 路由、数据库仓储、运行管理（文章线 service / 配图线 image_service）
  article_agent/      LangGraph 智能体（意图路由、上下文预算压缩、脱敏）
  scripts/            假模型服务器、E2E 服务器、真实 API 冒烟脚本
  data/               运行时数据（SQLite 与图片资产；假模型/E2E 各有独立子目录）
scripts/            Windows 双击启停脚本（start/stop × backend/frontend/all）
docs/               PRD / 技术设计 / 任务拆分 / 运维手册
prototype/          MVP 原型（冻结归档，不再开发）
```

### 开发工作流

后端带热重载：`uv run uvicorn app.main:app --reload --port 8000`；前端 `pnpm dev` 自带 HMR。前端 `/api` 与 `/static` 由 Vite proxy 转发到后端 8000，无需额外配置。

### 测试

```powershell
cd backend  ; uv run pytest -p no:cacheprovider   # 后端全量测试（51 例，含前端契约）
cd frontend ; pnpm test                            # Vitest 组件测试（26 例，含安全渲染断言）
cd frontend ; pnpm e2e                             # Playwright E2E（11 例，假模型，无需真实 Key）
```

E2E 首次运行前安装浏览器到项目本地目录（沙箱/受限环境无法写 `%LOCALAPPDATA%`）：

```powershell
cd frontend
$env:PLAYWRIGHT_BROWSERS_PATH = "<repo>\.playwright-browsers"
pnpm exec playwright install chromium
```

之后 `pnpm e2e` 无需再设环境变量（路径由 `playwright.config.ts` 自动注入；先 build 再以生产形态运行）。

### 代码规范

```powershell
cd frontend ; pnpm lint       # ESLint
cd frontend ; pnpm format     # Prettier
cd frontend ; pnpm build      # TS strict 编译 + 构建（类型检查含在内）
```

## 生产部署（单进程）

```powershell
cd frontend ; pnpm build                 # 产物 → frontend/dist
cd backend  ; $env:SERVE_FRONTEND = "true"   # 或在 backend/.env 中改为 true
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

`SERVE_FRONTEND=true` 时 FastAPI 托管 `frontend/dist`，非 `/api` 未命中路径返回 `index.html`（SPA fallback）；静态资源、API、SSE 同进程同源，浏览器只需访问 `http://<host>:8000`。

## 常见问题

- **启动提示端口已被占用（8000 / 5173）**：先双击 `scripts\stop-all.cmd` 清理；仍占用则检查其他程序（`netstat -ano | findstr :8000`）。
- **`pnpm` 命令不可用**：走 corepack 方式（见「快速开始」），或 `corepack enable`（需管理员权限）。
- **未配置 API Key 的表现**：文章发送后出现失败卡片（脱敏详情），配图线提示无可用生图模型。本地联调请改用假模型服务器。
- **E2E 浏览器下载失败/缓慢**：`$env:PLAYWRIGHT_DOWNLOAD_HOST = "https://npmmirror.com/mirrors/playwright"` 后重装。
- **数据在哪、如何重置**：全部在 `backend\data\`（业务库 `article.sqlite3`、图片 `assets/`）；假模型数据在 `data\dev-fake\`、E2E 在 `data\e2e\`，删除对应目录即重置。

## 更多文档

| 文档 | 内容 |
| --- | --- |
| `docs/prd/prd.md` | 产品需求与验收标准 |
| `docs/tech/tech-design.md` | 技术设计（架构、数据流、上下文预算） |
| `docs/task/` | 任务拆分 T001–T006 与实施状态 |
| `docs/ops/` | 人工操作手册（真实 API 走查、E2E 手册、故障排查） |
| `backend/README.md` | 后端 API 契约、启动方式、假模型约定 |
| `frontend/README.md` | 前端结构、命令、与后端的契约 |
| `scripts/README.md` | 启停脚本使用说明 |
