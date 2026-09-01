# T014：发布选主题支持主题预览（渲染即所见）+ 向导合并为三步

## 1. 任务信息

- 状态：已完成（2026-08-25）
- 优先级：P1
- 类型：功能增强 + 交互重构（前后端）
- 前置任务：T013
- 后续任务：无
- 目标目录：`frontend/`、`backend/`
- 创建日期：2026-08-25
- 关联文档：`docs/task/T013-publish-block-anchor-image-insertion.md`（配图画布，本任务不改）、`docs/task/T009-wechat-publish-frontend.md`（原四步向导设计）
- 需求来源：人工验收反馈——选主题后应能预览应用主题后的文章；文章默认只读渲染，可点【编辑】进入编辑模式

## 2. 需求与现状

| 项 | 现状（T013 后） | 调整后 |
|---|---|---|
| 选主题（步骤 3） | 主题卡片单选，仅名称 + 描述文字，无视觉效果 | 选中主题卡**即时渲染**「应用该主题后的文章」预览 |
| 预览形态（步骤 4） | 默认 Markdown TextArea 源码编辑 | 默认**只读渲染预览**，点【编辑】按钮进入编辑模式 |
| 向导结构 | 四步：版本和信息 → 配图与位置 → 选主题 → 预览与发布 | **三步**：选主题步骤合并预览 + 编辑 + 发布（同屏所见即所发） |
| 发布确认 | 步骤 4 内发布 | 步骤 3 选中主题后【确认发布】启用（保留发布前确认弹窗） |

**核心价值**：
1. 所见即所发——预览使用与真实发布**完全相同的渲染代码路径**（`@wenyan-md/core` 的 `renderStyledContent`，wenyan-mcp `publish_article` 发布前调用的同一函数、相同参数），杜绝"预览一个样、发布另一个样"。
2. 流程减一步——发布目标是草稿箱（可删可改，低危），不值得独立"最终确认"步骤。

**技术可行性（2026-08-25 已实测验证）**：
- wenyan-mcp 仅提供 4 个工具（`publish_article` / `list_themes` / `register_theme` / `remove_theme`），**无渲染工具**；
- 但其依赖 `@wenyan-md/core` 从 `dist/wrapper.js` 导出 `renderStyledContent(markdown, options)`——发布链路 `renderAndPublish` 内部正是先调它再上传微信；
- 本机实测：直接 import 全局安装的 core（`C:\Users\18520\AppData\Roaming\npm\node_modules\@wenyan-md\mcp\node_modules\@wenyan-md\core\dist\wrapper.js`），default / orangeheart 主题分别输出 2610 / 3284 字符的 `<section id="wenyan" style="...">` 内联样式 HTML——**纯本地渲染，无需微信凭据，不产生任何微信 API 调用**。

**技术约束**：
- core 是 wenyan-mcp 的嵌套依赖（非全局顶层包），渲染脚本需从 `WENYAN_MCP_COMMAND` 解析出的安装位置推导 core 路径；
- 组装产物中图片为本地绝对路径（wenyan-mcp 上传要求），预览 HTML 需逆映射回 `/static/...` 才能在同源 iframe 中显示；
- 渲染子进程含 JSDOM + mermaid，冷启动 1~3s（决策 ④A 接受，加载态覆盖）。

## 3. 已确认决策点（2026-08-25 与用户对齐）

| # | 决策 | 结论 |
|---|---|---|
| ① | 预览触发时机 | **选中主题卡即渲染**：步骤 2（选主题）左选右看，即时切换对比 |
| ② | 步骤 3 的 Markdown 编辑能力 | **默认预览 + 【编辑】按钮进入编辑模式**（用户在"彻底移除"基础上的调整） |
| ③ | fake 模式且 wenyan-mcp 未安装时的预览 | **直接报错提示安装**：保证预览 = 发布效果，不做两套渲染 |
| ④ | 预览中的性能取舍 | **保持 core 默认全功能**：mermaid / 数学公式可预览，首渲染 1~3s 可接受 |
| ⑤ | 步骤结构 | **三步合并**：选主题 + 预览 + 编辑 + 发布同屏，去掉独立「预览与发布」步骤 |
| ⑥ | 编辑模式形态 | **预览区内切换**：右上【编辑】按钮原位切换 TextArea +【完成编辑】，不弹窗 |
| ⑦ | 编辑后与预览的联动 | **完成编辑即重新渲染**：始终所见即所发，加载态覆盖延迟 |
| ⑧ | 无主题时的预览区状态 | **空态引导**：未选主题时显示「请选择主题查看排版效果」 |

