/// <reference types="node" />
/**
 * @description smew JS vs WASM 性能基准：直连两套实现，度量吞吐与单调用延迟
 * 运行：npm run bench -- --scale quick|full [--rounds N] [--out 文件.md] [--only 关键字]
 * 注意：Node 侧数字，不能外推为浏览器性能
 */

import os from 'node:os'

import rsInit, { gs as rsGs, ra as rsRa, twe as rsTwe } from '../dist/index.js'
import { gs, ra, twe } from '../ts/smooth.ts'

// ──类型与常量 ───────────────────────────────────────────────────────────────

/** 业务对象：与库的 SmoothInput 约束一致，带 index 模拟真实折线数据 */
interface Item {
  data: number
  index: number
}

/** TS 实现的算法签名（async、消费业务对象数组） */
type TsAlgo = (series: Item[], value: number) => Promise<Item[]>

/** WASM 实现的算法签名（同步、消费 Float64Array） */
type RsAlgo = (values: Float64Array, value: number) => Float64Array

/** 算法名 */
type AlgoName = 'twe' | 'ra' | 'gs'

/** 数据形态名 */
type ShapeName = 'random' | 'constant'

/** 算法 × 参数组合（参数取滑块典型值） */
interface AlgoConfig {
  algo: AlgoName
  param: number
  label: string
}

const ALGOS: AlgoConfig[] = [
  { algo: 'twe', param: 0.5, label: 'TWE@0.5' },
  { algo: 'twe', param: 0.98, label: 'TWE@0.98' },
  { algo: 'ra', param: 10, label: 'RA@10' },
  { algo: 'gs', param: 3, label: 'GS@3' }
]

/** 每格输入池的序列条数：多条序列轮转，防止单一序列被缓存/分支预测过度特化 */
const POOL_SIZE = 8
/** 输入池首条序列的 LCG 种子（与 tests/parity.test.ts 同款发生器，保证可复现） */
const FIRST_SEED = 42

const tsFns: Record<AlgoName, TsAlgo> = { twe, ra, gs }
const rsFns: Record<AlgoName, RsAlgo> = { twe: rsTwe, ra: rsRa, gs: rsGs }

// ── 数据生成（复刻 tests/parity.test.ts 的写法，保证样本确定） ────────────────

/**
 * 可复现的伪随机数发生器（LCG），与 parity.test.ts 同构，保证基准样本确定
 * @param seed 随机种子
 * @returns 返回 [0, 1) 均匀随机数的函数
 */
const createRng = (seed: number): (() => number) => {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}

/**
 * 生成带缺失的随机序列：base ± amp 内波动，missingRate 比例的点置为 NaN
 * @param length 序列长度
 * @param base 基线值
 * @param amp 波动幅度
 * @param seed 随机种子
 * @param missingRate 缺失点比例
 * @returns 数据数组（缺失值以 NaN 表示）
 */
const randomValues = (length: number, base: number, amp: number, seed: number, missingRate = 0.03): number[] => {
  const rng = createRng(seed)
  return Array.from({ length }, () => (rng() < missingRate ? NaN : base + (rng() * 2 - 1) * amp))
}

/**
 * 生成常数序列：全等常数值，逐点命中 safeLerp 的 a === b 快速分支（不执行浮点运算）
 * @param length 序列长度
 * @param value 常数值
 * @returns 全等常数的数据数组
 */
const constantValues = (length: number, value: number): number[] => new Array<number>(length).fill(value)

/**
 * 数据形态配置：random = 真实形态（随机 + 3% NaN），constant = 常数线（验证 a === b 快速分支）
 */
const SHAPES: Array<{ key: ShapeName; title: string; make: (length: number, seed: number) => number[] }> = [
  {
    key: 'random',
    title: '随机序列（base 2.5 ± 1.0，3% NaN，LCG seed 42..49）',
    make: (length: number, seed: number) => randomValues(length, 2.5, 1.0, seed)
  },
  {
    key: 'constant',
    title: '常数序列（全 42，命中 safeLerp a === b 快速分支）',
    make: (length: number, _seed: number) => constantValues(length, 42)
  }
]

/**
 * 把纯 data 数组包装成业务对象输入（与 tests/fixtures.ts 的 toItems 同构）
 * @param datas 纯 data 数组
 * @returns 业务对象列表
 */
const toItems = (datas: number[]): Item[] => datas.map((data, index) => ({ data, index }))

/**
 * 构建 TS / WASM-e2e 用的业务对象输入池：POOL_SIZE 条不同种子的序列
 * @param shapeKey 数据形态名
 * @param points 每条序列的点数
 * @returns 输入池
 */
