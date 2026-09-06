# T019：DeepSeek 配图编排兼容思考模式

## 1. 任务信息

- 状态：已完成（人工验收通过，2026-09-06）
- 优先级：P0
- 类型：缺陷修复 / LLM 结构化输出兼容
- 前置任务：T015（配图计划模式）、ISSUE-002（结构化输出 schema）、ISSUE-003（推理模型输出上限）
- 后续任务：无
- 目标目录：`backend/article_agent/`、`backend/app/`、`backend/tests/`、`docs/tech/`
- 创建日期：2026-09-06
- 需求来源：配图工作台计划模式选择 DeepSeek 时，一键编排返回 `Thinking mode does not support this tool_choice`
- 关联入口：`frontend/src/pages/ImageWorkspacePage.tsx`

## 2. 问题现象与影响

在配图工作台进入“计划”模式，选择 DeepSeek 模型并执行“一键编排”，页面显示：

> 配图编排失败：Error code: 400 - {'error': {'message': 'Thinking mode does not support this tool_choice', 'type': 'invalid_request_error', 'param': None, 'code': 'invalid_request_error'}}

影响范围：

- 使用 `deepseek-v4-flash` 等默认开启 thinking mode 的 DeepSeek V4 模型时，配图编排完全不可用。
- Moonshot 配图编排不受本错误影响。
- 配图工作台“行动”模式的图片生成链路不受影响。
- 前端只是提交用户选择的 `provider` / `model` 并展示 API 错误，不是本缺陷根因。

## 3. 根因分析

当前调用链：

```text
ImageWorkspacePage
  -> POST /api/image-sessions/{session_id}/image-plan
  -> app.plan_service.generate_image_plan()
  -> ModelRegistry.get_chat_model()
  -> ChatDeepSeek.with_structured_output(ImagePlanResult)
```

`backend/app/plan_service.py` 调用 `with_structured_output(ImagePlanResult)` 时未指定 `method`。项目当前锁定的 `langchain-deepseek 0.1.4` 默认采用 `function_calling`，实际绑定参数包含：

```python
{
    "tools": [ImagePlanResult 的 function schema],
    "tool_choice": {
        "type": "function",
        "function": {"name": "ImagePlanResult"},
    },
    "parallel_tool_calls": False,
}
```

当前运行配置使用 `deepseek-v4-flash`，该模型默认开启 thinking mode。DeepSeek 官方文档说明 thinking mode 支持 Tool Calls，但官方示例只传入 `tools`，没有传入强制 `tool_choice`；当前真实接口拒绝 LangChain 自动生成的上述“指定具体函数”式 `tool_choice`，请求在模型生成前即返回 HTTP 400。异常随后被服务层包装为 `PLAN_LLM_ERROR`，由前端错误 Banner 展示。

因此，本缺陷不能概括为“thinking mode 不支持工具调用”，准确根因是当前 DeepSeek thinking 接口与 LangChain `with_structured_output(function_calling)` 生成的强制 `tool_choice` 不兼容。DeepSeek Chat Completions 通用 API 虽列出了多种 `tool_choice` 形式，但 thinking 指南未承诺所有形式均可用，且实际 400 是当前运行环境的直接证据。

这不是输出 token 不足问题，也不能通过继续调大 `LLM_MAX_OUTPUT_TOKENS` 解决。

## 4. 已确认决策（2026-09-06）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | DeepSeek 结构化输出策略 | 使用 `json_mode`，保留 thinking mode |
| D2 | Provider 差异归属 | 封装在 `ModelRegistry`，业务服务不直接判断 `provider == "deepseek"` |
| D3 | 自动降级 | 首版不自动降级；解析或校验失败时明确返回错误，不做第二次模型调用 |
| D4 | 真实模型验证 | 自动化测试通过后执行一次真实 DeepSeek 冒烟；允许发送测试文章内容并产生少量 API 费用 |
| D5 | Moonshot 策略 | 继续使用 `function_calling`，不改变现有行为 |
| D6 | 前端范围 | 不修改 `ImageWorkspacePage.tsx` 及前端 API 契约 |
| D7 | Thinking 开关 | 依赖 DeepSeek V4 官方约定的默认 `thinking=enabled`，本任务不额外传 `extra_body` |
| D8 | JSON 提示词 | 将现有完整 JSON 结构明确标记为“JSON 格式示例”，不改变字段语义 |
| D9 | 空响应 | DeepSeek 返回空 `content` 时给出明确中文错误，保持 `PLAN_LLM_ERROR` / HTTP 502，不自动重试 |
| D10 | 编码前协议探测 | 使用非敏感短输入调用真实 DeepSeek，最多 5 次；确认 `json_mode + thinking` 可用后才开始编码 |

