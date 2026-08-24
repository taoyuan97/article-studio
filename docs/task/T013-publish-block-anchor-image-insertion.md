# T013：发布配图改为主流编辑器范式（正文画布锚点定位 + 弹窗插图）

## 1. 任务信息

- 状态：待执行
- 优先级：P1
- 类型：交互重构（前后端）
- 前置任务：T012
- 后续任务：无
- 目标目录：`frontend/`、`backend/`
- 创建日期：2026-08-24
- 关联文档：`docs/task/T012-publish-cover-author-restructure.md`（步骤 1 封面弹窗，本文配图弹窗的交互参照）、`docs/task/T009-wechat-publish-frontend.md`（原步骤 2 位置编排设计）
- 需求来源：人工验收反馈——配图应支持鼠标定位到正文任意位置后插入，参考主流编辑器

## 2. 需求与现状

| 项 | 现状（T012 后） | 调整后 |
|---|---|---|
| 正文可视化 | 步骤 2 无正文预览，仅缩略图墙 + 已选卡片 | 新增**正文画布**：渲染正文块，点击任意块设置插入锚点（显示插入指示线） |
| 插图入口 | 缩略图墙直接勾选 | 顶部固定「插入配图」按钮 → **弹窗多选**（样式参照步骤 1 封面弹窗），确定后插入锚点处 |
| 位置模型 | `top` / `bottom` / `after_section_{n}`（H2 小节级），下拉选择 | `after_block_{i}`（块/段落级，全局 1 起编号），由锚点决定 |
| 已插图管理 | 卡片列表 + 位置下拉 + 上移/下移 | 图片**内联显示**在画布对应块之后，hover 显示删除按钮；同锚点多图按插入顺序排列 |
| 空正文 | 可插图（round-robin 到小节/文末） | 禁用插图并提示先写正文 |

**核心价值**：位置粒度从「小节」细化到「块」，实现真正的"鼠标定位到任意位置插入"；交互从"先选图后配位置"反转为"先定位后选图"，与主流编辑器心智一致。

**技术约束**：`image_placements` 以 `asset_id` 为逻辑主键（前端 key / 后端按 asset 查找），**同一素材不可重复插入**——弹窗中已插入的素材置灰并标记「已插入」。

## 3. 已确认决策点（2026-08-24 与用户对齐）

| # | 决策 | 结论 |
|---|---|---|
| ① | 插入位置粒度 | **块/段落级**：点击任意段落/标题 → 插入该块之后（`after_block_{i}`）；扩展后端契约，preview 返回块列表 |
| ② | 定位交互形式 | **点击块设锚点 + 顶部固定「插入配图」按钮**：点击正文某处显示插入指示线，再点按钮开弹窗 |
| ③ | 选图弹窗单选/多选 | **多选**：一次勾选多张，确定后按勾选顺序连续插入同一锚点；footer 显示「确定（已选 n 张）」 |
| ④ | 已插图管理 | **内联管理**：画布内联展示，hover 删除；同锚点多图按插入顺序；第一版不做拖拽排序（删除重插即可） |
| ⑤ | 历史数据兼容 | **并存**：`after_block_{i}` 与 `after_section_{n}` / `top` / `bottom` 后端均支持，历史发布记录不受影响 |
| ⑥ | 正文变化时锚点处理 | **保留图片、失效锚点退到文末**：切版本后已选图不丢，`after_block_{i}` 超出新块数的位置重置为 `bottom`，界面提示重新定位；步骤 3 返回不受影响（画布基于原文，编辑仅作用于发布 payload） |
| ⑦ | 空正文边界 | **禁用并提示先写正文**：无块可点击时「插入配图」禁用 |

补充约定（随决策 ① 派生，不再单独确认）：
- 切换**文章**仍全部清空（现状不变，本文配图语境变化）；仅切**版本**走决策 ⑥ 的保留策略。
- 新向导只产生 `after_block_{i}` 位置；`top` / `bottom` 仅作为决策 ⑥ 的退化值与后端兼容值保留。

## 4. 范围

### 4.1 后端（backend/）

**`app/publish_service.py`**

- 新增 `split_blocks(markdown) -> list[dict]`：
  - 按空行切分顶层块（标题/段落/列表/引用/表格等），**fenced code block 内的空行不切分**（需行级状态机）；
  - 全局 1 起编号，返回 `[{index, kind, preview}]`（`kind`: heading/paragraph/list/quote/code 等；`preview`: 首行截断文本，供前端锚点提示与标签展示）。
- `build_publish_markdown` 重构为**按块重组**：
  - position 为 `after_block_{i}` 的图插入第 i 块之后；块间以空行连接，保证重组后 markdown 与原文语义一致（frontmatter、封面、作者逻辑不变）；
  - `top` / `bottom` / `after_section_{n}` 分支保留（历史记录兼容，行为不变；`after_section` 按现有 H2 切分逻辑定位）。
