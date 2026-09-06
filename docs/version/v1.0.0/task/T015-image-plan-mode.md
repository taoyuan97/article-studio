# T015：配图工作台「计划/行动」双模式（文章配图提示词编排）

## 1. 任务信息

- 状态：已完成（2026-08-25）
- 优先级：P1
- 类型：功能新增（前后端）
- 前置任务：T013（正文块级锚点编号）、T014（配图工作台现状）
- 后续任务：无（方案与发布 `after_block_{n}` 锚点天然对齐，后续可扩展「一键应用到发布配图」，本期不做）
- 目标目录：`frontend/`、`backend/`
- 创建日期：2026-08-25
- 关联文档：`docs/task/T013-publish-block-anchor-image-insertion.md`（块编号事实源）、`docs/prd/prd.md`（FR-I 系列新增 FR-I5）
- 需求来源：用户提出——将「人工灵感选图」转化为「算法结构化提取」，输入任意一篇中文长文，自动输出数量合理、位置精准、风格统一、可直接用于 AI 绘图的提示词方案

## 2. 需求与现状

| 项 | 现状（T014 后） | 调整后 |
|---|---|---|
| 模式 | 仅「行动」模式：输入描述 → 生图（provider / 图片参数 / 停止 / 发送） | 「计划/行动」双模式切换，默认**行动**（现状不变） |
| 图片参数按钮 | 始终显示 | 仅行动模式显示 |
| 计划模式 | 无 | 选择文章版本 + 可编辑角色/编排指令（有默认值）+ 选择 LLM 模型 → 一键编排 → 输出配图方案（数量、位置、排版建议、统一风格提示词），每条提示词可复制 |
| 结果持久化 | 无 | 入库保留最近一条，刷新自动恢复 |

**核心价值**：内容创作者发布长文时配图耗时且风格难统一；计划模式自动识别章节结构、情绪基调，按字数裁定数量、按四项评分筛选高视觉潜力段落，输出风格统一、位置精准的提示词方案，可直接复制到任何 AI 绘图工具。

**范围界定**：
- In-Scope：识别字数/章节结构/情绪基调；字数映射裁定配图数量；五感、空间、动作、情绪反差四项评分筛选段落；统一风格提示词（默认中文）；排版建议（横版/方图/竖版 + 留白位置）。
- Out-of-Scope：不生成图片文件（仅提示词）；不做版权溯源/查重；不支持简体中文以外的输入（输出语言可由用户在指令中指定）。

## 3. 已确认决策点（2026-08-25 与用户对齐）

| # | 决策 | 结论 |
|---|---|---|
| ① | 接口形态 | **同步 POST**：一次性结构化输出无需流式，典型 20-60s，`asyncio.wait_for` 120s 超时兜底（对齐 publish 超时风格）；前端 loading 态覆盖全程 |
| ② | 结果持久化 | **入库保留最近一条**（每会话覆盖式），刷新/重进自动恢复 |
| ③ | 计划用哪个 LLM | **面板加模型选择器**；前端**只显示模型名称、隐藏供应商名称**（不复用 `ModelSelect`——其 label 含供应商前缀） |
| ④ | 提示词语言 | **默认中文**；用户可在编排指令中自行要求英文输出 |
| ⑤ | 模式默认值 | 默认**行动**模式（即现状）；模式选择按会话持久化到 localStorage（与 tier/ratio 同机制） |
| ⑥ | 位置锚点 | 方案中每张图的位置用 `block_index` 表达，编号与 T013 发布画布 `after_block_{n}` 完全一致（复用 `split_blocks`） |

## 4. 范围

### 4.1 后端（backend/）

**新表 `image_plans`**（`app/database.py`）

```sql
CREATE TABLE IF NOT EXISTS image_plans (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES image_generation_sessions(id),
    article_id TEXT,
    version_id TEXT,
    role TEXT NOT NULL,
    instructions TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('completed','failed')),
    result_json TEXT,          -- 成功：ImagePlanResult JSON；失败：NULL
    error_message TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL
);
```

