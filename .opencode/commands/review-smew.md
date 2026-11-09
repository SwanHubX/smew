---
description: 审核 smew Rust/WASM PR（pr-review-smew skill）
agent: plan
---

使用 `skill` 工具加载 `pr-review-smew`，然后严格按其中的流程执行审核。

审核目标：`$ARGUMENTS`

- 携带 PR 编号/URL 时以其为准；为空时按 skill 的规则从当前分支推断关联 PR。
- 默认只执行阶段一（审查），输出完整审查草稿后停止；未获用户明确确认前，不向 GitHub 提交任何 review、comment 或审批。
- 顺带核对 commit 信息、分支名与 PR 标题是否为全英文，以及 PR 描述、issue、评论与文档正文是否为中文；不符合时记为 finding。
- 判据以 skill 和 `docs/agents/*` 为准；本命令只负责入口与参数，不额外增加或放宽要求。
