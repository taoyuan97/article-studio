# ISSUE-001：真实发布失败（EPERM 写 token 缓存 + 缺封面图校验）

## 1. 缺陷信息

| 项 | 内容 |
| --- | --- |
| 编号 | ISSUE-001 |
| 发现日期 | 2026-08-24 |
| 状态 | 已修复并验证 |
| 严重级别 | 高（真实发布线完全不可用） |
| 影响范围 | `PUBLISH_FAKE_MODE=false` 真实发布；fake 模式不受影响 |
| 发现场景 | T007–T010 交付后人工验收：从发布向导真实发布文章失败 |
| 关联任务 | T007 / T010（`docs/task/T007`、`docs/task/T010`） |
| 关联操作文档 | `docs/ops/manual-tasks-t007-t010.md` §6 |

## 2. 现象

发布向导走完四步后点击发布，失败态展示：

> 公众号接口调用失败：常见原因为 IP 不在白名单（错误码 40164）或 AppSecret 有误，请检查后重试。
> 错误码：`PUBLISH_MCP_ERROR`

发布记录详情中可见 wenyan-mcp 原始错误：

```
执行工具失败： 无法保存 token: EPERM: operation not permitted, open
'C:\Users\18520\AppData\Roaming\wenyan-md\token.json.tmp'
```

修复 EPERM 后重放发布，暴露第二个问题（微信侧硬校验）：

```
执行工具失败： 你必须指定一张封面图或者在正文中至少出现一张图片
```

## 3. 排查过程与根因

### 3.1 缺陷 A：EPERM 写 token 缓存

排查步骤（逐层排除）：

1. **排除微信侧配置错误**：错误发生在「保存 token」阶段，且 token 已从微信成功获取——证明 AppID/AppSecret/IP 白名单全部正确（IP 不在白名单会在取 token 时直接报 40164）。
2. **排除目录 ACL 问题**：`AppData\Roaming\wenyan-md` 目录当前用户 FullControl，PowerShell 直接写入成功。
3. **排除按可执行文件拦截**（Defender 可控文件夹访问等）：从普通上下文运行 `node.exe` 写同一目录成功；Defender CFA 状态为关闭。
4. **对比复现**：经后端 API 重放发布稳定复现 EPERM；其他上下文全部可写。差异仅剩「进程令牌」。
5. **定位根因**：后端进程由 TRAE IDE 沙箱化终端启动（后端日志出现 `TRAE Sandbox Error: hit restricted`），其派生的 wenyan-mcp 子进程继承受限令牌，对 `%APPDATA%` 部分路径无写权限。

根因：**沙箱/受限令牌环境下，后端子进程对 `%APPDATA%\wenyan-md` 不可写**。原实现未重定向 wenyan-mcp 的配置目录，token 缓存写入失败导致整个发布流程中断。

### 3.2 缺陷 B：缺封面图发布被微信拒绝

根因：微信公众号「新建草稿」接口硬性要求图文消息必须有封面图（thumb_media_id）或正文至少含一张图。原发布向导允许纯文字发布（文档甚至写明「不选图可发纯文字」），与微信实际约束不符；前端 `PUBLISH_MCP_ERROR` 文案又只归因于 IP 白名单/AppSecret，误导排障。

## 4. 修复方案

### 4.1 缺陷 A：配置目录重定向（代码修复）

wenyan-mcp 支持 `XDG_CONFIG_HOME` 环境变量重定向配置目录（优先级最高）。后端将该变量注入子进程环境，指向 `DATA_DIR`（后端对其有确凿写权限：SQLite、assets、publish_tmp 均在其中正常工作）：

| 文件 | 改动 |
| --- | --- |
| `backend/app/wenyan_client.py` | `WenyanMcpClient` 新增 `data_dir` 参数与 `_subprocess_env()`：子进程环境注入凭据 + `XDG_CONFIG_HOME=str(data_dir)`；wenyan-mcp 的 token 缓存随之落到 `DATA_DIR/wenyan-md/`（该目录随 `data/` 被 `.gitignore` 排除） |
| `backend/app/main.py` | 工厂函数构造客户端时传入 `resolved_data_dir` |
| `backend/tests/test_wenyan_client.py` | 新增 2 个用例：`_subprocess_env()` 含凭据且重定向生效 / 未传 `data_dir` 时不覆写环境 |

### 4.2 缺陷 B：错误信息与文档修正（不做发布强拦截）

- `frontend/src/features/publish/errorText.ts`：`PUBLISH_MCP_ERROR` 文案补充「未选择封面图」这一常见原因，并引导查看详情。
- `frontend/src/pages/PublishPage.tsx`：失败面板在 `PUBLISH_MCP_ERROR` 时展示后端返回的具体错误信息（`errorMessage`），不再只显示泛化文案。
- `docs/ops/manual-tasks-t007-t010.md`：§5 修正「不选图可发纯文字」为微信硬性要求说明；§6 错误对照表新增「缺封面图」与「EPERM token.json」两行。

> 未在前端强制「必须选封面」的原因：微信约束是「封面或正文图至少其一」，正文插图即可满足，前端强拦截会误伤合法操作；错误详情透出后用户可自行判断。

## 5. 验证结果

- **真实发布成功**（经后端 API 以同一文章参数重放）：《缓解头部的紧张练习引导》+ 封面图（素材「梅雨季-头部按摩」）发布成功，`media_id: h9fLPP1c_XdlKCD4R2eAZG5WX--iaI21mkkumfaFAFBt3TsI1AR0hqO2nmxpKeX7`，草稿已进入公众号草稿箱。
- **token 缓存落位确认**：`backend/data/wenyan-md/token.json` 写入成功（EPERM 消失即重定向生效的直接证据）。
- **回归**：后端 pytest **84 passed**（原 82 + 新增 2）；前端 `errorText`/`PublishPage` Vitest 10 passed；ESLint 零错误。
- **发布记录留痕**：发布记录页可见本缺陷完整排障历史（3 条失败：EPERM ×2、缺封面 ×1；1 条成功），失败详情可展开查看具体原因。

## 6. 经验与约定

1. **沙箱启动的后端派生子进程不继承普通用户写权限**：凡子进程需要写文件的（MCP 配置、缓存），一律显式重定向到项目 `DATA_DIR`，不依赖 `%APPDATA%` 等用户目录。
2. **错误文案不得只列举部分成因**：`PUBLISH_MCP_ERROR` 这类「外部工具执行失败」聚合码，必须透出原始错误详情供排障，泛化文案只作导航。
3. **外部平台硬校验要在操作文档中前置声明**：微信草稿「必须有封面或正文图」这类约束，写入冒烟清单（§5）而非让用户在失败中发现。