## 5. 修复范围与设计

### 5.1 Registry 统一结构化输出策略

在 `ModelRegistry` 中集中表达不同 Provider 的结构化输出能力，建议：

1. 为 `ModelCapabilities` 增加结构化输出方式，例如 `structured_output_method`，默认值为 `function_calling`。
2. 注册 DeepSeek 时设置为 `json_mode`；注册 Moonshot 时保持 `function_calling`。
3. 增加统一入口，例如：

```python
registry.get_structured_chat_model(provider, model, schema)
```

该入口负责：

- 校验模型是否注册以及是否支持结构化输出；
- 读取 Provider 对应的结构化输出方式；
- 调用 `chat_model.with_structured_output(schema, method=...)`；
- 返回可直接 `ainvoke()` 的结构化模型 Runnable。

业务层不得自行拼接 DeepSeek 专用的 `thinking`、`tools` 或 `tool_choice` 参数。

### 5.2 配图编排服务改造

`generate_image_plan()` 改为通过 Registry 的统一入口取得结构化模型：

- DeepSeek 最终调用 `with_structured_output(ImagePlanResult, method="json_mode")`。
- Moonshot 最终调用 `with_structured_output(ImagePlanResult, method="function_calling")`。
- 保留 `ImagePlanResult` 的 Pydantic 解析与校验。
- 保留 `_sanitize_images()`、空图片判断、覆盖式持久化和现有错误码。

使用 `json_mode` 后，DeepSeek 请求不得携带用于结构化结果的 `tools` / 强制 `tool_choice`，thinking mode保持启用。

本任务依赖 DeepSeek V4 当前默认开启 thinking mode，不显式注入 `extra_body={"thinking": {"type": "enabled"}}`。Registry 只管理结构化输出方式，不把任务级 thinking 偏好扩展为通用 capability。

### 5.3 Schema 约束与历史问题兼容

历史 ISSUE-002 曾因 `json_mode` 不向模型传递 Pydantic schema，导致模型自造字段名。当前 `IMAGE_PLAN_SYSTEM_PROMPT` 已显式列出完整 JSON 结构；本任务将其标题或引导语进一步明确为“JSON 格式示例”，包括：

- `mood`
- `style_summary`
- `images[].block_index`
- `images[].position_hint`
- `images[].layout` 及枚举值
- `images[].layout_reason`
- `images[].prompt`

本任务必须保留这些显式字段约束，并继续用 `ImagePlanResult` 对结果做严格解析。不得仅调用普通 `ainvoke()` 后直接信任未经校验的字典。

### 5.4 错误与重试语义

- JSON 语法错误、字段缺失、类型错误或枚举错误统一走现有 `PLAN_LLM_ERROR` 路径。
- DeepSeek 空 `content` 单独转为“DeepSeek 返回了空的 JSON 内容，请手动重试”等明确中文提示，错误码仍为 `PLAN_LLM_ERROR`。
- 错误信息继续经过敏感信息脱敏，并明确说明配图编排失败的原因。
- 失败结果不写入 `image_plans`，原有最近一次成功方案不被覆盖。
- 不因解析失败自动关闭 thinking 后重试，也不自动切换 Moonshot。
- HTTP 层仍将 `PLAN_LLM_ERROR` 映射为 502；底层 DeepSeek 400 不直接改变对前端的 API 契约。

## 6. 非目标

