from __future__ import annotations

import base64
import mimetypes
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlparse
from uuid import uuid4

import httpx


@dataclass(frozen=True, slots=True)
class ImageResult:
    """Result of a single image generation call."""

    local_path: Path
    storage_url: str
    width: int | None
    height: int | None
    seed: str | None
    raw_response: dict[str, Any]


class ImageProvider(Protocol):
    """Provider-specific image generator."""

    name: str
    model: str

    async def generate(
        self,
        prompt: str,
        *,
        size: str | None = None,
    ) -> ImageResult: ...


class ImageProviderError(RuntimeError):
    pass


def _default_image_size(size: str | None) -> str:
    return size or "1024*1024"


def _parse_dimensions(size: str) -> tuple[int | None, int | None]:
    """Parse common size strings like '1024*1024', '1024x1024', '16:9'."""

    for separator in ("*", "x", "X"):
        if separator in size:
            try:
                width, height = size.split(separator)
                return int(width), int(height)
            except ValueError:
                return None, None
    return None, None


# Resolution tier + aspect ratio -> provider-specific size strings.
# Wanxiang uses '*' as the separator; Seedream uses 'x'.
# Used by fake providers in tests; mirrors the Wanxiang shape.
FAKE_SIZE_MAP: dict[tuple[str, str], str] = {
    ("1K", "1:1"): "1024*1024",
    ("2K", "1:1"): "2048*2048",
    ("1K", "16:9"): "1024*576",
    ("2K", "16:9"): "2048*1152",
    ("1K", "9:16"): "576*1024",
    ("2K", "9:16"): "1152*2048",
    ("1K", "4:3"): "1024*768",
    ("2K", "4:3"): "2048*1536",
    ("1K", "3:4"): "768*1024",
    ("2K", "3:4"): "1536*2048",
}

WANXIANG_SIZE_MAP: dict[tuple[str, str], str] = {
    ("1K", "1:1"): "1024*1024",
    ("2K", "1:1"): "2048*2048",
    ("4K", "1:1"): "4096*4096",
    ("1K", "16:9"): "1024*576",
    ("2K", "16:9"): "2048*1152",
    ("4K", "16:9"): "4096*2304",
    ("1K", "9:16"): "576*1024",
    ("2K", "9:16"): "1152*2048",
    ("4K", "9:16"): "2304*4096",
    ("1K", "4:3"): "1024*768",
    ("2K", "4:3"): "2048*1536",
    ("4K", "4:3"): "4096*3072",
    ("1K", "3:4"): "768*1024",
    ("2K", "3:4"): "1536*2048",
    ("4K", "3:4"): "3072*4096",
}

DREAMINA_SIZE_MAP: dict[tuple[str, str], str] = {
    ("1K", "1:1"): "1024x1024",
    ("2K", "1:1"): "2048x2048",
    ("3K", "1:1"): "3072x3072",
    ("1K", "16:9"): "1024x576",
    ("2K", "16:9"): "2048x1152",
    ("3K", "16:9"): "3072x1728",
    ("1K", "9:16"): "576x1024",
    ("2K", "9:16"): "1152x2048",
    ("3K", "9:16"): "1728x3072",
    ("1K", "4:3"): "1024x768",
    ("2K", "4:3"): "2048x1536",
    ("3K", "4:3"): "3072x2304",
    ("1K", "3:4"): "768x1024",
    ("2K", "3:4"): "1536x2048",
    ("3K", "3:4"): "2304x3072",
}


def resolve_image_size(provider: str, tier: str, ratio: str) -> str:
    """Convert a resolution tier and aspect ratio into a provider-specific size string."""

    size_map = {
        "aliyun_wanxiang": WANXIANG_SIZE_MAP,
        "dreamina": DREAMINA_SIZE_MAP,
        "fake": FAKE_SIZE_MAP,
    }.get(provider)
    if size_map is None:
        raise ValueError(f"Unsupported image provider: {provider}")
    try:
        return size_map[(tier, ratio)]
    except KeyError as exc:
        raise ValueError(
            f"Unsupported size combination for {provider}: tier={tier}, ratio={ratio}"
        ) from exc


