# T001：工程脚手架（前端初始化与后端迁移）

## 1. 任务信息

- 状态：已完成
- 优先级：P0
- 类型：正式任务 1/6
- 前置任务：无
- 后续任务：T002、T003、T004、T005、T006
- 目标目录：`frontend/`、`backend/`
- 创建日期：2026-08-23
- 关联文档：`docs/prd/prd.md`、`docs/tech/tech-design.md`

## 2. 目标

建立正式项目的双工程脚手架：

1. 前端初始化为 Vite + React 19 + TypeScript 标准工程，可开发、可构建、可代理后端。
2. 后端从 `prototype/article-agent-mvp/backend` 契约不变迁移到 `backend/`，全量测试通过。

完成后应能通过命令行验证：

```text
pnpm dev + uvicorn 同时运行
  → http://localhost:5173 可访问占位页面
  → /api/health 经 Vite proxy 返回 ok
  → backend 目录 uv run pytest 全部通过
```

## 3. 已确认的全局决策

- 前端：React 19 + Vite + TypeScript（strict）+ Ant Design 5 + TanStack Query + Zustand + React Router。
- 包管理器：pnpm。
- 仓库结构：单仓双目录（`frontend/` + `backend/`）。
- 生产部署：FastAPI 托管 `frontend/dist`，单进程。
- 后端契约不变：API 路径、请求/响应结构、SSE 事件协议原样保留。
- 后端结构变化：`app/` 原位 + `src/article_agent/` 合并为平级包 `article_agent/`。
- 不迁移 MVP 数据（`.venv`、`data/`、缓存目录均不迁移）。

## 4. 范围

### 4.1 必须实现（前端）

- Vite + React 19 + TypeScript 初始化，`tsconfig` 开启 `strict`。
- pnpm 管理依赖，提交 `pnpm-lock.yaml`。
- ESLint（typescript-eslint + react-hooks）+ Prettier 配置。
- `vite.config.ts`：`/api` dev proxy → `http://127.0.0.1:8000`（`changeOrigin: true`）。
- 依赖安装与基础装配：Ant Design 5、React Router、TanStack Query、Zustand、react-markdown。
- 入口 Provider 装配：QueryClient / Router / AntD ConfigProvider（中文文案）。
- 根 README：启动方式、目录说明。

### 4.2 必须实现（后端）

- 源码逐文件迁移：`app/` 原位，`src/article_agent/` → `article_agent/`，调整 import 路径。
- `pyproject.toml`、`.env.example`、`scripts/`、`tests/` 一并迁移。
- 新增 `SERVE_FRONTEND` 环境变量：生产模式挂载 `frontend/dist` 静态资源，非 `/api` 未命中路径返回 `index.html`（SPA fallback）；默认 `false`。
- 根 README 或后端 README 更新启动说明。

### 4.3 不实现

- 任何业务功能页面与接口开发（T002 起）。
- 后端业务逻辑修改（迁移过程中发现的问题记录并单独评估，不顺手重构）。
- Docker 化、CI/CD。

## 5. 前端脚手架细节

```text
frontend/
├─ index.html
├─ package.json / pnpm-lock.yaml
├─ vite.config.ts
├─ tsconfig.json（strict）
├─ eslint.config.js / .prettierrc
└─ src/
   ├─ main.tsx          # Provider 装配
   ├─ App.tsx           # 最小路由占位
   └─ styles/           # 主题 tokens 占位
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

## 6. 后端迁移清单

| 来源（prototype/article-agent-mvp/backend） | 目标（backend/） |
|---|---|
| `app/`（main.py、service.py、image_service.py、database.py、security.py、`__init__.py`） | `app/` 原位 |
| `src/article_agent/`（agent、graph、state、models、registry、config、budget、prompts、callbacks、cancellation、image_providers、`__init__`） | `article_agent/`（平级包） |
| `tests/`（全量，含 `test_frontend_contract.py`） | `tests/` |
| `scripts/`（smoke_models.py、test_real_image_providers.py） | `scripts/` |
| `pyproject.toml`、`.env.example` | 原位（新增 `SERVE_FRONTEND` 说明） |
| `.venv/`、`data/`、`__pycache__/`、`.pytest_cache/` | 不迁移 |

`SERVE_FRONTEND` 托管逻辑要求：

- `false`（默认）：行为与 MVP 完全一致，不读 `frontend/dist`。
- `true`：挂载静态资源；`/api` 路径优先匹配 API；其余未命中路径返回 `index.html`。

## 7. 测试

- 前端：`pnpm build` 无 TS/ESLint 报错；dev server 启动正常。
- 后端：新目录 `uv sync` 成功；全量 pytest 通过（以文件清单核对：`test_api.py`、`test_graph.py`、`test_config_registry.py`、`test_budget.py`、`test_image_generation.py`、`test_assets.py`、`test_frontend_contract.py`、`conftest.py`、`fakes.py`）。
- 联调：`GET /api/health` 经 proxy 返回 `{"status": "ok"}`。

## 8. 验收标准

- [ ] `pnpm install && pnpm dev` 启动开发服务器，无 TS/ESLint 报错。
- [ ] `pnpm build` 产出 `dist/`。
- [ ] TypeScript strict 模式编译通过。
- [ ] `/api` 请求经 proxy 抵达本地后端。
- [ ] `backend/` 目录 `uv sync` 成功，`uvicorn app.main:app` 启动正常。
- [ ] 全量 pytest 通过，测试文件与 MVP 一一对应。
- [ ] `SERVE_FRONTEND=false`（默认）行为与 MVP 完全一致。
- [ ] 真实冒烟脚本（`smoke_models.py`）可执行。
- [ ] `prototype/` 目录未被改动。

## 9. 完成定义

上述验收全部通过后，T001 完成。此时才能进入 T002 的前端骨架开发。
