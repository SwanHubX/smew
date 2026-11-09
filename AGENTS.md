# AGENTS.md

smew 平滑算法库（Rust/WASM + TS 回退）。本文件是 agent 的入口：项目定位、命令、硬约束和文档路由。

## 项目定位

折线图平滑算法库：TWE / RA / GS 三算法，Rust 编译 WASM 优先，纯 TS 回退，双实现对拍一致。发布为 npm 包 `smew`。

技术栈与版本以 `package.json` 与 `Cargo.toml` 为准。

## 环境与命令

- TS 侧：`npm run lint`、`npx tsc --build tsconfig.json`、`npm run test`
- Rust 侧（在仓库根目录）：`cargo fmt --check`、`cargo check`、`cargo test`、`cargo clippy --target wasm32-unknown-unknown`、`cargo build --target wasm32-unknown-unknown`
- 完整命令与产物重建见 `docs/agents/smew.md` 的「验证命令」

## 硬约束

以下为入口摘要，细则与判定标准以 `docs/agents/smew.md` 为准；冲突时以规范正文为准。

1. 三个导出函数（twe / ra / gs）的签名与语义已冻结，任何变更必须先评审，并同步声明文件。
2. 行为权威源是 TS 实现；算法改动必须跑 JS↔Rust 对拍（`tests/parity.test.ts`），不接受"肉眼对比曲线"。
3. 禁止 `unsafe`；禁止 panic 逃逸到 JS；绑定代码只出现在绑定层。
4. 注释只说明为什么，禁止写入提示词或 AI 工作过程记录。
5. 不编辑生成物与依赖安装目录（`node_modules` 等）；`dist/**`、`types/**` 按子项目流程重建，不手改。
6. 用户指令与代码、规范或已核实的事实冲突时，先指出冲突点与依据，再按确认后的方向执行；不静默执行已知错误的指令，也不因存在冲突就自行改需求。

## 文档路由

| 改动路径或内容              | 读                    |
| --------------------------- | --------------------- |
| 所有代码与产物（`dist/**`、`types/**`、`src/**`、`ts/**`、`index.ts`） | `docs/agents/smew.md` |
| 提交信息、commit            | `docs/agents/commit.md` |
| 分支名、PR 标题与描述       | `docs/agents/pr.md`   |
| `docs/commands/**`、`docs/skills/**`（命令与审核技能） | `docs/agents/pr.md` |

## 提交

- commit 信息、分支名与 PR 标题用英文；PR 描述、issue、评论与文档正文用中文
- 提交信息用纯文本，不要用 Markdown 代码块包裹
- 完整规则：commit 见 `docs/agents/commit.md`，分支与 PR 见 `docs/agents/pr.md`
