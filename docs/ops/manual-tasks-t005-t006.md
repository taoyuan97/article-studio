# 人工配置与操作手册（T005/T006：仪表盘与质量交付）

> 适用范围：仪表盘与全局体验（T005）、测试/E2E/生产部署（T006）完成后，需要人工完成或协助的事项。
> 环境前提：同 `manual-setup.md`（Node.js 24+、pnpm 11、Python 3.13、uv；`backend/.env` 已配置真实 key）。

## 1. 真实 API 的生产模式人工走查（需要真实 key）

T006 验收要求「生产模式人工走查：单进程启动后完成新建文章 → 对话生成 → 版本查看 → 配图 → 保存素材全流程」。
自动化已覆盖生产形态的假模型路径（E2E 11 用例，单进程托管 dist）与真实后端的静态/API 冒烟（SPA fallback、health、文章创建）；
**以下真实模型全流程走查需人工完成**：

```powershell
cd frontend ; pnpm build          # 产物 → frontend/dist（若已构建可跳过）
cd backend
$env:SERVE_FRONTEND = "true"      # 或在 backend/.env 中改为 true（长期生产形态建议改 .env）
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
# 浏览器访问 http://127.0.0.1:8000（单进程同源，无需前端 dev server）
```

走查清单（建议截图留档）：

| 步骤 | 操作 | 关注点 |
| --- | --- | --- |
| 1 新建文章 | 首页「新建文章」快捷入口 | 创建成功并跳转工作台 |
| 2 对话生成 | 发送「直接写一篇关于 XX 的文章」 | SSE 流式逐字渲染、无整段缓冲 |
| 3 版本查看 | 继续一轮修改 → 版本下拉回看 v1 | 历史版本只读、返回当前正常 |
| 4 配图 | 首页「新建配图」→ prompt → 生成 | 进度条推进、完成后预览 |
| 5 保存素材 | 「保存素材」→ 素材库 | 素材库可见、详情可回链会话 |
| 6 深链刷新 | 在 /articles/{id}、/image-sessions/{id}、/assets 页按 F5 | 均 200 不 404（SPA fallback） |

走查完成后：若通过环境变量临时开启的 `SERVE_FRONTEND`，重启后端即恢复默认（`.env` 中仍为 `false`）。

## 2. Playwright E2E 运行手册（无真实 key）

E2E 全部基于假模型（`backend/scripts/e2e_server.py`，复用 dev_fake_server 假模型 + `SERVE_FRONTEND=true` 托管 dist + `--wipe` 清数据），不消耗任何真实 API 额度。

```powershell
cd frontend
pnpm e2e    # = pnpm build && playwright test（11 用例：场景 A–G、配图/素材主路径、部署、重启恢复）
```

### 2.1 首次运行/换机器需安装浏览器（项目本地目录，不写 %LOCALAPPDATA%）

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "<repo>\.playwright-browsers"
# 下载受限时可加镜像：$env:PLAYWRIGHT_DOWNLOAD_HOST = "https://npmmirror.com/mirrors/playwright"
pnpm exec playwright install chromium
```

运行时路径由 `playwright.config.ts` 自动注入，日常 `pnpm e2e` 无需再设环境变量。

### 2.2 假模型触发词约定（构造失败场景时注意）

- 文章线：**最新用户消息**包含「触发失败」→ 延迟 0.5s 后该次运行失败（失败卡片 + 脱敏详情含 SIMULATED_FAILURE）。
- 生图线：**prompt** 包含「触发失败」→ 延迟 0.5s 后生成失败。
- 触发词是「触发失败」而非「失败」：正文模板与上下文压缩摘要中含「失败」二字，短触发词会误触发（历史教训，见 §4）。

### 2.3 数据与产物清理

- E2E 数据目录：`backend/data/e2e/`（每次运行 `--wipe` 自动清空，无需手动处理；彻底弃用可整目录删除）。
- 失败截图/trace：`frontend/test-results/`（已加入 .gitignore，可随时删除）。

## 3. 测试命令速查

```powershell
cd backend  ; uv run pytest -p no:cacheprovider   # 后端全量（51 用例，含前端契约）
cd frontend ; pnpm test                            # Vitest 组件测试（26 用例，仅收集 src/）
cd frontend ; pnpm lint                            # ESLint
cd frontend ; pnpm build                           # tsc -b + vite build（类型检查含在内）
cd frontend ; pnpm e2e                             # Playwright E2E（先 build 后跑）
```

## 4. 已知事项（本阶段经验记录）

- **触发词误触发**：假模型曾用「失败」作失败触发词，场景 G（8 轮对话触发上下文压缩）中压缩摘要含「失败」导致后续轮次误失败。已改为「触发失败」且只看最新用户消息；`manual-tasks-t003-t004.md` §1 的旧约定已同步勘误。
- **Vitest 与 Playwright 目录分离**：`vite.config.ts` 的 `test.include` 限定 `src/**`，避免 Vitest 误收集 `e2e/*.spec.ts`（Playwright 用例）导致 `test.describe() called here` 报错。
- **瞬间失败导致状态不可观测**：失败注入若无延迟，运行在 UI 显示「正在生成」前就结束，断言会错过中间态；假模型失败注入统一带 0.5s 延迟。
- **`pnpm` 在自动化沙箱内不可用**：见 `manual-setup.md` §2（用户终端正常）。
- **构建产物单 chunk 约 1.28 MB（gzip 约 401 KB）**：MVP 阶段可接受，优化方式见 `manual-tasks-t003-t004.md` §3。

## 5. 自动化验证记录（2026-08-24，供复核）

- 后端全量 pytest：**51 passed**（含前端契约测试）。
- 前端 Vitest：**26 passed**（MarkdownView 安全渲染 3、MessageList 6、ModelSelect 6、SSE hooks 11）。
- 前端 `eslint .` 零错误；`tsc -b && vite build` 成功。
- Playwright E2E：**11 passed**（文章线场景 A/B/C/E/F/G、重启恢复 D、部署 SPA fallback×5 路由与同源静态/API、配图/素材主路径、生图失败卡片）。
- 真实后端单进程生产冒烟（`SERVE_FRONTEND=true` 环境变量覆盖，端口 8902）：`/`、`/articles`、`/assets`、`/image-sessions/{uuid}`、任意未知路径均 200 返回 index.html；`/api/health` 200；未命中 `/api` 路径 404；dist 静态资源 200（text/javascript）；文章创建写路径正常。冒烟产生的测试文章已从 SQLite 清除，`.env` 未改动。
