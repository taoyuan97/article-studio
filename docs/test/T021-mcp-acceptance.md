# T021 MCP Server 验收测试用例

> **关联任务**：[docs/task/T021-article-studio-mcp.md](../task/T021-article-studio-mcp.md)
> **分支**：`feature/T021-article-studio-mcp`
> **状态**：待人工验收（AI 自测层已通过，2026-10-18）
> **验收方式**：按 §3 复跑自动化用例，按 §4 逐条执行手工用例，在 §5 记录结果并给出结论

## 1. 测试范围与分层

| 层 | 内容 | 执行者 |
|---|---|---|
| 自动化（AT） | `backend/tests/test_mcp_server.py` 8 项；`scripts/mcp_smoke.py` 全链路；后端全量 pytest | AI（已执行，见 §3） |
| 手工验收（MT） | 真实 MCP 客户端接入、网页可见性、鉴权/错误路径、真实公众号草稿发布 | 人 |
| 回归（RT） | 后端全量测试、前端 test/lint/build、MCP 关闭时 REST 不受影响 | AI 跑命令 + 人判断 |

**范围外（本期不做）**：多公众号账号管理、群发/定时发布、stdio 独立进程或桥接、MCP Resources/Prompts、文章/素材删除类工具。

## 2. 测试环境与准备

### 2.1 推荐：fake 环境（不消耗真实额度，覆盖除真实发布外的全部链路）

```powershell
# 终端 1：假模型 + 假生图 + fake 发布 + MCP 默认开启
cd backend
uv run python scripts/dev_fake_server.py --port 8000 --data-dir data/mcp-acceptance

# 终端 2（可选）：网页工作台，用于可见性验收
cd frontend
pnpm dev
```

- MCP 端点：`http://127.0.0.1:8000/mcp/`（兼容 `/mcp`）。
- fake 服务默认：`MCP_ENABLED=true`、`PUBLISH_FAKE_MODE=true`、假公众号凭据、`MCP_ALLOWED_HOSTS=127.0.0.1,localhost,::1,test`。
- 数据隔离在 `backend/data/mcp-acceptance/`，删除即可重置。

### 2.2 真实环境（仅 MT-16 / MT-23 需要）

- `backend/.env`：真实 LLM Key、通义万相 Key、`WECHAT_APP_ID` / `WECHAT_APP_SECRET`、`PUBLISH_FAKE_MODE=false`、`MCP_ENABLED=true`。
- 微信公众平台 → 设置与开发 → 基本配置：把本机公网 IP 加入 IP 白名单。
- 已安装 `@wenyan-md/mcp`（`wenyan-mcp` 命令可解析）。

### 2.3 MCP 客户端配置（任选一个）

> DSH 使用 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 profile patch（含 `toolCallTimeoutMs`），完整 YAML 见 `docs/mcp/mcp-setup.md` §6.1；下面为其他客户端示例。

```json
// Cursor / 通用 Streamable HTTP
{ "mcpServers": { "article-studio": { "url": "http://127.0.0.1:8000/mcp/" } } }
```

```powershell
# Claude Code
claude mcp add --transport http article-studio http://127.0.0.1:8000/mcp/
```

若配置了 `MCP_AUTH_TOKEN`，客户端请求头需带 `Authorization: Bearer <token>`。

## 3. 自动化用例（AI 已执行，可复跑）

### AT-01 MCP 专项测试（8 项）

```powershell
cd backend
uv run pytest tests/test_mcp_server.py -p no:cacheprovider -q
```

预期：`8 passed`。覆盖：

1. 工具注册 16 个；MCP 关闭时 `/mcp` 与 `/mcp/` 均 404（`MCP_DISABLED`）。
2. HTTP 挂载 initialize / list_tools，`/mcp` 与 `/mcp/` 均可用。
3. `MCP_AUTH_TOKEN`：无 Token 401（`MCP_UNAUTHORIZED`），正确 Token 通过。
4. Host 白名单 403（`MCP_HOST_FORBIDDEN`）、恶意 Origin 403（`MCP_ORIGIN_FORBIDDEN`）。
5. 内存 ClientSession 全链路：建文章 → 生成 → 生图入库 → 配图方案 → 预览 → 渲染 → fake 发布 → 发布记录。
6. 定稿导入：版本号 1→2、当前版本/标题、历史版本读取。
7. 生成超时返回 `running`，`wait_for_run` 续等得到终态。
8. 结构化错误：`NOT_FOUND` / `INVALID_ARGUMENT`。

### AT-02 全链路冒烟脚本

```powershell
cd backend
uv run python scripts/mcp_smoke.py --url http://127.0.0.1:8000/mcp/
```

