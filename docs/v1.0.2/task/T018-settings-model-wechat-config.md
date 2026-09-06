# T018：设置页——模型与公众号配置

## 1. 任务信息

- 状态：已完成（人工验收通过，2026-09-06）
- 优先级：P0
- 类型：全局设置与运行时配置
- 前置任务：T003（文章模型）、T004（生图模型）、T007–T010（公众号发布）
- 后续任务：无
- 目标目录：`frontend/src/pages/`、`frontend/src/layouts/`、`frontend/src/api/`、`frontend/src/styles/`、`backend/app/`、`backend/article_agent/`、`backend/tests/`、`docs/tech/`
- 创建日期：2026-09-06
- 关联文档：`backend/.env.example`、`docs/tech/tech-design.md`、`docs/prd/prd.md`
- 参考实现：`C:\projects\studio\audio-studio\frontend\src\pages\SettingsPage.tsx` 及其后端 `SettingsStore` / settings API
- 需求来源：在主侧边栏增加设置页，通过两个 Tab 管理语言模型、生图模型与微信公众号配置

## 2. 目标与现状

在主侧边栏增加“设置”，路由为 `/settings`。设置页包含：

1. “模型配置”：支持 DeepSeek、Kimi（Moonshot）、通义万相运行时配置；即梦本期仅占位。
2. “公众号配置”：支持微信公众号 AppID、AppSecret 运行时配置，并展示 wenyan-mcp 与真假发布状态。

设置以 `.env` 为基线，以 `DATA_DIR/settings.json` 保存页面产生的字段级覆盖；保存后不重启后端即可对后续任务生效。

当前实现特点：

- `Settings` 在应用启动时一次性读取 `.env`。
- `ModelRegistry`、`ArticleAgent`、`ImageProviderRegistry`、`RunManager`、`ImageRunManager` 和 `WenyanMcpClient` 均在 lifespan 中一次性构建。
- 前端尚无设置页、设置 API 和侧边栏入口。
- DeepSeek / Kimi 模型 ID 来自后端配置；文章和历史版本保存实际使用的 provider/model。
- 通义万相和即梦后端均已有 provider 实现，但本任务只开放通义万相的页面配置，即梦显示禁用占位卡。
- 应用定位为单机、单用户、单进程；现有 API 没有登录鉴权。

## 3. 已确认决策（2026-09-06）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | “语音模型”含义 | 按“语言模型（LLM）”实施，不新增 TTS/语音能力 |
| D2 | 即梦范围 | 显示禁用卡片和“敬请期待”，不提供表单、保存、清除或连通测试 |
| D3 | 持久化 | `.env` 为只读基线，页面覆盖原子写入 `DATA_DIR/settings.json`，不改写 `.env` |
| D4 | 默认供应商 | 页面支持修改默认 LLM 和默认生图供应商；只能选择完整配置且本期可编辑的供应商 |
| D5 | 运行参数 | 模型 Tab 开放 LLM/生图相关六项运行参数 |
| D6 | Base URL | DeepSeek、Kimi、通义万相均开放修改，且必须为 HTTP(S) URL |
| D7 | 公众号范围 | AppID/AppSecret 可编辑；`WENYAN_MCP_COMMAND` 与 `PUBLISH_FAKE_MODE` 只读展示 |
| D8 | 连通测试 | DeepSeek、Kimi、通义万相、公众号均提供；万相测试明确提示可能产生最低额度费用 |
| D9 | 热更新冲突 | 有文章或生图任务运行时阻止保存任何模型/default/runtime 配置，返回 409 |
| D10 | 密钥存储 | 浏览器覆盖值明文保存于本地 `settings.json`，依赖文件权限；UI 明确提示仅限可信本机用户 |
| D11 | 访问边界 | 设置写入、查看密钥和探测接口执行同源/本机来源校验，响应禁止缓存；不在本任务引入登录系统 |
| D12 | 文档编号 | `docs/task/T018-settings-model-wechat-config.md` |

补充约束：

- 保存后立即生效指后续新启动的任务使用新配置；已完成记录保持原 provider/model。
- 页面中的 Kimi 对应后端环境变量和内部 provider 名 `MOONSHOT_*` / `moonshot`。
- 本任务同步将 `.env.example` 的 `LLM_MAX_OUTPUT_TOKENS` 改为代码默认值 `16384`，并将 README 中 `PUBLISH_FAKE_MODE` 的默认说明改为代码默认值 `false`。

