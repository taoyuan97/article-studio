# Article Studio — AI 协作指引

> 本文件是仓库的 **AI 入口**：新人/新会话先读这里，再按 §3 顺序读文档。
> 规则写进仓库，状态写进任务单；不依赖"上一个会话记得"。

**最后更新**：2026-10-18

---

## 1. 项目概况

Article Studio 是单机、单用户的 AI 文章创作与配图工作台：通过对话生成/修订长文（多版本），按提示词生成配图并沉淀素材库，按块锚点排版后发布到微信公众号草稿箱（只建草稿，不群发）。

- **仓库结构**：单仓双工程 —— `frontend/`（React 19 + Vite + TypeScript + Ant Design 5）、`backend/`（FastAPI + LangGraph + SQLite，Python 3.11+，uv 管理）。
- **部署形态**：本地单进程；`SERVE_FRONTEND=true` 时 FastAPI 托管前端构建产物，API/SSE/静态资源同源。
- **数据边界**：业务库 `backend/data/article.sqlite3`、checkpoint 库、`assets/` 图片、`settings.json` 均在本机 `DATA_DIR`，已被 git 忽略。
- **能力入口**：浏览器 SPA（REST + SSE）、后端内置 MCP Server（Streamable HTTP，默认关闭）、公众号发布（wenyan-mcp 子进程）。

---

## 2. 目录结构

```text
article-studio/
├─ AGENT.md                  # 本文件：AI 入口与硬约束
├─ README.md                 # 用户视角：功能、启动、配置、MCP 接入
├─ docs/
│  ├─ git/branch-workflow.md # 分支管理唯一事实源（先读）
│  ├─ task/                  # 当前任务单 TNNN-*.md（状态机、决策、验收）
│  ├─ version/               # 历史版本任务/issue 归档
│  ├─ tech/tech-design.md    # 技术设计与架构决策
│  ├─ prd/prd.md             # 产品需求与验收口径
│  ├─ ops/                   # 人工运维手册（.gitignore 忽略，仅本地）
│  └─ article/               # 公众号素材（忽略）
├─ backend/
│  ├─ app/                   # FastAPI：路由、仓储、运行管理、发布、设置
│  │  └─ mcp/                # MCP Server（工具层 + 挂载 + 安全中间件）
│  ├─ article_agent/         # LangGraph 智能体、模型/生图 provider 注册
│  ├─ scripts/               # 假模型服务器、E2E 服务器、MCP 冒烟、真实 API 探针
│  └─ tests/                 # pytest（含前端契约基准 test_frontend_contract.py）
├─ frontend/                 # React SPA（pages / features / api / hooks / e2e）
├─ scripts/                  # Windows 启停脚本、hooks 启用脚本
├─ .githooks/pre-push        # 禁止直推 main 的本地防线
└─ prototype/                # MVP 原型（冻结归档，不改）
```

---

## 3. 先读文档顺序

1. **本文件**（AGENT.md）——项目边界与硬约束
2. **[docs/git/branch-workflow.md](docs/git/branch-workflow.md)**——分支、提交、PR、钩子、合并纪律
3. **[docs/tech/tech-design.md](docs/tech/tech-design.md)**——架构、API/SSE 契约、存储与关键决策
4. **[docs/prd/prd.md](docs/prd/prd.md)**——产品功能与验收口径
5. **当前任务单** `docs/task/TNNN-*.md`——目标、已确认决策、范围、验收分层
6. 按需：`README.md` / `backend/README.md` / `frontend/README.md` / `docs/mcp/mcp-setup.md` / `docs/ops/`

---

## 4. 关键约束（技术 / 质量 / 安全）

**技术**
- 后端 REST 路径、请求/响应结构、SSE 事件协议是稳定契约，以 `backend/tests/test_frontend_contract.py` 为基准；不因内部重构改变契约。
- 单进程、单用户、SQLite；不引入 Docker/云依赖，不新增后台服务进程。MCP 与网页共用同一 `app.state` 与数据源。
- 依赖变更（Python `pyproject.toml` / 前端 `package.json`）必须先写进任务单计划，再实施。
- 前端 TypeScript 严格模式；Markdown 渲染走白名单（禁 raw HTML / `dangerouslySetInnerHTML`）。

**质量**
- 后端改动：`cd backend; uv run pytest -p no:cacheprovider` 全量通过。
- 前端改动：`pnpm test`、`pnpm lint`、`pnpm build` 通过；涉及页面主路径时按需跑 `pnpm e2e`。
- 每个任务按 [任务单验收分层](docs/git/branch-workflow.md)（AI 自测层 / 人工验收层）逐项汇报；**不允许假装验证过**。
- 文档与代码冲突：以仓库当前代码为准，指出差异并同步修文档。

