# 人工配置与操作手册（T015：配图计划线）

> 适用范围：配图工作台「计划/行动」双模式（T015）完成后，需要人工完成或协助的事项。
> 环境前提：同 `manual-setup.md`；后端依赖已安装（`backend/.venv`），`backend/.env` 已配置至少一家 LLM key（DeepSeek 或 Moonshot）。
> 开发/测试环境用假模型服务器（`scripts/dev_fake_server.py`）即可全流程演练（罐头方案 + 「触发失败」错误注入），本文档仅针对**真实 LLM 冒烟**。

## 1. 真实 LLM 编排冒烟（一次性人工验收）

fake 模式 E2E 已覆盖交互链路；以下质量项依赖真实 LLM 输出，需人工核对一次：

1. `cd backend; uv run uvicorn app.main:app --port 8000`（真实后端，`.env` 含 LLM key），前端 `cd frontend; pnpm dev`。
2. 素材库 →「新建配图」→ 顶部切「计划」→ 选择一篇 **1500 字以上** 的已生成文章版本 → 角色设定/编排指令保持默认 → 点「一键编排」。
3. 核对结果质量（对齐默认编排指令中的规则）：
   - **数量映射**：1500–3000 字应产出 3–5 张配图（其他档位见 `article_agent/prompts.py` 的 `DEFAULT_IMAGE_PLAN_INSTRUCTIONS`）；
   - **风格统一**：所有提示词共享同一风格前缀，与统计条「情绪基调/统一风格说明」一致；
   - **位置合理**：`block_index` 分布在开篇/中段/结语，`position_hint` 与该块内容对应；
   - **默认中文**：提示词为中文（除非指令中另行要求）。
4. 抽 1–2 条提示词复制到生图工具（通义万相 / 即梦）验证可直接出图。
5. 大模型典型耗时 20–60s；若超过 120s 由后端 `PLAN_TIMEOUT` 兜底，前端展示错误 Banner 可重试（无需人工处理）。

### 排查：一键编排报「输出达到长度上限被截断」

推理模型（如 `deepseek-v4-flash`）的思考 token 计入 `max_tokens` 输出预算，上限过小会导致输出被截断、结构化解析失败（详见 `docs/issue/ISSUE-003-image-plan-output-truncated.md`）：

1. 确认错误信息包含「模型输出达到长度上限被截断（当前 N）」。
2. 编辑 `backend/.env`，调大 `LLM_MAX_OUTPUT_TOKENS`（建议 ≥ 16384；错误信息中的「当前 N」即为生效值）。
3. 重启后端（`uvicorn` 进程）后重试一键编排。
4. 若仍截断，继续翻倍调大；DeepSeek / Moonshot 的 context window（100 万 / 25.6 万）远大于该值，无溢出风险。

> 冒烟结论（数量映射 / 风格统一 / 位置合理性）请回填至 `docs/task/T015-image-plan-mode.md` §5。
