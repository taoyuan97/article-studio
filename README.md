# Article Studio

单仓双工程：`frontend/`（React 19 + Vite + TS + AntD 5）+ `backend/`（FastAPI + LangGraph + SQLite）。

- 产品需求：`docs/prd/prd.md`
- 技术设计：`docs/tech/tech-design.md`
- 任务拆分：`docs/task/T001…T006`
- 运维/人工操作手册：`docs/ops/`
- MVP 原型（冻结归档，不再开发）：`prototype/`

## 开发工作流

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

详见 `frontend/README.md` 与 `backend/README.md`。

## 测试

```powershell
cd backend  ; uv run pytest -p no:cacheprovider   # 全量后端测试（含前端契约测试）
cd frontend ; corepack pnpm build                 # TS strict 编译 + 构建
cd frontend ; corepack pnpm lint                  # ESLint
```

## 生产部署（单进程）

```powershell
cd frontend ; corepack pnpm build                 # 产物 → frontend/dist
cd backend  ; $env:SERVE_FRONTEND = "true"
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

`SERVE_FRONTEND=true` 时 FastAPI 托管 `frontend/dist`，非 `/api` 未命中路径返回 `index.html`（SPA fallback）。