预期依次打印：`✓ MCP 已连接` → `studio_status` → `create_article` → `generate_article` → `plan_article_images` → `generate_image` ×3 → 组装 → 渲染 → `publish_article` → `list_publish_records` → `get_article`，最后 `✓ 冒烟通过`，并给出 `FAKE_MEDIA_xxx`。

### AT-03 后端全量回归

```powershell
cd backend
uv run pytest -p no:cacheprovider
```

预期：`163 passed`（2 条既有依赖告警，不影响；含 MCP 设置页 API 与预览 frontmatter 回归用例）。

> 已知环境抖动：`test_wenyan_client.py::test_render_markdown_real_node_integration` 依赖 node 冷启动，机器负载高时可能超过 30s 超时导致全量偶发 1 条失败；单跑该用例复跑可稳定通过，属环境抖动而非功能缺陷。若遇到，先单跑复验再判定 AT-03。

### AT-04 MCP 设置 API 与热生效

```powershell
cd backend
uv run pytest tests/test_settings.py -p no:cacheprovider -q
```

预期：覆盖空 Token 规范化、状态来源/掩码、PATCH/清除/reveal、revision 冲突、Hosts 校验、运行中任务可保存、probe、热生效（启用后 `/mcp` 200/401/404），全部通过。

### AT-05 主题预览 frontmatter 回归（ISSUE-004）

```powershell
cd backend
uv run pytest tests/test_wenyan_client.py tests/test_wenyan_render_script.py -p no:cacheprovider -q
```

预期：全部通过。覆盖真实 core 预览「frontmatter 不进入正文 + description 引用块」，以及 fake wrapper 断言预览脚本走 `prepareRenderContext`、`image_list`/旧 core 明确报错。

## 4. 手工验收用例

> 每条用例在 §5 记录「结果（通过/不通过）」与证据；不通过时写清现象与影响范围。

### A. 接入与安全

| 编号 | 前置 | 操作步骤 | 预期结果 |
|---|---|---|---|
| MT-01 | fake 环境 | 客户端注册 MCP，initialize 后列出工具 | 返回 16 个工具：`studio_status`、`list_articles`、`get_article`、`list_assets`、`list_publish_records`、`create_article`、`generate_article`、`import_article_version`、`get_article_version`、`wait_for_run`、`generate_image`、`plan_article_images`、`list_publish_themes`、`preview_publish`、`render_publish_preview`、`publish_article` |
| MT-02 | 客户端 URL 不带尾斜杠 | 把端点改为 `http://127.0.0.1:8000/mcp` 重连 | 正常 initialize，无 307/redirect 报错 |
| MT-03 | `MCP_ENABLED=false`（改 `backend/.env` 后重启） | `Invoke-WebRequest -Method Post -Uri http://127.0.0.1:8000/mcp/ -ContentType 'application/json' -Body '{"jsonrpc":"2.0","id":1,"method":"initialize"}'` | HTTP 404，body 含 `MCP_DISABLED`；`/api/health` 仍 200 |
| MT-04 | 设 `MCP_AUTH_TOKEN=test-token` 并重启 | 客户端不带 Token 连接；再带 `Authorization: Bearer test-token` 连接 | 第一次 401（`MCP_UNAUTHORIZED`）；第二次 initialize 成功 |
| MT-05 | 默认 Host 白名单 | 用非白名单 Host 请求 `/mcp/`（如 `Host: evil.example`）或伪造 `Origin: http://evil.example` | 403，`MCP_HOST_FORBIDDEN` / `MCP_ORIGIN_FORBIDDEN` |

### B. 文章线

| 编号 | 前置 | 操作步骤 | 预期结果 |
|---|---|---|---|
| MT-06 | fake 环境 | 调 `create_article` | 返回 `id`、`title="未命名文章"`、`status="draft"`、默认 provider/model |
| MT-07 | MT-06 | 调 `generate_article(article_id, instruction="写一篇关于专注的文章")` | 返回 `version_number=1`、标题与 `content_markdown`；网页文章工作台出现用户消息、助手消息与 v1 版本 |
| MT-08 | 设 `MCP_WAIT_TIMEOUT_SECONDS=0.01` 并重启 | `generate_article` 后立即观察返回；再调 `wait_for_run(run_id, kind="article", timeout_seconds=60)` | 第一次返回 `{status:"running", run_id}`；第二次返回版本终态；后台运行未被取消 |
| MT-09 | MT-06 | 调 `import_article_version(article_id, title="智能体定稿", content_markdown="# 定稿\n\n正文")` 两次 | 版本号依次 1、2；`get_article` 当前标题/版本正确；网页版本面板可见两条历史版本 |
| MT-10 | MT-09 | 调 `get_article_version`（不传 version_id）与显式传旧 version_id | 默认返回当前版本（`is_current=true`）；显式旧版本返回历史正文（`is_current=false`） |
| MT-11 | 正在生成时 | 对同一 article 连续调两次 `generate_article` | 第二次返回结构化错误 `ARTICLE_RUN_ACTIVE`，不产生新版本 |
| MT-12 | 未配置模型（或传不存在的 provider/model） | 调 `create_article(provider="deepseek", model="不存在")` | 返回 `MODEL_NOT_CONFIGURED` 或 `INVALID_ARGUMENT`，无 500、无密钥泄露 |

