# Article Studio 启动/停止脚本

Windows 10+ 可双击使用的前后端服务管理脚本（开发模式）。

## 文件说明

| 脚本 | 用途 |
|------|------|
| `start-all.cmd` | 一键启动前后端（先后端 8000，再前端 5173） |
| `stop-all.cmd` | 一键停止前后端 |
| `start-backend.cmd` / `stop-backend.cmd` | 单独启动/停止后端（FastAPI + uvicorn，端口 8000） |
| `start-frontend.cmd` / `stop-frontend.cmd` | 单独启动/停止前端（Vite 开发服务器，端口 5173） |

`.cmd` 是双击入口（绕过 PowerShell 执行策略），实际逻辑在同名 `.ps1`，共享函数在 `common.ps1`。

## 使用方式

1. 打开文件资源管理器，进入项目根目录的 `scripts\`。
2. 双击 `start-all.cmd`，会弹出两个服务窗口：
   - `ArticleStudio-Backend`：运行 uvicorn（`http://127.0.0.1:8000`，API 文档 `/docs`）
   - `ArticleStudio-Frontend`：运行 Vite（`http://localhost:5173`）
3. 浏览器访问 `http://localhost:5173`。
4. 使用完毕后双击 `stop-all.cmd` 停止两个服务（也可直接关闭两个服务窗口）。

首次启动会自动完成初始化（无需手工准备）：

- 后端：`backend\.venv` 不存在时自动执行 `uv sync`
- 前端：`frontend\node_modules` 不存在时自动执行 `pnpm install`

## 环境要求

- Windows 10 或更高版本
- `uv` 已安装并在 PATH 中（后端依赖）
- pnpm 可用：PATH 中有 `pnpm`，或有 `corepack`（Node.js 20.19+ 自带；脚本自动设置 `COREPACK_HOME` 到仓库 `.corepack\`）
- `backend\.env` 已按 `backend\.env.example` 配置真实 API Key；不消耗额度的联调可改用假模型后端（`backend/scripts/dev_fake_server.py`，见 `backend/README.md`）
- 发布到公众号（可选）：需 `npm install -g @wenyan-md/mcp` 并配置 `WECHAT_APP_ID / WECHAT_APP_SECRET`（`PUBLISH_FAKE_MODE=false`），详见 `docs/ops/manual-tasks-t007-t010.md`；未配置时默认假发布，不影响其余功能

## 端口约定

- 后端：8000（前端 Vite proxy 的 `/api` 与 `/static` 转发目标）
- 前端：5173（`vite.config.ts` 已设 `strictPort: true`，被占用时启动直接报错而非自动换端口，避免停止脚本按端口定位失效）

## 故障排查

- **双击 `.cmd` 后窗口一闪而过**：脚本执行失败。在 PowerShell 中手动运行对应 `.ps1` 查看详细错误，例如 `powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1`。
- **启动提示「已在运行」**：对应端口已被占用（可能是之前启动的服务）；运行对应的 `stop-*.cmd`，或检查其他程序占用。
- **停止失败**：结束其他用户或管理员启动的进程可能需要管理员权限，请右键「以管理员身份运行」对应的 stop 脚本。
- **前端已启动但页面接口报错**：后端未启动或已退出；先运行 `start-backend.cmd`，前端无需重启（proxy 会自动恢复转发）。
- **依赖安装卡住**：`pnpm install` / `uv sync` 需要网络；国内网络可配置 npm/PyPI 镜像后重试。

服务启动后各自在独立窗口运行，日志直接显示在对应窗口（uvicorn 访问日志 / Vite 编译输出）；关闭服务窗口也会停止对应服务，`stop-*.cmd` 与之等价。
