from __future__ import annotations

from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from article_agent.models import ImagePlanResult
from article_agent.prompts import (
    DEFAULT_IMAGE_PLAN_INSTRUCTIONS,
    DEFAULT_IMAGE_PLAN_ROLE,
    IMAGE_PLAN_SYSTEM_PROMPT,
)
from article_agent.registry import ModelRegistry

from .database import Repository
from .publish_service import split_blocks, split_sections
from .security import redact_sensitive


class PlanError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _build_plan_messages(
    *,
    content: str,
    word_count: int,
    section_count: int,
    blocks: list[dict[str, Any]],
    role: str,
    instructions: str,
) -> list[Any]:
    block_lines = [
        f"{block['index']}. [{block['kind']}] {block['preview']}" for block in blocks
    ]
    user_content = (
        f"【角色设定】\n{role}\n\n"
        f"【编排指令】\n{instructions}\n\n"
        f"【文章统计】总字数：{word_count}；章节数：{section_count}；块总数：{len(blocks)}\n\n"
        "【编号块清单】（block_index 与此编号一致）\n"
        + "\n".join(block_lines)
        + f"\n\n【文章全文】\n{content}"
    )
    return [
        SystemMessage(content=IMAGE_PLAN_SYSTEM_PROMPT),
        HumanMessage(content=user_content),
    ]


def _sanitize_images(
    images: list[Any], block_count: int
) -> list[Any]:
    """block_index clamp 到 [1, block_count] 并按位置去重（保留首个）。"""
    seen: set[int] = set()
    result = []
    for image in images:
        index = min(max(image.block_index, 1), max(block_count, 1))
        if index in seen:
            continue
        seen.add(index)
        result.append(image.model_copy(update={"block_index": index}))
    return result


async def generate_image_plan(
    *,
    registry: ModelRegistry,
    repository: Repository,
    session_id: str,
    article_id: str,
    version_id: str | None,
    role: str | None,
    instructions: str | None,
    provider: str,
    model: str,
    secret_values: list[str] | None = None,
) -> dict[str, Any]:
    """编排文章配图提示词：LLM 结构化输出 + 校验 + 覆盖式持久化。

    返回完整响应载荷（含 plan 与统计），GET 接口原样回放（决策 ②）。
    """
    repository.get_image_session(session_id)  # 不存在 → NotFoundError 404
    article = repository.get_article(article_id)
    resolved_version_id = version_id or article.get("current_version_id")
    if not resolved_version_id:
        raise PlanError("PLAN_NO_CONTENT", "该文章尚无可用版本，请先生成文章内容。")
    version = repository.get_version(article_id, resolved_version_id)

    content = version["content_markdown"]
    word_count = len("".join(content.split()))
    sections = split_sections(content)
    blocks = split_blocks(content)
    if not blocks:
        raise PlanError("PLAN_NO_CONTENT", "文章内容为空，无法编排配图。")

    resolved_role = (role or "").strip() or DEFAULT_IMAGE_PLAN_ROLE
    resolved_instructions = (instructions or "").strip() or DEFAULT_IMAGE_PLAN_INSTRUCTIONS

    try:
        chat_model = registry.get_chat_model(provider, model)
    except ValueError as exc:
        raise PlanError("PLAN_LLM_NOT_CONFIGURED", f"模型不可用：{exc}") from exc

    messages = _build_plan_messages(
        content=content,
        word_count=word_count,
        section_count=len(sections),
        blocks=blocks,
        role=resolved_role,
        instructions=resolved_instructions,
    )
    try:
        # 默认 function_calling：完整 Pydantic schema（字段名/必填/layout 枚举）作为
        # tool 定义传给模型，强制按 schema 输出（json_mode 不传 schema，模型会自造
        # 字段名，见 docs/issue/ISSUE-002-image-plan-structured-output-schema-mismatch.md）
        structured = chat_model.with_structured_output(ImagePlanResult)
        result: ImagePlanResult = await structured.ainvoke(messages)
    except Exception as exc:
        detail = redact_sensitive(exc, secret_values or [])
        message = f"配图编排失败：{detail}"
        if "length limit was reached" in str(exc):
            # 输出 token 上限截断：推理模型思考也消耗预算，见
            # docs/issue/ISSUE-003-image-plan-output-truncated.md
            try:
                limit = registry.get_capabilities(provider, model).max_output_tokens
                current = f"（当前 {limit}）"
            except ValueError:
                current = ""
            message = (
                "配图编排失败：模型输出达到长度上限被截断"
                f"{current}。推理模型的思考过程也消耗输出 token，"
                "请在 backend/.env 调大 LLM_MAX_OUTPUT_TOKENS 后重启后端重试。"
            )
        raise PlanError("PLAN_LLM_ERROR", message) from exc

    result = result.model_copy(
        update={"images": _sanitize_images(result.images, len(blocks))}
    )
    if not result.images:
        raise PlanError("PLAN_EMPTY", "未生成任何配图提示词，请调整编排指令后重试。")

    payload = {
        "plan": result.model_dump(),
        "article_title": version["title"] or article["title"],
        "article_id": article_id,
        "version_id": resolved_version_id,
        "word_count": word_count,
        "section_count": len(sections),
        "block_count": len(blocks),
        "role": resolved_role,
        "instructions": resolved_instructions,
        "provider": provider,
        "model": model,
    }
    repository.save_image_plan(
        session_id,
        article_id=article_id,
        version_id=resolved_version_id,
        role=resolved_role,
        instructions=resolved_instructions,
        result=payload,
        provider=provider,
        model=model,
    )
    return payload
