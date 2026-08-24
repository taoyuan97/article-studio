# 人工配置与操作手册（T007–T010：公众号发布线）

> 适用范围：公众号发布（T007 后端组装与执行 / T008 发布记录 / T009 前端向导 / T010 E2E 与交付）完成后，需要人工完成或协助的事项。
> 环境前提：同 `manual-setup.md`；后端依赖已安装（`backend/.venv`），`backend/.env` 已配置 LLM/生图 key。
> 开发/测试环境默认 `PUBLISH_FAKE_MODE=true`（假发布，不触微信接口）；**真实发布需按本文档 §1–§4 配置后关闭 fake 模式**。

## 1. 获取个人公众号 AppID / AppSecret（需人工在微信公众平台操作）

1. 浏览器打开 <https://mp.weixin.qq.com>，注册/登录**个人订阅号**（未认证的个人订阅号即可使用新建草稿接口，无需企业认证）。
2. 左侧菜单进入 **设置与开发 → 基本配置**。
3. 「开发者 ID」区域：
   - **AppID** 直接可见，复制备用；
   - **AppSecret** 点击「启用/重置」后按提示扫码/验证获取（**只显示一次**，请立即复制保存；遗忘只能重置）。
4. 同一页面「IP 白名单」区域用于 §2 的配置（微信公众号要求调用接口的出口 IP 必须在白名单内）。

> 注意：重置 AppSecret 会使旧 Secret 立即失效，需同步更新 `backend/.env`。

## 2. 本机公网 IP 查询与加入白名单（家宽 IP 变动后同样适用）

1. 查询本机出口公网 IP：浏览器打开 <https://ifconfig.me/ip> 或 <https://cip.cc>（返回的即微信服务器看到的出口 IP；公司网络下须与后端部署机一致）。
2. 回到 mp.weixin.qq.com → **设置与开发 → 基本配置 → IP 白名单 → 修改**，粘贴 IP（多 IP 用换行分隔，最多 100 个）。
3. **家宽 IP 变动后的更新**：发布报错 `40164`（invalid ip）时，重新查询当前公网 IP 并回到同一路径更新白名单，无需改任何代码或重启后端（白名单即时生效，偶有约 1 分钟延迟）。

## 3. 安装与验证 wenyan-mcp（后端发布子进程，需人工执行一次）

```powershell
npm install -g @wenyan-md/mcp   # 要求 Node.js 20+（本机已有则跳过）
where.exe wenyan-mcp            # 确认在 PATH 中（Windows 下实际是 wenyan-mcp.cmd）
```

> 验证说明：直接运行 `wenyan-mcp`（含 `--help`，该命令无帮助输出）会以 stdio 模式启动 MCP 服务器，
> 打印 `[Init] Starting Wenyan MCP server in local mode...` / `...started successfully...` 两行日志，
> stdin 关闭后自动退出——看到这两行即安装成功，属正常现象（安装时 npm 可能提示依赖 deprecated 警告，不影响使用）。
> 后端通过 `shutil.which` 解析出 `.cmd` 完整路径再启动，无需额外配置。

后端按 `WENYAN_MCP_COMMAND` 启动该子进程（stdio MCP），每次发布按需拉起、用完即退，无常驻进程。
若使用 npx 方式或自定义路径，将 `WENYAN_MCP_COMMAND` 配置为对应命令即可（见 §4）。

## 4. `backend/.env` 发布配置（需人工填写真实值）

```ini
# 公众号发布（wenyan-mcp）配置
WECHAT_APP_ID=wx1234567890abcdef        # §1 获取的 AppID
WECHAT_APP_SECRET=0123456789abcdef...   # §1 获取的 AppSecret
WENYAN_MCP_COMMAND=wenyan-mcp           # 默认值；npx 方式可写 "npx -y @wenyan-md/mcp"
PUBLISH_FAKE_MODE=false                 # 真实发布必须改为 false（开发/测试默认 true）
```

修改后重启后端生效（`scripts\start-backend.cmd` 或 `uv run uvicorn app.main:app`）。
> 说明：后端启动 wenyan-mcp 子进程时会把其配置目录（token 缓存等）重定向到 `backend/data/wenyan-md/`（经 `XDG_CONFIG_HOME` 注入），避免 `%APPDATA%` 在沙箱/受限令牌环境下不可写导致 `EPERM`；该目录随 `data/` 一并被 `.gitignore` 排除。
安全提醒：`.env` 已被 `.gitignore` 排除，严禁提交仓库或粘贴到外部文档。

## 5. 真实发布冒烟清单（配置完成后人工走查，建议截图留档）

启动后端（可配合 `SERVE_FRONTEND=true` 单进程访问 <http://127.0.0.1:8000>），按发布向导四步走：

| 步骤 | 操作 | 关注点 |
| --- | --- | --- |
| 1 版本和信息 | 文章工作台右上「发布到公众号」入口；选版本；「选择封面」弹窗单选（可从素材库全部图片中选，无需插入正文）；填作者 | 文章已有生成版本；**微信草稿硬性要求：必须选一张封面图（或正文至少插图一张），纯文字必须选封面** |
| 2 配图 | 勾选 2+ 张配图，调整插入位置/顺序 | 已选卡片实时反映位置 |
| 3 选主题 | 选择排版主题（默认 default） | 未选主题时发布按钮禁用 |
| 4 预览与发布 | 核对组装 Markdown（可编辑）→ 确认发布 | 成功态展示真实 media_id |
| 5 核对草稿箱 | mp.weixin.qq.com → 内容与互动 → 草稿箱（新的创作/图文消息） | 标题/封面/作者/配图与预览一致 |
| 6 查看记录 | 系统「发布记录」页 → 查看快照 | 成功记录 + media_id + 内容快照可回看 |

