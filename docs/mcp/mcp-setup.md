# MCP 配置工作流（Article Studio）

> **读者**：需要把 Article Studio 接入本地智能体的 AI agent / 开发者。
> **目标**：按本指引一步步完成「后端开启 MCP → 端点自检 → 客户端注册 → 工具验收」，每一步都有可验证的完成判据。
> **纪律**：分支与提交规则见 [docs/git/branch-workflow.md](../git/branch-workflow.md)；本文只覆盖 MCP 配置，不涉及发布流程改造。

**最后更新**：2026-10-19
**适用版本**：T021 及之后（MCP 工具 16 个）

---

## 0. 结论先行

- Article Studio 的 MCP Server 随后端进程运行，使用 **Streamable HTTP**，端点为 `http://127.0.0.1:8000/mcp/`（兼容不带尾斜杠的 `/mcp`）。
- **默认关闭**：`backend/.env` 设置 `MCP_ENABLED=true` 并重启后端才可用；关闭时 `/mcp*` 返回 404。
- 配置成功 = 客户端 `initialize` 成功 + 列出 **16 个工具** + `studio_status` 返回预期状态 +（可选）全链路冒烟通过。
- 仅有支持 Streamable HTTP 的客户端可直接接入；仅支持 stdio 的客户端用 `mcp-remote` 桥接（见 §6.4）。

---

## 1. 执行原则（agent 必读）

1. **只改必要的配置**：只改 `backend/.env` 中 `MCP_*` 四个键，保留其他键、注释与顺序；改前备份（§4.2）。
2. **不泄露密钥**：不打印、不提交 `API Key` / `AppSecret` / `MCP_AUTH_TOKEN` 的完整值；验证输出只允许出现掩码。
3. **不重复起服务**：先检查 8000 端口；已有后端进程时先确认它是否就是要用的实例，不要盲目再起一个。
4. **每步先验证再继续**：按 §3→§4→§5→§6→§7 顺序执行；任一步失败先按 §8 排查，不要"猜着改"。
5. **工作区纪律**：不直推 `main`、不合并 PR、不修改仓库设置；配置产物（`.env`、客户端本地配置）不提交。
6. **真实发布需授权**：真实公众号发布只在人明确授权后执行；默认只验证到 fake 发布或排版预览。

---

## 2. 选择运行形态

| 场景 | 启动方式 | LLM / 生图 / 发布 | MCP |
|---|---|---|---|
| 配置联调、验收（推荐先做） | `dev_fake_server.py` | 假模型 + 假生图 + fake 发布 | 默认开启 |
| 日常真实使用 | `uvicorn app.main:app` | 真实 Key（`.env`/设置页） | 需 `MCP_ENABLED=true` |
| 生产形态（单进程托管前端） | 前端 build + `SERVE_FRONTEND=true` | 真实 Key | 需 `MCP_ENABLED=true` |

MCP 只依赖后端进程与数据目录，**不要求前端 dev server 运行**；网页可见性验收时才需要前端。

---

## 3. 前置检查

```powershell
# 1) 仓库与分支
git status --short                 # 期望无输出；有改动先由人确认处置
git branch --show-current

# 2) 配置文件存在
Test-Path backend\.env

# 3) 默认语言模型是否已配置（只看键是否存在，不打印密钥）
Select-String -Path backend\.env -Pattern '^(DEFAULT_LLM_PROVIDER|DEEPSEEK_MODEL|MOONSHOT_MODEL|DEEPSEEK_CONTEXT_WINDOW|MOONSHOT_CONTEXT_WINDOW)='

# 4) 端口占用（有输出说明已有进程，确认归属后再决定复用）
Get-NetTCPConnection -State Listen -LocalPort 8000,5173 -ErrorAction SilentlyContinue

# 5) 依赖是否就绪
Test-Path backend\.venv
node --version
Get-Command wenyan-mcp -ErrorAction SilentlyContinue
```

| 检查项 | 要求 | 缺失时 |
|---|---|---|
| `backend/.env` | 存在，默认 LLM 的 Key/模型/上下文窗口齐全 | 参考根 `README.md`「快速开始」 |
| Python 依赖 | `backend/.venv` 已同步（或可 `uv sync`） | `cd backend; uv sync` |
| 生图（配图工具需要） | 通义万相 Key + Base URL + 模型，或 fake 环境 | 设置页配置；只用文章/排版可跳过 |
| 公众号（发布工具需要） | AppID/AppSecret（或 fake 模式） | 设置页配置；仅联调可用 `PUBLISH_FAKE_MODE=true` |
| 主题渲染/发布 | Node 20+；`wenyan-mcp` 可解析 | `npm install -g @wenyan-md/mcp` |
| 端口 8000 | 空闲或由目标后端占用 | 先停旧进程，避免起第二个实例 |