const makeSeriesPool = (shapeKey: ShapeName, points: number): Item[][] => {
  const shape = SHAPES.find((s) => s.key === shapeKey)
  if (!shape) throw new Error(`未知数据形态: ${shapeKey}`)
  return Array.from({ length: POOL_SIZE }, (_unused, i) => toItems(shape.make(points, FIRST_SEED + i)))
}

/**
 * 构建 WASM-pure 用的 Float64Array 输入池（与业务对象池同源数据）
 * @param seriesPool 业务对象输入池
 * @returns Float64Array 输入池
 */
const makeF64Pool = (seriesPool: Item[][]): Float64Array[] =>
  seriesPool.map((series) => Float64Array.from(series, (item) => item.data))

// ── WASM e2e 边界转换（逐行复刻 smew/index.ts 的 toValues / withSmoothedData） ─

/**
 * 把序列提取成 WASM 入参（缺失值以 NaN 表示）——复制自 index.ts，保持实现一致以度量 App 真实付费路径
 * @param series 原始序列
 * @returns Float64Array 形式的数值序列
 */
const toValues = <T extends { data: number }>(series: T[]): Float64Array => {
  const values = new Float64Array(series.length)
  series.forEach((item, i) => {
    values[i] = item.data
  })
  return values
}

/**
 * 把 WASM 输出按位置组装回去（data 替换为平滑值，其余业务字段原样保留）——复制自 index.ts
 * @param series 原始序列
 * @param out WASM 输出的数值序列
 * @returns 组装后的序列
 */
const withSmoothedData = <T extends { data: number }>(series: T[], out: ArrayLike<number>): T[] =>
  series.map((item, i) => ({
    ...item,
    data: out[i]
  }))

/**
 * WASM e2e 完整路径：业务对象 → Float64Array → WASM 计算 → 组装回业务对象（边界转换一并计时）
 * @param rsFn WASM 算法函数
 * @param series 业务对象序列
 * @param param 算法参数
 * @returns 组装后的业务对象序列
 */
const wasmE2e = <T extends { data: number }>(rsFn: RsAlgo, series: T[], param: number): T[] =>
  withSmoothedData(series, rsFn(toValues(series), param))

// ── 度量基础设施 ──────────────────────────────────────────────────────────────

/**
 * 消费对象数组的输出：抽样若干元素折叠进 checksum，防止死代码消除（在计时窗口外调用）
 * @param out 平滑输出的业务对象序列
 * @returns checksum 增量
 */
const consumeItems = (out: Item[]): number => {
  const pick = (item: Item): number => (Number.isFinite(item.data) ? item.data : 1)
  return pick(out[0]) + pick(out[out.length >> 1]) + pick(out[out.length - 1])
}

/**
 * 消费 Float64Array 的输出：抽样若干元素折叠进 checksum，防止死代码消除（在计时窗口外调用）
 * @param out 平滑输出的数值序列
 * @returns checksum 增量
 */
const consumeF64 = (out: Float64Array): number => {
  const pick = (v: number): number => (Number.isFinite(v) ? v : 1)
  return pick(out[0]) + pick(out[out.length >> 1]) + pick(out[out.length - 1])
}

/**
 * 取中位数（输入不被修改）
 * @param nums 数值数组
 * @returns 中位数
 */
const median = (nums: number[]): number => {
  const sorted = [...nums].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * 取已排序数组的分位数（最近邻下取）
 * @param sorted 已升序排序的数组
 * @param p 分位比例（如 0.5 / 0.95 / 0.99）
 * @returns 分位值
 */
const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]

/**
 * 吞吐人性化格式：points/s → K/M/G 每秒
 * @param pts 每秒处理的点数
 * @returns 形如 "12.3M/s" 的字符串
 */
const fmtThroughput = (pts: number): string => {
  if (pts >= 1e9) return `${(pts / 1e9).toFixed(2)}G/s`
  if (pts >= 1e6) return `${(pts / 1e6).toFixed(2)}M/s`
  if (pts >= 1e3) return `${(pts / 1e3).toFixed(2)}K/s`
  return `${pts.toFixed(0)}/s`
}

/**
 * 延迟人性化格式：毫秒值自适应显示 µs / ms / s
 * @param ms 延迟毫秒数
 * @returns 形如 "8.1µs" 的字符串
 */
const fmtLatency = (ms: number): string => {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  if (ms >= 1) return `${ms.toFixed(3)}ms`
  return `${(ms * 1000).toFixed(1)}µs`
}

/** 单格度量结果 */
interface CellResult {
  label: string
  impl: 'ts' | 'wasm'
  mode: 'e2e' | 'pure'
  throughput: number
  p50: number
  p95: number
  p99: number
  checksum: number
}