class HttpImageProvider:
    """Generic HTTP image provider with per-provider payload shaping."""

    def __init__(
        self,
        *,
        name: str,
        model: str,
        base_url: str,
        api_key: str,
        timeout: float,
        data_dir: Path,
    ) -> None:
        self.name = name
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.data_dir = data_dir

    def _request_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _endpoint(self) -> str:
        """Subclasses override this to match provider API endpoint."""

        return "/images/generation"

    def _build_payload(
        self,
        prompt: str,
        *,
        size: str | None = None,
    ) -> dict[str, Any]:
        """Subclasses override this to match provider API shape."""

        return {
            "model": self.model,
            "input": {"prompt": prompt},
            "parameters": {"size": _default_image_size(size)},
        }

    def _extract_image_url(self, payload: dict[str, Any]) -> str:
        """Subclasses override this to extract the image URL from response."""

        if "url" in payload:
            return payload["url"]
        raise ImageProviderError(f"Unsupported response shape: {payload.keys()}")

    def _extract_dimensions(
        self, payload: dict[str, Any], size: str | None
    ) -> tuple[int | None, int | None]:
        """Subclasses override this to read actual dimensions from the response."""

        return _parse_dimensions(size or "1024*1024")

    async def generate(
        self,
        prompt: str,
        *,
        size: str | None = None,
    ) -> ImageResult:
        payload = self._build_payload(prompt, size=size)
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                f"{self.base_url}{self._endpoint()}",
                headers=self._request_headers(),
                json=payload,
            )
            response.raise_for_status()
            data = response.json()

        image_url = self._extract_image_url(data)
        width, height = self._extract_dimensions(data, size)
        local_path, storage_url = await self._download(image_url)
        return ImageResult(
            local_path=local_path,
            storage_url=storage_url,
            width=width,
            height=height,
            seed=None,
            raw_response=data,
        )

    async def _download(self, image_url: str) -> tuple[Path, str]:
        """Download remote image to local assets dir and return local path + public URL."""

        parsed = urlparse(image_url)
        is_data_uri = parsed.scheme == "data"
        is_http = parsed.scheme in ("http", "https")

        session_dir = self.data_dir / "assets" / "images" / str(uuid4())
        session_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{uuid4()}.png"
        local_path = session_dir / filename

        if is_data_uri:
            header, encoded = image_url.split(",", 1)
            media_type = header.split(";")[0].split(":")[1]
            ext = mimetypes.guess_extension(media_type) or ".png"
            local_path = local_path.with_suffix(ext)
            local_path.write_bytes(base64.b64decode(encoded))
        elif is_http:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.get(image_url)
                response.raise_for_status()
                local_path.write_bytes(response.content)
        else:
            raise ImageProviderError(f"Unsupported image URL scheme: {image_url}")

        storage_url = f"/static/assets/images/{local_path.parent.name}/{local_path.name}"
        return local_path, storage_url


class WanxiangProvider(HttpImageProvider):
    """阿里云 DashScope 通义万相 2.x 图像生成。

    API reference: https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference
    """

    def __init__(
        self,
        *,
        name: str,
        model: str,
        base_url: str,
        api_key: str,
        timeout: float,
        data_dir: Path,
    ) -> None:
        # Some configs include the legacy OpenAI-compatible suffix; strip it so the
        # native multimodal-generation endpoint can be appended correctly.
        normalized = base_url.rstrip("/")
        for suffix in ("/compatible-mode/v1", "/compatible-mode"):
            if normalized.lower().endswith(suffix):
                normalized = normalized[: -len(suffix)]
                break
        super().__init__(
            name=name,
            model=model,
            base_url=normalized,
            api_key=api_key,
            timeout=timeout,
            data_dir=data_dir,
        )

    def _endpoint(self) -> str:
        return "/api/v1/services/aigc/multimodal-generation/generation"

    def _build_payload(
        self,
        prompt: str,
        *,
        size: str | None = None,
    ) -> dict[str, Any]:
        return {
            "model": self.model,
            "input": {
                "messages": [
                    {"role": "user", "content": [{"text": prompt}]}
                ]
            },
            "parameters": {
                "size": _default_image_size(size),
                "n": 1,
            },
        }

    def _extract_image_url(self, payload: dict[str, Any]) -> str:
        try:
            content_item = payload["output"]["choices"][0]["message"]["content"][0]
            # The content item may be {"type": "image", "image": "<url>"}
            # or {"type": "image", "image": {"url": "..."}} depending on model/version.
            image = content_item.get("image")
            if isinstance(image, dict):
                return image["url"]
            return image
        except (KeyError, IndexError, TypeError) as exc:
            raise ImageProviderError(
                f"Unexpected Wanxiang response: {payload.keys()}"
            ) from exc

    def _extract_dimensions(
        self, payload: dict[str, Any], size: str | None
    ) -> tuple[int | None, int | None]:
        # Prefer the actual rendered size reported by the API.
        usage = payload.get("usage", {})
        actual_size = usage.get("size")
        if isinstance(actual_size, str):
            dims = _parse_dimensions(actual_size)
            if dims[0] and dims[1]:
                return dims
        return _parse_dimensions(size or "1024*1024")


