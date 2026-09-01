# ISSUE-003：真实 LLM 配图编排失败（输出长度超限被截断）

## 1. 缺陷信息

| 项 | 内容 |
| --- | --- |
| 编号 | ISSUE-003 |
| 发现日期 | 2026-08-25 |
| 状态 | 已修复并回归通过（真实 LLM 复验待人工执行） |
| 严重级别 | 高（真实 LLM 计划模式完全不可用） |
| 影响范围 | 配图工作台「计划」模式一键编排（真实 LLM，推理模型）；fake 模式不受影响 |
| 发现场景 | ISSUE-002 修复后人工复验（`docs/ops/manual-tasks-t015.md` §1）：一键编排 → 失败 Banner |
| 关联任务 | T015（`docs/task/T015-image-plan-mode.md`）；前置缺陷 ISSUE-002 |

## 2. 现象

ISSUE-002 修复（function_calling + SystemPrompt 显式 schema）后，一键编排仍报错：

> 配图编排失败：Could not parse response content as the length limit was reached - CompletionUsage(completion_tokens=4096, prompt_tokens=1703, total_tokens=5799, completion_tokens_details=CompletionTokensDetails(accepted_prediction_tokens=None, audio_tokens=None, **reasoning_tokens=4095**, rejected_prediction_tokens=None, prompt_tokens_details=None))

关键线索：`completion_tokens=4096` 恰好等于配置的输出上限，其中 `reasoning_tokens=4095`——推理模型把输出预算几乎全部花在思考上，正文内容 token 为 0，响应被截断导致结构化输出解析失败。

## 3. 排查过程与根因

1. `reasoning_tokens=4095` ≈ `completion_tokens=4096`：输出内容本身不是过长，而是「思考」占满了预算。所用模型 `deepseek-v4-flash` 为推理模型，思考 token 计入 `max_tokens` 输出预算。
2. `max_tokens` 来源：`article_agent/registry.py` 注册 `ChatDeepSeek` 时传入 `max_tokens=settings.llm_max_output_tokens`。
3. `llm_max_output_tokens` 默认值 4096（`article_agent/config.py`），`.env` 未覆盖时即为 4096。
4. 配图方案（含 mood / style_summary / 每张图的完整 prompt，通常 3–5 张）加上推理思考，4096 token 明显不够。

**根因**：`LLM_MAX_OUTPUT_TOKENS` 默认值 4096 对「推理模型 + 结构化多字段输出」场景过小，思考阶段即耗尽预算，输出被截断解析失败。

测试未拦截的原因：fake 模型（`tests/fakes.py`、`scripts/dev_fake_server.py`）直接返回构造好的 Pydantic 对象，不存在真实 API 的 `max_tokens` 截断行为。

## 4. 修复方案（2026-08-25 与用户对齐）

### 4.1 调大输出 token 上限（主修复）

| 文件 | 改动 |
| --- | --- |
| `backend/article_agent/config.py` | `llm_max_output_tokens` 默认值 `4096` → `16384` |
| `backend/.env` | `LLM_MAX_OUTPUT_TOKENS=16384` |

> DeepSeek / Moonshot 的 context window（100 万 / 25.6 万）远大于 16384，调大无风险。

### 4.2 错误提示优化（可诊断性）

`app/plan_service.py` 异常处理识别「length limit was reached」类截断错误，错误信息中明确给出调参指引（含当前上限值），而不是透传底层晦涩的 CompletionUsage 结构：

> 配图编排失败：模型输出达到长度上限被截断（当前 4096）。推理模型的思考过程也消耗输出 token，请在 backend/.env 调大 LLM_MAX_OUTPUT_TOKENS 后重启后端重试。

## 5. 验证结果

- pytest 全量回归：通过（新增截断错误提示用例）。
- 真实 LLM 一键编排复验：待人工执行（步骤见 `docs/ops/manual-tasks-t015.md` §1），通过后回填此处。

## 6. 经验与约定

1. **推理模型的 `max_tokens` 预算含思考 token**：DeepSeek 等 reasoning 模型的 `reasoning_tokens` 计入输出预算，配置输出上限时需为思考过程预留充足余量（建议 ≥ 4 倍预期正文长度）。
2. **截断类错误要可自诊断**：透传 `CompletionUsage` 原文对用户无意义；识别截断特征后给出「调哪个参数、怎么调」的指引，用户可自助解决。
3. **`completion_tokens` == `max_tokens` 即截断铁证**：排查 LLM「输出为空/解析失败」问题时，先比对这两个值，再决定是调参还是改提示词。
