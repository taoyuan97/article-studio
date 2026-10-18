# 分支管理工作流（Article Studio）

> 面向在本仓库工作的**所有人（含 AI 编码智能体）**：所有改动必须走「短命分支 → PR → 合并」，**禁止直接推送到 `main`**。
>
> 本文件是**分支流程的唯一事实源**；[AGENT.md](../../AGENT.md) §5 只保留摘要与链接，不重复维护细节。
>
> 参考基线：`solo-dev-git-workflow`（第二大脑工作流母版）与 openself 仓库的 `docs/git/branch-workflow.md`；按本仓库（Windows 单机、AI 主力编码、无 CI）裁剪。

**最后更新**：2026-10-18
**分支模型**：单人 + AI 智能体协作的 PR 流
**合并方式**：默认 **Squash merge**（`main` 上一条提交 = 一次通过验证的完整变更；与现有「一个任务一条提交」历史一致）

---

## 1. 硬规则（不可违反）

| # | 规则 | 落地方式 |
|---|---|---|
| 1 | **禁止直推 `main`** | 本地 `.githooks/pre-push` 拦截（见 §7）；服务端保护可开启（见 §8） |
| 2 | **一律从最新 `main` 拉分支** | 阶段 0 先 `git pull --ff-only`，再 `git switch -c` |
| 3 | **合并统一使用 Squash merge** | 历史线性、可单条 revert；PR 标题将成为 `main` 上的提交标题 |
| 4 | **验证不通过不得建 PR** | 仓库当前无 CI，"验证"小节就是合并的唯一质量凭据（见 §6） |
| 5 | **agent 不自行合并 PR** | 合并必须由人明确授权（"合并""可以合"）；授权后执行并回报结果 |
| 6 | **禁止 force push 到 `main`** | 功能分支只允许 `--force-with-lease`，且仅限自己刚推过、未共享的分支 |
| 7 | **合并后删除分支** | 本地 + 远程各删一次；仓库未开启自动删分支 |
| 8 | **一个分支一个任务** | 禁止多任务共用一个分支；无关改动拆到独立分支/PR |

---

## 2. 角色与权限边界

| 动作 | agent | 人 |
|---|---|---|
| 读代码、跑本地服务、跑测试 | ✅ | ✅ |
| 从最新 `main` 建短命分支 | ✅ | ✅ |
| 分支内 `commit` | ✅（L1 授权后） | ✅ |
| 推送功能分支 | ✅（L1 授权后） | ✅ |
| 创建 PR | ✅（明确授权可代建） | ✅ |
| 合并 PR | ❌ 默认禁止；**仅当次明确授权**后可执行 | ✅ |
| 直推 / force push `main` | ❌ 钩子拦截；禁止 `--no-verify` 绕过 | ⚠️ 仅 §9.5 例外 |
| 移动/删除已有 tag | ❌ | ⚠️ 见 §8 |
| 修改仓库设置（可见性/合并方式/分支保护） | ❌ 属主操作，agent 只给建议 | ✅ |
| 删除已合并的短命分支 | ✅（合并后收尾） | ✅ |

**授权模式**（来自 `agent-collaboration`）：默认 **L0**（写文件/commit/push 前先确认）；人可在任务交接时声明 **L1**（当前分支内可直接 commit/push，PR merge 仍由人完成）。授权不跨会话继承。

---

## 3. 标准流程

每个阶段都有**完成判据**，判据不满足不得进入下一阶段。

### 阶段 0 · 开工前检查

```powershell
git switch main
git pull --ff-only
git status --short                 # 必须无输出（有改动先 commit 或由人确认处置）
git config core.hooksPath          # 必须输出 .githooks（否则先跑 §7.1）
git branch --show-current          # 必须输出 main
```

**完成判据**：在 `main`、工作区干净、与 `origin/main` 同步、钩子已启用。

### 阶段 1 · 建分支

```powershell
git switch -c <type>/<主题>
```

命名规则见 §4。功能/修复分支必须带任务编号（如 `feature/T021-article-studio-mcp`）。

**完成判据**：`git branch --show-current` 显示新分支名，且起点是刚拉取的 `main`。

### 阶段 2 · 开发与提交

