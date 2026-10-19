# T021：Article Studio MCP Server（本地智能体接入）

> **状态**：`WAIT_ACCEPTANCE`
> **分支**：`feature/T021-article-studio-mcp`
> **版本归属**：下一版本（建议 v1.1.0，验收通过后由人工打 tag）

## 1. 任务信息

- 状态：`WAIT_ACCEPTANCE`（AI 自测通过，待人工验收，2026-10-18）
- 优先级：P1
- 类型：MCP Server / 本地智能体集成
- 前置任务：T003（文章线）、T004（配图线）、T007–T010（公众号发布）、T015（配图计划）、T018（设置与运行态配置）
- 后续任务：多公众号账号管理（本期不做，见 D1）、stdio 桥接（本期不做，见 D3）
- 目标目录：`backend/app/mcp/`、`backend/app/`、`backend/article_agent/`、`backend/tests/`、`backend/scripts/`、`docs/`
- 创建日期：2026-10-18
- 关联文档：`docs/prd/prd.md`、`docs/tech/tech-design.md`、`backend/README.md`、`README.md`
- 需求来源：让本地智能体通过 MCP 调用文章工作台，完成「创建文章 → 配图 → 排版 → 发布到公众号草稿箱」闭环

## 2. 目标与现状

### 2.1 目标

在现有 FastAPI 单进程后端内新增 MCP Server，以 Streamable HTTP 暴露文章工作台能力。本地智能体（DSH / Claude Code / Cursor 等）注册 MCP 后，可以在不打开网页的情况下完成：

1. **创建文章**：新建文章；调用后端文章智能体生成/修订正文，或由智能体直接写入 Markdown 定稿。
2. **配图**：生成配图并自动保存为素材；按 T015 配图计划产出块锚点、排版建议与提示词。
3. **排版**：读取正文块清单，按 `after_block_{n}` 锚点插入配图；选择 wenyan 主题并渲染与发布完全一致的预览。
4. **发布**：将文章（含封面/插图和主题）发布到当前已配置公众号的草稿箱（只建草稿，不群发），发布记录可在网页回看。

MCP 产生的文章版本、素材、发布记录与网页工作台共用同一份 SQLite / 资产目录，UI 直接可见。

### 2.2 现状

- 后端已具备全部业务能力：`RunManager` + `ArticleAgent`（文章生成/修订）、`ImageRunManager` + `ImageProviderRegistry`（生图）、`plan_service`（配图编排）、`publish_service`（块锚点组装 + 主题渲染）、`WenyanMcpClient`（wenyan-mcp 发布草稿）。
- 现有对外接口为 REST + SSE，run 为异步语义，对智能体不友好；发布只支持「设置页当前配置」的单一公众号。
- Python 依赖已包含官方 `mcp` SDK（`mcp>=1.0,<2`，当前 1.29），仅用于 `WenyanMcpClient` 的客户端调用，尚无 MCP Server 层。
- 应用定位单机、单用户、单进程，现有 API 无登录鉴权。

## 3. 范围内与范围外

**做**

- 新增 `backend/app/mcp/`：Streamable HTTP MCP Server（16 个工具）、挂载、安全中间件。
- 新增定稿导入仓储方法（不调用 LLM 生成版本），并复用现有 run/消息/版本表结构。
- fake 模式端到端自测、接入文档、冒烟脚本。
- `MCP_ENABLED` / `MCP_AUTH_TOKEN` / `MCP_ALLOWED_HOSTS` / `MCP_WAIT_TIMEOUT_SECONDS` 配置与示例。

**不做（明确排除）**

- 多公众号账号管理、群发、定时发布（PRD 范围外，见 D1）。
- stdio 独立进程/MCP 桥接；仅 Streamable HTTP（D3）。
- 修改现有 REST 接口契约、网页工作台功能与 UI（D7）。
- MCP Resources/Prompts、登录鉴权体系、文章/素材删除工具。
- 真实公众号发布验收（需真实凭据 + IP 白名单，留人工）。

## 4. 已确认决策（2026-10-18）