## 4. 范围

### 4.1 后端（backend/）

**新脚本 `scripts/wenyan_render.mjs`**

- 调用方式：`node wenyan_render.mjs <core_wrapper_abs_path>`；stdin 传 JSON `{markdown, themeId}`；stdout 返回 JSON `{html}`。
- 渲染参数与 wenyan-mcp 发布**完全一致**（对齐 `publish.js` 的 `publishOptions`）：`hlThemeId: "solarized-light"`、`isMacStyle: true`、`isAddFootnote: true`、mermaid 默认启用（决策 ④A）。
- 失败（主题不存在 `主题不存在: xxx` 等）→ stderr 输出错误信息 + 非零退出码。
- 仅依赖 Node 20+ 运行时（core 及其依赖已随 wenyan-mcp 安装）。

**`app/wenyan_client.py`：新增 `render_markdown(markdown, theme_id) -> str` 方法**

- core 路径解析：复用 `_server_command()` 得到 wenyan-mcp 可执行路径 → 推导 npm 全局根（`dirname(dirname(resolved))`）→ 依次探测候选：
  1. `<npm_root>/node_modules/@wenyan-md/mcp/node_modules/@wenyan-md/core/dist/wrapper.js`（npm 全局嵌套布局，本机实测路径）
  2. `<npm_root>/node_modules/@wenyan-md/core/dist/wrapper.js`（core 被提升的布局）
  3. 以上均不存在 → `PUBLISH_MCP_NOT_INSTALLED`（文案含 `npm install -g @wenyan-md/mcp` 安装指引，决策 ③A——fake 模式同样走真实渲染，不伪造 HTML）
- 子进程：`asyncio.create_subprocess_exec("node", <script>, <core_path>)`，stdin 传 JSON、stdout 读结果；30s 超时 → `PUBLISH_RENDER_TIMEOUT`；脚本非零退出 → `PUBLISH_RENDER_ERROR`（透传 stderr 摘要，含"主题不存在"等原文）。

**`app/publish_service.py`：新增 `map_local_paths_to_static(markdown, assets) -> str`**

- `resolve_image_path` 的逆映射：组装产物中的本地绝对图片路径（`{data_dir}/assets/...`）替换回对应 `storage_url`（`/static/assets/...`）；http(s) URL 原样保留；无图正文不变。
- 作用对象：frontmatter `cover:` 与正文 `![](...)`（两者都是绝对路径形态）。

**`app/main.py`：新增 `POST /api/publish/render-preview`**

- 请求模型：`PublishPreviewRequest` 全部字段 + `theme_id: str`（必填）+ `markdown: str | None`（终稿覆盖——编辑模式重新渲染用；提供时跳过组装直接渲染，仍做路径映射）。
- 逻辑：markdown 未提供 → `build_publish_markdown` 组装（复用现有 collect/resolve 链路）→ `map_local_paths_to_static` → `wenyan_client.render_markdown(markdown, theme_id)` → 返回 `{html}`。
- `theme_id` 为空 → 422 校验错误（与现有请求校验风格一致）。

**pytest（backend/tests/）**

- `map_local_paths_to_static`：本地路径→static 映射、http 透传、无图不变、cover 与正文双命中。
- render-preview 接口契约（monkeypatch `render_markdown` 为 stub，不依赖 node）：markdown 覆盖分支 / 组装分支、theme_id 必填、stub 异常 → 错误码映射。
- node 脚本真实渲染集成用例 ×1：本机可解析 node + core 时执行（default 主题输出含 `<section id="wenyan"`、主题 CSS 内联特征），否则 `pytest.mark.skipif` 跳过（CI/无环境兜底）。

### 4.2 前端（frontend/）

**`src/api/types.ts` + `src/api/publish.ts`**

