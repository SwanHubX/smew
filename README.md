# smew 🦆

**smew: A smooth-feathered duck | 一只羽毛顺滑的鸭子 🦆**

SwanLab 折线图平滑算法（TWE / RA / GS）的高性能独立实现模块。

- ⚡ **Rust 实现**：编译为 WASM，提供原生计算加速。
- 🛡️ **TS 回退实现**：纯 JS 兜底，确保无环境依赖。
- 🔌 **统一导出**：由 `smew/index.ts` 暴露统一 API，WASM 优先、失败自动回退 TS，调用方无需感知内部细节。

---

> 三个导出函数的接口已冻结。Rust 实现与 TS 正本逐位对拍通过（TWE / RA 位级一致、GS 按容差，见
> `tests/parity.test.ts`）。接口签名以代码与类型声明为准，本文档面向人类说明其语义；任何签名或语义变更必须先评审。

---

## 📑 目录

- [公共入口与回退](#-公共入口与回退)
- [快速上手](#-快速上手)
  - [检查点（可选）：让出主线程 / 取消 / 进度](#️-检查点可选让出主线程--取消--进度)
- [接口分层](#️-接口分层)
- [导出函数](#-导出函数)
- [数据格式约定](#-数据格式约定)
- [参数语义与非法值行为](#️-参数语义与非法值行为)
  - [1. TWE — `smoothing`](#1-twe--smoothing)
  - [2. RA — `value`](#2-ra--value)
  - [3. GS — `sigma`](#3-gs--sigma)
  - [缺失值语义](#-缺失值语义)
  - [数值稳定性](#-数值稳定性)
  - [错误处理](#-错误处理)
- [非目标](#-非目标)
- [构建与产物](#-构建与产物)
- [测试与对拍](#-测试与对拍)
- [相关文档](#-相关文档)

---

## 🚀 公共入口与回退

`smew/index.ts` 是对外唯一入口。模块加载时后台初始化 WASM：

- ⚡ **WASM 就绪** → 平滑调用走 Rust 实现（更快）
- 🛡️ **WASM 未就绪 / 加载失败** → 自动回退 TS 实现（只告警一次，不重试）
- 🔄 **回退窗口期内调用平滑** → 结果由 TS 实现产生，行为与 WASM 路径完全一致（对拍保证）

---

## 💡 快速上手

任何调用方只需提供一组带 `data` 数值的对象（缺失值用 `NaN` 表示），选择算法与参数即可：

```ts
import smew from 'smew'

const input = [
  { data: 10, index: 0 },
  { data: NaN, index: 1 }, // NaN 表示该点缺失
  { data: 30, index: 2 }
]

const out = await smew('TWE', input, { value: 0.5 })
// out 与 input 等长、顺序一致：
// data 为平滑值；origin 为平滑前的原始 data 值，其他字段原样保留
```

### ⏸️ 检查点（可选）：让出主线程 / 取消 / 进度

平滑是逐点计算的。第四个参数可传入
`checkpoint`（一个异步函数），库会在**每处理一个数据点前**调用并等待它。函数里做什么完全由你决定，**抛出异常则整个计算中止并向上抛出**：

```ts
import smew from 'smew'

// 场景一：浏览器里数据量大，计算中定期让出主线程，避免页面卡顿
let sliceStart = performance.now()
const out = await smew('TWE', input, { value: 0.5 }, async () => {
  if (performance.now() - sliceStart >= 4) {
    await new Promise((resolve) => setTimeout(resolve)) // 让出主线程
    sliceStart = performance.now()
  }
})

// 场景二：数据已过期（如图表已切换），中途取消
const controller = new AbortController()
const pending = smew('TWE', input, { value: 0.5 }, () => {
  if (controller.signal.aborted) throw new Error('cancelled')
})
controller.abort()
const cancelled = await pending.catch(() => []) // 捕获中止，按需处理
```

- 不传 `checkpoint`：一次性算完，零调度开销（Node、脚本、测试场景推荐）
- 注意 WASM 路径单次完整计算，检查点仅 TS 回退路径逐点生效（详见下方错误处理）

---

## 🏗️ 接口分层

| 层                      | 文件                                              | 签名形态                      | 职责                        |
| :---------------------- | :------------------------------------------------ | :---------------------------- | :-------------------------- |
| **公共入口层**          | `index.ts`                                        | `业务对象 → 业务对象`         | 统一 API：调度 WASM/TS 回退 |
| **Rust 算法函数层**     | `src/algorithms/`（`twe.rs` / `ra.rs` / `gs.rs`） | `&[f64] → Vec<f64>`           | 纯计算，不接触 wasm-bindgen |
| **数值内核层**          | `src/utils/numeric.rs`                            | safeLerp / safeWeightRatio    | 共享数值原语（TS 正本镜像） |
| **wasm-bindgen 导出层** | `src/lib.rs`                                      | `Float64Array → Float64Array` | JS 类型转换与绑定           |

> 📌 `dist/wasm.d.ts` 描述的是**导出层**，必须与实际导出一致。

---

## 📦 导出函数

```rust
twe(values: &[f64], smoothing: f64) -> Vec<f64>   // Time Weighted EMA
ra(values: &[f64], value: f64) -> Vec<f64>        // Running Average
gs(values: &[f64], sigma: f64) -> Vec<f64>        // Gaussian
```

- 📝 JS 侧调用名为 snake_case 原名（`twe` 等），wasm-bindgen 不转换驼峰。

---

## 📋 数据格式约定

- 📐 入参出参均为 `Float64Array`（JS）/ `&[f64]`、`Vec<f64>`（Rust），**输出与输入等长、顺序对应**。
- 🔍 缺失值用 `NaN` 表示；判定口径两侧统一为 JS `Number.isFinite` ↔ Rust `f64::is_finite`。
- ⚪ 空数组输入返回空数组输出。
- 🔒 本模块**不修改调用方的原始数组**；横坐标、时间戳等业务字段留在 JS 侧。

---

## ⚙️ 参数语义与非法值行为

本库支持并验证过的参数范围：TWE `0~0.99`、RA `1~100`、GS
`1~100`。库内不信任调用方，非法输入的处理方式以现有 JS 实现（`smew/ts/smooth.ts`）的实际行为为准，逐参数冻结如下：

### 1. TWE — `smoothing`

| 输入         | 实际行为（JS 现状）                                                                   |
| :----------- | :------------------------------------------------------------------------------------ |
| `0` 或 `NaN` | 显式判定（`Number.isNaN`）按 0 处理 → 权重 0 → 输出等于输入（原样透传，缺失点仍 NaN） |
| 负数         | `sqrt(负) = NaN` → 权重 NaN → **全部输出 NaN**（含首个有效点）                        |
| `> 0.99`     | `min(sqrt(value), 0.999)` 钳制到 0.999                                                |

### 2. RA — `value`

| 输入                        | 实际行为（JS 现状）                                                                                                |
| :-------------------------- | :----------------------------------------------------------------------------------------------------------------- |
| `0`、`1` 或 `(0, 2)` 内小数 | `floor(value / 2) = 0` → 窗口仅自身 → 输出等于输入                                                                 |
| `≥ 2`                       | 正常窗口，长度 `2 × floor(value / 2) + 1`；超过序列长度时内部钳制为 `w = 序列长度`（等价于 `w = 序列长度` 的窗口） |
| 负数 或 `NaN`               | 循环区间为空 → 窗口内无有效数据 → **全部输出 NaN**                                                                 |
| `±Infinity`                 | 窗口无效（`w` 非有限），防御性**全部输出 NaN**，避免宿主挂起                                                       |

### 3. GS — `sigma`

| 输入         | 实际行为（JS 现状）                                                                                 |
| :----------- | :-------------------------------------------------------------------------------------------------- |
| `0` 或 `NaN` | 中心权重 `exp(0/0) = NaN` 污染整核 → **全部输出 NaN**                                               |
| 负数         | 分母 `2σ²` 为正，权重分布同 `\|σ\|`；但核大小取 `max(3, floor(负数)) = 3` → 3 点小核 + `\|σ\|` 权重 |
| `> 0`        | 正常：核大小 `max(3, floor(sigma × 6))`（调整为奇数），权重 `exp(-x² / 2σ²)` 归一化                 |

### 🧩 缺失值语义

- 🎯 输入中的 `NaN` 位置，对应输出为 `NaN`。
- **TWE**：缺失点不更新递推状态（`y` / `D` 归一化均值状态），后续有效点继续使用最近一次有效状态。
- **RA**：缺失值不参与加权、不计入权重；窗口内无有效数据时输出 `NaN`。
- **GS**：缺失值跳过贡献，按剩余有效权重重新归一化。

### 🛡 数值稳定性

三算法共用 safeLerp 凸组合内核：新数据逐点按权重 `t` 融入当前均值（`t` 为新数据占总权重的比例）。

- 🔒 **常数序列位级透传**：常数线输出与该常数全等（`===`，极差为 0）——每步命中 `a === b`
  快速分支，不执行任何浮点运算。修复 #1530（常数折线平滑后满屏波浪：旧实现分子 / 分母双累加器独立舍入，比值以 ~1e-16 幅度随机游走，y 轴按范围自适应将噪声放大成波浪）。
- 📏 **输出恒在已见数据值域内**：凸组合 `y = (1−t)·y_prev + t·x` 几何上落在 `[y_prev, x]`
  线段内 → 有限输入必得有限输出，不越界、不上溢。
- ⚡ **异号极端值防溢出**：`b − a` 可能溢出为 ±Infinity 的场景改走凸组合式
  `(1−t)·a + t·b`（几何上不可能上溢）；同时修复旧实现的稳态溢出缺陷——旧分子累加器稳态为 `x / (1−w)`，`w = 0.995`
  时约为输入的 200 倍，1e306 级合法输入数百步内即溢出为 Infinity。
- ⚠️ **非法权重 → NaN**：safeLerp 对非有限或越界 `[0, 1]` 的权重 `t` 返回 NaN——TWE 负参数（权重 NaN）、GS
  `σ = 0`（核 NaN）等既有契约经此分支统一保留。
- 🧊
  **已知局限**：浮点大数精度有限——数据基线极大且每步真实变化小于该基线的可表示精度（如往上百亿的基线加 0.000001）时，微小变化会被舍入直接吞掉，平滑曲线可能无法跟随。

### 🚨 错误处理

所有非法与边界输入均以 `NaN` 输出或原样返回输入表达，**不使用 panic**；插值内核 safeLerp /
safeWeightRatio 对非法输入（权重越界、负权重等）同样以 `NaN`
表达。本库是纯算法，不做任何调度：数据量大时的让出主线程、取消等策略由调用方通过检查点注入—— `smew` 的第四个参数
`checkpoint`（单算法入口为
`options.checkpoint`）为异步函数，每处理一个数据点前被调用并等待完成，抛出异常即中止整个计算并向上抛出；不传则一次性同步算完。注意 WASM 路径单次完整计算，不响应检查点（检查点仅 TS 回退路径逐点生效）。

---

## 🚫 非目标

- ❌ 不实现按相邻 timestamp 间隔调整 TWE 权重
- ❌ 不提供引擎切换开关（WASM 加载失败时由本模块自动回退 TS 实现）

---

## 🔨 构建与产物

一条命令完成"Rust 编译 → wasm 字节内嵌 → 生成 dist 产物"：

```bash
npm run build:wasm        # 在 smew 目录内执行；monorepo 中亦可用 npm run build:wasm -w smew
```

> 📌 工具版本：`wasm-pack` 建议 **v0.15.0**（与 CI 及本仓库现有 dist 的生成环境一致；不同版本的胶水生成可能存在差异）

链路：`wasm-pack build --target web` 编译（中间产物在 `pkg/`，不入库）→ `scripts/inline-wasm.mjs` 读取 `.wasm`
字节转为十进制数字数组内嵌、并替换胶水中按路径加载的逻辑 → 产出单文件 `dist/wasm.js` + `dist/wasm.d.ts`。

- ✅ **`dist/`
  随源码提交入库**：其他开发者无需安装 Rust，拉取仓库即可直接使用（WASM 路径自动生效，加载失败自动回退 TS 实现）
- 🚫 `pkg/`、`target/` 为编译中间产物，不入库（`.gitignore` 已覆盖）

**修改 Rust 源码后**：重跑 `npm run build:wasm`，并将重新生成的 `dist/wasm.js`、`dist/wasm.d.ts` 随代码一起提交。

> 说明：脚本为防御式——pkg 产物与预期模式不符（如 wasm-bindgen 升级改变生成物结构）时直接报错退出，不会静默生成坏产物。
> `Cargo.toml` 已设置 `wasm-opt = false` 规避 binaryen 的网络下载依赖，构建零网络要求。

### 类型声明（types/）

`types/` 由 TS 编译器从源码生成，**随源码提交入库、禁止手改**：

```bash
npm run build:types       # 在 smew 目录内执行；monorepo 中亦可用 npm run build:types -w smew
```

- 📦 `package.json` 的 `exports` 使用 `types` / `import` 双条件：**TypeScript 只读
  `types/*.d.ts`**（消费方无需把 smew 源码纳入自己的编译工程），**Vite / 运行时匹配 `import` 直连 TS 源码**，行为不变
- 🔢 `types` 条件必须排在 `import` 之前（TS 按键顺序匹配条件集，放后面会被 `import` 抢走、退回源码解析）
- ✏️ **修改 `index.ts` / `ts/**` 后必须重跑本命令并提交更新**，CI 对 types/ 做漂移 diff 校验，声明过期会直接失败

---

## 🧪 测试与对拍

- 🎯
  `smew/tests/smooth.test.ts`：行为用例（缺失值边界、空数组、全 NaN、单点、参数两端），断言即行为表，`npm run test -w smew`（或
  `cd smew && npm test`）执行
- 🕵️ 类型检查：`npx vue-tsc --build smew/tsconfig.json`
- 🧹 Lint：`npm run lint -w smew`
- ⚖️ `smew/tests/parity.test.ts`：TS ↔ Rust 对拍（TWE / RA 位级一致、GS 按容差），随 `npm run test` 一起执行
- 📊 性能基准：`cd smew && npm run bench -- --scale quick|full`，正式数字与结论见 `bench/REPORT.md`（直跑 TS 依赖 Node
  ≥23.6 的原生类型剥离；本仓库已固定 24.16.0）
- 🦀 Rust 侧：`cd smew && cargo test`

---

## 📚 相关文档

- 📖 接口变更必须同步更新本文件的人类向说明，并检查 `docs/agents/smew.md` 的规则是否需要同步
- 🔎 审核规范见 `docs/skills/pr-review-smew/SKILL.md`，规则正文见 `docs/agents/smew.md`
