# T006：质量与交付（测试、E2E 与生产部署）

## 1. 任务信息

- 状态：待实施
- 优先级：P0
- 类型：正式任务 6/6
- 前置任务：T001、T002、T003、T004、T005
- 后续任务：无
- 目标目录：`frontend/`、`backend/`
- 创建日期：2026-08-23
- 关联文档：`docs/prd/prd.md`（第 9 节产品级验收）、`docs/tech/tech-design.md`

## 2. 目标

补齐前端组件测试与 E2E 验收，验证生产构建与单进程部署形态，完成文档收尾。项目以生产模式完整可用为完成标准。

## 3. 范围

### 3.1 必须实现

**前端组件测试（Vitest + Testing Library）**

- `MarkdownView`：白名单渲染、恶意 HTML 输入不执行（安全断言用例）。
- `MessageList`：消息分型样式、失败卡片（脱敏详情展开、重新发送按钮）。
- SSE hooks：事件分发（含取消/失败路径）、`run.completed` 关闭、卸载清理。
- `ModelSelect`：运行中禁用、未配置项禁用并显示原因。

**E2E 验收（Playwright）**

- 配置：baseURL、webServer 编排（或连接已运行后端）；E2E 环境使用后端假模型（`tests/fakes.py` 机制），不依赖真实 API Key。
- 用例覆盖 MVP T003 场景 A–G：
  - A 新文章与标题；B 列表过滤；C 历史对话继续；D 重启恢复；E 取消；F 失败和重试；G 上下文压缩（后端断言预算不变量）。
- 配图与素材主路径用例：新建会话 → 发送 → 完成 → 保存素材 → 素材库可见。

**生产构建与部署验证**

- `pnpm build` 产物接入 FastAPI 静态托管（`SERVE_FRONTEND=true`）。
- SPA fallback 验证：直接访问/刷新 5 条路由均不 404。
- 单进程启动完整应用验证：静态资源、API、SSE（流式无缓冲）均正常。

**文档收尾**

- 根 README：项目简介、目录结构、开发启动、生产部署。
- 后端 README：迁移后启动方式与 `SERVE_FRONTEND` 说明。
- 三份文档（PRD、技术设计、任务拆分）随实施更新状态标记。

### 3.2 不实现

- CI/CD 流水线。
- Docker 化。
- 真实 API Key 依赖的自动化用例（保留手工冒烟脚本）。

## 4. 测试

- `pnpm test`（Vitest）全部通过。
- `pnpm e2e`（Playwright）全部用例通过。
- 生产模式人工走查：单进程启动后完成"新建文章 → 对话生成 → 版本查看 → 配图 → 保存素材"全流程。
- SSE 经生产模式（FastAPI 直接托管）验证流式无缓冲。

## 5. 验收标准

- [ ] Vitest 组件测试全部通过，覆盖 MarkdownView/MessageList/SSE hooks/ModelSelect。
- [ ] 安全渲染有断言用例（恶意 HTML 输入不执行）。
- [ ] Playwright E2E 覆盖 MVP 场景 A–G + 配图/素材主路径，全部通过。
- [ ] E2E 不依赖真实 API Key（假模型）。
- [ ] 单进程 `uvicorn` 启动后全功能可用。
- [ ] 深链路由刷新不 404；SSE 流式无缓冲延迟。
- [ ] PRD 第 9 节产品级验收逐条通过。
- [ ] 根 README 与后端 README 完整准确。
- [ ] `prototype/` 目录未被改动。

## 6. 完成定义

上述验收全部通过后，T006 完成，正式项目交付：

- MVP 端到端验收场景在正式版全部复验通过；
- 生产模式单进程部署验证完成；
- 文档与实施状态同步更新。
