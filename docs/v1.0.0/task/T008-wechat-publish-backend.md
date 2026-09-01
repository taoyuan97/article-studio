# T008：公众号发布（二）组装服务、数据模型与路由

## 1. 任务信息

- 状态：已完成
- 优先级：P0
- 类型：正式任务 8/10
- 前置任务：T007
- 后续任务：T009、T010
- 目标目录：`backend/`
- 创建日期：2026-08-24
- 关联文档：`docs/task/T007-wechat-publish-mcp-client.md`（客户端依赖）、`backend/app/database.py`（表结构）、`backend/app/main.py`（路由）

## 2. 目标

实现"文章 + 配图 → 微信公众号草稿"的后端闭环：文章小节切分、配图按位置插入、frontmatter 生成、发布记录持久化，并向前端暴露主题/预览/发布/记录四组 API。

## 3. 范围

### 3.1 必须实现

**数据模型（`backend/app/database.py` 新增表 `publish_records`）**

- 字段：
  - `id TEXT PRIMARY KEY`、`article_id TEXT REFERENCES articles(id)`、`version_id TEXT REFERENCES article_versions(id)`
  - `theme_id TEXT NOT NULL`、`cover_asset_id TEXT REFERENCES assets(id)`
  - `author TEXT`、`digest TEXT`（摘要，选填）
  - `image_placements_json TEXT NOT NULL`（发布快照：图片 asset_id → 插入位置，及顺序）
  - `status TEXT NOT NULL CHECK (status IN ('succeeded','failed'))`（同步接口，无中间态）
  - `media_id TEXT`、`error_code TEXT`、`error_message TEXT`
  - `content_snapshot TEXT NOT NULL`（发布时的最终 Markdown 快照，便于追溯）
  - `created_at TEXT NOT NULL`
- 索引：`idx_publish_records_article ON publish_records(article_id, created_at DESC)`。
- 沿用现有迁移机制（项目为启动时建表，保持一致）。

**组装服务（新增 `backend/app/publish_service.py`）**

- `split_sections(markdown: str) -> list[dict]`：按 H2（`## `）切分正文为小节；无 H2 时整篇为单节。返回 `[{index, heading, body}]`，供前端逐图选位置。
- `build_publish_markdown(...) -> str`：
  - 入参：文章标题、`content_markdown`、图片位置列表 `[{asset_id, position, order}]`（position ∈ `top / after_section_{n} / bottom`）、封面 asset、作者、摘要。
  - 生成 frontmatter：`title`（必填）、`cover`（图片本地绝对路径或 storage_url）、`author`、`digest`（摘要写为首段说明或省略——文颜 frontmatter 无 digest 字段时忽略，仅存记录）。
  - 图片插入：按 position 分组，同位置按 order 排序，以 `![](路径)` 插入对应小节之间；`top` 插文首（标题后）、`bottom` 插文末。
  - 图片路径解析（wenyan-mcp 支持本地绝对路径与网络 URL）：
    - `storage_url` 形如 `/static/assets/images/{session_dir}/{file}`（FastAPI 静态挂载的 Web 路径，见 `main.py` 的 `/static/assets` 挂载）→ 去掉 `/static` 前缀并拼接数据目录，得到本地绝对路径 `{data_dir}/assets/images/{session_dir}/{file}`；
    - `http(s)://` 开头的外链保持原样传入；
    - 解析后本地文件不存在时报 `PUBLISH_ASSET_MISSING` 错误（防止发布坏链文章）。
  - 输出同时落盘临时文件（如 `backend/data/publish_tmp/{uuid}.md`，发布后可保留供快照）。
- 发布执行 `execute_publish(...)`：
  - 组装 → 落盘 → 调用 `WenyanMcpClient.publish_article`（fake 模式走 T007 假实现）→ 写 `publish_records`。
  - 同步等待，FastAPI 路由层超时 120s；失败记录 `error_code/error_message` 并向前端返回结构化错误。
  - 防呆：未选任何图片允许发布（纯文字）；封面未选时文颜自动取正文第一张图（无需后端处理）。

**API 路由（`backend/app/main.py`）**

- `GET /api/publish/themes`：透传主题列表（id/name/description）。
- `POST /api/publish/preview`：
  - 入参：`article_id`、`version_id`（可选，默认当前版本）、`image_placements`、`cover_asset_id`（可选）、`author`（可选）。
  - 返回：`{ sections: [...], markdown: "组装后全文" }`——sections 供前端渲染位置选择器，markdown 供预览编辑框回填。
- `POST /api/publish/articles/{article_id}`：
  - 入参同 preview，另加 `theme_id`、`edited_markdown`（可选；用户在预览步手动改过则以它为准，跳过重新组装）。
  - 行为：执行发布 → 返回 `{ publish_id, media_id, status }`；失败返回结构化错误（含 `PUBLISH_CREDENTIALS_MISSING` / `PUBLISH_TIMEOUT` / `PUBLISH_MCP_ERROR` 等错误码）。
- `GET /api/publish/records?article_id=`：发布记录列表（时间倒序，联表 `articles` 返回 `article_title`，含 media_id/状态/主题/快照引用；`article_id` 省略时返回全部文章的记录，供发布记录页使用）。
- `GET /api/publish/records/{id}`：单条记录详情（含 content_snapshot，供查看当时发布内容）。

**图片来源**

- 可选图片 = 该文章关联的 `image_generation_sessions` 下已保存为 `assets` 的图片（沿用现有 assets 查询能力，按 `source_session_id` 关联文章）。

### 3.2 不实现

- 定时发布、群发（群发只能由公众号后台人工操作，符合"个人账号 + 草稿箱"定位）。
- 发布记录的编辑/删除接口。
- 图片素材库跨文章复用发布。
- Server 模式多公众号。

## 4. 测试

- pytest 单元测试（全部走 fake 模式）：
  - `split_sections`：有/无 H2、连续 H2、空正文等边界。
  - `build_publish_markdown`：frontmatter 字段正确性；top/after_section/bottom 插入位置与顺序；多图同位置排序；无图片纯文字。
  - 发布路由集成测试（httpx + 临时库）：preview 返回 sections+markdown；publish 成功写入 records 且返回 FAKE media_id；凭据缺失错误码透传；edited_markdown 优先生效；records 列表返回 `article_title` 且省略 `article_id` 时返回全部记录。
- 全量 pytest 回归通过。

## 5. 验收标准

- [x] `publish_records` 表随启动自动创建，含发布快照与图片位置 JSON。
- [x] `split_sections` 按上述规则切分并通过边界测试。
- [x] `build_publish_markdown` 输出含合法 frontmatter（title/cover/author）与正确图片位置。
- [x] 四组路由按契约工作，错误均为结构化 `{code, message}`。
- [x] 同步发布超时上限 120s，超时返回 `PUBLISH_TIMEOUT`。
- [x] fake 模式下全流程不产生真实网络请求。
- [x] 新增 pytest 用例通过；全量回归通过。
- [x] `prototype/` 目录未被改动。

## 6. 完成定义

上述验收全部通过后，T008 完成：前端即可基于这四组 API 完成发布工作台（T009）。