---

## 4. 后端配置（`backend/.env`）

### 4.1 变量

| 变量 | 默认 | 推荐值 | 说明 |
|---|---|---|---|
| `MCP_ENABLED` | `false` | `true` | 是否挂载 `/mcp/`；关闭时 404 |
| `MCP_AUTH_TOKEN` | 空 | 跨机访问时设置 | 设置后客户端必须带 `Authorization: Bearer <token>` |
| `MCP_ALLOWED_HOSTS` | `127.0.0.1,localhost,::1` | 保持默认 | Host/Origin 白名单，逗号分隔、忽略端口 |
| `MCP_WAIT_TIMEOUT_SECONDS` | `180` | `180`（长文可调大） | 生成工具默认等待秒数；超时返回 running，可 `wait_for_run` 续等 |

> 注意：后端从**启动时的工作目录**读取 `.env`（`Settings(env_file=".env")`）。必须 `cd backend` 后再启动，否则配置不会生效。
> `MCP_*` 只从 `.env` 读取，设置页不覆盖；改完必须重启后端。

### 4.2 安全写入（PowerShell，保留其他配置）

```powershell
cd C:\projects\studio\article-studio
$path = "backend\.env"
Copy-Item $path "$path.bak" -Force

$resolved = (Resolve-Path $path).Path
$lines = [System.IO.File]::ReadAllLines($resolved)

function Set-EnvValue {
    param([string[]]$Lines, [string]$Key, [string]$Value)
    $pattern = '^\s*' + [regex]::Escape($Key) + '\s*='
    $found = $false
    $result = foreach ($line in $Lines) {
        if ($line -match $pattern) { $found = $true; "$Key=$Value" } else { $line }
    }
    if (-not $found) { $result = @($result) + "$Key=$Value" }
    return $result
}

$lines = Set-EnvValue $lines "MCP_ENABLED" "true"
$lines = Set-EnvValue $lines "MCP_ALLOWED_HOSTS" "127.0.0.1,localhost,::1"
$lines = Set-EnvValue $lines "MCP_WAIT_TIMEOUT_SECONDS" "180"
# 需要鉴权时再设置（值不要贴进对话/日志）：
# $lines = Set-EnvValue $lines "MCP_AUTH_TOKEN" "<token>"

[System.IO.File]::WriteAllLines($resolved, $lines, (New-Object System.Text.UTF8Encoding($false)))
```

验证（不打印值）：

```powershell
Select-String -Path backend\.env -Pattern '^MCP_' | ForEach-Object { ($_.Line -split '=',2)[0] + '=<set>' }
```

### 4.3 fake 环境无需改 `.env`

`dev_fake_server.py` 自行构造 Settings（`_env_file=None`），默认 `MCP_ENABLED=true`、fake 发布、假凭据；适合先跑通配置再切真实环境。

---

## 5. 启动后端与端点自检

### 5.1 启动

```powershell
cd backend

# 真实环境（开发）
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload

# 或：fake 环境（数据隔离，不消耗真实额度）
uv run python scripts/dev_fake_server.py --port 8000 --data-dir data/mcp-config-check
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health    # 期望 status = ok
```

### 5.2 MCP 自检（推荐，只读、不生成内容）

```powershell
cd backend
uv run python scripts/mcp_selftest.py --url http://127.0.0.1:8000/mcp/

# 配置了 Token 时
uv run python scripts/mcp_selftest.py --url http://127.0.0.1:8000/mcp/ --token <token>

# 机器可读结果（agents/CI 用）
uv run python scripts/mcp_selftest.py --url http://127.0.0.1:8000/mcp/ --json
```

完成判据：

- 退出码 0；
- 输出 `✓ 工具清单：16 个（预期 16 个）`；
- `LLM` 显示默认 provider/model；需要配图时 `生图` 非"未配置"；发布需要时 `公众号：已配置`。

自检失败会直接给出分类提示（如 `[HTTP 404] MCP 未开启…`、`[HTTP 401]…`、`无法连接后端…`），按提示处理即可。

### 5.3 可选：全链路冒烟

仅在 fake 环境推荐执行（会生成文章/图片并 fake 发布）：

```powershell
cd backend
uv run python scripts/mcp_smoke.py --url http://127.0.0.1:8000/mcp/
```

预期最后输出 `✓ 冒烟通过` 与 `FAKE_MEDIA_xxx`。