## 4. 范围

### 4.1 导航、路由与页面结构

- 在 `AppLayout` 主导航末尾、“发布记录”之后增加“设置”。
- 在带壳路由中注册 `/settings`，侧边栏在该路径下设置 `aria-current="page"`。
- 页面标题为“设置”，说明为“管理文章模型、生图模型与微信公众号发布配置”。
- 页面顶部固定显示安全警告：运行时密钥会保存到本机数据目录，设置能力只适用于可信本机用户，不应将未鉴权服务暴露到局域网或公网。
- 使用 Ant Design `Tabs`，Tab key 为 `models`、`wechat`。
- Tab 状态与查询参数同步：默认 `/settings?tab=models`，公众号为 `/settings?tab=wechat`；未知值回退 `models`。
- 页面初次加载显示 Skeleton；加载失败显示错误 Alert 和重试按钮。
- status 返回的 revision 在页面标题区展示为“配置版本 N”。

### 4.2 模型配置 Tab

#### 4.2.1 默认供应商

Tab 顶部提供两个选择器：

- 默认语言模型：`deepseek` / `moonshot`。
- 默认生图模型：本期只有 `aliyun_wanxiang` 可选；`dreamina` 不进入可选项。

规则：

- 只有 `configured=true` 的可用供应商能被选为默认值。
- 默认值保存与 Provider 卡片保存相互独立，均携带 revision。
- 清除当前默认供应商凭据时，如果清除后没有 `.env` 凭据可回退，则返回 422，要求先切换默认供应商；不能留下不可用默认值。
- 新建文章、新建配图会话和配图计划默认模型从最新运行时 Settings 读取。
- 已有文章/会话保存的 provider/model 不自动改写；若其模型因配置变更不可用，工作台按现有“模型未配置”路径提示并允许切换。

#### 4.2.2 Provider 卡片

Provider ID 与字段：

| Provider ID | 显示名 | 类型 | 可编辑字段 |
|---|---|---|---|
| `llm_deepseek` | DeepSeek | LLM | API Key、Base URL、模型 ID、Context Window |
| `llm_moonshot` | Kimi | LLM | API Key、Base URL、模型 ID、Context Window |
| `image_wanxiang` | 通义万相 | IMAGE | API Key、Base URL、模型 ID |
| `image_dreamina` | 即梦 / 火山引擎 | IMAGE | 无；本期占位 |

每个可编辑卡片展示：

- 类型标签、已配置/未配置状态。
- 凭据掩码与来源：`runtime`（浏览器配置）、`env`（`.env`）、`mixed`（如未来出现多字段混用）、`null`（未配置）。
- 当前合并后的非敏感参数：Base URL、模型 ID、Context Window。
- API Key 使用密码输入；未修改时不提交，输入新值表示覆盖。
- 保存、清除浏览器 API Key、测试连通三个操作。
- 清除仅移除 `settings.json` 中 API Key 覆盖，其他参数覆盖保留；如 `.env` 有值则立即回退。
- `.env` 中的完整 API Key 永不返回浏览器，不能查看；运行时 API Key 只有点击眼睛时才通过专用 reveal 接口按字段读取。
- 即梦卡片显示当前产品名称、类型标签、“敬请期待”和简短说明，不显示后端 `.env` 中可能存在的即梦密钥或配置状态，避免形成“已经可编辑”的误导。

字段规则：

- 所有字符串保存前去除首尾空白。
- API Key、Base URL、模型 ID 不允许空字符串；清除凭据走独立 DELETE。
- Context Window 为正整数，前端建议范围 `1–2,000,000`，后端以 `> 0` 为最终规则。
- Base URL 必须是绝对 `http://` 或 `https://` URL，不接受凭据、fragment 或非 HTTP scheme。
- 通义万相 Base URL 说明业务空间域名格式，例如 `https://<workspace-id>.cn-beijing.maas.aliyuncs.com`。

#### 4.2.3 运行参数

在 Provider 卡片后增加“运行参数”卡，开放：

| 字段 | 页面名称 | 校验 |
|---|---|---|
| `llm_timeout_seconds` | LLM 超时（秒） | `> 0`，前端上限 600 |
| `llm_max_retries` | LLM 最大重试次数 | 整数，`0–10` |
| `llm_max_output_tokens` | LLM 最大输出 Token | 正整数，前端上限 1,000,000 |
| `llm_context_usage_ratio` | 上下文使用比例 | `> 0 && <= 0.80` |
| `llm_recent_message_limit` | 最近消息保留数 | 正整数，前端上限 10,000 |
| `image_timeout_seconds` | 生图超时（秒） | `> 0`，前端上限 1200 |