- 不修改计划模式页面布局、模型选择器或请求载荷。
- 不关闭 DeepSeek 的全局 thinking mode。
- 不调整 `LLM_MAX_OUTPUT_TOKENS`、context window、超时或重试次数。
- 不升级 LangChain、LangGraph、`langchain-deepseek` 或 OpenAI SDK 主版本。
- 不为本缺陷增加自动 Provider 切换、自动降级或双请求兜底。
- 不修改文章意图识别等其他现有 `json_mode` 调用。
- 不改造通用 Agent 工具调用循环或处理多轮 `reasoning_content` 回传问题。
- 不在本任务引入 DeepSeek strict Tool Calls、Beta Base URL 或手写工具调用解析器。

## 7. 实施步骤

1. 文档门禁：先完成第 8.4 节的真实 DeepSeek 协议探测；只有 `json_mode + thinking` 通过才继续实施，最多发起 5 次请求。
2. 扩展 `ModelCapabilities`，记录结构化输出方式。
3. 在 `ModelRegistry.from_settings()` 中配置 DeepSeek / Moonshot 的对应策略。
4. 在 `ModelRegistry` 增加统一的结构化模型获取入口及必要校验。
5. 修改 `plan_service.generate_image_plan()`，移除直接调用 `chat_model.with_structured_output()` 的逻辑，并补充空响应错误映射。
6. 将 `IMAGE_PLAN_SYSTEM_PROMPT` 的现有结构明确标记为“JSON 格式示例”。
7. 增强 fake模型，使测试可以记录 `schema`、`method` 等结构化输出参数。
8. 增加 Registry 单元测试和配图计划服务回归测试。
9. 更新与配图编排结构化输出方式冲突的技术设计和历史说明；历史 issue 保留原始背景，并注明当前兼容策略已变化。
10. 执行后端全量测试和前端相关回归。
11. 使用非敏感测试文章执行一次真实 DeepSeek V4 配图编排冒烟并记录结果。

## 8. 测试要求

### 8.1 Registry 单元测试

- DeepSeek 注册后的结构化输出方式为 `json_mode`。
- Moonshot 注册后的结构化输出方式为 `function_calling`。
- `get_structured_chat_model()` 向底层模型传递正确的 schema 和 method。
- 未注册模型继续抛出清晰的 `ValueError`。
- 声明不支持结构化输出的模型被拒绝，不静默回退。

### 8.2 配图计划服务与 API

- DeepSeek编排调用记录中 `method == "json_mode"`。
- 合法 `ImagePlanResult` 正常返回并持久化。
- JSON解析或 Pydantic校验异常返回 `PLAN_LLM_ERROR` / HTTP 502。
- DeepSeek 空 `content` 返回明确中文错误，不泄露底层异常结构。
- 解析失败时不触发第二次模型调用。
- 解析失败时不写入失败方案，不覆盖已有成功方案。
- 原有 block index clamp、去重、空方案、无内容、模型未配置和输出截断提示测试继续通过。

### 8.3 前端与回归

```powershell
cd backend
uv run pytest -p no:cacheprovider

cd ..\frontend
pnpm test -- ImageWorkspacePage
pnpm lint
pnpm build
```

前端重点确认：

- 计划模式仍提交相同的 provider/model 请求。
- 成功方案正常展示。
- `PLAN_LLM_ERROR` 仍显示错误 Banner并允许用户手动重试。

### 8.4 编码前真实 DeepSeek 协议探测

协议探测使用非敏感、极短输入，总请求数最多 5 次，并记录每次的请求类型、HTTP 结果和非敏感响应摘要；不得记录 API Key、完整请求头或思维链正文。

必测项：

1. 使用当前 `with_structured_output(function_calling)` 的指定函数式 `tool_choice`，确认是否能稳定复现当前 400；若服务端行为已经变化，也应如实记录。
2. 使用 `with_structured_output(..., method="json_mode")`，不显式设置 thinking，验证能返回并解析为最小 Pydantic 对象。

仅当第 2 项成功且请求未携带用于结构化输出的 `tools` / `tool_choice` 时，协议门禁判定通过并继续编码。若遇到偶发空 `content`，可在 5 次总额度内复测 `json_mode`；若仍不能确认可用，停止编码并重新评审方案。

