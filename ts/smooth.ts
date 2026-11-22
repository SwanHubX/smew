/**
 * @description 平滑算法的 TS 实现 —— WASM 加载失败时由前端使用
 * 本文件是纯算法：数据量大时的让出主线程、取消等调度策略由调用方通过检查点（checkpoint）注入，库内不感知任何调度细节
 * 数值内核：三算法统一为归一化均值状态 (y, D) / (mu, W)，新数据逐点按权重融入当前均值
 * 常数序列位级透传（#1530）、有限输入必得有限输出（凸组合恒落在已见数据值域内）
 */

/** 平滑输入的最小结构：只要带 data 数值即可（缺失值以 NaN 表示） */
export interface SmoothInput {
  data: number
}

/**
 * 检查点：每处理一个数据点前调用一次（异步等待其完成）
 * 让出主线程、响应取消等策略由调用方实现；检查点抛出异常会中止整个计算并向上抛出
 */
export type Checkpoint = (index: number) => void | Promise<void>

/** 平滑可选项 */
export interface SmoothOptions {
  /** 检查点；不传则无任何调度开销、一次性算完 */
  checkpoint?: Checkpoint
}

/** 平滑函数的统一签名：输入输出同构（data 被替换为平滑值，其余字段原样保留） */
export type SmoothFunc = <T extends SmoothInput>(series: T[], value: number, options?: SmoothOptions) => Promise<T[]>

// 平滑计算只接受有限数值；NaN/Infinity 等值视为缺失数据
const isValidData = (value: number): boolean => Number.isFinite(value)

// 安全线性插值：按权重 t 融合 a、b（t=0 返回 a，t=1 返回 b）
// 1. a === b（常数线）→ 不执行浮点运算原样返回，消除常数序列经平滑后的舍入漂移（#1530）
// 2. a、b 异号且量级极端时 b − a 会溢出为 ±Infinity，改走凸组合式 (1−t)·a + t·b，几何上不可能上溢
// 3. t 非有限或越界 [0,1] → NaN：保持非法参数以 NaN 表达的既有契约（如 TWE 负参数、GS σ=0）
const safeLerp = (a: number, b: number, t: number): number => {
  if (!Number.isFinite(t) || t < 0 || t > 1) return NaN
  if (t === 0) return a
  if (t === 1) return b
  if (a === b) return a
  if ((a < 0 && b > 0) || (a > 0 && b < 0)) return (1 - t) * a + t * b
  return a + t * (b - a)
}

// 安全权重比 w2/(w1+w2)：先按最大值缩放再相除，权重和相加永不溢出
const safeWeightRatio = (w1: number, w2: number): number => {
  if (!Number.isFinite(w1) || !Number.isFinite(w2) || w1 < 0 || w2 < 0) return NaN
  if (w2 === 0) return 0
  if (w1 === 0) return 1
  const scale = Math.max(w1, w2)
  return w2 / scale / (w1 / scale + w2 / scale)
}

// Time Weighted EMA
export const twe = async <T extends SmoothInput>(series: T[], value: number, options?: SmoothOptions): Promise<T[]> => {
  const result: T[] = []
  // 入口显式校验，逐条复刻既有非法值行为：NaN 参数按 0 透传；负数参数权重为 NaN → 全部输出 NaN
  const smoothingWeight = Number.isNaN(value) ? 0 : Math.min(Math.sqrt(value), 0.999)
  // 归一化状态：y 为当前平滑输出，D 为已累计权重
  let y = 0
  let D = 0
  const checkpoint = options?.checkpoint

  for (let index = 0; index < series.length; index++) {
    if (checkpoint !== undefined) await checkpoint(index)
    const item = series[index]
    // 缺失值不更新递推状态，避免 NaN 污染后续有效点
    if (isValidData(item.data)) {
      D = smoothingWeight * D + 1
      // 首个有效点 D === 1 → t === 1 → safeLerp 原样返回该点；常数线此后每步命中 a === b 位级透传
      y = safeLerp(y, item.data, 1 / D)
    }
    result.push({
      // 保留原始缺失点的位置，下一个有效点继续使用最近一次有效状态
      ...item,
      data: isValidData(item.data) ? y : NaN
    })
  }

  return result
}

