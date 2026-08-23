# 人工配置与环境操作手册（T001/T002）

> 适用范围：项目脚手架（T001）与前端骨架（T002）完成后，需要人工完成或协助的事项。
> 环境前提：Node.js 24+、pnpm 11（corepack）、Python 3.13、uv。

## 1. 配置 backend/.env（必做）

后端启动时会校验默认 LLM provider 的完整配置（API key + model + context window）。
缺少 `.env` 时启动直接失败，报错形如：

```text
Value error, Default provider 'deepseek' is missing: API key, model, context window
```

API key 属于秘密信息，无法由自动化流程代填，需人工操作：

1. 复制模板：

   ```powershell
   Copy-Item backend\.env.example backend\.env
   ```

2. 编辑 `backend/.env`，至少填写默认 LLM provider 三项（以 DeepSeek 为例）：

   ```text
   DEFAULT_LLM_PROVIDER=deepseek
   DEEPSEEK_API_KEY=<你的真实 key>
   DEEPSEEK_MODEL=deepseek-chat
   DEEPSEEK_CONTEXT_WINDOW=128000
   ```

   - 若改用 Moonshot：设置 `DEFAULT_LLM_PROVIDER=moonshot` 并填写 `MOONSHOT_*` 三项。
   - 生图 provider（阿里云通义万相 / 即梦）在 T004 前配置即可，见 `.env.example` 内注释。
   - `SERVE_FRONTEND` 开发期保持 `false`；生产部署置 `true`（需先 `pnpm build`）。

3. 验证：

   ```powershell
   cd backend
   uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
   # 另开终端
   Invoke-WebRequest http://127.0.0.1:8000/api/health   # 期望 {"status":"ok"}
   ```

## 2. pnpm 环境问题（按需处理）

自动化沙箱内执行 pnpm 可能遇到以下三类问题，均需在**用户自己的终端**（非沙箱）操作：

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `pnpm` 不是内部或外部命令 | pnpm 未加入 PATH | 用户终端执行 `corepack enable`；或安装 pnpm 后重开终端 |
| corepack 报 `EPERM ... corepack` | corepack 需下载 pnpm 到 `AppData\Local\node\corepack`，被沙箱拦截 | 在用户终端执行一次任意 `pnpm` 命令完成下载缓存 |
| `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild` | pnpm 11 默认拦截依赖构建脚本 | 已通过 `frontend/pnpm-workspace.yaml` 的 `allowBuilds: esbuild: true` 解决；若升级 pnpm 后复现，检查该文件语法（pnpm 10 为 `onlyBuiltDependencies` 数组，pnpm 11 为 `allowBuilds` 映射） |

首次安装依赖与构建请在用户终端执行：

```powershell
cd frontend
pnpm install
pnpm build        # 产出 dist/
pnpm dev          # 开发服务器 http://localhost:5173，/api 代理到 127.0.0.1:8000
```

## 3. 真实模型冒烟（T001 验收项，需真实 key）

`smoke_models.py` 依赖 `.env` 中的真实 API key，自动化测试（FakeChatModel）无法覆盖：

```powershell
cd backend
uv run python scripts/smoke_models.py <deepseek|moonshot>
# 生图 provider 冒烟（配置生图 key 后）
uv run python scripts/test_real_image_providers.py
```

注：`smoke_models.py` 需显式传入 provider 参数。

## 4. 回归验证清单（已完成，供人工复核）

以下项已由自动化流程验证通过（2026-08-23）：

- 后端全量 pytest：51 passed（含新增 `test_serve_frontend_spa_fallback`）。
- 前端 `pnpm build` 成功；ESLint / `tsc --noEmit` 零错误。
- 联调：`GET /api/health` 经 Vite proxy 返回 `{"status":"ok"}`；`/api/nonexistent` 返回 404。
- `SERVE_FRONTEND=true`：`/` 与深链 `/articles` 均返回 `index.html`；`/api/*` 404 保持可见。
- 浏览器实测：首页 / 文章 / 素材三路由切换正常，console 无错误。

## 5. 真实模型冒烟结果（2026-08-23，已通过）

配置：`.env` 已填 DeepSeek（deepseek-v4-flash）、Moonshot（kimi-k2.6）、阿里云通义万相（wan2.7-image）、即梦（doubao-seedream-5-0-lite-260128）真实 key。

| 冒烟项 | 结果 |
| --- | --- |
| `smoke_models.py deepseek` | 通过：非流式 OK / 流式正常（usage 含 reasoning）/ 取消 1 chunk 停止 / 文章生成 + 修订成功 |
| `smoke_models.py moonshot` | 通过：非流式 OK / 流式正常 / 取消正常 / 文章生成 + 修订成功（修订标题更新） |
| `test_real_image_providers.py` aliyun_wanxiang | 通过：1024×1024 PNG 落盘 `backend/data/assets/images/`，`storage_url` 为 `/static/assets/...` |
| `test_real_image_providers.py` dreamina | 通过：2048×2048 图片落盘，raw_response 正常 |

冒烟副产物：`backend/data/assets/images/` 下两张测试图片，可按需清理。