/** 单格度量配置 */
interface CellConfig {
  label: string
  impl: 'ts' | 'wasm'
  mode: 'e2e' | 'pure'
  param: number
  calls: number
  points: number
  rounds: number
  warmupCalls: number
  seriesPool: Item[][]
  f64Pool: Float64Array[]
  tsFn: TsAlgo
  rsFn: RsAlgo
}

/**
 * 跑一格基准：先 warmup（JIT 预热、不计时），再 rounds 轮正式测量
 * 每次调用以 performance.now 夹住计时（TS 侧含 await 完成，如实计入 async 开销）；
 * 吞吐取轮时长的中位数（抗 GC 噪声），延迟分位数跨轮合并；结果在计时窗口外消费进 checksum
 * @param cfg 单格配置
 * @returns 度量结果
 */
const runCell = async (cfg: CellConfig): Promise<CellResult> => {
  const latencies: number[] = []
  const roundDurations: number[] = []
  let checksum = 0
  const poolSize = cfg.seriesPool.length

  const runBatch = async (times: number, record: boolean): Promise<void> => {
    for (let c = 0; c < times; c++) {
      const idx = c % poolSize
      if (cfg.impl === 'ts') {
        const t0 = performance.now()
        const out = await cfg.tsFn(cfg.seriesPool[idx], cfg.param)
        const dt = performance.now() - t0
        checksum += consumeItems(out)
        if (record) latencies.push(dt)
      } else if (cfg.mode === 'pure') {
        const t0 = performance.now()
        const out = cfg.rsFn(cfg.f64Pool[idx], cfg.param)
        const dt = performance.now() - t0
        checksum += consumeF64(out)
        if (record) latencies.push(dt)
      } else {
        const t0 = performance.now()
        const out = wasmE2e(cfg.rsFn, cfg.seriesPool[idx], cfg.param)
        const dt = performance.now() - t0
        checksum += consumeItems(out)
        if (record) latencies.push(dt)
      }
    }
  }

  await runBatch(cfg.warmupCalls, false)
  for (let r = 0; r < cfg.rounds; r++) {
    const roundStart = performance.now()
    await runBatch(cfg.calls, true)
    roundDurations.push(performance.now() - roundStart)
  }

  const sorted = latencies.slice().sort((a, b) => a - b)
  return {
    label: cfg.label,
    impl: cfg.impl,
    mode: cfg.mode,
    throughput: (cfg.calls * cfg.points) / (median(roundDurations) / 1000),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    checksum
  }
}

// ── 场景与矩阵驱动 ────────────────────────────────────────────────────────────

/** 场景配置：形态比例固定（S1 多批次小数据 / S2 少批次大数据），总量按档位缩放 */
interface ScenarioConfig {
  key: string
  title: string
  calls: number
  points: number
}

/**
 * 档位：quick = 每格 1000 万点（先出结论用），full = 每格 1 亿点（正式数字）
 * @param scale 档位名（quick / full）
 * @returns 两个场景的配置
 */
const makeScenarios = (scale: string): ScenarioConfig[] => {
  if (scale === 'full') {
    return [
      { key: 's1', title: '多批次小数据（100,000 次调用 × 1,000 点）', calls: 100_000, points: 1_000 },
      { key: 's2', title: '少批次大数据（1,000 次调用 × 100,000 点）', calls: 1_000, points: 100_000 }
    ]
  }
  return [
    { key: 's1', title: '多批次小数据（10,000 次调用 × 1,000 点）', calls: 10_000, points: 1_000 },
    { key: 's2', title: '少批次大数据（100 次调用 × 100,000 点）', calls: 100, points: 100_000 }
  ]
}

/**
 * 主流程：解析 CLI → 构建 3 算法 × 2 场景 × 2 数据形态 × 2 实现的矩阵 → 逐格测量 → 输出 markdown
 * @returns 全部格子的度量结果
 */