- preview 组装链路同步返回 blocks（见 main.py）。

**`app/main.py`**

- `_POSITION_PATTERN` 扩展：`^(top|bottom|after_section_[1-9]\d*|after_block_[1-9]\d*)$`，校验错误文案同步。
- `POST /api/publish/preview` 响应新增 `blocks` 字段（`split_blocks` 结果）——**块切分的单一事实源在后端**，避免前端自行切分与组装不一致导致锚点错位。
- publish 接口对 `after_block_{i}` 越界（i > 实际块数）返回 `PUBLISH_PLACEMENT_INVALID` 类错误（与现有 asset 缺失错误同级；具体错误码沿用现有校验风格）。

**pytest（backend/tests/）**

- `split_blocks`：普通段落/标题/列表混排、fenced code 含空行、无空行长文、空正文、首尾空行。
- `build_publish_markdown`：`after_block_{i}` 单图/同锚点多图按 order、与 `after_section` / `top` / `bottom` 混用、越界 position 报错、重组后 frontmatter 不变。
- preview 接口契约：响应含 `blocks` 且编号连续。

### 4.2 前端（frontend/）

**`src/api/types.ts`**

- 新增 `PublishBlock { index: number; kind: string; preview: string }`；`PublishPreviewResponse` 增加 `blocks: PublishBlock[]`。
- `ImagePlacement` 契约不变（`position` 取值扩展 `after_block_{i}`）。

**新组件 `src/features/publish/ArticleCanvas.tsx`**

- Props：`blocks`、`placements`、`assetById`（或素材列表）、`anchorBlockIndex`（当前锚点）、`onBlockClick`、`onRemoveAsset`。
- 渲染：逐块渲染（每块一个可点击容器，内容用现有 `MarkdownView` 渲染，保持 sanitize 白名单）；点击块 → 设置锚点，锚点处显示**插入指示线**（「↳ 将插入到这里」样式）。
- 已插图内联：块之后按 `order` 升序展示图片卡（缩略图 + 标题 + hover 浮出删除按钮）。
- 空正文：显示引导文案「正文为空，请先撰写正文后再插入配图」。

**新组件 `src/features/publish/ImagePickerModal.tsx`**

- 参照 `CoverPickerModal` 的分组缩略图墙样式（复用 `publish-picker-item` 等样式类）：
  - 分组：`articleAssets` 非空时「本文配图」置顶 +「素材库图片」；
  - **多选**：点击切换勾选，草稿勾选集合在打开时初始化为空（不预选）；
  - 已插入素材（传入 `selectedAssetIds`）置灰 + 「已插入」角标，不可选（数据模型约束，见 §2）；
  - footer：「取消」/「确定（已选 n 张）」（n=0 时确定禁用）；确定后按勾选顺序回调 `onConfirm(assetIds)` 并关闭。
- 素材库完全无图时空态引导（与现有文案一致）。

**重构 `src/features/publish/ImagePlacementEditor.tsx`**

- 新布局：顶部工具栏（「插入配图」按钮 + 锚点状态提示「将在第 n 块之后插入」）+ 正文画布（`ArticleCanvas`）。
- 按钮状态：无锚点时禁用（tooltip「请先点击正文选择插入位置」）；空正文禁用（tooltip「正文为空，请先撰写正文」，决策 ⑦）。
- 移除：缩略图墙、已选卡片列表、位置下拉、上移/下移（决策 ④：删除重插即可）。
- Props 相应简化（`onToggleAsset` / `onPlacementsChange` → `onInsertAssets` / `onRemoveAsset` / `onAnchorChange` 等）。

**`src/pages/PublishPage.tsx`**

- preview 拉取 effect 同时保存 `blocks`（同一次请求，无新增接口调用）。
- 交互处理替换：
  - `handleInsertAssets(assetIds)`：在锚点块后追加 placements（`position: after_block_{anchor}`，`order` 接续该锚点现有最大 order +1，多图按勾选顺序连续编号）；插入后锚点保持（便于连续补图）。
  - `handleRemoveAsset(assetId)`：从 placements 移除。
- 版本切换行为变更（决策 ⑥）：
  - 切文章：清空配图/封面/blocks（现状不变）。
  - 切版本：**保留** `selectedAssetIds` 与 `placements`；blocks 加载后执行 sanitize——`after_block_{i}` 且 `i > blocks.length` 的位置重置为 `bottom`；发生退化时显示一次性提示（如 Alert/message「部分图片位置已失效，已移至文末，请重新定位」）。
- 步骤 3 预览/发布链路不变（`assemblyInput` 透传 placements，后端按块组装）。

**`src/features/publish/placements.ts`**