- 新增 `PublishRenderPreviewRequest`（preview 字段 + `theme_id` + 可选 `markdown`）与 `PublishRenderPreviewResponse { html: string }`；`publishApi.renderPreview(payload)`。

**新组件 `src/features/publish/ThemePreviewPanel.tsx`**

- 布局：手机框预览（iframe `sandbox=""` + `srcDoc={html}`，宽约 420px、白底、圆角边框，模拟公众号阅读宽度；sandbox 禁脚本，内联样式安全）。
- 工具栏（预览区顶部）：右上【编辑】按钮（决策 ⑥A）。
- 状态：加载 Spin 覆盖（渲染 1~3s）；错误 StatusBanner + 重试按钮；未选主题空态「请选择主题查看排版效果」（决策 ⑧A）。
- 编辑模式：预览区原位切换为 TextArea（复用 `publish-markdown-editor` 样式）+【完成编辑】按钮 → 触发重新渲染（决策 ⑦A）。
- Props：`html`、查询状态、`editedMarkdown`、`onEdit` / `onFinishEdit` 等（编辑终稿状态由 PublishPage 持有，便于发布 payload 复用）。

**`src/pages/PublishPage.tsx`**

- `STEP_ITEMS` 四项 → 三项：`['版本和信息', '配图与位置', '选主题']`；步骤索引 0/1 不变，原步骤 2（选主题）承接到索引 2，原步骤 3（预览与发布）删除。
- 步骤 2（选主题）新布局：左侧主题卡竖排列表 + 右侧 `ThemePreviewPanel`；底部【上一步】+【确认发布】（主题未选中时禁用；保留现有发布前确认弹窗 `okText: '确认发布'`）。
- 渲染查询：React Query，key 含 `articleId / versionId / placements 摘要 / coverAssetId / author / themeId / 编辑内容 hash`——主题切换即时重渲染（决策 ①A），配图/版本变化触发重渲染；queryKey 变化自动缓存与复用（来回切主题不重复渲染）。
- 编辑终稿语义迁移：`previewMarkdown` / `markdownDirty` 保留——编辑模式写入 `previewMarkdown`；**组装输入（版本/配图/封面/作者）变化时清除编辑态**（沿用现有"编辑仅作用于当前组装结果"语义，避免终稿与画布脱节）；发布 payload `edited_markdown` 仅在 dirty 时发送（现状不变）。
- `publishPhase` 成功（media_id Alert）/ 失败（错误 + 重试）UI 从原步骤 3 迁移至步骤 2 预览面板下方。
- 清理：`step === 3` 分支、`setStep(3)`、旧步骤导航边界、`markdownDirty` 相关旧 UI。
- Steps 组件点击回退边界同步（仅允许回退）。

**样式（`src/styles/global.css`）**

- 新增：主题步骤左右布局、手机框 iframe 容器（宽 420px 居中）、预览工具栏、编辑模式切换。
- 清理：仅旧步骤 4 使用的死样式（`publish-preview` 容器等；`publish-markdown-editor` 编辑 TextArea 复用保留）。

**测试**

- Vitest（`PublishPage.test.tsx`）：
  - 三步结构（Steps 渲染 3 项；无「预览与发布」步骤）。
  - 选中主题卡触发 renderPreview 调用（参数含 theme_id 与 placements）；未选主题预览区空态文案。
  - 【编辑】切换 TextArea、修改内容、【完成编辑】→ 重新渲染（请求参数带编辑后 markdown）。
  - 组装输入变化（如切版本）清除编辑态。
  - 【确认发布】主题未选禁用；发布 payload `edited_markdown` 仅编辑过时发送。
  - 渲染失败 → 错误提示 + 重试。
- E2E（`e2e/publish.spec.ts`）：
  - 主路径改为三步：配图 → 下一步 → 选主题（default）→ iframe 预览出现 →【确认发布】→ 确认弹窗 → 成功断言（FAKE media id / 发布记录）不变。
  - iframe 断言：优先断言 iframe 元素 + `srcdoc` 属性含主题渲染特征（如 `<section id="wenyan"`）；必要时用 `frameLocator` 断言正文文本（假文章文本「如果你能看到这段文字」）。
  - 校验路径（无图纯文字发布）：三步导航同步调整。
  - 注意：E2E 环境依赖本机已装 wenyan-mcp（现状已满足，`--wipe` 后端 fake 模式 + 真实本地渲染共存）。

