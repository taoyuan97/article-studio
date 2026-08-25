"""假模型后端开发服务器：用于前端浏览器端到端联调，不消耗任何真实 API 额度。

原理：通过 create_app 的依赖注入（settings / registry / image_registry_override /
data_dir）挂载假 LLM 与假生图 provider，其余 API、SSE、SQLite 行为与真实后端完全一致。

假模型行为约定（便于联调时构造场景）：
- 文章：第 1 条消息 → GENERATE（生成 v1）；后续消息 → REVISE（生成下一版）。
- 最新用户消息包含「触发失败」→ 生成阶段延迟 0.5s 后抛错（错误详情含
  SIMULATED_FAILURE，用于验证失败卡片与重新发送；历史消息与压缩转录中的
  「失败」字样不影响运行——正文模板本身含「失败」二字，故用更长的触发词）。
- 生图：提示词包含「触发失败」→ 延迟后生成失败，用于验证失败卡片。
- 配图计划：编排指令（或角色）包含「触发失败」→ 延迟后抛错，验证
  PLAN_LLM_ERROR 错误路径；正常请求返回罐头方案（3 张图、三种排版）。
- 发布：最新用户消息包含「触发发布失败」→ 生成正文末尾嵌入同名标记，
  发布线 fake 模式（wenyan_client）据此抛 PUBLISH_MCP_ERROR，用于验证
  发布失败记录与重试；发布凭据为假值且 PUBLISH_FAKE_MODE=true，不外呼。

用法（backend 目录下）：

    uv run python scripts/dev_fake_server.py [--port 8000] [--data-dir data/dev-fake]

数据写入独立目录（默认 data/dev-fake），与真实数据互不影响；删除该目录即可重置。
"""

from __future__ import annotations

import argparse
import asyncio
import struct
import sys
import uuid
import zlib
from collections.abc import AsyncIterator
from pathlib import Path

# 允许 `python scripts/dev_fake_server.py` 直接运行（scripts/ 不在包内）
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from langchain_core.messages import AIMessage, AIMessageChunk  # noqa: E402

from app.main import create_app  # noqa: E402
from article_agent.config import Settings  # noqa: E402
from article_agent.image_providers import (  # noqa: E402
    ImageProviderError,
    ImageProviderRegistry,
    ImageResult,
)
from article_agent.models import (  # noqa: E402
    ArticleBrief,
    ImagePlanImage,
    ImagePlanResult,
    IntentDecision,
    UserIntent,
)
from article_agent.registry import (  # noqa: E402
    ModelCapabilities,
    ModelRegistry,
    conservative_token_estimate,
)

ARTICLE_TEMPLATE = """# 冒烟测试文章 v{n}

这是假模型第 {n} 次生成的演示正文。当前流程用于验证前端工作台的流式渲染、
版本面板与消息分型展示，不依赖任何真实模型。

## 要点

- 消息分型（用户 / 智能体 / 失败）样式正常。
- 正文随 SSE 流式增量渲染。
- 每次生成都会落一个只读历史版本。

## 结语

如果你能看到这段文字，说明文章线的假模型端到端链路已经打通。
"""

# 发布失败触发词：用户消息包含它时，生成正文末尾嵌入同名标记，
# 供 wenyan_client fake 模式识别并模拟 PUBLISH_MCP_ERROR（与「触发失败」互不包含）。
PUBLISH_FAIL_TRIGGER = "触发发布失败"

_COLORS = [
    (91, 122, 158),
    (158, 91, 122),
    (91, 158, 122),
    (122, 91, 158),
    (158, 122, 91),
]


def _make_png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """生成一张纯色 PNG（无第三方依赖）。"""

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    row = b"\x00" + bytes(rgb) * width
    raw = row * height
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


def _latest_human_text(messages: list) -> str:
    """取最新一条用户消息文本（失败注入只看当前指令，历史不影响后续运行）。"""
    for message in reversed(messages):
        if getattr(message, "type", "") == "human":
            return str(message.content)
    return ""