```powershell
git add -A
git commit -m "<type>: <TNNN> <一句话>" -m "- 要点 1`n- 要点 2"
```

- 一个 commit 一个意图；分支内允许 WIP 提交，合入时 squash 成一条。
- 涉及行为/决策/验证方式变化时，同步更新 `docs/task/TNNN-*.md`；缺陷另建 `docs/issue/` 记录。
- 不把 `backend/data/`、`.env`、`settings.json`、图片资产等运行时文件加入暂存。

**完成判据**：`git status --short` 无输出。

### 阶段 3 · 本地验证（不可跳过）

按改动范围执行基线 + 任务匹配测试（命令见 [AGENT.md](../../AGENT.md) §7）：

```powershell
cd backend ; uv run pytest -p no:cacheprovider     # 后端改动必跑
cd frontend ; pnpm test                            # 前端改动必跑
cd frontend ; pnpm lint ; pnpm build               # 前端改动基线
git diff --check                                   # 空白错误基线
```

- 文档/纯工程改动：至少 `git diff --check`，并在 PR 里注明「跳过 test 验证」及原因。
- 涉及 MCP 时追加：`uv run python scripts/mcp_smoke.py`（先启动 `dev_fake_server`）。
- **不允许**把"应该没问题"写进验证结论。

**完成判据**：验证结果足以填写 PR 的「验证」小节。

### 阶段 4 · 推送分支

```powershell
git push -u origin <branch>
```

- 钩子只拦截 `main` / `master`；若被拦见 §9.1。
- 推送需鉴权时优先复用 gh 登录态：`git -c credential.helper= -c credential.helper='!gh auth git-credential' push -u origin <branch>`。

**完成判据**：`git rev-parse HEAD` 与 `git ls-remote origin refs/heads/<branch>` 一致。

### 阶段 5 · 创建 PR

```powershell
gh pr create --base main --head <branch> --title "<type>: <TNNN> <一句话>" --body-file <描述文件>
```

- 描述套用 [.github/pull_request_template.md](../../.github/pull_request_template.md)。
- **PR 标题遵守 §5**（squash 后它成为 `main` 的提交标题）。

**完成判据**：输出 PR 链接；`gh pr view <n> --json mergeable` 为 `MERGEABLE`。

### 阶段 6 · 等待人工确认

agent 在此停止，报告：PR 链接、验证结果、需要人决定的事项。**不合并。**

### 阶段 7 · 合并（人工或授权后）

- 默认由人在 GitHub 页面点 **Squash and merge**；
- 人明确授权时，agent 执行 `gh pr merge <n> --squash`，随后回报结果；
- 合并信息格式：

  ```text
  <type>: <TNNN> <PR 标题>

  - 主要改动要点 1
  - 主要改动要点 2
  - 验证结论
  ```

**完成判据**：`gh pr view <n> --json state` 为 `MERGED`。

### 阶段 8 · 合并后收尾

```powershell
git switch main
git fetch origin --prune
git pull --ff-only
git branch -d <branch>
git push origin --delete <branch>
git branch -r                     # 确认远端分支已消失
git log --oneline -3              # 确认 squash 提交已在 main 上
```

**完成判据**：本地与远程都只剩 `main`，工作区干净。

---

## 4. 分支命名

格式：`<type>/<主题>`；主题用**小写英文 kebab-case**。

| type | 用途 | 示例 |
|---|---|---|
| `feature` | 新功能 / 新模块（**必须带任务编号**） | `feature/T021-article-studio-mcp` |
| `fix` | 非紧急缺陷修复（**必须带任务编号**） | `fix/T023-mcp-timeout` |
| `hotfix` | 线上紧急修复，从 `main` 拉出 | `hotfix/publish-40164` |
| `docs` | 文档、流程、说明 | `docs/repo-governance` |
| `chore` | 构建、依赖、脚本、仓库维护 | `chore/hooks-setup` |
| `refactor` | 不改行为的结构调整 | `refactor/publish-service-split` |

- 禁止：空格、中文、大写字母、`main` / `master` / `dev` 这类通用名。
- 任务编号与 `docs/task/TNNN-*.md` 一致；一个任务一个分支。

---

## 5. 提交信息

```text
<type>: <TNNN> <一句话总结>

