# Article Studio

AI 驱动的文章创作与配图工作台：通过对话生成与修订长文（多版本管理），按提示词生成配图并沉淀素材库。

单仓双工程：`frontend/`（React 19 + Vite + TypeScript + AntD 5）+ `backend/`（FastAPI + LangGraph + SQLite），本地单机运行，数据不出本机。

## 功能一览

| 模块         | 能力                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仪表盘       | 文章/素材统计、快捷入口、最近文章与素材                                                                                                                   |
| 文章创作     | 对话式生成与修订（SSE 流式输出）、标题自动生成、双模型切换（DeepSeek / Moonshot）、运行中取消、失败重试                                                   |
| 版本管理     | 每次生成落一个只读历史版本，可随时回看任意版本                                                                                                            |
| 文章导出     | 选择任意正式版本，导出 Markdown 原文或 TXT 纯文本，并通过系统窗口保存到指定位置                                                                           |
| 配图工作台   | 提示词生图（通义万相 / 即梦）、生成进度实时展示、档位与比例参数持久化、取消、保存素材；「计划」模式一键编排文章配图提示词方案（位置/排版/风格，逐条复制） |
| 素材库       | 图片素材列表、详情查看、回链来源配图会话                                                                                                                  |
| 发布到公众号 | 三步向导（选文章/版本 → 正文画布锚点定位插图 → 选主题即渲染预览、可编辑）一键推送至个人公众号草稿箱（仅建草稿不群发），发布记录与内容快照可回看           |
| 设置         | 页面配置 DeepSeek、Kimi、通义万相及微信公众号凭据，支持默认模型、运行参数、凭据回退和连通测试；即梦入口暂为占位                                     |

## 环境要求

