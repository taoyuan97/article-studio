# ISSUE-002：真实 LLM 配图编排失败（结构化输出字段不符 schema）

## 1. 缺陷信息

| 项 | 内容 |
| --- | --- |
| 编号 | ISSUE-002 |
| 发现日期 | 2026-08-25 |
| 状态 | 已修复并回归通过（真实 LLM 复验待人工执行） |
| 严重级别 | 高（真实 LLM 计划模式完全不可用） |
| 影响范围 | 配图工作台「计划」模式一键编排（真实 LLM）；fake 模式（罐头方案）与 pytest/E2E 不受影响 |
| 发现场景 | T015 交付后人工冒烟（`docs/ops/manual-tasks-t015.md` §1）：选择已生成文章版本 → 一键编排 → 失败 Banner |
| 关联任务 | T015（`docs/task/T015-image-plan-mode.md`） |

## 2. 现象

计划模式「一键编排」报错：

> 配图编排失败：Failed to parse ImagePlanResult from completion {"style_prefix": "柔和水彩插画，奶油色与灰蓝色调，自然漫射光，留白构图，纸张纹理质感。", "images": [{"block_index": 5, "prompt": "…", "layout": "portrait", "layout_reason": "…"}, …]}

LLM 返回了合法 JSON，但字段与 `ImagePlanResult` schema 不符，LangChain 解析失败 → `PLAN_LLM_ERROR`(502)。

## 3. 排查过程与根因

对比 LLM 实际输出与 schema（`article_agent/models.py`），三处不匹配：

| Schema 要求 | LLM 实际输出 |
| --- | --- |
| `mood`（必填，情绪基调） | 缺失 |
| `style_summary`（必填，统一风格说明） | 输出自造字段 `style_prefix` |
| 每个 image 的 `position_hint`（必填，位置说明） | 全部缺失 |

**根因**：`app/plan_service.py` 的结构化输出调用使用了 `method="json_mode"`：

```python
structured = chat_model.with_structured_output(
    ImagePlanResult, method="json_mode"
)
```

LangChain 的 `json_mode` 仅开启模型 JSON 输出格式，**不把 Pydantic schema 传给模型**——模型只能从提示词文字中获知字段结构。而 `IMAGE_PLAN_SYSTEM_PROMPT` 只有一句「仅输出符合给定 schema 的 JSON 对象」，该「给定 schema」从未出现在任何 LLM 可见位置。模型只能从编排指令文字猜字段名（指令第 3 条写了「风格前缀」，故猜出 `style_prefix`），`mood`、`position_hint` 则完全无信息来源。

测试未拦截的原因：`FakeChatModel.with_structured_output(schema, **kwargs)`（`tests/fakes.py`）与 fake server 的 `ScriptedFakeChatModel` 均忽略 `method` 参数、直接返回构造好的 Pydantic 对象，真实链路的「模型自由生成字段名」环节在 fake 下不存在。

## 4. 修复方案（A + B 组合，2026-08-25 与用户对齐）

### 4.1 方案 A：改用默认 function_calling（主修复）

`with_structured_output(ImagePlanResult)` 不传 `method`——LangChain 将完整 Pydantic schema（字段名、必填约束、`layout` 枚举值）作为 tool 定义传给模型，强制按 schema 输出。真实模型为 `ChatOpenAI`（`article_agent/registry.py`），DeepSeek / Moonshot 的 OpenAI 兼容端点均支持 tools。

### 4.2 方案 B：SystemPrompt 显式列出 JSON 结构（双保险）

`IMAGE_PLAN_SYSTEM_PROMPT` 中显式写出完整字段结构（mood / style_summary / images[].block_index、position_hint、layout 枚举、layout_reason、prompt）。即便个别环境 tool call 退化，字段名也有明确锚点；对 function_calling 无副作用。

| 文件 | 改动 |
| --- | --- |
| `backend/app/plan_service.py` | `with_structured_output` 调用去掉 `method="json_mode"` |
| `backend/article_agent/prompts.py` | `IMAGE_PLAN_SYSTEM_PROMPT` 显式列出 JSON 字段结构与枚举取值 |

> 兼容性已核实：pytest（`tests/fakes.py`、`scripts/dev_fake_server.py`）的 fake 模型 `with_structured_output(schema, **kwargs)` 忽略 method 参数，行为不变。

## 5. 验证结果

- pytest 全量回归：**121 passed**（`plan_service` 契约/错误路径/持久化用例全部通过，fake 模型 `with_structured_output(schema, **kwargs)` 忽略 method 参数，行为不受影响）。
- 真实 LLM 一键编排复验：待人工执行（步骤见 `docs/ops/manual-tasks-t015.md` §1），通过后回填此处。

## 6. 经验与约定

1. **`with_structured_output` 的 `json_mode` 不传 schema**：只约束「是 JSON」，不约束「字段是什么」；凡依赖 Pydantic schema 解析的调用，用默认 function_calling（或确保提示词中显式给出字段结构）。
2. **提示词中不得引用「未提供的东西」**：SystemPrompt 里「符合给定 schema」这类表述，前提是 schema 确实出现在模型可见输入中，否则等于让模型盲猜。
3. **fake 模型无法覆盖「模型自由生成字段名」**：结构化输出链路的 fake 直接返回构造好的对象时，应在冒烟手册（`docs/ops/`）中保留真实 LLM 验收项作为最后防线。