// average 平滑
export const ra = async <T extends SmoothInput>(series: T[], value: number, options?: SmoothOptions): Promise<T[]> => {
  const result: T[] = []
  const w = Math.floor(value / 2)
  // 非有限窗口（如 ±Infinity）无法构成有效循环区间，按非法参数直接输出全 NaN，避免宿主挂起
  if (!Number.isFinite(w)) {
    return series.map((item) => ({ ...item, data: NaN }))
  }
  // 极大有限窗口按序列长度钳制：w ≥ 序列长度时窗口本就覆盖全序列，输出不变；
  // 同时规避浮点精度下 i++ 增量失效导致的循环挂起
  const half = Math.min(w, series.length)
  const checkpoint = options?.checkpoint

  for (let index = 0; index < series.length; index++) {
    if (checkpoint !== undefined) await checkpoint(index)
    const item = series[index]
    // 折叠状态每个输出点重置：mu 为窗口有效样本的均值，W 为有效样本数
    let mu = 0
    let W = 0
    for (let i = index - half; i <= index + half; i++) {
      const nowIndex = Math.min(Math.max(i, 0), series.length - 1)
      const value = series[nowIndex].data
      // 缺失值不参与加权，使用有效样本数作为权重，避免结果被缺失值拉低
      if (!isValidData(value)) continue
      // 首个有效样本 t === 1 原样返回；常数窗口此后每步命中 a === b 位级透传
      mu = safeLerp(mu, value, safeWeightRatio(W, 1))
      W++
    }
    result.push({
      // 当前点缺失时保持 NaN，窗口无有效样本时也无法计算平均值
      ...item,
      data: !isValidData(item.data) || W === 0 ? NaN : mu
    })
  }

  return result
}

/**
 * @description 高斯平滑，用 sigma 反算窗口大小
 * @param series 系列数据
 * @param value sigma
 * @param options 可选项（checkpoint：每处理一个数据点前异步调用的检查点）
 */
export const gs = async <T extends SmoothInput>(series: T[], value: number, options?: SmoothOptions): Promise<T[]> => {
  const result: T[] = []
  let kernelSize = Math.max(3, Math.floor(value * 6) | 0)
  if (kernelSize % 2 === 0) kernelSize++
  const half = (kernelSize - 1) / 2
  const kernel = new Array<number>(kernelSize)
  let sum = 0

  for (let i = 0; i < kernelSize; i++) {
    const x = i - half
    const val = Math.exp(-(x * x) / (2 * value * value))
    kernel[i] = val
    sum += val
  }
  for (let i = 0; i < kernelSize; i++) kernel[i] /= sum

  const checkpoint = options?.checkpoint
  for (let index = 0; index < series.length; index++) {
    if (checkpoint !== undefined) await checkpoint(index)
    const item = series[index]
    // 折叠状态每个输出点重置：mu 为卷积均值，W 为已累计的有效核权重
    let mu = 0
    let W = 0
    for (let j = 0; j < kernelSize; j++) {
      const sourceIndex = Math.min(Math.max(index + j - half, 0), series.length - 1)
      const value = series[sourceIndex].data
      // 缺失值不贡献卷积结果，剩余有效权重重新归一化
      if (!isValidData(value)) continue
      // σ=0 时核为 NaN → t 为 NaN → 输出 NaN，既有契约经 NaN 分支保留
      mu = safeLerp(mu, value, safeWeightRatio(W, kernel[j]))
      W += kernel[j]
    }
    result.push({
      // 当前点缺失时保留 NaN，没有有效权重时避免产生无意义的除法结果
      ...item,
      data: !isValidData(item.data) || W === 0 ? NaN : mu
    })
  }

  return result
}