| 编号 | 决策点 | 结论 |
|---|---|---|
| D1 | 公众号范围 | **单公众号**：沿用设置页当前配置的 AppID/AppSecret；MCP 只返回掩码/配置状态，不引入账号库。多账号管理仍属 PRD 范围外，留待后续任务 |
| D2 | 文章内容来源 | **两者都支持**：`generate_article` 调用后端文章智能体生成/修订；`import_article_version` 允许智能体直接写入 Markdown 定稿为新版本（不调用 LLM） |
| D3 | 接入方式 | **仅 Streamable HTTP**：随后端启动挂载 `<base>/mcp/`；不提供 stdio 独立进程/桥接，客户端仅支持 stdio 时用 `npx mcp-remote` 等外部方案 |
| D4 | 开启方式 | **显式开启**：`MCP_ENABLED=true`（`backend/.env`）才对外提供 `/mcp/`，默认关闭；叠加 Host 白名单与可选 Bearer Token |
| D5 | 同步语义 | 生成类工具默认等待终态；超过 `timeout_seconds` 返回 `{status:"running", run_id}`，配套 `wait_for_run` 续等。超时/断开不取消后端运行 |
| D6 | 配图入库 | `generate_image` 成功后自动保存素材（沿用仓储幂等），返回 `asset_id` 供正文化插图/封面直接使用 |
| D7 | 契约影响 | 不修改现有 REST 接口路径与响应；仅新增内部仓储方法与共享校验模型，前端本期零改动 |
| D8 | 安全 | Host 白名单（默认 127.0.0.1/localhost/::1）、可选 `MCP_AUTH_TOKEN` Bearer 校验、错误脱敏、不提供删除类工具；MCP 关闭时 `/mcp*` 返回 404 |
| D9 | 文档编号 | `docs/task/T021-article-studio-mcp.md`（按当前指定放 `docs/task/`） |
| D10 | Git 纪律 | 单分支 `feature/T021-article-studio-mcp`，Conventional Commits + 任务编号；PR 由人工创建与 merge |

## 5. 实施步骤与阶段验收

单分支完成，按提交拆分；每步完成后跑对应自测（[AI] 层），最终统一回归。

| 步骤 | 内容 | 验收标准 |
|---|---|---|
| s1 | 配置、共享 `ImagePlacement`、定稿导入仓储 | [AI] 现有 pytest 通过；导入版本号/当前版本/标题正确 |
| s2 | MCP 骨架：context/server/asgi 挂载与安全 | [AI] 关闭时 `/mcp*` 404；开启时可 initialize；Host/Token 拦截符合预期 |
| s3 | 工具：meta/articles/images/publish | [AI] 工具清单=16；参数校验与错误码映射正确 |
| s4 | 端到端自测与冒烟脚本 | [AI] fake 模型 + fake 生图 + fake 发布完整链路；超时续等成功 |
| s5 | 文档与回归 | [AI] 全量 pytest、`git diff --check`；README/tech-design/接入手册更新；[人工] 真实客户端注册与真实公众号发布走查 |

## 6. 架构

```text
本地智能体（DSH / Claude Code / Cursor）
        │  MCP Streamable HTTP  POST http://127.0.0.1:8000/mcp/
        ▼
FastAPI 同进程（单进程、单数据源）
  app/mcp/  FastMCP 工具层（薄适配：参数校验 + 等待/超时 + 错误码）
     ├── RunManager / ArticleAgent        文章生成、版本
     ├── ImageRunManager / ImageRegistry  配图、素材
     ├── plan_service                     配图方案
     ├── publish_service                  排版组装 / 渲染预览
     └── WenyanMcpClient ──stdio──> wenyan-mcp ──> 公众号草稿箱
```

关键点：

- **同进程挂载**：工具直接使用 `app.state` 中的仓储/运行管理/客户端，不新增服务、不复制业务逻辑、无双写。
- **工具层只做编排**：把异步 run 转为「等待到终态或超时返回句柄」，把领域错误映射为 MCP `isError` + `CODE: message`。
- **Streamable HTTP**：`FastMCP(stateless_http=True, json_response=True)`，挂载到 `/mcp/`；同时把 `/mcp` 规整为 `/mcp/`，避免客户端漏写尾斜杠时被 307 中断（MCP 客户端不跟随重定向）。
- **生命周期**：MCP 的 session manager 在 FastAPI lifespan 中 `async with` 启动/关闭。
- **安全护栏**：纯 ASGI 中间件在路由前校验「是否开启 / Host / Token」，关闭时 404、未授权时 401；关闭 DNS rebinding 默认校验以便自定义白名单。