- 新增：`blockPositionLabel(position, blocks)`（「第 n 块之后 · 摘要」）、`sanitizePlacements(placements, blocks)`（决策 ⑥ 的失效退化）。
- 删除无引用旧工具：`positionOptions`、`computeDefaultPlacements`、`movePlacement`；`positionLabel` 视引用情况保留或删除（当前仅编辑器使用，可一并清理）。
- `placements.test.ts` 同步重写。

**样式（`src/styles/global.css`）**

- 新增：画布容器与块 hover/选中态、插入指示线、内联图卡（缩略图 + hover 删除按钮）、「已插入」角标、工具栏。
- 清理死样式：`publish-picker`（步骤 2 旧缩略图墙）、`publish-card-*`、`publish-position-select` 等仅旧编辑器使用的类（注意 `publish-picker-item/grid/group` 仍被两个弹窗共用，**保留**）。

**测试**

- Vitest（`PublishPage.test.tsx` + 组件测试）：
  - 画布渲染块列表；点击块显示插入指示线与「将在第 n 块之后插入」提示。
  - 未设锚点/空正文时「插入配图」禁用（决策 ②⑦）。
  - 弹窗多选：分组展示、已插入置灰、确定后多图按顺序内联出现在锚点后、footer 计数。
  - 内联删除：hover 删除后画布与 payload 同步移除。
  - 切版本：保留图片、越界锚点退到文末并提示（决策 ⑥）；切文章全清（现状）。
  - 发布 payload `image_placements` 为 `after_block_{i}` 且 order 正确。
- E2E（`e2e/publish.spec.ts`）：步骤 2 主路径改为「点击块 → 插入配图 → 弹窗选 2 张 → 确定 → 画布内联回显」；步骤 3/发布断言基本不变（frontmatter、快照等）。

### 4.3 文档

- `docs/prd/prd.md`：FR-P2（配图与位置）重写为画布锚点 + 弹窗多选交互；验收项同步。
- `docs/tech/tech-design.md`：发布流程架构补充块切分、`after_block_{i}` 契约、preview `blocks` 字段。
- `README.md`：使用指南「发布到公众号」步骤 2 描述同步。
- `docs/ops/manual-tasks-t007-t010.md`：冒烟清单步骤 2 操作路径同步（如涉及）。
- 本任务文档状态与验收项同步。

### 4.4 不实现

- 拖拽排序/拖拽插图（决策 ④：删除重插即可，第一版不做）。
- 同一素材多处插入（`asset_id` 主键约束，弹窗置灰规避）。
- 步骤 3 编辑后的 Markdown 反向同步回步骤 2 画布（画布始终基于文章版本原文；步骤 3 编辑属于终稿手动覆盖，现状语义不变）。
- 历史发布记录的 `after_section` 位置迁移（决策 ⑤：后端并存支持，不迁移）。
- 块内行级定位（如段落中间插图）——粒度到块为止。
- `prototype/` 目录任何改动。

## 5. 测试

- 后端：pytest 全量通过（新增 `split_blocks` / `after_block` 组装 / 越界校验 / preview blocks 契约用例）。
- 前端：Vitest 全量通过（新增/重写画布、弹窗、sanitize 用例）；`pnpm exec eslint .` 零错误；`tsc -b` / `pnpm build` 成功。
- Playwright E2E 全量回归通过（publish 主路径/校验路径不因调整失败）。
- 手动冒烟：真实发布链路验证 `after_block` 组装结果与封面/纯文字边界不受影响。

## 6. 验收标准

- [ ] 步骤 2 显示正文画布，块级渲染（Markdown 安全渲染，含代码块内空行不拆块）。
- [ ] 点击任意块出现插入指示线与锚点提示；未设锚点或空正文时「插入配图」禁用并给出原因（决策 ②⑦）。
- [ ] 「插入配图」弹窗与封面弹窗风格一致：分组缩略图墙、多选、footer「确定（已选 n 张）」、已插入素材置灰（决策 ①②③）。
- [ ] 确定后多图按勾选顺序内联插入锚点块后；hover 可删除；同锚点多图按插入顺序排列（决策 ③④）。
- [ ] 发布 payload 与 preview/发布组装使用 `after_block_{i}`；步骤 3 组装结果正确（图在对应块后）。
- [ ] 切版本保留已选图、失效锚点退到文末并提示；切文章全部重置（决策 ⑥）。
- [ ] 后端兼容 `top` / `bottom` / `after_section_{n}`（历史发布记录快照/详情不受影响，决策 ⑤）；越界 `after_block` 返回明确错误。
- [ ] pytest / Vitest / ESLint / tsc / build / Playwright E2E 全量通过。
- [ ] PRD、tech-design、README、ops 手册同步更新。
- [ ] `prototype/` 目录未被改动。

## 7. 完成定义

上述验收全部通过后，T013 完成：发布配图从「小节级下拉编排」升级为「正文画布块级锚点 + 弹窗多选插图」的主流编辑器范式，前后端位置契约向后兼容，历史数据零迁移。