**安全 / 数据**
- `.env`、`backend/data/`、`settings.json`、图片资产、日志**不得提交**；运行数据不迁移、不删除、不覆盖（除非任务明确要求）。
- 不把服务暴露到 `0.0.0.0` 或局域网给未鉴权用户；MCP 默认关闭且仅本机回环，开启需 `MCP_ENABLED=true`。
- 工具/日志/PR 不写入真实密钥；错误信息沿用 `redact_sensitive` 脱敏。
- 公众号发布只建草稿、不群发；真实发布会受 IP 白名单与 AppSecret 约束。

---

## 5. Git 与分支约定（摘要，细节见 docs/git/branch-workflow.md）

- `main` 是唯一长期分支；一切改动走**短命分支 → PR → Squash merge**，禁止直推 `main`。
- 功能/修复分支必须带任务编号：`feature/T021-article-studio-mcp`、`fix/T023-...`；文档/杂务：`docs/...`、`chore/...`。
- 分支内提交用 Conventional Commits + 中文 + 任务编号：`feat: T021 新增 MCP Server`。
- 本地防线：`.githooks/pre-push` 拦截直推 `main`。每个克隆执行 `git config core.hooksPath .githooks`（Windows 可双击 `scripts\setup-hooks.cmd`），**启用后必须实测两条路径**（拦 main / 放行功能分支）。
- agent 默认 L0（写操作先确认）；获得 L1 授权后可在当前分支 commit/push；**PR merge 永远由人完成**（除非当次明确授权）。
- 合并后清理本地与远程分支；tag 只打在 `main` 且只加不改。

---

## 6. AI 行为禁区与交接

**禁区（任何授权模式下都不做，除非人当次明确指示）**
- 直推 / force push `main`，使用 `--no-verify` 绕过钩子，删除或移动已完成 tag。
- 自行合并 PR、修改仓库设置（可见性 / 合并方式 / 分支保护）。
- 越任务单范围改文件；擅自新增依赖、删除旧逻辑、改动无关模块。
- 提交密钥、运行时数据、本机私有配置；读取/输出 `.env`、`settings.json` 里的完整凭据。
- 在自测失败未汇报时继续推进；把未验证项写成"已验证"。
- 修改 `prototype/` 或删除历史文档。

**会话交接**
- 任务状态、决策、下一步必须落盘到 `docs/task/TNNN-*.md`（状态机见任务流程规范）；不依赖会话记忆。
- 新会话开工前：读 AGENT.md → 分支工作流 → 当前任务单 → 检查 `git status` / 分支 / 钩子。
- 交接提示词自包含：背景、先读清单、授权模式与分支名、执行内容、自测清单、完成动作。

---

## 7. 常用命令

```powershell
# 环境准备
git config core.hooksPath .githooks      # 或双击 scripts\setup-hooks.cmd（含自测）
cd backend ; uv sync

# 后端开发
cd backend ; uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
cd backend ; uv run pytest -p no:cacheprovider

# 假模型后端（免真实 Key，MCP 默认开启）
cd backend ; uv run python scripts/dev_fake_server.py --port 8000
cd backend ; uv run python scripts/mcp_smoke.py --url http://127.0.0.1:8000/mcp/

# 前端开发与验证
cd frontend ; pnpm install
cd frontend ; pnpm dev
cd frontend ; pnpm test
cd frontend ; pnpm lint
cd frontend ; pnpm build
cd frontend ; pnpm e2e

# 双击脚本（Windows）
scripts\start-all.cmd
scripts\stop-all.cmd
```

pnpm 通过 corepack 使用；无全局 pnpm 时见 [README.md](README.md) 快速开始。

---

## 8. 文档索引

| 文档 | 内容 |
|---|---|
| [docs/git/branch-workflow.md](docs/git/branch-workflow.md) | 分支管理唯一事实源：硬规则、流程、命名、钩子、合并、保护现状 |
| [docs/task/](docs/task/) | 当前任务单（TNNN）与状态机 |
| [docs/mcp/mcp-setup.md](docs/mcp/mcp-setup.md) | MCP 配置工作流：开启、自检、客户端注册、验收、排障 |
| [docs/test/](docs/test/) | 验收测试用例与执行记录 |
| [docs/version/](docs/version/) | 历史版本任务与 issue 归档 |
| [docs/tech/tech-design.md](docs/tech/tech-design.md) | 技术设计、API/SSE 契约、MCP 架构 |
| [docs/prd/prd.md](docs/prd/prd.md) | 产品需求与验收标准 |
| [README.md](README.md) | 启动、配置、MCP 客户端接入、常见问题 |
| [backend/README.md](backend/README.md) | 后端 API 契约、假模型、MCP 端点 |
| [frontend/README.md](frontend/README.md) | 前端结构、命令、与后端契约 |
| `docs/ops/` | 人工运维手册（本地忽略，不随仓库分发） |