- 每会话仅保留最近一条：重新编排时删除旧记录后插入（覆盖式）。
- Repository 方法：`save_image_plan(...)`（事务内 delete + insert）、`get_image_plan(session_id)`（无则返回 None）。

**提示词与 schema（`article_agent/prompts.py` + `article_agent/models.py`）**

- `DEFAULT_IMAGE_PLAN_ROLE`（默认角色，如「资深视觉编辑与插画艺术指导」）。
- `DEFAULT_IMAGE_PLAN_INSTRUCTIONS`（默认编排指令，用户可改），内含默认规则：
  - 数量按字数映射：<1500 字 2-3 张；1500-3000 字 3-5 张；3000-6000 字 5-7 张；>6000 字 7-9 张；
  - 选段按**五感描写、空间场景、动作场面、情绪反差**四项评分筛选「高视觉潜力」段落；
  - 所有提示词共享同一风格前缀（由 LLM 依据全文基调统一裁定）；
  - 输出默认中文。
- `IMAGE_PLAN_SYSTEM_PROMPT`：约束 LLM 仅输出符合 schema 的结构化方案。
- `models.py` 新增：

```python
class ImagePlanImage(BaseModel):
    block_index: int          # 插在第几个块之后（>=1，与 split_blocks 编号一致）
    position_hint: str        # 位置说明（如「第二章咖啡馆场景之后」）
    layout: Literal["landscape", "square", "portrait"]
    layout_reason: str        # 排版建议理由（含留白位置说明）
    prompt: str               # 绘画提示词

class ImagePlanResult(BaseModel):
    mood: str                 # 情绪基调
    style_summary: str        # 统一风格说明
    images: list[ImagePlanImage]
```

**新服务 `app/plan_service.py`**

- `generate_image_plan(registry, repository, *, session_id, article_id, version_id, role, instructions, provider, model) -> dict`：
  1. 解析文章与版本（复用 `resolve_version` 语义：`version_id` 空则取 `current_version_id`，无版本 → `PLAN_NO_CONTENT` 422）；
  2. 组装输入：全文 + 章节数（`split_sections`）+ 块编号清单（`split_blocks`，含 index/kind/preview）+ 字数（后端计算 `len(content)`，不信任 LLM 计数）；
  3. role/instructions 为空时用默认值；
  4. 调 `registry.get_chat_model(provider, model).with_structured_output(ImagePlanResult)`；
  5. 校验：`block_index` clamp 到 [1, 块总数]、按 `block_index` 去重（保留首个）、`images` 为空 → `PLAN_EMPTY`；
  6. 持久化并返回结果。
- 错误码：`PLAN_NO_CONTENT`(422)、`PLAN_LLM_ERROR`(502，脱敏透传)、`PLAN_TIMEOUT`(504)、`PLAN_EMPTY`(502)、`PLAN_LLM_NOT_CONFIGURED`(422，模型未注册时)。

**接口（`app/main.py`）**

| 接口 | 说明 |
|---|---|
| `GET /api/image-plan/defaults` | 返回 `{role, instructions, models: [{provider, model}], default_model: {provider, model}}`；`models` 来自 `registry.list_models()`（LLM 列表），`default_model` 取 `settings.default_llm_provider` 首个可用项 |
| `POST /api/image-sessions/{session_id}/image-plan` | 入参 `{article_id, version_id?, role?, instructions?, provider, model}`；`asyncio.wait_for` 120s → `PLAN_TIMEOUT`；返回 `{plan: ImagePlanResult, article_title, version_id, word_count, section_count, block_count}` |
| `GET /api/image-sessions/{session_id}/image-plan` | 最近一条方案（同 POST 响应结构，含 word_count 等统计）；无记录返回 `{plan: null}` |

