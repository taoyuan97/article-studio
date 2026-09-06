# T009：公众号发布（三）前端发布工作台

## 1. 任务信息

- 状态：已完成
- 优先级：P0
- 类型：正式任务 9/10
- 前置任务：T008
- 后续任务：T010
- 目标目录：`frontend/`
- 创建日期：2026-08-24
- 关联文档：`docs/task/T008-wechat-publish-backend.md`（API 契约）、`frontend/src/pages/`（页面组织约定）

## 2. 目标

新增发布向导页 `PublishPage`（四步流，从文章工作台进入）与发布记录页 `PublishRecordsPage`（侧边栏新入口，位于"素材"之后），实现"选版本 → 选图定位置 → 选主题 → 预览发布"的完整交互，发布成功后可在记录列表查看内容快照（只读渲染）。

## 3. 范围

### 3.1 必须实现

**API 层（`frontend/src/api/`）**

- 类型定义：`PublishTheme`、`PublishSection`、`ImagePlacement`、`PublishRecord` 等（types.ts）。
- 请求函数：`fetchPublishThemes` / `publishPreview` / `publishArticle` / `fetchPublishRecords` / `fetchPublishRecordDetail`，沿用现有 API client 封装与错误处理约定（结构化 `{code, message}`）。

**PublishPage（`frontend/src/pages/PublishPage.tsx`，专注模式，不进侧边栏）**

四步向导（步骤条可回退，状态本地维护）：

- **步骤 1 选文章与版本**：下拉选文章（复用现有文章列表 API）→ 版本下拉（默认当前版本）→ 加载该文章可选配图（assets）与正文小节。
- **步骤 2 配图与位置**（核心交互，手动逐图指定位置）：
  - 已选图片卡片列表：缩略图、标题、排序（上移/下移，同位置顺序）。
  - 每张图独立"插入位置"选择器：`文首 / 第 N 节之后（显示小节标题摘要） / 文末`；小节列表来自 preview 接口的 `sections`。
  - 默认值：按勾选顺序均分到各小节（省去逐张设置）。
  - 封面选择：从已选图片单选（默认第一张）；明确展示"不选则自动用正文第一张图"提示。
  - 作者输入框（选填）。
- **步骤 3 选主题**：主题卡片网格（名称 + 描述），数据来自 `GET /api/publish/themes`；默认选中 `default`。
- **步骤 4 预览与发布**：
  - 调 `POST /api/publish/preview` 渲染组装结果；Markdown 编辑框可直接修改（改动后发布时传 `edited_markdown`）。
  - "发布到公众号草稿箱"按钮：确认弹窗（提示发布为草稿、不群发）→ 调发布接口 → 按钮 loading（同步等待，前端请求超时 120s）。
  - 成功：展示 media_id 与成功态，引导"去公众号后台草稿箱查看"，并提供"查看发布记录"链接跳转 `/publish-records`。
  - 失败：按错误码展示原因（凭据缺失/IP 白名单/超时等），可重试。

**侧边栏导航（`frontend/src/layouts/AppLayout.tsx`）**

- `NAV_ITEMS` 新增第 4 项：`{ key: '/publish-records', label: '发布记录' }`，位于"素材"之后；侧边栏变为 首页 / 文章 / 素材 / 发布记录。

**PublishRecordsPage（`frontend/src/pages/PublishRecordsPage.tsx`，带壳 AppLayout）**

- 发布记录列表（时间倒序，`GET /api/publish/records`）：发布时间、文章标题、主题、状态徽标（成功/失败）、media_id；成功与失败记录均展示，支持按状态筛选（全部/成功/失败）与按文章过滤（`?article_id=`）。
- 失败记录可展开查看错误码与错误信息（便于排障，如 IP 白名单类错误）。
- 行操作"查看快照"→ 跳转 `/publish-records/:recordId`。
- 空态：无记录时展示引导文案（"从文章工作台发布第一篇文章"）。

**快照详情页（`/publish-records/:recordId`，FocusLayout，返回发布记录）**

- 数据来自 `GET /api/publish/records/{id}`（含 `content_snapshot`）。
- 元信息面板：文章标题、主题、状态、media_id、作者、发布时间、封面缩略图（记录的 cover_asset）。
- 正文只读渲染：剥离 frontmatter 后的 Markdown 经现有 `MarkdownView` 白名单渲染（安全性与文章工作台一致）；图片以缩略图形式可预览。

**文章工作台入口**

- `ArticleWorkspacePage` 头部操作区新增"发布到公众号"按钮，携带当前 `article_id` 跳转 `/publish?article_id=xxx`（PublishPage 读取 query 预选文章）。

**路由（`frontend/src/App.tsx`，路由表 5 → 8 条）**

- `/publish`：PublishPage，FocusLayout（返回文章列表）——SPA fallback 已有机制覆盖刷新场景。
- `/publish-records`：PublishRecordsPage，AppLayout（侧边栏"发布记录"高亮）。
- `/publish-records/:recordId`：快照详情页，FocusLayout（backTo=`/publish-records`，backLabel="返回发布记录"）。

### 3.2 不实现

- 拖拽排序（用上移/下移按钮替代，降低复杂度）。
- 富文本可视化预览（仅 Markdown 文本编辑预览；所见即所得排版属于文颜/公众号后台能力）。
- 主题注册/管理 UI（后端本期也不暴露）。
- 移动端适配。

## 4. 测试

- Vitest + Testing Library：
  - 向导步骤流转：步骤跳转/回退/必选项校验（未选文章不可下一步、未选主题不可发布）。
  - 配图位置组件：默认均分位置计算、位置切换、上移下移排序、封面单选。
  - 发布交互：loading 态、成功态（展示 media_id 与"查看发布记录"链接）、失败态（错误码映射文案）、edited_markdown 透传断言。
  - PublishRecordsPage：列表渲染（含文章标题/状态徽标/media_id）、状态筛选、失败记录展开错误信息、空态、跳转详情。
  - 快照详情页：元信息面板展示、frontmatter 剥离后的只读渲染（恶意 HTML 不执行，沿用 MarkdownView 安全断言）。
  - 侧边栏：第 4 项"发布记录"渲染与当前项高亮（`/publish-records` 路径下）。
- ESLint、tsc、`pnpm build` 通过。

## 5. 验收标准

- [x] `/publish` 页面四步向导完整可用，支持回退与状态保持。
- [x] 每张图片可独立指定插入位置（文首/第 N 节之后/文末），同位置多图按顺序排列。
- [x] 封面可从已选图片单选，默认第一张；不选有自动封面提示。
- [x] 主题列表来自后端接口，默认选中 default。
- [x] 预览步可编辑 Markdown，发布时以编辑后内容为准。
- [x] 发布全程同步等待有 loading；成功/失败状态清晰，失败文案按错误码区分。
- [x] ArticleWorkspacePage 有发布入口并正确带参跳转。
- [x] 侧边栏新增"发布记录"项，位于"素材"之后，`/publish-records` 下正确高亮。
- [x] 发布成功的记录出现在发布记录列表（文章标题、主题、状态、media_id）。
- [x] 失败记录可见并可展开错误信息；支持状态筛选与按文章过滤。
- [x] 快照详情页只读渲染发布内容（frontmatter 剥离、MarkdownView 白名单渲染），元信息完整。
- [x] Vitest 新增用例通过；ESLint/tsc/build 通过。
- [x] `prototype/` 目录未被改动。

## 6. 完成定义

上述验收全部通过后，T009 完成：用户可在前端完成从已有文章/配图到公众号草稿箱的一键发布全流程（开发环境 fake 模式即可演示）。
