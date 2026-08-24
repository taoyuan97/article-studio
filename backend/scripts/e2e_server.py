"""Playwright E2E 专用后端：假模型 + 生产形态单进程托管前端构建产物。

与 dev_fake_server.py 复用同一套假模型（chunk 延迟更大便于稳定测试取消），
区别在于：
- `serve_frontend=True`：FastAPI 直接托管 `frontend/dist`（SPA fallback），
  E2E 因此验证的是生产部署形态（静态资源、API、SSE 同进程同源）；
- `--wipe`：启动前清空数据目录，保证每次测试运行从干净状态开始；
- 不依赖任何真实 API Key。

用法（backend 目录下）：

    .venv/Scripts/python.exe scripts/e2e_server.py --port 8901 --wipe

前置条件：frontend 已执行 `pnpm build`（产物在 frontend/dist）。
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

# 允许 `python scripts/e2e_server.py` 直接运行，并复用 dev_fake_server 的假模型
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dev_fake_server import build_application  # noqa: E402

import uvicorn  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8901)
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "e2e",
    )
    parser.add_argument(
        "--wipe",
        action="store_true",
        help="启动前删除数据目录（干净状态）",
    )
    parser.add_argument(
        "--chunk-delay",
        type=float,
        default=0.2,
        help="文章流式每个 chunk 的延迟秒数（放大便于稳定测试取消）",
    )
    parser.add_argument(
        "--image-delay",
        type=float,
        default=3.0,
        help="生图耗时秒数（放大便于稳定测试取消）",
    )
    args = parser.parse_args()

    data_dir = args.data_dir.resolve()
    if args.wipe:
        shutil.rmtree(data_dir, ignore_errors=True)
    data_dir.mkdir(parents=True, exist_ok=True)

    application = build_application(
        data_dir,
        chunk_delay=args.chunk_delay,
        image_delay=args.image_delay,
        serve_frontend=True,
    )

    print(f"[e2e] data_dir = {data_dir} (wiped={args.wipe})")
    print(f"[e2e] listening on http://{args.host}:{args.port} (fake models + dist)")
    uvicorn.run(application, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