---

## 6. 客户端注册

注册完成后**重启客户端**（或重新加载 MCP 配置），再按 §7 验收。

### 6.1 DSH

在 MCP / 能力配置中注册 Streamable HTTP 服务（等价配置）：

```json
{
  "name": "article-studio",
  "transport": "streamable-http",
  "url": "http://127.0.0.1:8000/mcp/",
  "headers": { "Authorization": "Bearer <token>" }
}
```

- 未设置 `MCP_AUTH_TOKEN` 时去掉 `headers`。
- 注册后确认工具列表为 16 个；若客户端需要显式"启用/连接"，连接后调用 `studio_status` 验证。

### 6.2 Claude Code

```powershell
claude mcp add --transport http article-studio http://127.0.0.1:8000/mcp/
# 需要鉴权时（视 CLI 版本支持）：
# claude mcp add --transport http --header "Authorization: Bearer <token>" article-studio http://127.0.0.1:8000/mcp/
claude mcp list
```

### 6.3 Cursor

`%USERPROFILE%\.cursor\mcp.json`：

```json
{
  "mcpServers": {
    "article-studio": {
      "url": "http://127.0.0.1:8000/mcp/",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### 6.4 仅支持 stdio 的客户端

用 `mcp-remote` 桥接（需 Node.js）：

```json
{
  "mcpServers": {
    "article-studio": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:8000/mcp/",
        "--header",
        "Authorization: Bearer <token>"
      ]
    }
  }
}
```

不带 Token 时删除 `--header` 及其值。

---

## 7. 客户端侧验收与工具使用

### 7.1 最小验收

1. 客户端能列出 16 个工具（清单见 §7.2）。
2. 调用 `studio_status`，确认：
   - `llm.default_provider` / `default_model` 正确；
   - 需要配图时 `image.providers` 非空；
   - 需要发布时 `wechat.configured=true`，并确认 `publish_fake_mode` 是否符合当前环境；
   - `waits.default_timeout_seconds` 与 `.env` 一致。
3. 可选：按 §5.3 跑 fake 全链路；或执行 §7.3 的最小文章流程。

### 7.2 工具 → 能力映射

| 阶段 | 工具 | 用途 |
|---|---|---|
| 自检/查询 | `studio_status`、`list_articles`、`get_article`、`list_assets`、`list_publish_records` | 确认配置、定位 article_id/asset_id |
| 文章 | `create_article`、`generate_article`、`import_article_version`、`get_article_version`、`wait_for_run` | 新建；后端生成/修订；智能体直写定稿；读取版本；长任务续等 |
| 配图 | `plan_article_images`、`generate_image` | 块锚点方案；按 prompt 生成并自动入库素材 |
| 排版/发布 | `list_publish_themes`、`preview_publish`、`render_publish_preview`、`publish_article` | 主题列表；正文块与组装 Markdown；主题 HTML 预览；发布草稿（不群发） |

推荐顺序：`studio_status` → `create_article` / `import_article_version` → `generate_article` → `plan_article_images` + `generate_image` → `preview_publish` → `render_publish_preview` → `publish_article`。

### 7.3 最小文章流程（可选，真实或 fake 均可）

1. `create_article` 得到 `article_id`；
2. `generate_article(article_id, "写一段 300 字关于专注的短文")`；
3. `get_article(article_id)` 确认版本；
4. 需要配图/发布时按 §7.2 继续。

---

## 8. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `[HTTP 404] MCP_DISABLED` | `MCP_ENABLED` 未开或未重启；或 `.env` 未生效（工作目录错误） | 设 `MCP_ENABLED=true`；从 `backend` 目录重启 |
| `[HTTP 401]` | 设置了 `MCP_AUTH_TOKEN`，客户端未带/带错 | 客户端加 `Authorization: Bearer <token>`，核对值 |
| `[HTTP 403] MCP_HOST_FORBIDDEN` | Host 不在 `MCP_ALLOWED_HOSTS` | 用 `127.0.0.1`/`localhost`，或把实际主机名加入白名单 |
| `[HTTP 403] MCP_ORIGIN_FORBIDDEN` | 浏览器/客户端带非白名单 Origin | 用本地 MCP 客户端或把 Origin 主机加入白名单 |
| `无法连接后端` | 后端未启动、端口错、防火墙/代理 | `Invoke-RestMethod http://127.0.0.1:8000/api/health`；检查端口占用 |
| 自检超时 | 后端卡住/端口被别的进程占用 | 查 `Get-NetTCPConnection` 与 `backend/data/logs/app.log` |
| 工具数不是 16 | 旧后端进程仍在跑旧代码 | 停掉旧进程（检查命令行），重启当前代码 |
| `MODEL_NOT_CONFIGURED` | 默认 LLM 未配置完整 | 设置页补齐 Key/模型/上下文窗口 |
| `IMAGE_PROVIDER_NOT_CONFIGURED` | 未配置生图 provider | 设置页配置通义万相，或改用 fake 环境 |
| `PUBLISH_CREDENTIALS_MISSING` | 未配置公众号 AppID/AppSecret | 设置页配置；仅联调用 `PUBLISH_FAKE_MODE=true` + 假凭据 |
| `PUBLISH_MCP_NOT_INSTALLED` | 未安装 wenyan-mcp 或命令不可解析 | `npm install -g @wenyan-md/mcp`；检查 `WENYAN_MCP_COMMAND` |
| `PUBLISH_MCP_ERROR`（含 40164） | 公众号 IP 白名单、AppSecret、封面缺失等 | 查看工具返回原文与发布记录错误详情；核对白名单与封面 |
| `ARTICLE_RUN_ACTIVE` | 同文章已有运行中任务 | 等完成或换文章；客户端断开不会取消后台运行 |
| 生成工具超时返回 `running` | 客户端读超时短于生成耗时 | 调大客户端超时；或用返回的 `run_id` 调 `wait_for_run` |
| `.env` 改了不生效 | 从错误目录启动、未重启、或以为设置页能改 MCP 开关 | `cd backend` 启动；改完重启；MCP_* 只读 `.env` |
| 中文/符号输出乱码 | Windows 控制台编码 | 脚本已自动 `UTF-8`；终端执行前可 `$env:PYTHONIOENCODING='utf-8'` |