- 会话不存在 → 现有 NotFoundError 404。
- `PLAN_*` 错误统一走 `PublishError` 风格的 exception handler（新增映射，或抽公共 PlanError——实现时取更简方案）。

### 4.2 前端（frontend/）

**`src/api/types.ts` + `src/api/imagePlan.ts`（新）**

- 类型：`ImagePlanImage` / `ImagePlanResult` / `ImagePlanDefaults` / `ImagePlanResponse`。
- API：`imagePlanApi.getDefaults()` / `generate(sessionId, payload)` / `getLatest(sessionId)`。

**`src/pages/ImageWorkspacePage.tsx`**

- `composer-actions` 中、`ImageParamsPopover` 左侧新增 antd `Segmented`（选项：计划 | 行动），默认行动；选择持久化 localStorage（key 复用 `features/image-workspace/params.ts` 的存储工具，新增 mode 字段）。
- 行动模式：现有 UI 完全不变。
- 计划模式：
  - 左栏切换为 `ImagePlanForm`；
  - 右栏切换为 `ImagePlanResults`；
  - 隐藏 `ImageParamsPopover`（条件渲染）；
  - 生图运行中（`running`）禁止切到计划模式（反之亦然：计划请求 pending 时模式切换禁用）。

**新组件 `src/features/image-workspace/ImagePlanForm.tsx`**

- 文章 Select（`articlesApi.listArticles`，label 为文章标题；会话已关联 `article_id` 时预选）。
- 版本 Select（联动 `articlesApi.listVersions`，label `V{n} · 标题`，默认当前版本 `current_version_id`）。
- LLM 模型 Select（数据源 `imagePlanApi.getDefaults()`；**只显示模型名称**，不显示供应商——决策 ③）。
- 角色 Input.TextArea（默认值来自 defaults，可编辑）。
- 编排指令 Input.TextArea（默认值来自 defaults，可编辑，rows≈6）。
- 【一键编排】按钮：pending 时 loading + 禁用全部表单项。

**新组件 `src/features/image-workspace/ImagePlanResults.tsx`**

- 顶部统计条：文章标题 · 字数 · 章节数 · 情绪基调徽标 · 统一风格说明。
- 每张配图一张卡片：
  - 头部：`#序号 · position_hint · layout 标签`（横版 / 方图 / 竖版）；
  - 正文：prompt（等宽/预格式样式，可滚动）；
  - 尾部：layout_reason（排版建议）+ 【复制】按钮（`navigator.clipboard.writeText` + `document.execCommand('copy')` 兜底；成功后按钮短暂显示「已复制」）。
- 状态：空态引导（「选择文章版本，点击一键编排」）、错误 StatusBanner + 重试按钮、加载 Spin 覆盖。
- 恢复：进入计划模式时 `imagePlanApi.getLatest(sessionId)` 有结果则直接渲染（角色/指令输入框同步回填为该次方案使用的值）。

**样式（`src/styles/global.css`）**

- 新增：计划表单布局（两栏 label + 控件纵向排列）、结果卡片、统计条、复制按钮态、prompt 预格式块。
- 不改动行动模式现有样式。

### 4.3 fake 模式（`backend/scripts/dev_fake_server.py`）

- `_ScriptedStructuredModel` 按 schema 类型识别 `ImagePlanResult` 请求，返回罐头方案：
  - mood「温暖治愈」、style_summary 一句统一风格；
  - 2-3 张图，`block_index` 取 1/2、layout 覆盖三种取值、prompt 带编号便于 E2E 断言；
- 沿用 `触发失败` 关键字：最新用户输入（instructions 含该词）时抛错，走 `PLAN_LLM_ERROR` 路径。

### 4.4 测试

- **pytest**（`backend/tests/test_plan_service.py` 新 + `test_api.py` 扩展）：
  - 服务层：块编号 clamp/去重、空 images → PLAN_EMPTY、默认 role/instructions 回填、字数后端计算；
  - 接口契约：defaults 返回结构（含 models 列表）、POST 成功（monkeypatch LLM stub）、404 会话、PLAN_LLM_NOT_CONFIGURED、PLAN_NO_CONTENT、超时映射；
  - 持久化：POST 后 GET 恢复、重新编排覆盖旧记录。
