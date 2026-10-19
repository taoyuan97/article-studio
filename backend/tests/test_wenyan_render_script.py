from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "wenyan_render.mjs"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(NODE is None, reason="node not installed")


def _write_wrapper(tmp_path: Path, source: str) -> Path:
    path = tmp_path / "fake-core-wrapper.mjs"
    path.write_text(source, encoding="utf-8")
    return path


def _run(wrapper: Path, markdown: str, theme: str = "default"):
    payload = json.dumps(
        {"markdown": markdown, "themeId": theme}, ensure_ascii=False
    ).encode("utf-8")
    result = subprocess.run(
        [NODE, str(SCRIPT), str(wrapper)],
        input=payload,
        capture_output=True,
        timeout=60,
    )
    return (
        result.returncode,
        result.stdout.decode("utf-8", errors="replace"),
        result.stderr.decode("utf-8", errors="replace"),
    )


def test_render_script_uses_publish_prepare_path(tmp_path):
    """Preview must go through prepareRenderContext (handleFrontMatter), not
    bare renderStyledContent — fake wrapper fails if renderStyledContent runs."""

    wrapper = _write_wrapper(
        tmp_path,
        """
export async function prepareRenderContext(inputContent, options, getInputContent) {
  if (options.theme !== "default") throw new Error("unexpected theme");
  if (options.highlight !== "solarized-light") throw new Error("unexpected highlight");
  if (options.macStyle !== true) throw new Error("unexpected macStyle");
  if (options.footnote !== true) throw new Error("unexpected footnote");
  const { content } = await getInputContent(inputContent);
  if (!content.startsWith("---")) throw new Error("frontmatter was not passed to core");
  const body = content.replace(/^---[\\s\\S]*?---\\s*/, "");
  return { gzhContent: { content: `<section id="wenyan">${body}</section>`, title: "t" } };
}
export async function renderStyledContent() {
  throw new Error("renderStyledContent must not be called by the preview path");
}
""",
    )
    code, stdout, stderr = _run(wrapper, "---\ntitle: t\n---\n\n正文")
    assert code == 0, stderr
    html = json.loads(stdout)["html"]
    assert "正文" in html
    assert "title:" not in html


def test_render_script_rejects_image_list_frontmatter(tmp_path):
    wrapper = _write_wrapper(
        tmp_path,
        """
export async function prepareRenderContext() {
  return { gzhContent: { content: "unrendered", image_list: ["a.png"] } };
}
export async function renderStyledContent() {}
""",
    )
    code, _stdout, stderr = _run(wrapper, "---\ntitle: t\n---\n\n正文")
    assert code == 1
    assert "图文消息" in stderr


def test_render_script_requires_prepare_render_context(tmp_path):
    wrapper = _write_wrapper(
        tmp_path,
        """
export async function renderStyledContent() {
  return "<section></section>";
}
""",
    )
    code, _stdout, stderr = _run(wrapper, "---\ntitle: t\n---\n\n正文")
    assert code == 1
    assert "prepareRenderContext" in stderr
