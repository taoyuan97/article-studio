// 主题预览渲染脚本：stdin 传 JSON {markdown, themeId}，stdout 返回 JSON {html}。
// 渲染路径与 wenyan-mcp publish_article 完全一致（@wenyan-md/core 的 renderStyledContent，
// 参数对齐 wenyan-mcp dist/publish.js 的 publishOptions），保证预览=发布效果。
// 用法：node wenyan_render.mjs <core_wrapper_abs_path>
import { readFileSync } from "node:fs";

const coreWrapperPath = process.argv[2];
if (!coreWrapperPath) {
  console.error("用法: node wenyan_render.mjs <core_wrapper_abs_path>");
  process.exit(1);
}

let input;
try {
  input = JSON.parse(readFileSync(0, "utf-8"));
} catch (error) {
  console.error(`读取 stdin JSON 失败: ${error.message}`);
  process.exit(1);
}

const markdown = String(input.markdown ?? "");
const themeId = String(input.themeId ?? "");
if (!markdown) {
  console.error("markdown 不能为空");
  process.exit(1);
}
if (!themeId) {
  console.error("themeId 不能为空");
  process.exit(1);
}

const wrapperUrl = `file:///${coreWrapperPath.replace(/\\/g, "/").replace(/^\/+/, "")}`;

try {
  const { renderStyledContent } = await import(wrapperUrl);
  // 参数与 wenyan-mcp 发布链路一致：highlight=solarized-light、macStyle、footnote
  const html = await renderStyledContent(markdown, {
    themeId,
    hlThemeId: "solarized-light",
    isMacStyle: true,
    isAddFootnote: true,
  });
  process.stdout.write(JSON.stringify({ html }));
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exit(1);
}