- **Vitest**（`ImageWorkspacePage.test.tsx` 新或扩展）：
  - 默认行动模式；切到计划模式后图片参数按钮消失；
  - 计划表单渲染（文章/版本/模型/角色/指令）+ defaults 回填；
  - 一键编排 → POST 参数正确（含所选 provider/model）；
  - 结果卡片渲染 + 复制（mock clipboard）；
  - 刷新恢复（getLatest 有数据时渲染结果）；
  - 失败 → 错误 Banner + 重试。
- **E2E**（`e2e/image-assets.spec.ts` 扩展）：
  - 进入配图工作台 → 切「计划」→ 选文章版本 → 一键编排 → 结果卡片与复制按钮断言；
  - fake 罐头方案的 mood/prompt 文案断言。
- **文档**：`docs/prd/prd.md`（新增 FR-I5 配图计划 + FR-I 系列同步）、`docs/tech/tech-design.md`（image_plans 表 + 三接口 + LLM 编排链路）、`README.md`（计划模式使用指南）、本任务文档状态同步。

### 4.5 不实现

- 「一键应用到发布配图」（方案 block_index → 发布 placements 的自动转换）——锚点已对齐，留作后续任务。
- 方案结果导出文件 / 全量复制。
- 计划结果的流式输出与取消（同步接口，决策 ①）。
- 除文章版本外的自由文本输入源（仅支持关联文章版本，Out-of-Scope 已排除非中文）。
- `prototype/` 目录任何改动。

## 5. 测试

- 后端：pytest 全量通过（新增 plan 服务/契约/持久化用例）。
- 前端：Vitest 全量通过；`pnpm exec eslint .` 零错误；`tsc --noEmit` / `pnpm build` 成功。
- Playwright E2E 全量通过（image-assets 扩展用例 + 现有回归）。
- 手动冒烟：真实 LLM 编排一篇长文，核对数量映射与风格统一性（操作步骤见 `docs/ops/manual-tasks-t015.md`，待人工执行后回填结论）。

## 6. 验收标准

- [x] 模式切换：默认「行动」；「计划/行动」Segmented 位于图片参数按钮左侧；计划模式下图片参数按钮隐藏（决策 ⑤）。
- [x] 计划表单：文章 → 版本联动；LLM 模型选择器只显示模型名称（决策 ③）；角色/指令有默认值且可编辑（决策 ④）。
- [x] 一键编排：loading 覆盖；结果含统计条（字数/章节/情绪基调/风格）与配图卡片（位置说明/排版建议/提示词）。
- [x] 每条提示词可复制，复制成功有反馈；复制内容与卡片展示一致。
- [x] 方案入库：刷新/重进自动恢复最近一条（决策 ②）；重新编排覆盖旧记录。
- [x] block_index 与 T013 `after_block_{n}` 编号一致（复用 split_blocks）（决策 ⑥）。
- [x] 超时（120s）/ LLM 失败 / 无版本 / 模型未配置有明确错误码与 UI 提示。
- [x] 行动模式现有功能与样式零回归（含 Vitest/E2E 现有用例）。
- [x] pytest / Vitest / ESLint / tsc / build / Playwright E2E 全量通过（pytest 121、Vitest 77、E2E 15 全绿）。
- [x] PRD、tech-design、README 同步更新；`prototype/` 未改动。

## 7. 完成定义

- 上述验收标准全部勾选。
- 所有变更经全量回归（pytest / Vitest / ESLint / tsc / build / Playwright E2E）验证通过。
- 文档（PRD / tech-design / README / 本任务文档）与实现一致。
- 真实 LLM 冒烟事项（若有）记录到 `docs/ops/` 对应手册。