class DreaminaProvider(HttpImageProvider):
    """即梦 / 火山引擎 Seedream 图像生成（火山方舟 OpenAI 兼容接口）。

    API reference: https://www.volcengine.com/docs/82379/1824121
    """

    def __init__(
        self,
        *,
        name: str,
        model: str,
        base_url: str,
        api_key: str,
        timeout: float,
        data_dir: Path,
    ) -> None:
        # Dreamina uses the fixed Ark OpenAI-compatible endpoint; configured
        # base_url (if any) is intentionally ignored.
        super().__init__(
            name=name,
            model=model,
            base_url="https://ark.cn-beijing.volces.com/api/v3",
            api_key=api_key,
            timeout=timeout,
            data_dir=data_dir,
        )

    def _endpoint(self) -> str:
        return "/images/generations"

    def _build_payload(
        self,
        prompt: str,
        *,
        size: str | None = None,
    ) -> dict[str, Any]:
        # Seedream supports size strings like "2K" or explicit pixels like "2048x2048".
        # Normalize the generic "1024*1024" shape to lowercase-x for this provider.
        if size is None:
            normalized_size = "2K"
        else:
            normalized_size = size.replace("*", "x").lower()
        return {
            "model": self.model,
            "prompt": prompt,
            "size": normalized_size,
            "response_format": "url",
        }

    def _extract_image_url(self, payload: dict[str, Any]) -> str:
        data = payload.get("data", [])
        if isinstance(data, list) and data and "url" in data[0]:
            return data[0]["url"]
        raise ImageProviderError(f"Unexpected Dreamina response: {payload.keys()}")

    def _extract_dimensions(
        self, payload: dict[str, Any], size: str | None
    ) -> tuple[int | None, int | None]:
        data = payload.get("data", [])
        if isinstance(data, list) and data:
            actual_size = data[0].get("size")
            if isinstance(actual_size, str):
                dims = _parse_dimensions(actual_size)
                if dims[0] and dims[1]:
                    return dims
        return _parse_dimensions(size or "1024*1024")


class ImageProviderRegistry:
    """Registry for image generation providers."""

    def __init__(self) -> None:
        self._providers: dict[str, ImageProvider] = {}

    def register(self, name: str, provider: ImageProvider) -> None:
        self._providers[name] = provider

    def get(self, name: str) -> ImageProvider:
        try:
            return self._providers[name]
        except KeyError as exc:
            raise ValueError(f"Image provider is not registered: {name}") from exc

    def list(self) -> list[dict[str, str]]:
        return [
            {"provider": provider.name, "model": provider.model}
            for provider in self._providers.values()
        ]

    @classmethod
    def from_settings(cls, settings: Any, data_dir: Path) -> "ImageProviderRegistry":
        from .config import Settings

        settings = Settings() if settings is None else settings
        registry = cls()

        for name, model, provider_class, needs_base_url in (
            ("aliyun_wanxiang", settings.aliyun_wanxiang_model, WanxiangProvider, True),
            ("dreamina", settings.dreamina_model, DreaminaProvider, False),
        ):
            try:
                config = settings.image_provider(name)
            except ValueError:
                continue
            if not (config.api_key and config.api_key.get_secret_value() and model):
                continue
            if needs_base_url and not config.base_url:
                continue
            registry.register(
                name,
                provider_class(
                    name=name,
                    model=model,
                    base_url=config.base_url,
                    api_key=config.api_key.get_secret_value(),
                    timeout=settings.image_timeout_seconds,
                    data_dir=data_dir,
                ),
            )
        return registry
