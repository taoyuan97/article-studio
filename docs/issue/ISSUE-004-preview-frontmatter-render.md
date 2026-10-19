# ISSUE-004：主题预览把 YAML frontmatter 当正文渲染（预览 ≠ 发布）

## 1. 缺陷信息

| 项 | 内容 |
| --- | --- |
| 编号 | ISSUE-004 |
| 发现日期 | 2026-10-19 |
| 状态 | 已修复（AI 自测通过；浏览器/真实草稿人工验收待执行） |
| 严重级别 | 中（预览正确性与验收口径缺陷；不影响真实发布结果） |
| 影响范围 | 网页发布向导主题预览、`POST /api/publish/render-preview`、MCP `render_publish_preview`；真实 `publish_article` 不受影响 |
| 发现场景 | T021 MCP 验收期间，对比预览 HTML 与发布行为 |
| 关联任务/文档 | T021（`docs/task/T021-article-studio-mcp.md`）；T014 历史设计（`docs/version/v1.0.0/task/T014-*.md`） |

## 2. 现象

带 frontmatter 的文章进入「选主题」预览时，手机框 iframe 顶部出现一段正文式文字：

```text
title: 测试标题
cover: C:\tmp\cover.png
author: 测试作者
```

真实发布到公众号草稿箱时，这些字段由 `handleFrontMatter` 消费，不会进入正文。因此 T021 声称的「预览 = 发布」在带 frontmatter 时不成立；验收用例 MT-18 也未断言 frontmatter 不出现。

## 3. 复现

使用本机 `@wenyan-md/core` 3.0.11 直接调用 core 渲染（未改仓库文件）：

```text
DIRECT_TEXT_HEAD= title: 测试标题 cover: C:\tmp\cover.png author: 测试作者 正文标题 正文内容
```

修复后再经预览脚本渲染：

```text
HAS_TITLE_FIELD= false
HAS_COVER_FIELD= false
HAS_AUTHOR_FIELD= false
HAS_DESCRIPTION= true
TEXT_HEAD= 摘要说明 正文标题 正文第一段。
```

## 4. 根因

- 发布链路：`publish_article` → wenyan-mcp `publishArticle` → core `renderAndPublish` → `prepareRenderContext` → `handleFrontMatter` → 渲染。
  - `@wenyan-md/mcp/dist/publish.js:32-54`
  - `@wenyan-md/core/dist/wrapper.js:955-970,1032-1044`
- 预览链路：`render_markdown` → `scripts/wenyan_render.mjs` → `renderStyledContent`，**漏掉 `handleFrontMatter`**。
  - `backend/app/wenyan_client.py:207-254`
  - 修复前 `backend/scripts/wenyan_render.mjs:35-42`

`renderStyledContent` 只做 Markdown → HTML + 主题样式，不解析 frontmatter；`prepareRenderContext` 才是发布链路的前置步骤。

## 5. 修复（2026-10-19 按用户确认执行）

`backend/scripts/wenyan_render.mjs` 改为复用发布链路：

- 动态导入 core wrapper 的 `prepareRenderContext`；
- 传入与 `publish.js` 一致的 options：`theme` / `highlight: solarized-light` / `macStyle` / `footnote`；
- `getInputContent` 只返回内存 markdown（预览不读本地文件），`absoluteDirPath` 作为占位；
- 输出 `gzhContent.content`；
- 缺少 `prepareRenderContext`（旧 core）→ 明确报错并提示升级（不做两套渲染）；
- frontmatter 含 `image_list`（图文消息）→ 明确报错「暂不支持主题预览」；
- 标题/封面/作者不再出现在正文，`description` 按发布语义转为引用块；手机框外不额外加标题（D4）。

## 6. 验证

- 本机真实 core 验证：frontmatter 字段不再出现，正文与 description 正确，见 §3。
- 新增 `backend/tests/test_wenyan_render_script.py`：
  - fake wrapper 断言预览脚本走 `prepareRenderContext` 而非 `renderStyledContent`；
  - `image_list` 明确报错；
  - 缺少 `prepareRenderContext` 明确报错。
- 更新 `backend/tests/test_wenyan_client.py` real-node 集成用例：断言 HTML 不含 `title:` / `cover:` / `author:`，description 存在。
- 后端全量：**163 passed**；`git diff --check` 通过。
- 人工验收待执行：浏览器预览确认无 frontmatter；真实公众号草稿与预览一致性复验（见 `docs/test/T021-mcp-acceptance.md` MT-18 / AT-05）。

## 7. 经验

1. **“调用同一个函数”不等于“同一条链路”**：发布用了 `renderAndPublish` 的完整前置流程；预览只调了渲染函数，遗漏 `handleFrontMatter`。
2. **验收要覆盖负向断言**：仅断言“正文存在”无法发现 frontmatter 泄漏；必须断言 `title:` 等字段不出现在 HTML 中。
3. **预览脚本应复用发布入口的公共预处理**，而不是自行拼装渲染参数；core 的 `prepareRenderContext` 是公开导出，可直接复用。