## 7. 工具契约（16 个）

### 7.1 查询与自检

| 工具 | 参数 | 返回 |
|---|---|---|
| `studio_status` | — | 默认/可用 LLM 模型、生图 provider、公众号配置状态（掩码）、fake 模式、文章/素材/发布记录计数、默认等待超时 |
| `list_articles` | `limit=20` | 文章摘要列表（id/title/status/version_count/updated_at） |
| `get_article` | `article_id` | 文章详情 + 版本列表 + 当前版本完整正文 |
| `list_assets` | `limit=20` | 素材（id/title/storage_url/尺寸/来源） |
| `list_publish_records` | `article_id?`、`limit=20` | 发布记录（状态/media_id/错误码/时间） |

### 7.2 文章

| 工具 | 参数 | 返回 |
|---|---|---|
| `create_article` | `provider?`、`model?` | 新文章（id/title/provider/model） |
| `generate_article` | `article_id`、`instruction`、`provider?`、`model?`、`wait=true`、`timeout_seconds=180` | 成功：版本 id/title/content_markdown/run_id；超时：`{status:"running", run_id}` |
| `import_article_version` | `article_id`、`title`、`content_markdown` | 新版本 id/version_number/title；不调用 LLM，创建 completed run 以复用版本/消息模型 |
| `get_article_version` | `article_id`、`version_id?` | 版本正文（缺省当前版本） |
| `wait_for_run` | `run_id`、`kind=article\|image`、`timeout_seconds=180` | 终态结果；仍未完成返回 running |

### 7.3 配图

| 工具 | 参数 | 返回 |
|---|---|---|
| `generate_image` | `prompt`、`article_id?`、`provider?`、`model?`、`tier?`、`ratio?`、`wait=true`、`timeout_seconds=180` | `asset_id`、`image_url`、`session_id`、`message_id`、尺寸；自动创建配图会话并保存素材 |
| `plan_article_images` | `article_id`、`version_id?`、`role?`、`instructions?`、`provider?`、`model?` | 配图方案（mood/style_summary/images[{block_index,position_hint,layout,layout_reason,prompt}]）+ session_id |

### 7.4 排版与发布

| 工具 | 参数 | 返回 |
|---|---|---|
| `list_publish_themes` | — | wenyan 主题列表（id/name/description） |
| `preview_publish` | `article_id`、`version_id?`、`image_placements?`、`cover_asset_id?`、`author?`、`digest?` | `blocks`（{index,kind,preview,text}）、`sections`、组装后 `markdown` |
| `render_publish_preview` | 同上 + `theme_id`、`markdown?` | `html`（与真实发布同一 `@wenyan-md/core` 渲染参数） |
| `publish_article` | `article_id`、`theme_id`、`version_id?`、`image_placements?`、`cover_asset_id?`、`author?`、`digest?`、`edited_markdown?`、`timeout_seconds=180` | `publish_id`、`media_id`、`status:"succeeded"` + 当前公众号掩码信息；失败落 publish_records 并抛结构化错误 |

`image_placements` 元素为 `{asset_id, position, order?}`，`position` 支持 `top` / `bottom` / `after_block_{n}` / `after_section_{n}`（历史兼容），越界抛 `PUBLISH_PLACEMENT_INVALID`。

### 7.5 错误与超时语义

- 预期失败统一抛 MCP `ToolError`，文本格式 `CODE: message`；未知异常同样脱敏后返回 `MCP_TOOL_ERROR: ...`。
- 沿用既有错误码：`PUBLISH_*`、`PLAN_*`、`NOT_FOUND`、`ARTICLE_RUN_ACTIVE`、`MODEL_NOT_CONFIGURED`、`IMAGE_PROVIDER_NOT_CONFIGURED`、`INVALID_ARGUMENT` 等。
- `wait=true` 超时不是错误：返回 `{status:"running", run_id, hint}`，可继续 `wait_for_run`；客户端断开/超时不会取消后台运行。
- 工具结果不包含任何密钥；公众号只返回掩码与配置状态。