诊断顺序建议：`health` → `selftest` → 后端日志 `backend/data/logs/app.log` → 端口/进程命令行 → 客户端配置 → `.env`。

---

## 9. 安全与边界

- MCP 默认关闭；仅监听 `127.0.0.1` 时不对局域网暴露。**不要把开启 MCP 的未鉴权服务绑定到 `0.0.0.0`**。
- 跨机访问至少设置 `MCP_AUTH_TOKEN`，并用 `MCP_ALLOWED_HOSTS` 限定来源；仍建议叠加网络隔离。
- 工具与错误信息会脱敏，不返回密钥；公众号只返回掩码。
- 不提供文章/素材/发布记录删除工具；`publish_article` 只建草稿、不群发。
- `.env`、客户端 MCP 配置中的 Token 不提交仓库；`backend/data/` 已被 git 忽略。
- Agent 不修改 GitHub 仓库设置、不合并 PR、不直推 `main`。

---

## 10. 配置记录（执行后填写并汇报）

| 项 | 值 |
|---|---|
| 执行日期 / 执行者 |  |
| 后端形态 | fake / 真实 / 生产单进程 |
| 端点 | `http://127.0.0.1:8000/mcp/` |
| 鉴权 | 无 / Bearer（不记录 Token 值） |
| 客户端 | DSH / Claude Code / Cursor / mcp-remote |
| 工具数 | 16 |
| `mcp_selftest` 结果 | 通过 / 不通过（附输出摘要） |
| `mcp_smoke`（可选） | 未执行 / 通过（media_id 摘要） |
| 备注 |  |

---

## 11. 关联文档

| 文档 | 内容 |
|---|---|
| [docs/git/branch-workflow.md](../git/branch-workflow.md) | 分支、提交、PR 与钩子纪律 |
| [docs/task/T021-article-studio-mcp.md](../task/T021-article-studio-mcp.md) | MCP 任务单（决策、工具契约、实现记录） |
| [docs/test/T021-mcp-acceptance.md](../test/T021-mcp-acceptance.md) | MCP 验收测试用例与记录表 |
| [README.md](../../README.md) | 用户视角的 MCP 接入与常见问题 |
| [backend/README.md](../../backend/README.md) | 后端 API、MCP 端点与冒烟脚本 |
| [docs/tech/tech-design.md](../tech/tech-design.md) | MCP 架构与安全设计（§5.9） |
| `backend/scripts/mcp_selftest.py` | 本文 §5.2 使用的只读自检脚本 |
| `backend/scripts/mcp_smoke.py` | 全链路冒烟脚本 |

---

## 12. 变更记录

- 2026-10-19 初版：按 T021 实现整理 MCP 配置工作流（后端开关 → 自检 → 客户端注册 → 验收 → 排障），配套只读自检脚本 `mcp_selftest.py`，供 AI agent 按步骤执行并汇报。
