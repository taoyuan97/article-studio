# Article Studio Frontend

正式项目前端：React 19 + Vite + TypeScript（strict）+ Ant Design 5。

- 服务端状态：TanStack Query；客户端状态：Zustand（T003 起按需创建 store）
- 路由：React Router（BrowserRouter，5 条路由）
- Markdown 渲染：react-markdown + rehype-sanitize（禁用原始 HTML）
- SSE：原生 EventSource 封装（`src/lib/sse.ts`）

## 启动（开发模式）

需要 Node 20.19+ 与 pnpm（本仓库通过 corepack 使用，见根 README）：

```powershell
pnpm install
pnpm dev          # http://localhost:5173
```

`/api` 请求经 Vite proxy 转发到 `http://127.0.0.1:8000`，请先启动后端（见 `../backend/README.md`）。

## 常用命令

```powershell
pnpm dev          # 开发服务器（含 /api proxy）
pnpm build        # tsc -b + vite build，产物 → dist/
pnpm lint         # ESLint（typescript-eslint + react-hooks）
pnpm format       # Prettier 格式化
pnpm preview      # 本地预览 dist 构建产物
```

## 目录说明

```text
src/
├─ main.tsx           # 入口：Provider 装配（AntD ConfigProvider 中文 / QueryClient / Router）
├─ App.tsx            # 路由表（5 条路由 + 两种布局形态）
├─ api/               # API 层（前端唯一 fetch 出口）
│  ├─ client.ts       # fetch 封装 + ApiError（BACKEND_UNREACHABLE 等错误码归一）
│  ├─ types.ts        # 后端契约 TS 类型（单一事实源）
│  ├─ articles.ts     # 文章线接口
│  ├─ imageSessions.ts# 配图线接口
│  └─ assets.ts       # 素材线接口
├─ lib/
│  ├─ queryClient.ts  # QueryClient 实例与默认配置
│  └─ sse.ts          # SSE 封装（事件监听 / run.completed 自动关闭 / 断网回调）
├─ hooks/
│  ├─ useArticleRunStream.ts   # 文章运行事件流 hook（卸载自动清理）
│  └─ useImageRunStream.ts     # 配图运行事件流 hook
├─ layouts/
│  ├─ AppLayout.tsx   # 侧边导航壳（首页/文章/素材，aria-current 高亮）
│  └─ FocusLayout.tsx # 专注模式布局（顶部返回链接 + 全宽内容）
├─ pages/             # 路由级页面（T002 为占位，T003–T005 填充业务）
├─ components/        # 跨模块通用组件（MarkdownView / StatusBanner）
└─ styles/            # 主题 tokens（tokens.ts）与全局样式（global.css）
```

## 与后端的契约

- API 路径、请求/响应结构、SSE 事件协议与后端一一对应，契约基准见 `../backend/tests/test_frontend_contract.py`。
- 类型定义集中在 `src/api/types.ts`，字段保持后端蛇形命名，后续如引入 openapi-typescript 在此替换。
