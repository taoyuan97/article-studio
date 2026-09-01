from __future__ import annotations

import pytest
from langchain_core.messages import HumanMessage

from article_agent.budget import ContextBudgetExceeded, ContextBudgeter
from article_agent.models import ArticleBrief
from article_agent.registry import ModelCapabilities, conservative_token_estimate


def capabilities(context_window=1000, max_output=100):
    return ModelCapabilities(
        context_window=context_window,
        max_output_tokens=max_output,
        supports_streaming=True,
        supports_structured_output=True,
        token_estimator=conservative_token_estimate,
    )


async def test_long_history_is_summarized_then_truncated():
    messages = [
        HumanMessage(content=f"第 {index} 条历史 " + "内容" * 40, id=f"m{index}")
        for index in range(20)
    ]
    summarized = []

    async def summarizer(items):
        summarized.extend(items)
        return "此前讨论了文章主题和语气。"

    result = await ContextBudgeter(0.8, recent_message_limit=4).build(
        capabilities=capabilities(),
        system_prompt="系统规则",
        latest_instruction="现在生成",
        brief=ArticleBrief(topic="测试"),
        history=messages,
        summarizer=summarizer,
    )
    assert len(summarized) == 16
    assert result.summary_until_message_id == "m15"
    assert result.estimated_input_tokens + 100 <= result.limit
    assert len(result.messages) < len(messages) + 3


async def test_irrelevant_failed_messages_are_excluded():
    history = [
        HumanMessage(content="secret irrelevant", additional_kwargs={"relevant": False}),
        HumanMessage(content="failed", additional_kwargs={"status": "failed"}),
        HumanMessage(content="useful"),
    ]
    result = await ContextBudgeter().build(
        capabilities=capabilities(2000),
        system_prompt="rules",
        latest_instruction="go",
        brief=ArticleBrief(topic="x"),
        history=history,
    )
    text = "\n".join(str(message.content) for message in result.messages)
    assert "useful" in text
    assert "secret irrelevant" not in text
    assert "failed" not in text


async def test_required_content_over_limit_has_readable_error():
    with pytest.raises(ContextBudgetExceeded, match="缩短文章|缩小修改范围"):
        await ContextBudgeter().build(
            capabilities=capabilities(context_window=200, max_output=50),
            system_prompt="规则",
            latest_instruction="全部重写",
            brief=ArticleBrief(topic="测试"),
            history=[],
            current_content="很长" * 1000,
        )


async def test_current_attachment_is_complete_and_history_attachment_can_truncate():
    history = [
        HumanMessage(
            content="历史指令必须保留",
            id="history",
            additional_kwargs={
                "article_attachments": [
                    {"name": "history.txt", "content": "历史资料" * 500}
                ]
            },
        ),
        HumanMessage(
            content="当前指令",
            id="latest",
            additional_kwargs={
                "article_attachments": [
                    {"name": "current.md", "content": "当前完整资料"}
                ]
            },
        ),
    ]
    result = await ContextBudgeter(recent_message_limit=4).build(
        capabilities=capabilities(context_window=500, max_output=50),
        system_prompt="规则",
        latest_instruction="当前指令",
        latest_attachments=history[-1].additional_kwargs["article_attachments"],
        brief=ArticleBrief(topic="附件"),
        history=history,
    )
    text = "\n".join(str(message.content) for message in result.messages)
    assert "历史指令必须保留" in text
    assert "历史附件内容因上下文预算已截断" in text
    assert "当前完整资料" in text


def test_usage_ratio_cannot_exceed_eighty_percent():
    with pytest.raises(ValueError, match="0.80"):
        ContextBudgeter(0.81)
