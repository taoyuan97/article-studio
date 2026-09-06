# T007：公众号发布（一）后端 wenyan-mcp 客户端接入

## 1. 任务信息

- 状态：已完成
- 优先级：P0
- 类型：正式任务 7/10
- 前置任务：T006
- 后续任务：T008、T009、T010
- 目标目录：`backend/`
- 创建日期：2026-08-24
- 关联文档：`docs/prd/prd.md`、`docs/tech/tech-design.md`、T008（本客户端的使用方）

## 2. 目标

在后端实现 wenyan-mcp（`@wenyan-md/mcp`）的 MCP 客户端封装：以 stdio 子进程方式按需拉起 `wenyan-mcp`，支持 `list_themes` / `publish_article` 两个工具调用，并提供 fake 模式供开发与测试使用（不产生真实微信 API 请求）。

## 3. 范围

### 3.1 必须实现

**新增依赖（`backend/pyproject.toml`）**

- 新增 `mcp>=1.0,<2`（官方 Python SDK，提供 stdio_client 与 ClientSession，基于 anyio，与现有 async 栈兼容）。当前后端无此依赖，需显式添加。

**新增 `backend/app/wenyan_client.py`**

- 封装类 `WenyanMcpClient`：
  - `async list_themes() -> list[dict]`：返回主题列表（id / name / description），内置主题在前、自定义主题在后。
  - `async publish_article(markdown_path: str, theme_id: str) -> str`：传入落盘后的 Markdown 文件绝对路径（走 `file` 参数，避免大正文塞进 `content` 参数），返回成功消息中的 `media_id`。注意：wenyan-mcp 的工具返回是纯文本（如 `Your article was successfully published to '公众号草稿箱'. The media ID is xxx.`），需用正则从文本中提取 media_id；工具返回含"执行工具失败"字样时视为失败并抛领域错误（保留原文作为 error_message）。
- 进程管理：每次调用按需 spawn 子进程（stdio transport），调用结束即关闭；不做常驻连接。需正确处理子进程超时（默认 120s）与退出码，异常转为带 `code/message` 的领域错误。
- 环境注入：子进程 env 继承当前进程，并显式注入 `WECHAT_APP_ID` / `WECHAT_APP_SECRET`（来自 Settings）。
- Windows 兼容：spawn 使用 `wenyan-mcp.cmd` 解析（`shutil.which` 查找），避免直接执行 npm shim 脚本失败。

**配置扩展（`backend/article_agent/config.py` 的 `Settings`）**

- 新增字段（均从 `.env` 读取，沿用 pydantic-settings 现有机制）：
  - `wechat_app_id: str = ""`
  - `wechat_app_secret: str = ""`
  - `wenyan_mcp_command: str = "wenyan-mcp"`（允许覆盖为 npx 形式或绝对路径）
  - `publish_fake_mode: bool = False`（开发/测试假发布开关）

**Fake 模式（`publish_fake_mode=true` 时）**

- `list_themes`：返回固定内置主题清单（default / orangeheart / rainbow / lapis / pie / maize / purple / phycat，与 wenyan-mcp 内置一致）。
- `publish_article`：校验入参（文件存在、theme_id 非空、凭据已配置）后，返回伪造 `media_id`（如 `FAKE_MEDIA_` + uuid 前 8 位），不启动子进程、不发网络请求。沿用项目 fake 惯例（参考 `backend/scripts/dev_fake_server.py` 与 E2E 假模型机制）。

**凭据预检**

- 真实模式下若 `wechat_app_id` / `wechat_app_secret` 为空，调用即失败并返回明确错误码 `PUBLISH_CREDENTIALS_MISSING`（不启动子进程）。

### 3.2 不实现

- Client-Server 远程模式（`--server` 参数）——留作后续扩展，接口签名预留但不做配置项。
- 多公众号发布（依赖 server 模式）。
- `register_theme` / `remove_theme` 工具调用（本期主题仅用内置 + 预注册）。
- MCP 常驻连接池。

## 4. 测试

- pytest 单元测试（fake 模式路径，不依赖 npm 安装）：
  - 凭据缺失时真实模式返回 `PUBLISH_CREDENTIALS_MISSING`。
  - fake 模式 `list_themes` 返回 8 个内置主题。
  - fake 模式 `publish_article` 返回 `FAKE_MEDIA_` 前缀 media_id；文件不存在时报错。
- 手工冒烟（本机已装 `@wenyan-md/mcp` 且配置真实凭据时，可选）：`list_themes` 返回真实主题列表。
- 现有 pytest 全量回归通过（51+ 用例）。

## 5. 验收标准

- [x] `WenyanMcpClient` 提供 `list_themes` / `publish_article` 两个异步方法，签名与上述一致。
- [x] 子进程按需拉起、用后关闭；超时 120s；异常带结构化 `code/message`。
- [x] Settings 新增 4 个配置字段并从 `.env` 读取，默认值不破坏现有启动。
- [x] fake 模式两个方法均不产生子进程与网络请求。
- [x] 真实模式凭据缺失时快速失败，错误码 `PUBLISH_CREDENTIALS_MISSING`。
- [x] 新增 pytest 用例全部通过；全量回归通过。
- [x] `prototype/` 目录未被改动。

## 6. 完成定义

上述验收全部通过后，T007 完成：后端具备可测试、可 mock 的文颜 MCP 调用能力，供 T008 的发布服务直接使用。