### C. 配图线

| 编号 | 前置 | 操作步骤 | 预期结果 |
|---|---|---|---|
| MT-13 | fake 环境 | 调 `generate_image(prompt="水彩：清晨书桌", article_id=...)` | 返回 `asset_id`、`image_url`（`/static/assets/...`）、`session_id`、`message_id`、尺寸；网页配图会话与素材库可见该图 |
| MT-14 | MT-07 | 调 `plan_article_images(article_id)` | 返回 `plan.images[]`，每项含 `block_index`、`position_hint`、`layout`、`prompt`；`block_index` 与 `preview_publish.blocks[].index` 对齐 |
| MT-15 | MT-13 | 调 `generate_image(prompt="x", ratio="5:7")`（非法比例） | 返回 `IMAGE_PARAMS_INVALID`，不发起生图 |
| MT-15b | 真实环境且未配置生图 Key | 调 `generate_image` | 返回 `IMAGE_PROVIDER_NOT_CONFIGURED`，提示到设置页配置 |

### D. 排版

| 编号 | 前置 | 操作步骤 | 预期结果 |
|---|---|---|---|
| MT-16 | fake 或真实环境 | 调 `list_publish_themes` | fake 返回 8 个内置主题；真实环境返回 wenyan 主题列表（含 `default`） |
| MT-17 | MT-13 | 调 `preview_publish(article_id, image_placements=[{asset_id, position:"after_block_2"}], cover_asset_id=asset_id, author="验收")` | 返回 `blocks`（含 index/kind/preview/text）、`markdown`（`---` frontmatter + 正文插图）；插图出现在第 2 块后 |
| MT-18 | MT-17 | 调 `render_publish_preview(..., theme_id="default")`，再换 `theme_id="orangeheart"` | 均返回 `html`；两次 HTML 样式不同；HTML 不含 frontmatter 字段文本（`title:`/`cover:`/`author:`），`description` 按发布语义渲染为引用块；HTML 内不含本地绝对路径 |
| MT-19 | MT-17 | 调 `preview_publish`，`position="middle"` 或 `after_block_999` | `middle` → `INVALID_ARGUMENT`；越界 → `PUBLISH_PLACEMENT_INVALID` |

### E. 发布

| 编号 | 前置 | 操作步骤 | 预期结果 |
|---|---|---|---|
| MT-20 | fake 环境（有 1 张图） | 调 `publish_article(article_id, theme_id="default", image_placements=[...], cover_asset_id=...)` | 返回 `media_id="FAKE_MEDIA_..."`、`status="succeeded"`、`draft_only=true`；网页发布记录出现成功记录与快照 |
| MT-21 | fake 环境 | 发布一段用户消息含「触发发布失败」生成的文章 | 返回 `PUBLISH_MCP_ERROR`；发布记录为 `failed`，含错误码/信息，可展开查看 |
| MT-22 | 清空 `WECHAT_APP_ID/SECRET` 并重启（或直接调真实环境缺凭据） | 调 `publish_article` | 返回 `PUBLISH_CREDENTIALS_MISSING`，不发起微信请求 |
| MT-23 | 真实环境（凭据 + IP 白名单 + 非 fake） | 用真实公众号发布一篇含封面与插图的文章 | 公众号草稿箱出现草稿；标题、封面、正文插图与主题预览一致；**只建草稿未群发** |

### F. 数据可见性与回归

| 编号 | 前置 | 操作步骤 | 预期结果 |
|---|---|---|---|
| MT-24 | MT-07 / MT-13 / MT-20 | 网页打开文章工作台、素材库、发布记录、快照详情 | 版本/消息、素材、发布记录、内容快照均与 MCP 返回一致 |
| MT-25 | fake 环境 | `GET /api/articles`、`/api/assets`、`/api/publish/records` | 返回 MCP 产出的数据；无 500 |
| MT-26 | 无改动代码 | `cd backend; uv run pytest -p no:cacheprovider`；`cd frontend; pnpm test; pnpm lint; pnpm build` | 后端 150 passed；前端测试/lint/build 通过 |
| MT-27 | 默认关闭 MCP 启动真实后端 | 访问 `/api/health` 与网页主路径 | REST/网页正常；`/mcp/` 404（默认不暴露） |