- 要点 1
- 要点 2
```

- `type` ∈ `feat` / `fix` / `docs` / `chore` / `refactor`；无任务编号的工程/文档提交可省略 `TNNN`。
- 语言：中文；正文用 `-` 列要点；涉及决策时写清「为什么」。
- **squash 合并后保留 PR 标题 + 合并信息**，因此 PR 标题同样遵守本规范。
- 存量提交不追溯；不修改已推送的公共提交历史。

---

## 6. PR 规范

- 描述结构固定（模板见 [.github/pull_request_template.md](../../.github/pull_request_template.md)）：对应任务 / 改动概要 / 验证结论 / 跳过 test 说明 / 检查清单。
- **「验证结论」必填**：写实际跑过的命令与现象，区分基线验证与任务匹配验证。
- **一个 PR 一件事**；无关改动拆到另一个分支。
- agent 建完 PR 即停；合并由人授权。
- 合并方式固定 **Squash**（见 §1 规则 3）；建议属主在仓库设置里只保留 Allow squash merging（§8，留人工）。

---

## 7. 本地防线（pre-push hook）

### 7.1 启用（每个克隆一次）

```powershell
git config core.hooksPath .githooks
git config core.hooksPath            # 应输出 .githooks
```

Windows 也可双击 `scripts\setup-hooks.cmd`，它会设置并校验，同时跑两条钩子自测。

`.githooks/pre-push` 拦截推送到 `refs/heads/main` 与 `refs/heads/master`（含 force push、删除 main）。`.gitattributes` 已固定 `.githooks/** text eol=lf`——Windows 上若钩子被检出为 CRLF，会因 `bad interpreter` **静默失效**。

### 7.2 启用后必须实测两条路径（不实测等于没启用）

```powershell
# 1) 直推 main：预期被拦截（exit 1）
git push --dry-run origin HEAD:refs/heads/main

# 2) 推功能分支：预期放行（exit 0 / dry-run 成功）
git push --dry-run origin HEAD:refs/heads/chore/hook-check
```

若网络/鉴权不可用，可退化为本地钩子直测（结果等价）：

```powershell
"refs/heads/local 0000000000000000000000000000000000000000 refs/heads/main 0000000000000000000000000000000000000000" |
  & "C:\Program Files\Git\bin\sh.exe" .githooks/pre-push origin origin   # 预期 exit 1
"refs/heads/local 0000000000000000000000000000000000000000 refs/heads/feature/x 0000000000000000000000000000000000000000" |
  & "C:\Program Files\Git\bin\sh.exe" .githooks/pre-push origin origin   # 预期 exit 0
```

### 7.3 逃生口

确需绕过（明确知道自己在做什么，且仅限 §9.5 hotfix 例外）：`git push --no-verify origin ...`。**agent 无权自行使用**。

---

## 8. 服务端保护现状与建议（属主操作）

**实测现状（2026-10-18）**：仓库 `taoyuan97/article-studio` 为 **Public**，当前账号 `taoyuan97` 具备 **ADMIN** 权限，因此 GitHub Rulesets / Branch protection **可用**。

建议由**仓库属主**在 GitHub 上开启（agent 不自行修改仓库设置）：

1. **Settings → Rules → Rulesets → New branch ruleset**
   - Target branches：`main`
   - 勾选：*Require a pull request before merging*、*Block force pushes*、*Restrict deletions*
2. **Settings → General → Pull Requests**：只保留 **Allow squash merging**，取消 merge commit / rebase。
3. 可选：开启 *Automatically delete head branches*（与 §3 阶段 8 清理一致）。

CLI 等价参考（属主执行）：

```powershell
gh api -X POST repos/taoyuan97/article-studio/rulesets --input ruleset.json
```

在服务端保护开启前，**只有本地钩子 + 本约定生效**，服务端不会阻止任何人直推 `main`。

### 发布与 tag

- 正式发布 = `main` 合并 → 打 SemVer tag（如 `v1.1.0`）→ 部署该 tag。
- **tag 只打在 `main`**；只加不改不删；回滚靠 checkout 旧 tag，不移动 tag。
- agent 打 tag / 推送 tag 需人当次明确授权。

---

## 9. 异常处理

### 9.1 push 被钩子拦住

```text
✗ 已被分支规则拦截：禁止直接推送到 main/master
```

先 `git branch --show-current` 确认分支。多数情况是把提交落在了 `main`：在当前工作区 `git switch -c <type>/<主题>` 把未推送提交带过去，再推功能分支。

### 9.2 push 被拒（non-fast-forward）

```powershell
git fetch origin
git rebase origin/main            # 在功能分支上
git push --force-with-lease origin <branch>
```

**禁止**对 `main` 使用 `--force` / `--force-with-lease`。

### 9.3 合并冲突

在功能分支上 `git rebase origin/main` 解决；冲突大或涉及数据/契约时先停下来问人，不猜。

### 9.4 误推了 `main`

1. 立即建分支保存现场：`git branch rescue/<日期>`；
2. 用 PR 补 `git revert`（或在 GitHub 上 revert 对应提交）；
3. 在 PR 描述里写明误推原因与影响范围。

### 9.5 hotfix 例外（仅人工决策）

生产事故时**由人决定**是否允许 `git push --no-verify origin main` 直推修复。agent 无权自行启用；直推后 24 小时内补等价 PR（含验证记录），例外记录写入 `docs/issue/`。

### 9.6 鉴权失败（fetch / pull / push）

```powershell
git -c credential.helper= -c credential.helper='!gh auth git-credential' fetch origin --prune
git -c credential.helper= -c credential.helper='!gh auth git-credential' pull --ff-only
```

---

## 10. 与其他文档的关系

| 文档 | 关系 |
|---|---|
| [AGENT.md](../../AGENT.md) | 仓库 AI 工作手册；§5 是本文件的摘要与入口，技术约束以 AGENT.md 为准 |
| `docs/task/TNNN-*.md` | 每次任务的目标 / 决策 / 改动清单 / 验证 / 验收 |
| `docs/version/` | 历史版本的任务与 issue 归档 |
| `docs/tech/tech-design.md` | 技术设计与架构约束 |
| `.githooks/pre-push` | 硬规则 1 的本地技术实现 |
| `scripts/setup-hooks.cmd` | Windows 一键启用 + 自测 |
| `.github/pull_request_template.md` | PR 描述模板 |

修改本工作流本身：走 `docs/` 前缀分支 + PR，并同步检查 AGENT.md §5 的摘要是否仍准确。

---

## 11. 变更记录

- 2026-10-18 初版：按 `solo-dev-git-workflow` 与本仓库现状建立短命分支 + PR + Squash 模型；落地本地 `.githooks/pre-push`、Windows 启用脚本与 PR 模板；补充服务端保护现状（Public + ADMIN，可开启 Rulesets，留属主操作）。
