"""Smoke test real image providers with the current implementation.

Run from the backend directory:
    uv run python scripts/test_real_image_providers.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

# Ensure the backend root (article_agent/, app/) is on path when running directly.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx

from article_agent.config import Settings
from article_agent.image_providers import ImageProviderRegistry


async def test_provider(registry: ImageProviderRegistry, name: str, model: str) -> None:
    print(f"\n=== Testing provider: {name} (model: {model}) ===")
    provider = registry.get(name)
    try:
        result = await provider.generate("一只可爱的橘色小猫，卡通风格，纯色背景")
        print(f"local_path: {result.local_path}")
        print(f"storage_url: {result.storage_url}")
        print(f"width: {result.width}, height: {result.height}, seed: {result.seed}")
        print("raw_response:")
        print(json.dumps(result.raw_response, indent=2, ensure_ascii=False))
    except httpx.HTTPStatusError as exc:
        print(f"FAILED: {exc.response.status_code} for {exc.request.url}")
        try:
            body = exc.response.json()
        except Exception:
            body = exc.response.text
        print(f"response body: {body}")
    except Exception as exc:  # noqa: BLE001
        print(f"FAILED: {type(exc).__name__}: {exc}")


async def main() -> None:
    settings = Settings(_env_file=".env")
    data_dir = Path(settings.data_dir).resolve()
    registry = ImageProviderRegistry.from_settings(settings, data_dir=data_dir)

    providers = registry.list()
    print(f"Enabled providers: {providers}")
    if not providers:
        print("No image providers are enabled. Check .env configuration.")
        return

    for info in providers:
        await test_provider(registry, info["provider"], info["model"])


if __name__ == "__main__":
    asyncio.run(main())