| 依赖         | 版本                 | 说明                                                                                                  |
| ------------ | -------------------- | ----------------------------------------------------------------------------------------------------- |
| 操作系统     | Windows 10+          | 启停脚本为 PowerShell；其余平台可用命令行方式                                                         |
| Node.js      | 20.19+               | 前端构建                                                                                              |
| pnpm         | 11（`pnpm@11.22.0`） | 经 corepack 使用，无需全局安装                                                                        |
| Python       | 3.11+                | 后端运行时                                                                                            |
| uv           | 任意近期版本         | Python 依赖管理，见 [uv 安装](https://docs.astral.sh/uv/)                                             |
| 模型 API Key | —                    | 文章线需 DeepSeek 或 Moonshot 至少一个；配图线可选（通义万相 / 即梦）                                 |
| 公众号凭据   | —                    | 发布线可选：个人订阅号 AppID/AppSecret（mp.weixin.qq.com），详见 `docs/ops/manual-tasks-t007-t010.md` |

## 快速开始

### 1. 首次启动前的最低配置

全新安装时，后端必须先有一个可用的默认语言模型才能启动。只需完成一次下面的最低配置，后续即可在网页“设置”中管理模型参数。

```powershell
copy backend\.env.example backend\.env
```

用记事本或其他文本编辑器打开 `backend\.env`，填写一组 DeepSeek 配置：

```dotenv
DEFAULT_LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=你的_API_Key
DEEPSEEK_MODEL=你的模型_ID
DEEPSEEK_CONTEXT_WINDOW=该模型的上下文窗口大小
```

API Key、模型 ID 和上下文窗口请以服务商控制台及对应模型说明为准。其余项目可暂时保持 `.env.example` 中的默认值；Kimi、通义万相和公众号都可以在启动后按需配置。

如果只有 Kimi API Key，也可以把 Kimi 作为首次启动模型：

```dotenv
DEFAULT_LLM_PROVIDER=moonshot
MOONSHOT_API_KEY=你的_API_Key
MOONSHOT_MODEL=你的模型_ID
MOONSHOT_CONTEXT_WINDOW=该模型的上下文窗口大小
```

### 2. 启动服务

**方式 A：双击脚本（推荐）**

双击 `scripts\start-all.cmd`，首次运行会自动安装依赖（`uv sync` / `pnpm install`），随后弹出两个服务窗口：

- 后端 `http://127.0.0.1:8000`（API 文档 `/docs`）
- 前端 `http://localhost:5173` ← 浏览器访问这里

使用完毕双击 `scripts\stop-all.cmd` 停止。详见 `scripts/README.md`。

**方式 B：命令行**

```powershell
# 终端 1：后端
cd backend
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000

# 终端 2：前端
cd frontend
pnpm install
pnpm dev          # http://localhost:5173，/api 经 proxy 转发到 8000
```

pnpm 通过 corepack 使用（系统无全局 pnpm 时）：

```powershell
$env:COREPACK_HOME = "<repo>\.corepack"
corepack pnpm install
```

> 不想消耗真实 API 额度？后端改用假模型服务器：`cd backend; uv run python scripts/dev_fake_server.py`（API/SSE/持久化行为与真实后端完全一致）。

## 使用指南

- **仪表盘**：查看统计与最近内容；点「新建文章 / 新建配图」快捷创建并跳转。
- **文章列表**：搜索框按标题过滤；点「新建文章」进入工作台。
- **文章工作台**：左侧对话，右侧正文与版本。发送指令（如「写一篇关于 X 的文章」）后流式生成；继续对话产生 v2、v3…；版本下拉可回看任意历史版本（只读）；顶部可切换模型；生成中可点「停止」（不落版本）。点右上「导出」可选择任意正式版本，以 Markdown 原文或 TXT 纯文本保存；当前 Chrome / Edge 会打开系统“另存为”，不支持路径选择的浏览器将下载到浏览器下载目录。
- **配图工作台（行动模式，默认）**：输入画面描述 → 选择档位/比例 → 发送；进度条实时推进；完成后可「保存素材」。失败时会展示失败卡片，展开可见脱敏详情。
- **配图工作台（计划模式）**：顶部切到「计划」→ 选择文章与版本（默认关联会话文章）→ 按需修改配图角色设定与编排指令（有默认值）→ 「一键编排」让 LLM 按字数/章节结构/情绪基调自动产出配图提示词方案（每张含插入位置（块级锚点，与发布插图位置编号一致）、横版/方图/竖版排版建议、统一风格提示词），每条提示词可一键复制到任意 AI 绘图工具；方案自动入库，刷新后恢复。
- **素材库**：浏览已保存素材；点击查看详情（提示词、尺寸等），可跳回来源配图会话。
- **发布到公众号**：文章工作台右上「发布到公众号」进入三步向导——版本和信息（文章/版本 + 「选择封面」弹窗从全部图片单选 + 作者）→ 配图与位置（正文画布点击任意段落/标题设置插入点，「插入配图」弹窗多选（本文配图置顶 + 素材库图片），确定后按勾选顺序插入；已插图内联展示、hover 可删除）→ 选主题（左侧选主题卡、右侧手机框即时渲染主题预览，与最终发布效果一致；预览默认只读，点【编辑】可原位修改 Markdown，完成编辑后重新渲染）→ 确认发布到公众号草稿箱（仅建草稿，不群发；微信要求封面或正文至少一张图，封面可选不插入正文的图）。
- **发布记录**：按时间倒序查看全部发布结果（成功/失败、media_id）；失败记录可展开错误码与信息；「查看快照」回看发布时的完整内容与配图。

### 设置页配置指南

启动前后端服务并打开 `http://localhost:5173`，点击左侧导航最下方的“设置”。直接访问 `http://localhost:5173/settings` 也可以。

#### 配置语言模型

“模型配置”中提供 DeepSeek 和 Kimi 两张语言模型卡片。每张卡片包含：

- **API Key**：从对应服务商控制台获取。输入框为空表示保留现有凭据，不会清除配置。
- **Base URL**：服务商接口地址；使用官方服务时通常保持页面已有值即可。
- **模型 ID**：实际调用的模型名称，以服务商控制台或模型文档为准。
- **Context Window**：模型可容纳的上下文 Token 数，以对应模型说明为准。

操作顺序：

1. 修改需要调整的参数；没有任何变更时“保存”按钮会保持禁用。
2. 点击“保存”，成功提示出现后配置立即作用于后续新任务，无需重启服务。
3. 点击“测试连通”，确认 API Key、地址和模型 ID 可以正常调用。
4. 两个模型都配置完成后，可在上方“默认语言模型”中选择新建文章默认使用哪一个。

已有文章仍保留原来选择的模型，不会被批量改写；进入文章工作台后可以单独切换。

#### 配置通义万相

在“通义万相”卡片填写：

- **API Key**：阿里云百炼 API Key。
- **Base URL**：百炼业务空间域名，格式类似 `https://<workspace-id>.cn-beijing.maas.aliyuncs.com`，不是普通官网地址。
- **模型 ID**：要调用的万相模型 ID。

保存后可将“默认生图模型”设为通义万相。“测试连通”会执行一次真实的最低规格生图，可能产生少量费用，页面会在调用前再次确认。

即梦目前只显示“敬请期待”占位，不能在页面中编辑或测试；已有 `.env` 配置不会被设置页改写。

#### 默认模型和运行参数

- 只有已完整配置的模型才能被选为默认模型。
- 默认模型只影响之后新建的文章或配图会话。
- LLM 超时、重试次数、最大输出 Token、上下文使用比例、最近消息数和生图超时已有适合一般使用的默认值；不确定含义时建议保持不变。
- 参数修改后再恢复为原值，“保存”按钮会重新禁用，避免重复提交。
- 文章或图片正在生成时不能保存模型配置。请等待任务完成，或先停止当前任务再保存。

#### 配置微信公众号

切换到“公众号配置”Tab，填写微信公众号的 **AppID** 和 **AppSecret**，保存后点击“测试配置”。获取位置：微信公众平台 `mp.weixin.qq.com` → “设置与开发” → “基本配置”。

真实发布还需要：

1. 将运行 Article Studio 的电脑公网 IP 加入公众号 IP 白名单。
2. 安装 `wenyan-mcp`；页面显示“wenyan-mcp 可用”后才能进行真实发布。
3. 确认页面显示“真实发布”。`PUBLISH_FAKE_MODE` 默认是 `false`，只能在 `backend\.env` 中修改，修改后需重启后端。

如果暂时没有公众号、只想体验发布流程，可在 `backend\.env` 中设置：

```dotenv
PUBLISH_FAKE_MODE=true
```

公众号发布只创建草稿，不会自动群发。真实配置的 IP 白名单、AppSecret 和 wenyan-mcp 安装说明见 `docs/ops/manual-tasks-t007-t010.md`。

#### 凭据来源、查看和清除

每张配置卡都会显示凭据来源：

- **`.env`**：来自 `backend\.env`。为避免泄露，网页只能显示掩码，不能查看完整值；输入新值并保存即可覆盖。
- **浏览器配置**：通过设置页保存。点击密码框的眼睛图标可以查看。
- **混合来源**：公众号的 AppID/AppSecret 一部分来自页面、一部分来自 `.env`。
- **未配置**：缺少必需凭据或参数。

“清除 API Key / 清除凭据”只会删除设置页保存的覆盖值；如果 `.env` 中有对应配置，系统会自动回退使用 `.env`，不会删除或修改 `.env` 文件。

页面配置保存在 `DATA_DIR/settings.json`，刷新页面和重启服务后仍然有效。该文件包含明文敏感凭据，默认随 `backend/data/` 被 Git 忽略。请勿分享此文件，也不要将没有登录鉴权的 Article Studio 暴露到局域网或公网。

#### 设置页常见问题

- **保存按钮是灰色的**：当前值和已保存配置相同；修改任意字段后才会启用。
- **提示配置版本冲突**：配置已在另一个页面更新，刷新设置页后重新修改。
- **提示当前有生成任务运行**：等待文章或图片生成完成，或停止任务后再保存。
- **测试连通失败**：依次检查 API Key、模型 ID、Base URL、网络和账号余额/权限。
- **wenyan-mcp 显示不可用**：确认已安装 `@wenyan-md/mcp`，并检查 `backend\.env` 中的 `WENYAN_MCP_COMMAND`。
- **公众号提示 IP 不在白名单**：将当前公网 IP 加入微信公众平台的 IP 白名单；家用网络公网 IP 变化后需要重新更新。

## 开发者指南

### 目录结构

```text
frontend/           React SPA（9 路由：仪表盘 / 文章列表 / 文章工作台 / 配图工作台 / 素材库 / 发布向导 / 发布记录 / 快照详情 / 设置）
  src/                页面、组件、features、hooks、api 客户端、SSE 封装
  e2e/                Playwright E2E 用例（MVP 场景 A–G + 配图/素材 + 发布线 + 部署形态）
backend/            FastAPI 单进程应用（API + SSE + SQLite 持久化）
  app/                API 路由、数据库仓储、运行管理（文章线 service / 配图线 image_service / 发布线 publish_service + wenyan_client）
  article_agent/      LangGraph 智能体（意图路由、上下文预算压缩、脱敏）
  scripts/            假模型服务器、E2E 服务器、真实 API 冒烟脚本
  data/               运行时数据（SQLite 与图片资产；假模型/E2E 各有独立子目录）
scripts/            Windows 双击启停脚本（start/stop × backend/frontend/all）
docs/               PRD / 技术设计 / 任务拆分 / 运维手册
prototype/          MVP 原型（冻结归档，不再开发）
```

### 开发工作流

后端带热重载：`uv run uvicorn app.main:app --reload --port 8000`；前端 `pnpm dev` 自带 HMR。前端 `/api` 与 `/static` 由 Vite proxy 转发到后端 8000，无需额外配置。

### 测试

```powershell
cd backend  ; uv run pytest -p no:cacheprovider   # 后端全量测试
cd frontend ; pnpm test                            # Vitest 组件测试
cd frontend ; pnpm e2e                             # Playwright E2E（13 例，假模型，无需真实 Key）
```

E2E 首次运行前安装浏览器到项目本地目录（沙箱/受限环境无法写 `%LOCALAPPDATA%`）：

```powershell
cd frontend
$env:PLAYWRIGHT_BROWSERS_PATH = "<repo>\.playwright-browsers"
pnpm exec playwright install chromium
```

之后 `pnpm e2e` 无需再设环境变量（路径由 `playwright.config.ts` 自动注入；先 build 再以生产形态运行）。

### 代码规范

```powershell
cd frontend ; pnpm lint       # ESLint
cd frontend ; pnpm format     # Prettier
cd frontend ; pnpm build      # TS strict 编译 + 构建（类型检查含在内）
```

## 生产部署（单进程）

```powershell
cd frontend ; pnpm build                 # 产物 → frontend/dist
cd backend  ; $env:SERVE_FRONTEND = "true"   # 或在 backend/.env 中改为 true
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

`SERVE_FRONTEND=true` 时 FastAPI 托管 `frontend/dist`，非 `/api` 未命中路径返回 `index.html`（SPA fallback）；静态资源、API、SSE 同进程同源，浏览器只需访问 `http://<host>:8000`。

## 常见问题

- **启动提示端口已被占用（8000 / 5173）**：先双击 `scripts\stop-all.cmd` 清理；仍占用则检查其他程序（`netstat -ano | findstr :8000`）。
- **`pnpm` 命令不可用**：走 corepack 方式（见「快速开始」），或 `corepack enable`（需管理员权限）。
- **未配置 API Key 的表现**：文章发送后出现失败卡片（脱敏详情），配图线提示无可用生图模型。请先到侧边栏“设置”完成配置；本地联调也可改用假模型服务器。
- **E2E 浏览器下载失败/缓慢**：`$env:PLAYWRIGHT_DOWNLOAD_HOST = "https://npmmirror.com/mirrors/playwright"` 后重装。
- **数据在哪、如何重置**：全部在 `backend\data\`（业务库 `article.sqlite3`、图片 `assets/`）；假模型数据在 `data\dev-fake\`、E2E 在 `data\e2e\`，删除对应目录即重置。
- **发布报 40164（invalid ip）/ IP 白名单**：微信要求调用方公网 IP 在白名单内；到 mp.weixin.qq.com → 设置与开发 → 基本配置 → IP 白名单，加入当前公网 IP（家宽变动后同样处理）。详见 `docs/ops/manual-tasks-t007-t010.md`。
- **只想体验发布流程、没有公众号**：保持 `PUBLISH_FAKE_MODE=true`，发布返回 `FAKE_MEDIA_xxx` 假 media_id，全流程（含失败重试）可正常演练。

## 更多文档

| 文档                       | 内容                                              |
| -------------------------- | ------------------------------------------------- |
| `docs/prd/prd.md`          | 产品需求与验收标准                                |
| `docs/tech/tech-design.md` | 技术设计（架构、数据流、上下文预算）              |
| `docs/task/`               | 任务拆分 T001–T018 与实施状态                     |
| `docs/ops/`                | 人工操作手册（真实 API 走查、E2E 手册、故障排查） |
| `backend/README.md`        | 后端 API 契约、启动方式、假模型约定               |
| `frontend/README.md`       | 前端结构、命令、与后端的契约                      |
| `scripts/README.md`        | 启停脚本使用说明                                  |