“tools 但不传 `tool_choice`”和 strict Beta 不是本任务必测项；只有前两项结果不足以解释行为时，才可在剩余额度内追加对照探测。

协议探测结果（2026-09-06，共 3 次真实 API 请求）：

| # | 请求 | 结果 |
|---|---|---|
| 1 | `function_calling`，LangChain 指定函数式 `tool_choice` | HTTP 400，稳定复现 `Thinking mode does not support this tool_choice` |
| 2 | `json_mode`，不显式设置 thinking | 成功，返回并解析为最小 `ImagePlanResult` |
| 3 | `json_mode` + `include_raw`，不显式设置 thinking | 成功；响应存在非空 `reasoning_content`，确认 thinking 实际启用 |

探测过程使用非敏感最小输入，未输出或记录 API Key、请求头及思维链正文。`json_mode + thinking` 协议门禁通过，可以继续编码。

### 8.5 编码后真实 DeepSeek 冒烟

使用专门准备的非敏感测试文章，选择当前配置的 `deepseek-v4-flash`，执行一次“一键编排”：

1. 请求不再出现 `Thinking mode does not support this tool_choice`。
2. 返回结果通过 `ImagePlanResult` 校验。
3. 页面展示 mood、style summary和至少一张配图方案。
4. 刷新页面后可恢复最近方案。
5. 记录模型、执行日期、结果和费用提示；日志中不得出现 API Key。

若真实冒烟失败，不得临时加入自动降级；应保留错误证据并重新评审策略。

验证结果（2026-09-06）：使用独立临时数据库和非敏感短文章，真实调用 `deepseek-v4-flash` 成功生成 2 张配图方案；结果通过 `ImagePlanResult` 校验，并能从 `image_plans` 完整恢复。临时脚本、数据库和文章已在验证后清理。

自动化结果：

- 后端定向测试：21 passed。
- 后端全量测试：140 passed。
- 前端 `ImageWorkspacePage`：6 passed。
- 前端 lint：通过。
- 前端生产构建：通过（仅保留既有的大 chunk 警告）。

## 9. 验收标准

- [x] DeepSeek V4 thinking mode下配图编排不再发送不兼容的强制 `tool_choice`。
- [x] DeepSeek使用 `json_mode` 且 thinking保持启用。
- [x] Moonshot继续使用 `function_calling`，现有行为无回归。
- [x] Provider差异封装在 `ModelRegistry`，`plan_service` 无 DeepSeek条件分支。
- [x] 输出继续通过 `ImagePlanResult` 严格校验。
- [x] 解析失败只调用模型一次，返回明确错误且不写入失败数据。
- [x] `ImageWorkspacePage.tsx` 及前端 API 契约无需修改。
- [x] 后端全量测试、前端相关测试、lint和 build全部通过。
- [x] 真实 DeepSeek冒烟通过，并记录验证结果。
- [x] 编码前协议探测不超过 5 次，门禁结果已记录且不包含密钥或思维链正文。
- [x] 技术文档与最终结构化输出策略一致。

## 10. 交付文件预估

修改：

- `backend/article_agent/registry.py`
- `backend/app/plan_service.py`
- `backend/tests/fakes.py`
- `backend/tests/test_config_registry.py`
- `backend/tests/test_plan_service.py`
- `docs/tech/tech-design.md`
- `docs/v1.0.0/issue/ISSUE-002-image-plan-structured-output-schema-mismatch.md`
- `docs/v1.0.0/issue/ISSUE-003-image-plan-output-truncated.md`（如最终说明涉及当前策略）

不修改：

- `frontend/src/pages/ImageWorkspacePage.tsx`
- `frontend/src/api/imagePlan.ts`

## 11. 完成定义

以上范围全部实现，自动化验证和真实 DeepSeek冒烟均通过，并经用户验收后，将任务状态更新为“已完成”并记录验收日期。若实现过程中需要关闭 thinking、增加自动降级、升级 LangChain依赖或改变前端契约，必须先暂停编码并重新向用户确认。