- 后端 Pydantic 校验是最终事实源。
- 保存运行参数同样会重建 LLM/图片运行时依赖。
- `LANGSMITH_*`、`DATA_DIR`、`SERVE_FRONTEND` 不开放页面修改。

#### 4.2.4 连通测试

- DeepSeek / Kimi：使用当前已保存配置发起一次极短补全，最长等待 30 秒；成功返回延迟和简短说明，不返回模型内容。
- 通义万相：使用最小可用规格执行真实生图探测，测试前 `Popconfirm` 明确“可能产生最低额度调用费用”；生成文件不得进入素材库，临时文件在结束后删除。
- 即梦：本期无测试按钮。
- `PUBLISH_FAKE_MODE` 不改变模型探测语义，探测始终请求真实服务。
- 探测与保存为独立操作：失败不回滚配置；错误消息截断、脱敏，不能包含 API Key、Authorization header 或签名 URL。

### 4.3 公众号配置 Tab

可编辑字段：

- `WECHAT_APP_ID`
- `WECHAT_APP_SECRET`

只读状态：

- `WENYAN_MCP_COMMAND`：仅显示命令是否已配置以及解析到的可执行文件名/可用状态，不把任意绝对路径作为可编辑输入。
- `PUBLISH_FAKE_MODE`：显示“假发布”或“真实发布”；不允许页面切换。
- 凭据来源与掩码。
- 公众号整体 `configured` 状态。

交互规则：

- AppID 可按普通输入展示，但仍按凭据字段处理，不从 `.env` 回传完整值；运行时覆盖可查看。
- AppSecret 使用密码输入，只在用户主动点击眼睛时读取运行时覆盖值。
- 保存时可只更新发生变化的字段；未传字段保持原值。
- “清除浏览器凭据”同时删除 AppID 和 AppSecret 的运行时覆盖；如果 `.env` 有值则回退。
- 保存成功后重建 `WenyanMcpClient`，后续主题查询、预览渲染和发布使用新配置。
- `WENYAN_MCP_COMMAND` 不允许通过 API 写入，避免设置页演变为任意本地命令执行入口。

公众号测试：

- 假发布模式：验证 AppID/AppSecret 完整性和 wenyan-mcp 命令可解析，返回“当前为假发布，未请求微信接口”。
- 真实发布模式：验证命令可用，并通过最轻量的微信认证/接口调用验证 AppID/AppSecret；不创建草稿、不群发。
- 如果 wenyan-mcp 现有能力无法提供无副作用认证探测，则退化为命令可用性与凭据完整性检查，并在响应中明确“未验证微信凭据有效性”，不得通过创建测试草稿实现探测。

### 4.4 前端 API 与类型

新增 `frontend/src/api/settings.ts`，所有请求继续走 `apiRequest`。扩展 `frontend/src/api/types.ts`，核心类型建议为：

```ts
export type SettingsProviderId =
  | 'llm_deepseek'
  | 'llm_moonshot'
  | 'image_wanxiang'
  | 'image_dreamina'

export interface ProviderStatus {
  configured: boolean
  editable: boolean
  credential_masked: string | null
  credential_source: 'runtime' | 'env' | 'mixed' | null
  runtime_credential_fields: Array<'credential'>
  base_url?: string
  model_id?: string
  context_window?: number
  unavailable_reason?: string
}

export interface WechatSettingsStatus {
  configured: boolean
  credential_masked: string | null
  credential_source: 'runtime' | 'env' | 'mixed' | null
  runtime_credential_fields: Array<'app_id' | 'app_secret'>
  mcp_command_configured: boolean
  mcp_available: boolean
  mcp_executable: string | null
  publish_fake_mode: boolean
}
```

`SettingsStatus` 还需包含：

- `revision`
- `default_llm_provider`
- `default_image_provider`
- `providers`
- `runtime`
- `wechat`

TanStack Query key：

- `['settings-status']`

保存模型配置后至少失效：

- `['settings-status']`
- 所有文章 workspace 中的可用模型数据
- 所有配图 workspace 中的可用 provider 数据
- `['image-plan-defaults']`

现有 workspace query key 若包含资源 ID，可使用前缀失效，不在页面中枚举每个 ID。

### 4.5 后端 SettingsStore