## 8. 文件改动

**新增**

- `backend/app/mcp/__init__.py`
- `backend/app/mcp/context.py`：`McpContext`（访问 `app.state`）、数据整理与错误映射辅助
- `backend/app/mcp/server.py`：`create_mcp_server()`，注册全部工具与 server instructions
- `backend/app/mcp/tools_meta.py`：`studio_status` / `list_articles` / `get_article` / `list_assets` / `list_publish_records`
- `backend/app/mcp/tools_articles.py`：`create_article` / `generate_article` / `import_article_version` / `get_article_version` / `wait_for_run`
- `backend/app/mcp/tools_images.py`：`generate_image` / `plan_article_images`
- `backend/app/mcp/tools_publish.py`：`list_publish_themes` / `preview_publish` / `render_publish_preview` / `publish_article`
- `backend/app/mcp/asgi.py`：挂载与安全中间件（开启开关 / Host 白名单 / 可选 Bearer / `/mcp` 路径规整）
- `backend/app/publish_models.py`：`ImagePlacement` 与位置校验（从 `main.py` 抽出，REST/MCP 共用）
- `backend/tests/test_mcp_server.py`
- `backend/scripts/mcp_smoke.py`：连本地 `/mcp/` 跑完整 happy path 的人工冒烟脚本
- `docs/ops/manual-mcp-clients.md`：客户端接入与冒烟手册（docs/ops 为本地忽略目录）

**修改**

- `backend/app/main.py`：lifespan 启动/关闭 MCP session manager；挂载 `/mcp` 与安全中间件；复用抽取后的 `ImagePlacement`
- `backend/article_agent/config.py`：`MCP_ENABLED`、`MCP_AUTH_TOKEN`、`MCP_ALLOWED_HOSTS`、`MCP_WAIT_TIMEOUT_SECONDS`
- `backend/app/database.py`：`create_imported_version()`（定稿导入：completed run + 消息 + 版本，复用既有表结构）+ `get_version_by_run_id()`
- `backend/.env.example`、`README.md`、`backend/README.md`、`docs/tech/tech-design.md`
- `backend/scripts/dev_fake_server.py`：fake 模式默认开启 MCP（免真实 Key 验收）

## 9. 安全与边界

- `/mcp/` 默认不开启；仅 `MCP_ENABLED=true` 时可用，其余情况 404（不暴露工具清单）。
- Host 校验默认只允许本机回环；`MCP_ALLOWED_HOSTS` 可扩展（逗号分隔，忽略端口）。跨机访问应自行叠加 Token 与网络隔离。
- `MCP_AUTH_TOKEN` 设置后要求 `Authorization: Bearer <token>`；Token 不写入日志。
- 不提供文章/素材/发布记录删除工具；发布只建草稿、不群发。
- `import_article_version` 只接受字符串正文，不读取本机任意文件路径。

## 10. 测试与验收（分层）

### 10.1 AI 自测层

验收用例与执行记录见 [docs/test/T021-mcp-acceptance.md](../test/T021-mcp-acceptance.md)（人工验收按该文档 §4 逐条执行）。

- 工具注册清单与参数校验。
- 内存 `ClientSession` 端到端（fake 模型 + fake 生图 + fake 发布）：创建文章 → 生成正文 → 生图自动入库 → 配图方案 → 组装预览 → 渲染预览 → fake 发布 → 发布记录。
- 定稿导入：版本号递增、当前版本与标题更新、消息时间线正常。
- 超时语义：`timeout_seconds` 很小时返回 running；`wait_for_run` 能等到终态。
- HTTP 挂载：`initialize/list_tools/call_tool`；`/mcp` 无尾斜杠可用；关闭时 404；Host 拒绝；Token 拒绝/通过。
- 现有后端全量 pytest 回归通过。
- `git diff --check`；构建类检查（后端无编译步骤，以 pytest 为基线）。

### 10.2 人工验收层（留人工）

