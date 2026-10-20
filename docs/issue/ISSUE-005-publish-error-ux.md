# ISSUE-005：发布失败提示不可定位（40164 等微信错误被泛化文案淹没）

## 1. 缺陷信息

| 项 | 内容 |
| --- | --- |
| 编号 | ISSUE-005 |
| 发现日期 | 2026-10-20 |
| 状态 | 已修复（AI 自测通过；浏览器/真实公众号复验待执行） |
| 严重级别 | 中（失败可定位性差；不影响发布接口本身） |
| 影响范围 | 网页发布向导失败提示、发布记录展开、发布快照详情；MCP `publish_article` 错误码 |
| 关联任务 | T021（已合并）；发布线（T007–T014） |

## 2. 现象

点击「发布到公众号草稿箱」失败时，主文案固定列出三种可能：

> 公众号接口调用失败：常见原因有 IP 不在白名单（错误码 40164）、AppSecret 有误、未选择封面图……

即使原始详情已经明确是 `40164 invalid ip 120.85.124.127`，用户仍需自己从英文详情里判断原因、找 IP、找修复入口。

## 3. 根因

- `WenyanMcpClient.publish_article` 把 `wenyan-mcp` 的所有工具失败文本统一包装为 `PUBLISH_MCP_ERROR`，未区分 40164/40125/48001 等。
- `publish_records.error_code` 落库为泛化码；记录页/详情页也只能展示原文。
- 前端 `errorText.ts` 对 `PUBLISH_MCP_ERROR` 使用固定“三选一”文案，不解析 IP/rid/具体错误码。
- 错误 API 仍为 `{code, message}`，原文保留但未被结构化呈现。

## 4. 修复（2026-10-20）

### 4.1 后端分类

`wenyan_client.classify_publish_failure(text)` 识别常见微信错误并映射领域错误码：

| 微信错误 | 领域错误码 |
| --- | --- |
| `40164` / `invalid ip` | `PUBLISH_IP_NOT_WHITELIST` |
| `40125` / `40001` / `40013` / `invalid appsecret` | `PUBLISH_CREDENTIALS_INVALID` |
| `48001` / `api unauthorized` | `PUBLISH_API_UNAUTHORIZED` |
| `45009` / `freq limit` | `PUBLISH_RATE_LIMITED` |
| `thumb_media_id` / 封面 | `PUBLISH_COVER_REQUIRED` |
| `40007` / `40009` / `40006` / media | `PUBLISH_MEDIA_INVALID` |
| 其他 | `PUBLISH_MCP_ERROR`（原文保留） |

- 原始 message 不变，失败记录仍保留完整诊断文本。
- `main.py` 增加新码 HTTP 状态映射（配置类 422，接口/限频/未知 502）。
- fake 模式失败文本改为带模拟 IP/rid 的 40164，便于 E2E 验证新提示。

### 4.2 前端统一失败面板

新增 `features/publish/publishFailure.ts` + `PublishFailurePanel.tsx`：

- 首屏给具体原因（如「公众号 IP 白名单未包含当前出口 IP」），不再列三种猜测。
- 从原文提取 IPv4、`::ffff:` 映射、`rid`、微信错误码；给出 1–3 步修复指引。
- 操作：重试发布、打开公众平台、公众号设置、查看发布记录、复制诊断信息。
- 技术详情折叠展示错误码/rid/原始文本；旧记录 `PUBLISH_MCP_ERROR` 仍按原文识别。
- 发布页、发布记录展开行、发布快照详情共用该组件。

## 5. 验证

- 后端：分类单测覆盖 40164/40125/40001/40013/48001/45009/40007/封面/未知；fake 失败落库为新码并保留原文；全量 pytest **174 passed**。
- 前端：`describePublishFailure` 单测覆盖 IP + `::ffff` + rid、凭据、未知错误、旧码兼容；发布页/记录页/详情页测试通过；**117 passed**，lint/build 通过。
- E2E：`e2e/publish.spec.ts` **2 passed**，fake 发布失败显示“IP 白名单”标题、模拟 IP、新错误码，记录展开一致。
- 人工待验：浏览器实际操作、真实公众号 40164 复验。

## 6. 经验

1. 聚合错误码会抹掉可操作信息：外部 API 错误应尽早分类，并保留原始诊断。
2. UI 的主文案必须给“最可能的具体原因”，不能把多个猜测并列。
3. 记录/详情/向导必须复用同一套错误解释，避免同一失败三种说法。