新增 `backend/app/settings_store.py`，或在保持职责清晰的前提下放入独立配置模块。不得把运行时存储逻辑继续堆入已较大的 `main.py`。

配置合并：

```text
Settings(_env_file=.env)  → base
DATA_DIR/settings.json    → overrides
Settings(_env_file=None, **base, **overrides) → current
```

`settings.json` 格式：

```json
{
  "revision": 3,
  "overrides": {
    "deepseek_model": "deepseek-chat",
    "llm_timeout_seconds": 180
  }
}
```

要求：

- 进程内使用 `threading.RLock` 或等价同步机制保护 revision、overrides 和 current。
- 写入临时文件、flush、fsync 后通过 `os.replace` 原子替换。
- 写入成功后才切换内存状态；失败时内存和磁盘均保持旧配置。
- 启动时严格校验 revision、overrides 类型及允许字段；未知字段拒绝启动并给出明确错误。
- 所有 mutation 携带 `expected_revision`；不匹配返回 `409 SETTINGS_REVISION_CONFLICT`。
- SettingsStore 允许覆盖的字段仅限本任务明确开放的模型、默认值、运行参数与公众号凭据。
- `dreamina_*`、`wenyan_mcp_command`、`publish_fake_mode` 不允许写入覆盖文件。
- `reveal_override` 只读取 overrides，绝不回退 base；`.env` 值只能以掩码和来源状态展示。
- AppID/AppSecret 允许产生 `mixed` 来源；单 Key Provider 通常只有 `runtime` / `env` / `null`。

### 4.6 设置 API

新增独立 router，例如 `backend/app/settings.py`，并在应用中 include。

```text
GET    /api/settings/status
PATCH  /api/settings/providers/{provider}
DELETE /api/settings/providers/{provider}/credentials
POST   /api/settings/providers/{provider}/credentials/reveal
PATCH  /api/settings/defaults
PATCH  /api/settings/runtime
PATCH  /api/settings/wechat
DELETE /api/settings/wechat/credentials
POST   /api/settings/wechat/credentials/reveal
POST   /api/settings/probe/{provider}
POST   /api/settings/probe/wechat
```

通用响应约束：

- `GET status`、reveal 及所有包含配置状态的响应设置 `Cache-Control: no-store`。
- status、PATCH、DELETE、probe 和日志均不得包含完整凭据。
- reveal 请求必须同时传 revision 与单个字段名；响应只包含该运行时字段。
- Pydantic 请求模型使用 `extra="forbid"`，拒绝未声明字段。
- 未知 provider、即梦写入或字段/provider 不匹配返回 `422 SETTINGS_PARAMS_INVALID`。
- 磁盘保存失败返回 `500 SETTINGS_PERSIST_FAILED`。
- 活跃生成任务冲突返回 `409 SETTINGS_RUN_ACTIVE`。
- URL、数值、默认供应商和必填组合非法返回 `422 SETTINGS_PARAMS_INVALID`。

### 4.7 运行时热更新

模型/default/runtime 保存必须按以下顺序执行：

1. 确认当前没有文章或生图 active run。
2. 用候选 overrides 构建并完整校验候选 `Settings`。
3. 以候选 Settings 构建候选 `ModelRegistry`、`ArticleAgent`、`ImageProviderRegistry` 以及脱敏密钥集合；任一步失败均不持久化。
4. 原子持久化 SettingsStore。
5. 在应用级配置锁内切换 `application.state.settings`、registry 及 manager 使用的运行时依赖。
6. 响应新 revision 和最新状态。

实现时优先保持现有 manager 对 active run、SSE 订阅和 shutdown 的管理能力，不应通过直接替换整个 `RunManager` / `ImageRunManager` 丢失其内部 `_runs`、`_active_by_*` 状态。建议：

- 为 manager 增加受锁保护的 `reconfigure(...)`，只替换后续 `start()` 获取的 Agent/Registry/secret values。
- 为两个 manager 增加明确的 `has_active_runs()`，由 settings router 检查。
- `RunManager.start()` / `ImageRunManager.start()` 在创建 run 上下文时抓取当前依赖快照；后续配置切换不能影响已创建任务。
- `application.state.registry`、`image_registry` 与 manager 内部依赖必须在同一临界区切换，避免 API 校验看到新 Registry 而 manager 使用旧 Registry。
- LangGraph checkpointer 连接继续复用，不因配置保存重建。
- `ArticleAgent` 的 usage ratio、recent message limit、callbacks 与新的 ModelRegistry 一起重建。
- `secret_values` 同步更新，确保新密钥在错误、SSE 和日志中继续脱敏。