> 本系统仅创建草稿、**不会群发**；群发仍需在公众号后台人工操作。

## 6. 常见发布错误对照

| 错误码/现象 | 原因 | 处理 |
| --- | --- | --- |
| `PUBLISH_MCP_ERROR`，详情含 **40164** invalid ip | 本机公网 IP 不在白名单 | 按 §2 查询并更新白名单后重试 |
| `PUBLISH_MCP_ERROR`，详情含 **41004** appsecret missing | wenyan-mcp 未收到 Secret（.env 未配置或拼写错误） | 核对 §4 配置并重启后端 |
| `PUBLISH_MCP_ERROR`，详情含 **你必须指定一张封面图** | 未选封面且正文无图（微信草稿硬性要求） | 在发布向导步骤 1「版本和信息」点「选择封面」弹窗选一张（或步骤 2 勾选正文配图）后重试 |
| `PUBLISH_MCP_ERROR`，详情含 **EPERM ... token.json** | wenyan-mcp 无法写 token 缓存到 `%APPDATA%\wenyan-md`（沙箱/受限令牌环境） | 已修复：后端将 wenyan-mcp 配置目录重定向到 `backend/data/wenyan-md/`（经 `XDG_CONFIG_HOME`），无需人工处理 |
| `PUBLISH_CREDENTIALS_MISSING` | `WECHAT_APP_ID/SECRET` 未配置 | 按 §4 配置 |
| `PUBLISH_MCP_NOT_INSTALLED` | 未安装 wenyan-mcp 或命令不在 PATH | 按 §3 安装/修正 `WENYAN_MCP_COMMAND` |
| `PUBLISH_TIMEOUT` / 请求超时（120s） | 微信接口慢或网络异常 | 稍后在「发布记录」查看结果（超时不代表失败），必要时重试 |
| `PUBLISH_ASSET_MISSING` | 配图素材文件被移动/删除 | 重新生成配图素材后再发布 |

## 7. 开发/测试环境假发布约定（fake 模式，无需任何真实凭据）

- `PUBLISH_FAKE_MODE=true`（dev_fake_server / e2e_server 默认）：不启动子进程、不外呼，media_id 返回 `FAKE_MEDIA_xxxxxxxx`。
- **发布失败触发词**：生成文章的**用户消息**包含「触发发布失败」→ 正文末尾嵌入同名标记 → 发布时 fake 客户端模拟 `PUBLISH_MCP_ERROR`（40164），用于演练失败记录与重试。与既有「触发失败」（生图/文章失败）互不包含。
- 临时文件策略：发布组装的 Markdown 写入 `backend/data/publish_tmp/`，**发布结束（成功或失败）后即自动删除**；完整内容快照持久化于 `publish_records.content_snapshot`，可随时在「发布记录 → 查看快照」回看，目录不会残留文件。

## 8. 人工验证记录（待填写）

| 项 | 结果 | 日期 | 备注 |
| --- | --- | --- | --- |
| AppID/AppSecret 配置 | ☑ 通过 | 2026-08-24 | `.env` 四项已配置且 `PUBLISH_FAKE_MODE=false`；后端已重启加载，`GET /api/publish/themes` 经 wenyan-mcp 真实子进程链路返回 200 |
| wenyan-mcp 安装（PATH 可解析、stdio 启动正常） | ☑ 通过 | 2026-08-24 | 189 packages；PATH：`C:\Users\18520\AppData\Roaming\npm\wenyan-mcp.cmd`，stdio 启动日志正常 |
| IP 白名单更新 | ☑ 通过 | 2026-08-24 | 微信 access_token 获取成功即为佐证（IP 不在白名单时报 40164） |
| 真实发布冒烟 §5（6 步） | ☑ 通过 | 2026-08-24 | 经 API 重放：文章《缓解头部的紧张练习引导》+ 封面图发布成功；media_id：`h9fLPP1c_XdlKCD4R2eAZG5WX--iaI21mkkumfaFAFBt3TsI1AR0hqO2nmxpKeX7`；发布记录含 3 条失败（EPERM×2、缺封面×1）+ 1 条成功，可回看排障过程 |
| 草稿箱内容与预览一致 | ☐ 通过 | | 待人工到 mp.weixin.qq.com → 草稿箱核对（标题/封面/作者） |

## 9. 自动化验证记录（2026-08-24，供复核）

- 后端全量 pytest：**84 passed**（含 wenyan_client fake 模式 6 + 子进程环境重定向 2、publish_service 组装/记录/失败注入等 20+）。
- 前端 Vitest：**62 passed**（新增发布线：PublishPage 8、PublishRecordsPage 5、PublishRecordDetailPage 3、placements 9、snapshot 5、errorText 2、AppLayout 4）。
- 前端 `pnpm exec eslint .` 零错误；`pnpm build`（tsc -b + vite build）成功。
- Playwright E2E：**13 passed**（原 11 + 新增 publish 主路径/校验路径 2），全程 fake 模式无真实网络依赖。
- **真实发布修复回归（2026-08-24 晚）**：EPERM token 缓存问题修复（`XDG_CONFIG_HOME` 重定向到 `DATA_DIR/wenyan-md/`）后，pytest 84 passed、errorText/PublishPage Vitest 10 passed、ESLint 零错误；经 API 重放真实发布成功（media_id 见 §8）。
- E2E 期间发现并修复：发布页素材/会话列表请求 `limit=200` 超出后端上限 100（422），已改为 100（`PublishPage.tsx` / `PublishRecordDetailPage.tsx`）。
