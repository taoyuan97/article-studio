// 主题预览渲染脚本：stdin 传 JSON {markdown, themeId}，stdout 返回 JSON {html}。
// 使用 @wenyan-md/core 的 prepareRenderContext —— 与 wenyan-mcp 真实发布链路
// renderAndPublish 完全一致的预处理（handleFrontMatter + renderWithTheme），
// 先剥离 YAML frontmatter 再按 publishOptions 参数渲染，保证「预览 = 发布」。
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
  const { prepareRenderContext } = await import(wrapperUrl);
  if (typeof prepareRenderContext !== "function") {
    throw new Error(
      "当前 @wenyan-md/mcp 版本不支持主题预览（缺少 prepareRenderContext），" +
        "请升级后重试：npm install -g @wenyan-md/mcp",
    );
  }

  // 与 wenyan-mcp dist/publish.js 的 publishOptions 对齐；getInputContent 只提供
  // 内存中的 markdown（预览不读取本地文件），absoluteDirPath 仅作为占位。
  const getInputContent = async (content) => ({
    content: String(content ?? ""),
    absoluteDirPath: process.cwd(),
  });
  const { gzhContent } = await prepareRenderContext(
    markdown,
    {
      theme: themeId,
      highlight: "solarized-light",
      macStyle: true,
      footnote: true,
    },
    getInputContent,
  );

  if (Array.isArray(gzhContent?.image_list) && gzhContent.image_list.length > 0) {
    throw new Error("图文消息（frontmatter image_list）暂不支持主题预览");
  }
  if (typeof gzhContent?.content !== "string" || !gzhContent.content) {
    throw new Error("主题预览渲染未返回正文内容");
  }
  process.stdout.write(JSON.stringify({ html: gzhContent.content }));
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exit(1);
}
