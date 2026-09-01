from __future__ import annotations

import base64
from collections.abc import AsyncIterator
import asyncio
from pathlib import Path
from typing import Any

from langchain_core.messages import AIMessage, AIMessageChunk

from article_agent.image_providers import ImageResult


class FakeStructuredModel:
    def __init__(self, parent: "FakeChatModel") -> None:
        self.parent = parent

    async def ainvoke(self, messages: list[Any], config: dict[str, Any] | None = None):
        self.parent.structured_invocations.append(messages)
        value = self.parent.decisions.pop(0)
        if isinstance(value, Exception):
            raise value
        return value


class FakeChatModel:
    def __init__(
        self,
        *,
        decisions: list[Any],
        responses: list[str | Exception] | None = None,
        chunk_delay: float = 0,
    ):
        self.decisions = list(decisions)
        self.responses = list(responses or [])
        self.invocations: list[list[Any]] = []
        self.structured_invocations: list[list[Any]] = []
        self.chunk_delay = chunk_delay

    def with_structured_output(
        self, schema: type[Any], **kwargs: Any
    ) -> FakeStructuredModel:
        return FakeStructuredModel(self)

    async def ainvoke(self, messages: list[Any], config: dict[str, Any] | None = None):
        self.invocations.append(messages)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return AIMessage(content=response)

    async def astream(
        self, messages: list[Any], config: dict[str, Any] | None = None
    ) -> AsyncIterator[AIMessageChunk]:
        self.invocations.append(messages)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        for index in range(0, len(response), 8):
            if self.chunk_delay:
                await asyncio.sleep(self.chunk_delay)
            yield AIMessageChunk(content=response[index : index + 8])


# 1x1 red PNG
_FAKE_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAEiEB8tvGo/oAAAAASUVORK5CYII="
)


class FakeImageProvider:
    """Image provider that writes a tiny red PNG to the configured local path."""

    name = "fake"
    model = "fake-image-model"

    def __init__(self, *, data_dir: Path | None = None, delay: float = 0) -> None:
        self.data_dir = data_dir or Path("/tmp")
        self.delay = delay
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def generate(
        self,
        prompt: str,
        *,
        size: str | None = None,
    ) -> ImageResult:
        self.calls.append((prompt, {"size": size}))
        if self.delay:
            await asyncio.sleep(self.delay)
        session_dir = self.data_dir / "assets" / "images" / "fake-session"
        session_dir.mkdir(parents=True, exist_ok=True)
        local_path = session_dir / "fake.png"
        local_path.write_bytes(_FAKE_PNG_BYTES)
        return ImageResult(
            local_path=local_path,
            storage_url=f"/static/assets/images/fake-session/{local_path.name}",
            width=1,
            height=1,
            seed="fake-seed",
            raw_response={"prompt": prompt},
        )
