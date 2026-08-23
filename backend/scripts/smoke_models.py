from __future__ import annotations

import argparse
import asyncio

from langchain_core.messages import HumanMessage

from article_agent.agent import ArticleAgent
from article_agent.cancellation import CancellationToken
from article_agent.config import Settings
from article_agent.registry import ModelRegistry
from article_agent.state import initial_state


async def smoke(provider: str) -> None:
    settings = Settings()
    registry = ModelRegistry.from_settings(settings)
    config = settings.provider(provider)
    if not config.model:
        raise SystemExit(f"{provider} is not configured")
    model = registry.get_chat_model(provider, config.model)

    response = await model.ainvoke([HumanMessage(content="只回复 OK")])
    print("non-stream:", response.content)
    print(
        "non-stream usage:",
        response.usage_metadata or response.response_metadata.get("token_usage"),
    )

    print("stream:", end=" ", flush=True)
    stream_usage = None
    async for chunk in model.astream([HumanMessage(content="用一句话解释写作。")]):
        print(chunk.content, end="", flush=True)
        stream_usage = chunk.usage_metadata or stream_usage
    print()
    print("stream usage:", stream_usage)

    token = CancellationToken()
    count = 0
    async for _ in model.astream([HumanMessage(content="写一篇 2000 字文章。")]):
        count += 1
        token.cancel()
        if token.cancelled:
            break
    print(f"cancel: stopped after {count} chunk(s)")

    agent = ArticleAgent(
        registry,
        usage_ratio=settings.llm_context_usage_ratio,
        recent_message_limit=settings.llm_recent_message_limit,
    )
    generation_state = initial_state(
        provider=provider,
        model=config.model,
        run_id="smoke-generate",
        force_generate=True,
        messages=[
            HumanMessage(
                content="直接写一篇约 300 字的文章，主题是保持专注。",
                id="smoke-user-1",
            )
        ],
    )
    generated = None
    async for event in agent.stream(generation_state):
        if event.type == "result.ready":
            generated = event.data["result"]
        if event.type == "run.failed":
            raise RuntimeError(event.data["message"])
    if not generated:
        raise RuntimeError("article generation produced no result")
    print("article generation:", generated["title"])

    revision_state = initial_state(
        provider=provider,
        model=config.model,
        run_id="smoke-revise",
        current_title=generated["title"],
        current_content=generated["content_markdown"],
        messages=[HumanMessage(content="把语气改得更轻松。", id="smoke-user-2")],
    )
    revised = None
    async for event in agent.stream(revision_state):
        if event.type == "result.ready":
            revised = event.data["result"]
        if event.type == "run.failed":
            raise RuntimeError(event.data["message"])
    if not revised:
        raise RuntimeError("article revision produced no result")
    print("article revision:", revised["title"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("provider", choices=["deepseek", "moonshot"])
    args = parser.parse_args()
    asyncio.run(smoke(args.provider))


if __name__ == "__main__":
    main()