- 真实本地智能体（DSH capability / Claude Code / Cursor）注册 MCP 后完成一次真实交互。
- 网页工作台确认 MCP 产出的文章版本、配图素材、发布记录可见。
- 真实公众号（凭据 + IP 白名单）发布草稿并核对草稿箱内容；预览 = 发布效果。

### 10.3 人工冒烟步骤

1. `backend/.env` 设 `MCP_ENABLED=true`；无真实 Key 时用 `uv run python scripts/dev_fake_server.py`（fake 模型 + `PUBLISH_FAKE_MODE=true`）。
2. `uv run python scripts/mcp_smoke.py --url http://127.0.0.1:8000/mcp/` 跑完整链路。
3. 网页工作台确认：新文章/版本、配图素材、发布记录可见。
4. 真实客户端注册（DSH capability / Claude Code / Cursor），验证 initialize 与至少一次工具调用。

## 11. 验收标准

- [x] [AI] `MCP_ENABLED=true` 时 MCP 客户端可 initialize 并列出 16 个工具；关闭时 `/mcp*` 为 404。
- [x] [AI] `create_article` + `generate_article` 产出 v1，网页文章工作台可见版本与消息。
- [x] [AI] `import_article_version` 可写入智能体定稿并生成新版本（不调用 LLM）。
- [x] [AI] `generate_image` 生成图片、自动入库素材，返回的 `asset_id` 可用于排版/封面。
- [x] [AI] `plan_article_images` 返回与 T015 一致的块锚点方案。
- [x] [AI] `preview_publish` / `render_publish_preview` 与网页发布向导同源（块编号、渲染效果一致）。
- [x] [AI] `publish_article` 在 fake 模式返回 media_id 并落发布记录；失败返回结构化错误且记录失败。
- [x] [AI] 生成工具超时返回 running，`wait_for_run` 可续等；失败不泄露密钥。
- [x] [AI] `cd backend; uv run pytest -p no:cacheprovider` 全量通过。
- [x] [AI] README / backend README / tech-design / 接入手册更新，客户端配置示例可直接复制。
- [ ] [人工] 真实客户端接入 + 网页可见性 + 真实公众号草稿发布验收。

## 12. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| MCP 客户端长工具调用超时 | 文章生成可能 30–120s，部分客户端默认超时更短 | 默认 `wait=true` + 可调 `timeout_seconds`；超时返回 running，`wait_for_run` 续等；文档给客户端超时配置建议 |
| 无鉴权端点被误暴露到局域网 | 可被任意本机/网络客户端调用 | 默认关闭 + Host 白名单 + 可选 Bearer；文档强调仅监听 127.0.0.1 |
| 定稿导入绕过文章智能体 | 版本缺少 brief/摘要等字段 | 复用 completed run/消息模型，保持工作台时间线与版本一致；brief 保持原值 |
| 同进程长任务占资源 | 与网页共用事件循环 | 复用既有 RunManager 的异步任务模型，不新增线程；超时不取消后台运行 |
| MCP SDK 版本升级不兼容 | 工具注册/传输行为变化 | 锁定 `mcp>=1.0,<2`；测试覆盖 initialize/list/call 关键路径 |
| 并发操作同一文章 | MCP 与网页同时发消息 | 沿用 `ARTICLE_RUN_ACTIVE` 409→MCP 结构化错误，由智能体等待或换文章 |

## 13. 实施与自测记录（2026-10-18）

### 13.1 实施内容

- 新增 `backend/app/mcp/`：`server.py`（FastMCP + 16 工具注册 + instructions）、`context.py`（状态访问/整形/run 等待/`guarded` 错误映射）、`tools_meta.py`、`tools_articles.py`、`tools_images.py`、`tools_publish.py`、`asgi.py`（挂载 + 守卫中间件 + 专用 lifespan task）。
- 修改 `backend/app/main.py`：lifespan 启停 MCP；挂载 `/mcp` 与 `McpGuardMiddleware`；复用抽取后的 `ImagePlacement`。
- 新增 `backend/app/publish_models.py`：从 `main.py` 抽出 `ImagePlacement`/位置校验，REST 与 MCP 共用。
- 修改 `backend/app/database.py`：新增 `create_imported_version()`（定稿导入合成 completed run + 消息 + 版本）与 `get_version_by_run_id()`。
- 修改 `backend/article_agent/config.py` / `backend/.env.example`：`MCP_ENABLED`、`MCP_AUTH_TOKEN`、`MCP_ALLOWED_HOSTS`、`MCP_WAIT_TIMEOUT_SECONDS`。
- 修改 `backend/scripts/dev_fake_server.py`：fake 联调默认开启 MCP。
- 新增 `backend/tests/test_mcp_server.py`、`backend/scripts/mcp_smoke.py`、`backend/scripts/mcp_selftest.py`（只读配置自检）。
- 文档：本任务单、`README.md`、`backend/README.md`、`docs/tech/tech-design.md`、`docs/mcp/mcp-setup.md`、`docs/test/T021-mcp-acceptance.md`、`docs/ops/manual-mcp-clients.md`（本地手册）。