公众号配置保存：

- 构建候选 Settings 和候选 `WenyanMcpClient` 后原子持久化并切换。
- 不要求等待文章或生图任务。
- 正在进行的同步发布请求继续使用调用开始时捕获的 client；之后的调用使用新 client。

### 4.8 安全边界

- 在 `backend/app/security.py` 新增设置写操作需要的同源/本机来源校验，覆盖 PATCH、DELETE、reveal、probe。
- 开发环境允许 `http://localhost:5173` 和 `http://127.0.0.1:5173`；同源生产请求允许通过。
- 明确处理缺失 Origin 的非浏览器调用策略，并为合法本地测试客户端保留可测试入口；不能仅依靠 CORS 作为写入保护。
- 设置页显示“无登录鉴权，不要暴露到局域网或公网”的警告。
- `settings.json` 必须位于 `DATA_DIR`，不进入 Git；README 说明其包含敏感信息。
- 所有异常、日志、SSE provider detail、探测响应继续经过 `redact_sensitive`，并包含当前合并配置的全部密钥集合。
- 不在 status 中返回完整 AppID、绝对 MCP 命令路径或其他不必要的本机信息。

### 4.9 现有业务链路适配

- `create_article`、`create_image_session`、image-plan defaults 从 `SettingsStore.current` 读取最新默认值。
- article workspace 的 `available_models` / `unavailable_models` 使用最新 Registry。
- image workspace 的 `available_providers` 使用最新 ImageProviderRegistry。
- 模型错误提示从“检查环境变量”调整为“请到设置页完成配置”，但保留必要字段提示。
- 发布链路缺凭据提示从“修改 `.env` 并重启”调整为“请到设置 > 公众号配置填写凭据”。
- 现有文章、版本、消息、配图会话、素材和发布记录数据库结构不变。
- 假模型/E2E 应用工厂注入的 registry/image registry 必须保持可用；设置热更新测试不得意外发起真实第三方请求。

## 5. 非目标

- 不支持即梦页面配置、即梦连通测试或将即梦设为页面默认 Provider。
- 不新增语音模型或 TTS 能力。
- 不开放 LangSmith、DATA_DIR、静态托管、MCP 命令和真假发布开关的网页编辑。
- 不修改 `.env` 文件，不提供导入/导出 `.env`。
- 不做云端密钥托管、系统密钥链、加密数据库或多用户权限管理。
- 不做微信公众号多账号管理、群发或定时发布。
- 不自动迁移、重写已有文章或配图会话的 provider/model。
- 不允许在 active run 中无缝替换模型依赖。

## 6. 实施步骤

1. 配置层：实现 SettingsStore、字段白名单、revision、原子持久化和凭据来源/掩码。
2. 运行时层：为两个 manager 增加 active-run 查询与安全 reconfigure，集中实现候选依赖构建和原子切换。
3. API 层：新增 settings router、请求/响应模型、同源校验、凭据 reveal/clear 和探测。
4. 业务适配：新建文章/会话、模型列表、配图计划和公众号发布改为读取最新配置。
5. 前端契约：新增 settings API 与类型。
6. 前端页面：增加路由、侧边栏、两个 Tab、Provider/运行参数/公众号卡片和交互反馈。
7. 测试：后端单元与契约、前端组件与导航、必要的 E2E 设置恢复场景。
8. 文档：更新 README、技术设计和 API 契约；记录本地敏感文件与真实探测费用提示。

## 7. 测试要求

### 7.1 后端

- 无 `settings.json` 时完全使用 `.env` 基线。
- 覆盖写入、进程重建后加载、revision 递增及并发冲突。
- 临时文件写入或 replace 失败不切换内存配置。
- 非法 JSON、未知字段、非法 URL、越界数值和不完整默认 Provider 拒绝。
- status 只返回掩码、来源和非敏感字段。
- reveal 只返回运行时覆盖；`.env`、未保存字段、字段错配和旧 revision 均拒绝。
- 清除 API Key / 微信凭据后正确回退 `.env`；无法维持默认 Provider 时拒绝清除。
- DeepSeek、Kimi、万相配置保存后，Registry 和新任务实际使用新配置。
- 配置切换不替换 manager，不丢失 SSE/run 状态；active run 时返回 409 且磁盘未修改。
- LLM、生图和公众号探测成功/失败、超时及敏感信息脱敏。
- 即梦写入与探测均不可用。
- 微信配置保存后 WenyanMcpClient 使用新凭据；MCP Command/Fake Mode 不能通过 API 修改。
- 开发 Origin、生产同源、非法 Origin 和 reveal no-store 头覆盖。
- 应用工厂注入 fake registry 的既有测试保持通过。

