# 参与开发

打算为 smew 做贡献？这份指南覆盖从本地跑通到提交 PR 的完整流程。

npm 用户的安装与使用文档见 [README.md](./README.md)。工程规范的规则正文在 `docs/agents/`，入口是 `AGENTS.md`，本文与其冲突时以规范正文为准。

## 🛠 本地跑通

```bash
git clone git@github.com:SwanHubX/smew.git && cd smew
npm install
npm run test          # 69 个测试应全绿，包括 TS ↔ Rust 对拍
```

日常最常用的三条：

```bash
npm run test                      # vitest（含 parity 对拍）
npx tsc --build tsconfig.json     # 类型检查
npm run lint                      # eslint
```

Rust 侧检查，改了 `.rs` 才需要：

```bash
cargo fmt --check && cargo test
cargo clippy --target wasm32-unknown-unknown -- -D warnings   # CI 硬门禁
```

## 🧱 代码是怎么分层的

| 层 | 文件 | 职责 |
| :--- | :--- | :--- |
| **公共入口层** | `index.ts` | 统一 API：调度 WASM / TS 回退 |
| **Rust 算法函数层** | `src/algorithms/`，含 `twe.rs`、`ra.rs`、`gs.rs` | 纯计算，不接触 wasm-bindgen |
| **数值内核层** | `src/utils/numeric.rs` | safeLerp / safeWeightRatio，TS 正本镜像 |
| **wasm-bindgen 导出层** | `src/lib.rs` | JS 类型转换与绑定 |

几条约束：绑定代码只允许出现在绑定层，算法层必须能在原生工具链下直接测试。Rust 侧原始导出为 `twe` / `ra` / `gs`，wasm-bindgen 不做驼峰转换。`dist/wasm.d.ts` 描述的就是这层导出，必须与实际一致。

## 🔁 两套实现，必须说一致

smew 的核心资产是「Rust 与 TS 双实现、输出严格一致」，所以：

- **行为权威源是 TS 实现**：两边不一致时默认 TS 为准。想让行为变？那属于接口变更，先声明、先评审。
- **TWE / RA 位级一致**：有限值的浮点位模式必须完全相同，用 `f64::to_bits()` 对比，不接受任何误差容差。
- **GS 按容差**：高斯核依赖 `exp`，不同平台末位可能不同。缺失位置与语义严格一致，有限值在约定容差内即可。
- **不得改变运算顺序**：折叠次序、权重累加次序都是契约的一部分。优化导致结果差异时，以未优化结果为准，或显式放宽标准并评审。
- 改算法必须跑对拍 `tests/parity.test.ts`，同一组 fixture 断言一致。仅凭人眼观察曲线相似不算验证通过。

缺失值判定口径两侧统一为 JS `Number.isFinite` ↔ Rust `f64::is_finite`，不要发明第二套。

## 📦 改了代码，产物要跟着走

`dist/` 和 `types/` 是生成物，**随源码提交入库、禁止手改**，全靠管线重建。

**WASM 胶水**，改了任何 `.rs` 之后必须重跑：

```bash
npm run build:wasm
# wasm-pack 编译 → scripts/inline-wasm.mjs 把 .wasm 字节转成数字数组内嵌
# → 产出 dist/wasm.js + dist/wasm.d.ts，与源码在同一提交内提交
```

> 📌 `wasm-pack` 建议 v0.15.0，现有 `dist/wasm.js` 就是这个版本生成的，版本不同胶水可能有差异。CI 只跑 cargo 检查，不重建胶水，产物同步只能本机验证。脚本本身是防御式的，wasm-bindgen 产物结构变了会直接报错退出，不会静默生成坏产物。`wasm-opt` 保持默认开启，首次构建会联网下载 wasm-bindgen 与 wasm-opt 到 wasm-pack 缓存目录（macOS 在 `~/Library/Caches/.wasm-pack`），之后离线可用。

**npm 入口**：

```bash
npm run build    # tsup 把 index.ts 编译成 dist/index.js（ESM）
```

`tsup.config.ts` 的插件在 `onLoad` 里把源码的动态 import 从 `./dist/wasm.js` 改写成 `./wasm.js`：源码在仓库根，产物在 `dist/` 内，同一路径两个视角。`external` 必须写**改写后**的 `./wasm.js`，因为改写发生在 esbuild 解析之前，解析器只见过新说明符，写旧路径等于没配，动态 import 会被内联成 chunk。懒加载、失败回退、WebAssembly 守卫三条设计都依赖它原样保留。插件找不到 `./dist/wasm.js` 字面量会直接报错退出，源码改了导入写法时先同步这里。不要加 `--clean`，它会连同目录里的 wasm 产物一起删除。

**类型声明**，改了 `index.ts` / `ts/**` 之后必须重跑：

```bash
npm run build:types
```

CI 会把重新生成的 `types/` 与已提交版本做 diff，漂移即失败。`package.json` 里 `types` 条件必须排在 `import` 之前，TS 按键顺序匹配，排在后面会被 `import` 抢走，退回源码解析。

声明文件原样保留源码的导入路径，而 `node16` / `nodenext` 的消费者要求相对导入带扩展名，所以源码里的相对导入一律写成 `./ts/smooth.js`，TS 会自动解析到 `ts/smooth.ts`。同理，源码里不要用 `@/` 这类路径别名，别名只在本仓库的 tsconfig 有效，写进声明后消费者解析不了。CI 的 `consumer-types` 会把 tarball 装进独立的 `node16` 项目做类型检查，这类问题在仓库自检里看不见。

`pkg/`、`target/` 是编译中间产物，不入库，`.gitignore` 已覆盖。产物同步 CI 验不了，因为依赖本机 wasm-pack 版本，只能靠人工契约：重建后 `git diff` 一下 dist 目录，无 diff 才算同步。

## 📝 文档与图片

- README 面向 npm 用户，新增示例要能直接复制运行，不能只给导入片段
- 正文少用中文括号与分号，能用逗号、句号说清就不用括号补充
- 效果图放 `readme_files/`，直接用原始截图，不裁剪、不缩放、不压缩
- README 里的图片写 `raw.githubusercontent.com` 绝对地址，npm 页面不解析相对路径
- `README.md` 会随包发布到 npm 页面，站内链接（语言切换、LICENSE）一律写绝对 GitHub URL；`README_EN` / `README_JP` / `README_RU` 不进 tarball，只在 GitHub 阅读，用相对路径即可

## ✅ 提交 PR 之前

- **commit 与分支名用英文**，遵循 conventional：feat / fix / refactor / perf / test / docs / ci / chore。PR 描述与评论用中文，细则在 `docs/agents/commit.md` 和 `docs/agents/pr.md`
- 发布走 `prepublishOnly`，自动依次重建 build:wasm / build:types / build
- PR 审核走 `review-smew` 命令，规则正文在 `docs/skills/pr-review-smew/SKILL.md`。先本地审查出草稿，确认后才提交到 GitHub
- **合并需要仓库所有者确认**，CI 绿只是必要条件，不是合并授权
- 硬约束摘要见根目录 [AGENTS.md](./AGENTS.md)，包括禁止 unsafe、不允许 panic 逃逸到 JS、热路径不做重复分配等，规则正文在 `docs/agents/smew.md`

---

期待你的 PR