const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)
  const readArg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const scale = readArg('scale') ?? 'quick'
  const rounds = Number(readArg('rounds') ?? 3)
  const outFile = readArg('out')
  const only = readArg('only')
  const scenarios = makeScenarios(scale)

  await rsInit()

  const cpus = os.cpus()
  const lines: string[] = []
  lines.push('# smew JS(TS) vs WASM 性能基准（原始结果）', '')
  lines.push(`- 日期：${new Date().toISOString()}`)
  lines.push(
    `- 运行环境：Node ${process.version} / ${os.platform()} ${os.arch()} / ${cpus[0].model} × ${cpus.length} 核`
  )
  lines.push(`- 档位：${scale}，轮数：${rounds}（吞吐取轮中位数，延迟为跨轮合并分位数）`)
  lines.push('- 口径：e2e = 业务对象 → 结果（Float64Array 边界转换计入 WASM 侧）；pure = 各自原生输入，只计时平滑本体')
  lines.push('- 注意：这是 Node 侧数字，不能外推为浏览器性能；建议接电源 / 高性能模式运行', '')

  const checksumLines: string[] = []

  for (const scenario of scenarios) {
    for (const shape of SHAPES) {
      const seriesPool = makeSeriesPool(shape.key, scenario.points)
      const f64Pool = makeF64Pool(seriesPool)
      const warmupCalls = Math.min(2_000, Math.max(3, Math.round(scenario.calls * 0.02)))

      const results: Record<string, CellResult> = {}
      for (const algo of ALGOS) {
        const prefix = `${scenario.key}/${shape.key}/${algo.label}`
        if (only && !prefix.includes(only)) continue
        const cells: Array<{ impl: 'ts' | 'wasm'; mode: 'e2e' | 'pure' }> = [
          { impl: 'ts', mode: 'e2e' },
          { impl: 'wasm', mode: 'e2e' },
          { impl: 'wasm', mode: 'pure' }
        ]
        for (const cell of cells) {
          const label = `${scenario.key}/${shape.key}/${algo.label}/${cell.impl}-${cell.mode}`
          const result = await runCell({
            label,
            impl: cell.impl,
            mode: cell.mode,
            param: algo.param,
            calls: scenario.calls,
            points: scenario.points,
            rounds,
            warmupCalls,
            seriesPool,
            f64Pool,
            tsFn: tsFns[algo.algo],
            rsFn: rsFns[algo.algo]
          })
          results[label] = result
          checksumLines.push(`- ${label}: ck=${result.checksum}`)
          console.log(
            `[done] ${label}  吞吐 ${fmtThroughput(result.throughput)}  p50 ${fmtLatency(result.p50)}  p95 ${fmtLatency(result.p95)}  p99 ${fmtLatency(result.p99)}`
          )
        }
      }

      // 表格：每个算法两行（WASM e2e / WASM pure），TS 输入即业务对象、两口径计时区间相同，为同一测量
      const tableRows: string[] = []
      for (const algo of ALGOS) {
        const ts = results[`${scenario.key}/${shape.key}/${algo.label}/ts-e2e`]
        if (!ts) continue
        for (const mode of ['e2e', 'pure'] as const) {
          const wasm = results[`${scenario.key}/${shape.key}/${algo.label}/wasm-${mode}`]
          if (!wasm) continue
          const modeText = mode === 'e2e' ? 'e2e（含边界转换）' : 'pure（纯计算）'
          tableRows.push(
            `| ${algo.label} | ${modeText} | ${fmtThroughput(wasm.throughput)} | ${fmtThroughput(ts.throughput)} | ${(wasm.throughput / ts.throughput).toFixed(2)}× | ${fmtLatency(wasm.p50)} / ${fmtLatency(wasm.p95)} / ${fmtLatency(wasm.p99)} | ${fmtLatency(ts.p50)} / ${fmtLatency(ts.p95)} / ${fmtLatency(ts.p99)} |`
          )
        }
      }
      if (tableRows.length > 0) {
        lines.push(`## 场景 ${scenario.key === 's1' ? '1' : '2'} · ${scenario.title}`, '')
        lines.push(`### 数据形态：${shape.title}`, '')
        lines.push('| 算法 | 口径 | WASM 吞吐 | TS 吞吐 | 加速比 | WASM p50 / p95 / p99 | TS p50 / p95 / p99 |')
        lines.push('|------|------|-----------|---------|--------|----------------------|--------------------|')
        lines.push(...tableRows, '')
      }
    }
  }

  lines.push('## 方法说明', '')
  lines.push('- 每格：warmup（不计时）→ 3 轮正式；吞吐 = 总点数 / 轮时长中位数，延迟分位数跨轮合并')
  lines.push('- 单调用以 performance.now 夹住计时；TS 侧含 await 完成（async 开销如实计入，App 亦如此调用）')
  lines.push('- 结果消费在计时窗口外（checksum 抽样累加，防死代码消除）；输入池 8 条序列轮转')
  lines.push('- TS 实现输入即业务对象，e2e / pure 两口径下其计时区间相同，表中为同一测量值')
  lines.push('- WASM e2e 的边界转换逐行复刻 smew/index.ts 的 toValues / withSmoothedData，计入 WASM 侧')
  lines.push('- 亚毫秒级单调用延迟受计时器粒度影响（S1 小批量 WASM 调用为微秒级，分位数仅供参考）', '')
  lines.push('## 各格 checksum（证明结果被消费，同配置两次运行应一致）', '')
  lines.push(...checksumLines, '')

  const markdown = lines.join('\n')
  if (outFile) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(outFile, markdown, 'utf8')
    console.log(`\n[report] 已写入 ${outFile}`)
  } else {
    console.log(`\n${markdown}`)
  }
}

await main()