### G. MCP 设置页（2026-10-19 新增）

| 编号 | 前置 | 操作步骤 | 预期结果 |
|---|---|---|---|
| MT-28 | 后端已启动（fake 或真实） | 打开 `/settings?tab=mcp` | 看到「MCP 配置」Tab、状态卡（端点/传输/16 工具/来源）、服务开关、鉴权、Hosts、等待时间、DSH 片段 |
| MT-29 | MT-28 | 开启服务并保存；不重启，调用 `/mcp/` initialize；再关闭并保存后调用 | 开启后 initialize 成功；关闭后 `/mcp/` 返回 404；保存后无需重启 |
| MT-30 | 空 `MCP_AUTH_TOKEN=` | 页面确认鉴权关闭；标准客户端连接 | 鉴权显示未启用，客户端无需 Token 即可 initialize（空 Token 不再启用鉴权） |
| MT-31 | MT-28 | 开启鉴权 + 填/生成 Token 并保存；用无 Token 与正确 Token 的客户端分别连接 | 无 Token 401，正确 Token initialize 成功；状态仅显示 Token 掩码，眼睛可查看 runtime Token，`.env` Token 不可查看 |
| MT-32 | MT-28 | 修改 Allowed Hosts（含非法项）保存；再改合法值/等待时间保存 | 非法 Hosts 返回 422；合法值保存后状态与来源更新；等待时间持久化 |
| MT-33 | 两个浏览器标签打开设置页 | 标签 A 保存后，标签 B 用旧 revision 保存；再清除 Token | B 返回 409 冲突并提示刷新；清除 Token 后回退 `.env`（无 `.env` Token 时需先关鉴权） |
| MT-34 | MT-28 | 查看并复制 DSH YAML 片段 | 片段含端点、`toolCallTimeoutMs`（鉴权开启时含 `Authorization` 占位）；复制成功；不会自动修改 `~/.dsh` |
| MT-35 | MT-28 | 点击「测试配置」 | 配置级返回（开启状态、16 工具、鉴权状态），不发起真实网络请求/不校验 Token 有效性 |

## 5. 验收执行记录

| 用例 | 结果（通过/不通过） | 证据 / 现象 | 执行人 | 日期 |
|---|---|---|---|---|
| AT-01 ~ AT-05 |  |  |  |  |
| MT-01 ~ MT-05 |  |  |  |  |
| MT-06 ~ MT-12 |  |  |  |  |
| MT-13 ~ MT-15b |  |  |  |  |
| MT-16 ~ MT-19 |  |  |  |  |
| MT-20 ~ MT-23 |  |  |  |  |
| MT-24 ~ MT-27 |  |  |  |  |
| MT-28 ~ MT-35 |  |  |  |  |

**验收结论**：☐ 通过（可合并 `feature/T021-article-studio-mcp` 到 `main`）　☐ 不通过（需返工，问题记录：）

**验收人 / 日期**：____________________

## 6. 通过判据

- §3 自动化用例全部通过（AI 已跑）。
- §4 手工用例 MT-01 ~ MT-22、MT-24 ~ MT-35 通过；MT-23（真实公众号草稿）可单独确认是否本次执行。
- 无密钥/凭据出现在工具返回、日志、错误信息或发布记录中。
- MCP 关闭时 REST/网页行为不变；开启时网页可见 MCP 产物。
- 验收记录与结论已填写。

## 7. 清理

```powershell
# 停止 dev_fake_server / 前端 dev server（Ctrl+C）
# 重置验收数据（可选）
Remove-Item -Recurse -Force backend\data\mcp-acceptance

# 若临时改过 .env（MCP_ENABLED / MCP_AUTH_TOKEN / MCP_WAIT_TIMEOUT_SECONDS），恢复原值
# 若临时注册了 MCP 客户端，按客户端文档移除
git status --short   # 应无输出
```

## 8. 已知边界

- 发布只创建公众号草稿，**不群发**；群发需在公众号后台人工操作。
- 单公众号：MCP 只能发布到设置页当前配置的账号（多账号管理不在本期）。
- 不提供删除文章/素材/发布记录的工具。
- MCP 默认关闭；不监听 `0.0.0.0` 时仅本机可访问，跨机接入需自行叠加 Token 与网络隔离。
