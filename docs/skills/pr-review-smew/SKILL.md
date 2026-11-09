---
name: pr-review-smew
description:
  Use when reviewing smew Rust/WASM PRs, running cargo check/build/test for wasm32-unknown-unknown,
  reviewing wasm-bindgen exports (twe/ra/gs), NaN missing-value semantics, smoothing algorithm implementations, prebuilt
  artifacts under dist/**, or running smew's self-hosted TS checks (npm run lint, tsc --build tsconfig.json, npm run
  test). Reviews locally first and only posts to GitHub after the user confirms.
---

# PR 审核 (smew)

## 概述

按照 smew Rust 工程约定审核 Pull Request，并用 `gh`
CLI 提交结构化结论。重点确认变更不破坏 JS/WASM 接口契约、缺失值语义与位级一致性承诺，不引入 panic 逃逸、unsafe、绑定层污染和产物漂移。

技术栈：**Rust（edition 2024）**、**wasm-bindgen 0.2**、编译目标 **wasm32-unknown-unknown**。TS 侧为纯 TS 库，lint /
类型检查 / 测试配置全部自持于仓库内。工程位于仓库根目录，crate 名
`smew`，crate-type 为 `cdylib` + `rlib`。

适用：PR 合并前审核、`cargo check` / `cargo build` / `cargo test`、TS 侧的 lint
/ 类型检查 / 测试、检查 wasm-bindgen 导出、平滑算法实现、预构建产物同步。

不适用：无 PR 上下文的本地单文件编辑、只要求解释代码。

## 审核流程

先确定审核目标：用户指定 PR 编号或 URL 时以其为准；未指定时默认执行
`gh pr view --json number,url,headRefName,baseRefName`，通过当前分支推断关联 PR，无需先询问编号。认证、网络等查询失败不等于"没有 PR"，应如实说明阻碍。

审核分为两个阶段，**默认只执行阶段一**。未获得用户明确确认前，不得向 GitHub 提交任何 review、comment 或审批状态。

### 阶段一：审查（默认）

1. 先确认 PR 意图、base 分支、head 分支、文件列表和 Actions 状态，再阅读实现：

```bash
gh pr view <PR> --json files,additions,deletions,baseRefName,headRefName
gh pr diff <PR>
gh pr checks <PR>
```

2. 直接在当前工作区 checkout 到 PR head 审核，不创建单独的 worktree。开始前先用 `git branch --show-current`
   记录原分支（审核结束后恢复）；工作区存在未提交改动时停下来询问用户，不要继续：

```bash
git status
gh pr checkout <PR>
```

3. 按下方"范围参考"读取 [`../../agents/smew.md`](../../agents/smew.md) 中对应章节。所有代码都要检查"横切规范"；涉及产物目录时额外检查产物同步。
4. 对关键发现检查 head 分支中的完整文件，不只依据 diff 片段。
5. 在对话中输出完整审查意见草稿：结论、逐条 finding（含文件与行号）、验证结果。**到此停止**，明确告知用户尚未发布，并询问是否发布。无论用户是否选择发布，审核暂告一段落时都先切回原分支，避免工作区停留在被审核分支：

```bash
git checkout <原分支>
```

### 阶段二：发布（需用户显式确认）

仅当用户在阶段一之后明确要求发布时才执行。发布前把最终结论和 `event` 类型（`APPROVE` / `REQUEST_CHANGES` /
`COMMENT`）复述给用户确认。发布后回报 review 链接，并切回原分支：

```bash
git checkout <原分支>
```

## 范围参考

详细规则位于
[`../../agents/smew.md`](../../agents/smew.md)。先读取 PR 文件列表，再按下表加载适用章节。同一文件命中多行时，读取所有命中章节。

| 变更路径或内容                                                              | 读取章节                                                                         |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/lib.rs`、接口签名变更、`dist/index.d.ts`                               | 接口契约                                                                         |
| `index.ts` 公共入口与回退调度                                               | 接口契约 + 回退路径                                                              |
| `src/{twe,ra,gs}.rs` 平滑算法实现                                           | 算法实现与一致性（有真实算法实现时）                                             |
| `ts/**`（TS 回退实现）                                                      | 算法实现与一致性 + 横切规范                                                      |
| `dist/**` 预构建产物                                                        | 产物同步（存在预构建产物时）                                                     |
| `Cargo.toml`、`Cargo.lock`、内嵌脚本变更                                    | 工程与工具链 + 产物同步                                                          |
| `package.json`、`tsconfig.json`、`eslint.config.mjs`、`vitest.config.ts`、`scripts/inline-wasm.mjs`、`.github/workflows/**` | 工程与工具链                     |
| `bench/**`（基准脚本与报告）                                                | 工程与工具链 + 方法学口径（计时口径定义、可复现性、checksum 防优化、数值一致性） |
| 所有代码                                                                    | 横切规范                                                                         |
| 凭据、网络、文件路径、用户数据                                              | 安全与隐私                                                                       |

上表未命中的路径仍需按"横切规范"审核，并在 review 中说明该文件按通用标准处理。

## 验证要求

Rust 侧在仓库根目录运行：

```bash
cargo fmt --check
cargo check
cargo test
cargo clippy --target wasm32-unknown-unknown
cargo build --target wasm32-unknown-unknown
```

TS 侧在仓库根目录运行（lint / 类型检查 / 测试均为自持配置）：

```bash
npm run lint
npx tsc --build tsconfig.json
npm run test
```

涉及产物同步的 PR，还需确认 `dist/` 已随源码同 PR 更新（审核时可重跑 `npm run build:wasm` 并对 `dist/`
做 `git diff --exit-code` 验证产物可复现：无 diff 即为源码与产物同步）。

CI 现状：由专用 workflow `.github/workflows/test.yml` 覆盖——TS 侧跑上述三项（vitest 含 parity 对拍，会加载 dist 并实例化）；
Rust 侧 `rust-check` job 跑
`cargo fmt --check`、
`clippy --target wasm32-unknown-unknown -- -D warnings`（硬门禁）、`cargo build --target wasm32-unknown-unknown`
与单元测试。因此：

- TS 侧：CI 已覆盖；本地复核仍建议执行，Actions 未跑完或失败时以本地结果为准
- Rust 侧：fmt / clippy（`-D warnings` 硬门禁）/
  wasm 完整构建 / 单元测试全部在 CI；本地复核仍建议执行，Actions 未跑完或失败时以本地结果为准
- 产物同步：CI 不验证（本地重建依赖本机 wasm-pack 版本），由人工契约保证——修改 `.rs`
  的 PR 必须同 PR 重建并提交 dist，审核时可本地重跑 `npm run build:wasm` 复核（无 diff 即同步）

`cargo fmt --check` 与 `cargo clippy -- -D warnings`
在 CI 中均为红绿门禁：本地复核失败时按阻塞级发现处理；确需豁免的告警统一走显式
`#[allow]` + 注释说明理由（豁免本身可评审）。

## 严重性

| 前缀           | 含义           | 作者需要                                                                                   |
| -------------- | -------------- | ------------------------------------------------------------------------------------------ |
| **阻塞：**     | 阻塞合并       | panic 逃逸到 JS、接口签名未评审变更、产物与源码不同步、引入 `unsafe`、数据正确性破坏       |
| **必须修改：** | 合并前必须处理 | 缺失值语义与契约不符、算法遍历顺序与 JS 版不一致、纯算法模块混入 wasm-bindgen、d.ts 不同步 |
| **建议：**     | 建议处理       | 值得改进但不阻塞，例如命名、局部抽象、测试覆盖提升                                         |
| **细节：**     | 次要问题       | 格式、微小风格问题，通常可由 `cargo fmt` 处理                                              |
| **说明：**     | 信息记录       | 不要求行动，记录上下文或后续风险                                                           |

每条 finding 都必须使用对应的显式前缀，不能用无前缀文本表示"必须修改"。

## 提交审核

优先把可行动的 finding 提交为 PR diff 上的 inline review comment，方便作者逐条 Resolve。顶层 review
body 用于审核结论和无法挂到 diff 行的问题，不要在顶层正文重复 inline finding。

### 选择提交方式

- 无 finding 或只需总评：用 `gh pr review --approve/--comment --body-file` 提交顶层结论。
- 有可定位 finding：用 `gh api repos/{owner}/{repo}/pulls/<PR>/reviews --input /tmp/pr-review.json`
  批量创建一次 review，并把每个 finding 放进 `comments[]`。
- 有阻塞或必须修改 finding：review `event` 使用 `REQUEST_CHANGES`；只有建议、细节或说明时使用
  `COMMENT`；确认通过且无可行动 finding 时才使用 `APPROVE`。
- 无法挂到 diff 行的 finding：例如缺少测试、缺少文档或跨文件架构问题，放进顶层 `body`
  的"未挂行发现"部分，不要强行挂到无关代码行。
- PR 作者对自己的 PR 发起审核时，GitHub 不允许 `APPROVE` / `REQUEST_CHANGES`：改用 `COMMENT`
  提交，但正文仍明确写出实际的"通过"或"要求修改"结论。

### 定位 inline comment

先获取 patch，确认 finding 的位置在 PR diff 中：

```bash
gh pr diff <PR> --patch --color=never
```

定位规则：

- 新增或修改后的代码使用 `side: "RIGHT"`，`line` 是新文件行号。
- 删除导致的问题使用 `side: "LEFT"`，`line` 是旧文件行号。
- 多行问题可使用 `start_line`、`line`、`start_side`、`side`，但单行评论更稳定。
- 只评论 diff 中存在的行；目标行不在 diff 中时放进顶层 `body`。
- 每条 inline comment 只包含一个独立 finding，并以严重性前缀开头，说明问题、影响和建议。

### 提交 inline review

将 review 写入 `/tmp/pr-review.json`，再提交：

```bash
gh api --method POST repos/{owner}/{repo}/pulls/<PR>/reviews --input /tmp/pr-review.json
```

JSON 结构如下。`body` 使用下一节的顶层正文模板，提交前替换占位文本；不要在 JSON 示例中维护第二份转义后的正文模板。

```json
{
  "event": "REQUEST_CHANGES",
  "body": "<使用下一节的顶层正文结构>",
  "comments": [
    {
      "path": "src/gs.rs",
      "line": 12,
      "side": "RIGHT",
      "body": "**必须修改:** 缺失值在此处参与了加权求和。\n\n影响：NaN 会污染卷积结果，与 JS 版行为不一致。\n\n建议：跳过非有限值，并用剩余有效权重重新归一化。"
    }
  ]
}
```

### 顶层 review 正文

Reviews API 的 `body` 和 `gh pr review --body-file` 共用以下正文结构。有 inline
finding 时不要在正文重复；没有 inline
finding 时通过以下命令提交：

```bash
gh pr review <PR> --request-changes --body-file /tmp/pr-review-body.md
gh pr review <PR> --approve --body-file /tmp/pr-review-body.md
gh pr review <PR> --comment --body-file /tmp/pr-review-body.md
```

顶层正文结构：

```markdown
## 审核结论: 通过 / 要求修改 / 评论

## 本次 PR 解决的问题

<一句话概述>

## 审核范围

- [x] 接口契约: <是/否 — 详情>
- [x] 算法实现与一致性: <是/否 — 详情>
- [x] 产物同步: <是/否 — 详情>
- [x] 回退路径: <是/否 — 详情>
- [x] 工程与工具链: <是/否 — 详情>
- [x] 横切规范: <是/否 — 详情>
- [x] 安全与隐私: <是/否 — 详情>
- [x] 验证与测试: <是/否 — 详情>

## 未挂行发现

### **阻塞:** <问题标题>

- 位置：`src/path.rs:42`
- 说明：...
- 影响：...
- 建议：...

### **必须修改:** <问题标题>

- 位置：`src/path.rs:42`
- 说明：...
- 影响：...
- 建议：...

### **建议:** <问题标题>

- 位置：`src/path.rs:42`
- 说明：...
- 建议：...

### **细节:** <问题标题>

- 位置：`src/path.rs:42`
- 说明：...

### **说明:** <标题>

- 说明：...

## 验证

- [ ] cargo fmt --check
- [ ] cargo check
- [ ] cargo test
- [ ] cargo clippy --target wasm32-unknown-unknown
- [ ] cargo build --target wasm32-unknown-unknown
- [ ] npm run lint
- [ ] npx tsc --build tsconfig.json
- [ ] npm run test
- [ ] 产物同步检查（如适用）: <结果、未验证原因或不适用>
- [ ] PR Actions 状态: <Test 已覆盖 TS 侧（含 parity 对拍 dist）与 Rust fmt/clippy(-D
      warnings)/wasm 构建/单测；产物同步靠人工契约，记录本地复核结果或运行中/失败状态>
```

## 完成验证

- [ ] 所有阻塞发现已解决
- [ ] 所有必须修改发现已解决或明确延期并附理由
- [ ] 适用范围维度已确认
- [ ] 若 PR 涉及目录或模块重命名：`SKILL.md` 的范围参考表与验证命令路径已同步更新
- [ ] 适用范围内 `docs/agents/smew.md` 已读取，规范项已逐条核对
- [ ] 仓库内说明文档（含 README）已与 `docs/agents/smew.md` 核对一致性，不一致记为文档债务
- [ ] 本地 `cargo fmt --check` 已通过或明确说明无法运行的原因
- [ ] 本地 `cargo check` 已通过或明确说明无法运行的原因
- [ ] 本地 `cargo test` 已通过或明确说明无法运行的原因
- [ ] 本地 `cargo clippy --target wasm32-unknown-unknown` 已运行，或明确说明无法运行的原因
- [ ] `cargo build --target wasm32-unknown-unknown` 已通过或明确说明无法运行的原因
- [ ] 本地 `npm run lint` 已通过或明确说明无法运行的原因
- [ ] 本地 `npx tsc --build tsconfig.json` 已通过或明确说明无法运行的原因
- [ ] 本地 `npm run test` 已通过或明确说明无法运行的原因
- [ ] （仅阶段二适用）审核结论已通过 Reviews API 或 `gh pr review` 提交；用户选择不发布时记录该决定
- [ ] 可定位 finding 已作为 inline review comments 提交，无法挂行的问题已放入顶层 review body