### 4.3 文档

- `docs/prd/prd.md`：FR-P3（选主题）重写（主题预览 + 编辑模式 + 三步向导）；用户旅程 / IA 图 / 验收项同步（四步 → 三步）。
- `docs/tech/tech-design.md`：5.6 发布线补 `render-preview` 接口、`wenyan_render.mjs` 脚本、core 路径解析策略、渲染参数与发布一致性说明。
- `README.md`：发布使用指南（三步流程、主题预览、编辑模式入口）。
- `docs/ops/manual-tasks-t007-t010.md`：冒烟清单原步骤 3/4 合并重写；补「主题预览需 wenyan-mcp（本地渲染，无需凭据）」说明。
- 本任务文档状态与验收项同步。

### 4.4 不实现

- 配图步骤（步骤 1）画布的主题效果预览（画布保持无主题 Markdown 渲染，主题预览仅存在于选主题步骤）。
- 自定义主题管理 UI（`register_theme` / `remove_theme` 不暴露，仅展示 `list_themes` 结果）。
- 代码高亮主题选择（固定 `solarized-light`，与发布一致）。
- 预览 HTML 导出 / 复制。
- 编辑模式语法高亮（纯 TextArea，与现状一致）。
- 移动端适配（预览固定桌面布局）。
- `prototype/` 目录任何改动。

## 5. 测试

- 后端：pytest 全量通过（新增路径映射 / render-preview 契约 / node 集成用例）。
- 前端：Vitest 全量通过（三步结构 / 预览交互 / 编辑模式 / 发布 payload）；`pnpm exec eslint .` 零错误；`tsc --noEmit` / `pnpm build` 成功。
- Playwright E2E 全量通过（publish 主路径 / 校验路径按三步流程重写后回归）。
- 手动冒烟：真实发布链路验证「预览效果 = 草稿箱实际效果」（同一主题渲染一致性）；未装 wenyan-mcp 环境的错误提示（可选，卸载验证成本高，以单元测试为准）。

## 6. 验收标准

- [x] 向导为三步：版本和信息 → 配图与位置 → 选主题；无独立「预览与发布」步骤（决策 ⑤A）。
- [x] 选中主题卡即渲染预览（手机框 iframe），切换主题即时切换；未选主题显示空态引导（决策 ①⑧A）。
- [x] 预览为只读渲染；点【编辑】原位切换 TextArea，【完成编辑】后重新渲染（决策 ②⑥⑦A）。
- [x] 发布以编辑后内容为准（dirty 时发送 `edited_markdown`）；组装输入变化清除编辑态。
- [x] 【确认发布】仅主题选中后启用；发布成功 / 失败 UI 在步骤 2 内呈现。
- [x] 预览与发布使用同一渲染路径（`renderStyledContent` + 相同参数：`solarized-light` / macStyle / footnote）。
- [x] 未装 wenyan-mcp 时预览报 `PUBLISH_MCP_NOT_INSTALLED` 并提示安装（决策 ③A）；渲染超时 / 主题不存在有明确错误。
- [x] 渲染 HTML 中图片显示正常（本地路径已映射回 `/static/...`）。
- [x] pytest / Vitest / ESLint / tsc / build / Playwright E2E 全量通过（2026-08-25：pytest 108 passed；Vitest 71 passed；ESLint 零错误；tsc -b + vite build 成功；E2E 13 passed）。
- [x] PRD、tech-design、README、ops 手册同步更新。
- [x] `prototype/` 目录未被改动。

## 7. 完成定义

- 上述验收标准全部勾选。
- 所有变更经全量回归（pytest / Vitest / ESLint / tsc / build / Playwright E2E）验证通过。
- 文档（PRD / tech-design / README / ops / 本任务文档）与实现一致。
- 真实发布链路的人工冒烟事项（若有）记录到 `docs/ops/manual-tasks-t007-t010.md`。