### 7.2 前端

- 侧边栏顺序为：首页、文章、素材、发布记录、设置。
- `/settings` 下“设置”高亮，其他路径不误命中。
- 两个 Tab 正确渲染并与 `tab` 查询参数同步。
- 加载、失败重试、revision、可信本机警告正确展示。
- 三个可编辑 Provider 和一个即梦占位卡正确展示。
- 密钥未修改不提交；运行时密钥查看、隐藏、覆盖和清除交互正确。
- `.env` 密钥不可查看且提示输入新值覆盖。
- 默认 Provider、URL、Context Window 和六项运行参数校验正确。
- active run 的 409、revision 409 和磁盘失败错误有明确中文反馈。
- 通义万相测试前出现费用确认；即梦无操作按钮。
- 公众号 AppID/AppSecret 局部更新、查看、清除及只读状态正确。
- 保存后 settings、workspace provider/model 和 image-plan defaults 缓存失效。
- 所有按钮有 loading、防重复提交及可访问名称。

### 7.3 回归

```powershell
cd backend
uv run pytest -p no:cacheprovider

cd ..\frontend
pnpm test
pnpm lint
pnpm build
```

至少人工验证：

1. 仅 `.env` 配置启动，设置页显示来源为 `.env` 且不可查看完整密钥。
2. 页面覆盖 DeepSeek 参数，刷新和重启后恢复；新文章使用新模型。
3. 页面配置通义万相，新建配图会话可生成；清除后回退 `.env`。
4. active run 期间保存模型设置被阻止，run 与 SSE 不受影响。
5. 页面配置公众号后无需重启即可查询主题并发布草稿；清除后出现正确缺凭据提示。
6. 即梦只显示占位，不因 `.env` 已配置而出现可编辑入口。

## 8. 验收标准

- [ ] 侧边栏新增“设置”，`/settings` 路由和高亮正确。
- [ ] 设置页严格包含“模型配置”“公众号配置”两个 Tab。
- [ ] DeepSeek、Kimi、通义万相可查看状态、保存、清除运行时凭据和测试连通。
- [ ] 即梦仅以禁用卡片占位。
- [ ] 默认 Provider 与六项运行参数可配置，并对后续任务立即生效。
- [ ] 微信 AppID/AppSecret 可配置；MCP Command/Fake Mode 仅只读。
- [ ] 页面覆盖持久化到 `DATA_DIR/settings.json`，刷新和服务重启不丢失。
- [ ] `.env` 保持只读基线，清除覆盖后正确回退。
- [ ] `.env` 凭据永不明文返回；运行时凭据只能通过受保护 reveal 接口读取。
- [ ] active run 时模型配置保存被原子拒绝，不出现半生效状态。
- [ ] 设置写入和探测具备同源/本机来源校验，所有配置响应禁止缓存并正确脱敏。
- [ ] 现有文章、生图、配图计划、公众号发布和假模型测试无回归。
- [ ] 后端测试、前端测试、lint 和 build 全部通过。
- [ ] README、技术设计和 API 契约与最终行为一致。

## 9. 交付文件预估

新增：

- `backend/app/settings.py`
- `backend/app/settings_store.py`
- `backend/tests/test_settings.py`
- `frontend/src/api/settings.ts`
- `frontend/src/pages/SettingsPage.tsx`
- `frontend/src/pages/SettingsPage.test.tsx`

修改：

- `backend/article_agent/config.py`
- `backend/app/main.py`
- `backend/app/service.py`
- `backend/app/image_service.py`
- `backend/app/security.py`
- `backend/app/wenyan_client.py`
- `backend/tests/test_api.py` 及相关回归测试
- `frontend/src/App.tsx`
- `frontend/src/layouts/AppLayout.tsx`
- `frontend/src/layouts/AppLayout.test.tsx`
- `frontend/src/api/types.ts`
- `frontend/src/styles/global.css`
- `backend/.env.example`
- `README.md`
- `docs/tech/tech-design.md`

最终文件可根据实现拆分调整，但 SettingsStore、settings router 与页面组件必须保持独立职责。