def _fake_image_plan() -> ImagePlanResult:
    """罐头配图方案：3 张图覆盖三种排版，文案带编号便于 E2E 断言。"""
    return ImagePlanResult(
        mood="温暖治愈",
        style_summary="暖色调水彩手绘插画，柔和光影，统一呈现静谧治愈的氛围",
        images=[
            ImagePlanImage(
                block_index=1,
                position_hint="开篇引入，奠定全文视觉基调",
                layout="landscape",
                layout_reason="开篇横版大图，承载场景全景并留出下方呼吸空间",
                prompt="暖色调水彩插画：清晨的咖啡馆内景，木桌上一杯冒着热气的拿铁，"
                "柔和晨光透过玻璃窗洒落，温暖治愈氛围，横版构图（假模型方案一）",
            ),
            ImagePlanImage(
                block_index=2,
                position_hint="中段要点处强化记忆",
                layout="square",
                layout_reason="方图适配段落间留白，聚焦单点意象",
                prompt="暖色调水彩插画：一盏台灯下摊开的笔记本与钢笔，纸页微卷，"
                "暖黄光晕环绕，静谧治愈氛围，居中构图（假模型方案二）",
            ),
            ImagePlanImage(
                block_index=3,
                position_hint="结语处收束呼应主题",
                layout="portrait",
                layout_reason="竖版收尾呼应纵向滚动阅读，视觉重心上移",
                prompt="暖色调水彩插画：暮色中的城市天际线与一扇亮灯的窗，"
                "远山剪影，温暖治愈氛围，竖版构图（假模型方案三）",
            ),
        ],
    )


class _ScriptedStructuredModel:
    def __init__(self, parent: "ScriptedFakeChatModel", schema: type) -> None:
        self.parent = parent
        self.schema = schema

    async def ainvoke(self, messages: list, config: dict | None = None):
        if self.schema is ImagePlanResult:
            if "触发失败" in _latest_human_text(messages):
                await asyncio.sleep(0.5)
                raise RuntimeError("模拟的编排错误：SIMULATED_FAILURE（已脱敏）")
            return _fake_image_plan()
        intent = (
            UserIntent.GENERATE if self.parent.generation_count == 0 else UserIntent.REVISE
        )
        return IntentDecision(intent=intent, brief=ArticleBrief(topic="冒烟测试"))


class ScriptedFakeChatModel:
    """自动续杯的假聊天模型：GENERATE → 之后一律 REVISE，正文按次数编号。"""

    def __init__(self, *, chunk_delay: float = 0.03) -> None:
        self.generation_count = 0
        self.chunk_delay = chunk_delay

    def with_structured_output(self, schema: type, **kwargs: object):
        return _ScriptedStructuredModel(self, schema)

    def _next_article(self) -> str:
        self.generation_count += 1
        return ARTICLE_TEMPLATE.format(n=self.generation_count)

    def _compose_reply(self, messages: list) -> str:
        text = self._next_article()
        if PUBLISH_FAIL_TRIGGER in _latest_human_text(messages):
            text += f"\n\n{PUBLISH_FAIL_TRIGGER}\n"
        return text

    async def ainvoke(self, messages: list, config: dict | None = None):
        if "触发失败" in _latest_human_text(messages):
            await asyncio.sleep(0.5)
            raise RuntimeError("模拟的提供方错误：SIMULATED_FAILURE（已脱敏）")
        return AIMessage(content=self._compose_reply(messages))

    async def astream(
        self, messages: list, config: dict | None = None
    ) -> AsyncIterator[AIMessageChunk]:
        if "触发失败" in _latest_human_text(messages):
            await asyncio.sleep(0.5)
            raise RuntimeError("模拟的提供方错误：SIMULATED_FAILURE（已脱敏）")
        text = self._compose_reply(messages)
        for index in range(0, len(text), 12):
            if self.chunk_delay:
                await asyncio.sleep(self.chunk_delay)
            yield AIMessageChunk(content=text[index : index + 12])