### 13.2 与计划的偏差

1. MCP session manager 改为在**专用长驻 task** 中运行：Mounted sub-app 的 lifespan 不会自动执行，且 anyio task group 的 cancel scope 要求同任务进出（pytest-asyncio fixture 场景会报 “cancel scope in a different task”）。FastAPI lifespan 只负责启动/停止该 task。
2. 为支持智能体直写定稿，除计划中的 `create_imported_version` 外补充了 `get_version_by_run_id`，保证 `wait_for_run` 能精确回取某次 run 的版本（而非总是当前版本）。
3. `create_article` 未扩展标题参数：标题由 `generate_article` / `import_article_version` 落版本时确定，与现有数据模型一致。

### 13.3 AI 自测结果

- 后端全量：`.venv\Scripts\python.exe -m pytest -p no:cacheprovider` → **150 passed, 2 warnings in 29.08s**（含既有 node 渲染集成用例；该用例在首轮全量中因 node 冷启动超时一次，单跑与复跑均通过）。
- MCP 专项：`tests/test_mcp_server.py` → **8 passed**，覆盖：工具注册/关闭 404、HTTP 挂载（`/mcp` 与 `/mcp/`）、Bearer 401/通过、Host 403、内存 ClientSession 全链路（生成→配图→方案→预览→真实主题渲染→fake 发布→记录）、定稿导入版本递增、超时返回 running 后 `wait_for_run` 续等、结构化错误。
- 人工冒烟（fake 服务，不消耗真实额度）：`dev_fake_server.py` + `mcp_smoke.py` 完整跑通；生成文章 v1 → 3 张不同比例配图自动入库 → 组装 6 块/3 插图 → 真实 `@wenyan-md/core` 渲染 2180 字符 HTML → fake 发布 `FAKE_MEDIA_9f38e828` → 发布记录查询成功；另验证不带尾斜杠的 `/mcp` 端点可用。
- 配置自检脚本：`scripts/mcp_selftest.py` 在 fake 服务（8001）返回 16 工具与 `studio_status` 摘要、退出码 0；对 MCP 关闭的后端正确输出 `[HTTP 404] MCP 未开启…` 诊断并以退出码 1 结束（未触碰运行中的真实后端进程）。
- 数据可见性（API 层）：`GET /api/articles` 可见 MCP 产出的文章与版本数；`GET /api/publish/records` 可见成功记录。
- `git diff --check` 通过。

### 13.4 留人工

- 真实客户端（DSH capability / Claude Code / Cursor）注册与一次真实交互。
- 网页工作台的视觉走查（MCP 产出的版本/素材/发布记录）。
- 真实公众号（凭据 + IP 白名单）发布草稿并核对草稿箱内容。

## 14. 变更记录

- 2026-10-18 初版：基于现有文章/配图/发布能力新增 MCP Server；确认单公众号、双内容来源、仅 Streamable HTTP、显式开启（D1–D4）。
- 2026-10-18 对齐团队 Git/任务工作流：补充分支与状态头、范围外清单、实施步骤与验收分层、风险与对策、变更记录；新增 `get_version_by_run_id` 以支持 `wait_for_run` 精确回取版本。
- 2026-10-18 开发完成并自测：新增 `app/mcp/` 16 工具、守卫中间件、定稿导入；全量 pytest 150 passed；fake 全链路冒烟通过；状态置 `WAIT_ACCEPTANCE`。