class ScriptedFakeImageProvider:
    """假生图 provider：写一张纯色 PNG，带延迟以模拟生成耗时。"""

    name = "fake"
    model = "fake-image-model"

    def __init__(self, *, data_dir: Path, delay: float = 1.5) -> None:
        self.data_dir = data_dir
        self.delay = delay
        self.calls = 0

    async def generate(self, prompt: str, *, size: str | None = None) -> ImageResult:
        # 失败注入前先延迟 0.5s（与假聊天模型一致），保证 UI 能观测到「正在生成」中间态
        if "触发失败" in prompt:
            await asyncio.sleep(0.5)
            raise ImageProviderError("模拟的生图错误：SIMULATED_FAILURE（已脱敏）")
        await asyncio.sleep(self.delay)
        self.calls += 1

        width, height = 512, 512
        if size:
            for separator in ("*", "x", "X"):
                if separator in size:
                    left, right = size.split(separator, 1)
                    if left.isdigit() and right.isdigit():
                        width, height = int(left), int(right)
                        break
        scale = min(1.0, 512 / max(width, height))
        width, height = max(1, round(width * scale)), max(1, round(height * scale))

        session_dir = f"dev-fake-{uuid.uuid4().hex[:10]}"
        directory = self.data_dir / "assets" / "images" / session_dir
        directory.mkdir(parents=True, exist_ok=True)
        filename = f"{uuid.uuid4().hex[:12]}.png"
        local_path = directory / filename
        local_path.write_bytes(
            _make_png(width, height, _COLORS[self.calls % len(_COLORS)])
        )
        return ImageResult(
            local_path=local_path,
            storage_url=f"/static/assets/images/{session_dir}/{filename}",
            width=width,
            height=height,
            seed=f"fake-seed-{self.calls}",
            raw_response={"prompt": prompt, "size": size},
        )


def build_application(
    data_dir: Path,
    *,
    chunk_delay: float,
    image_delay: float,
    serve_frontend: bool = False,
) -> object:
    settings = Settings(
        _env_file=None,
        default_llm_provider="deepseek",
        deepseek_api_key="fake-key-for-dev",
        deepseek_model="fake-model",
        deepseek_context_window=32_000,
        moonshot_api_key=None,
        moonshot_model=None,
        moonshot_context_window=None,
        default_image_provider=None,
        data_dir=data_dir,
        serve_frontend=serve_frontend,
        # 发布线：fake 模式 + 假凭据（凭据校验仍生效但不外呼，行为与真实后端一致）
        publish_fake_mode=True,
        wechat_app_id="fake-app-id",
        wechat_app_secret="fake-secret",
    )
    registry = ModelRegistry()
    for provider in ("deepseek", "moonshot"):
        registry.register(
            provider,
            "fake-model",
            ScriptedFakeChatModel(chunk_delay=chunk_delay),
            ModelCapabilities(
                context_window=32_000,
                max_output_tokens=2_000,
                supports_streaming=True,
                supports_structured_output=True,
                token_estimator=conservative_token_estimate,
            ),
        )
    image_registry = ImageProviderRegistry()
    image_registry.register(
        "fake", ScriptedFakeImageProvider(data_dir=data_dir, delay=image_delay)
    )
    return create_app(
        settings=settings,
        registry=registry,
        image_registry_override=image_registry,
        data_dir=data_dir,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "dev-fake",
    )
    parser.add_argument(
        "--chunk-delay",
        type=float,
        default=0.03,
        help="文章流式每个 chunk 的延迟秒数（调大便于测试取消）",
    )
    parser.add_argument(
        "--image-delay",
        type=float,
        default=1.5,
        help="生图耗时秒数（调大便于测试取消）",
    )
    args = parser.parse_args()

    data_dir = args.data_dir.resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    application = build_application(
        data_dir, chunk_delay=args.chunk_delay, image_delay=args.image_delay
    )

    import uvicorn

    print(f"[dev-fake] data_dir = {data_dir}")
    print(
        f"[dev-fake] chunk_delay = {args.chunk_delay}s, image_delay = {args.image_delay}s"
    )
    print(f"[dev-fake] listening on http://{args.host}:{args.port} (fake models, no real API)")
    uvicorn.run(application, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
