/**
 * smew/ts/smooth.ts（TS 回退实现）的行为测试
 * 测什么：三种平滑算法（TWE / RA / GS）在正常数据、缺失值、空数组、非法参数（负数 / NaN / 超出滑块范围）等场景下的输出是否符合预期。
 * 每个期望值都对照 src/board/chart/smooth.ts 的现有行为核算得出，合起来就是平滑算法的行为契约
 * 将来 Rust 实现（smew/src/）落地后，同样的输入必须产生同样的输出，本文件的断言就是那时判定"行为没变"的依据。
 */
import { describe, expect, it } from 'vitest'

import { gs, ra, twe } from '../ts/smooth'
import type { FixtureItem } from './fixtures'
import { datas, fixtures, toItems } from './fixtures'

/**
 * 可复现的伪随机数发生器（LCG），保证测试确定性
 * @param seed 随机种子
 */
const createRng = (seed: number): (() => number) => {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}

/**
 * 生成常数序列（可选缺失间隔 every：每 every 个点缺失一个，0 表示不缺失）
 * @param c 常数值
 * @param length 序列长度
 * @param missingEvery 缺失间隔
 */
const constantSeries = (c: number, length: number, missingEvery = 0): FixtureItem[] =>
  toItems(
    Array.from({ length }, (_, index) => (missingEvery > 0 && index % missingEvery === missingEvery - 1 ? NaN : c))
  )

/**
 * 生成带缺失的随机序列：base ± amp 内波动，missingRate 比例的点置为 NaN
 * @param length 序列长度
 * @param base 基线值
 * @param amp 波动幅度
 * @param rng 随机数发生器
 * @param missingRate 缺失点比例
 */
const randomSeries = (
  length: number,
  base: number,
  amp: number,
  rng: () => number,
  missingRate = 0.03
): FixtureItem[] =>
  Array.from({ length }, (_, index) => ({ data: rng() < missingRate ? NaN : base + (rng() * 2 - 1) * amp, index }))

// ---------- 旧双累加器公式复刻（等价性守卫的参照实现，故意不做任何数值优化） ----------

/**
 * 旧 TWE：分子 lastY 与分母 debias 双累加器，输出 lastY / debias
 * @param series 输入序列
 * @param value 平滑参数
 */
const tweOld = (series: FixtureItem[], value: number): number[] => {
  const w = Number.isNaN(value) ? 0 : Math.min(Math.sqrt(value), 0.999)
  let lastY = 0
  let debias = 0
  return series.map((item) => {
    if (Number.isFinite(item.data)) {
      lastY = lastY * w + item.data
      debias = debias * w + 1
    }
    return Number.isFinite(item.data) ? lastY / debias : NaN
  })
}

/**
 * 旧 RA：窗口内逐点直加求和后除以有效样本数（含端点 clamp 与长度钳制，同旧实现）
 * @param series 输入序列
 * @param value 窗口参数
 */
const raOld = (series: FixtureItem[], value: number): number[] => {
  const half = Math.min(Math.floor(value / 2), series.length)
  return series.map((_, index) => {
    let sum = 0
    let count = 0
    for (let i = index - half; i <= index + half; i++) {
      const v = series[Math.min(Math.max(i, 0), series.length - 1)].data
      if (!Number.isFinite(v)) continue
      sum += v
      count++
    }
    return !Number.isFinite(series[index].data) || count === 0 ? NaN : sum / count
  })
}

/**
 * 旧 GS：核权重归一化后逐点卷积累加 acc / weightSum
 * @param series 输入序列
 * @param sigma 高斯核带宽
 */
const gsOld = (series: FixtureItem[], sigma: number): number[] => {
  let kernelSize = Math.max(3, Math.floor(sigma * 6) | 0)
  if (kernelSize % 2 === 0) kernelSize++
  const half = (kernelSize - 1) / 2
  const kernel = Array.from({ length: kernelSize }, (_, i) => {
    const x = i - half
    return Math.exp(-(x * x) / (2 * sigma * sigma))
  })
  const kSum = kernel.reduce((s, v) => s + v, 0)
  for (let i = 0; i < kernelSize; i++) kernel[i] /= kSum
  return series.map((_, index) => {
    let acc = 0
    let weightSum = 0
    for (let j = 0; j < kernelSize; j++) {
      const v = series[Math.min(Math.max(index + j - half, 0), series.length - 1)].data
      if (!Number.isFinite(v)) continue
      acc += v * kernel[j]
      weightSum += kernel[j]
    }
    return !Number.isFinite(series[index].data) || weightSum === 0 ? NaN : acc / weightSum
  })
}

/**
 * 断言两组序列 NaN 位置一致、有限值最大绝对差不超过容差
 * @param actual 实际平滑输出
 * @param expected 参照输出
 * @param tolerance 有限值最大绝对差容限
 */
const expectEquivalent = (actual: number[], expected: number[], tolerance = 1e-12): void => {
  expect(actual).toHaveLength(expected.length)
  let maxDiff = 0
  for (let i = 0; i < expected.length; i++) {
    if (Number.isNaN(expected[i])) {
      expect(Number.isNaN(actual[i])).toBe(true)
      continue
    }
    expect(Number.isNaN(actual[i])).toBe(false)
    maxDiff = Math.max(maxDiff, Math.abs(actual[i] - expected[i]))
  }
  expect(maxDiff).toBeLessThanOrEqual(tolerance)
}

describe('twe (Time Weighted EMA)', () => {
  it('smoothing = 0 时原样透传（权重 0，缺失点仍 NaN）', async () => {
    const out = datas(await twe(toItems([10, NaN, 30]), 0))
    expect(out[0]).toBe(10)
    expect(out[1]).toBeNaN()
    expect(out[2]).toBe(30)
  })

  it('负数平滑度：sqrt(负) = NaN 污染递推，全部输出 NaN', async () => {
    const out = datas(await twe(toItems(fixtures.normal), -1))
    expect(out.every((v) => Number.isNaN(v))).toBe(true)
  })

  it('超出滑块上限时钳制到 0.999（smoothing=2 与 5 输出一致）', async () => {
    const a = datas(await twe(toItems(fixtures.normal), 2))
    const b = datas(await twe(toItems(fixtures.normal), 5))
    expect(a).toEqual(b)
  })

  it('缺失点输出 NaN 且不更新递推状态，后续有效点继续计算', async () => {
    const out = datas(await twe(toItems(fixtures.withMissing), 0.5))
    expect(out[0]).toBe(10)
    expect(out[1]).toBeNaN()
    // p2: lastY = 10w + 30 = 37.0711，debias = w + 1 = 1.7071 → 21.7157
    expect(out[2]).toBeCloseTo(21.7157, 3)
  })

  it('空数组返回空数组', async () => {
    expect(datas(await twe(toItems(fixtures.empty), 0.5))).toEqual([])
  })
})

describe('ra (Running Average)', () => {
  it('value = 0 / 1 时窗口仅自身，原样透传', async () => {
    expect(datas(await ra(toItems(fixtures.normal), 0))).toEqual(fixtures.normal)
    expect(datas(await ra(toItems(fixtures.normal), 1))).toEqual(fixtures.normal)
  })

  it('value = 2（窗口 3）：边界 clamp 重复使用端点', async () => {
    const out = datas(await ra(toItems(fixtures.normal), 2))
    expect(out[0]).toBeCloseTo(40 / 3, 5) // [10,10,20]
    expect(out[1]).toBeCloseTo(20, 5) // [10,20,30]
    expect(out[2]).toBe(30) // [20,30,40]
  })

  it('窗口内缺失值跳过、不计入分母；当前点缺失则输出 NaN', async () => {
    const out = datas(await ra(toItems(fixtures.withMissing), 2))
    expect(out[0]).toBe(10) // [10,10,NaN] → 有效 10
    expect(out[1]).toBeNaN() // 当前点缺失 → NaN（契约行为）
    expect(out[2]).toBe(30) // [NaN,30,30] → 有效 30
  })

  it('负数窗口：循环区间为空，全部输出 NaN（JS 现状保留；NaN 参数现状为全 NaN，行为冻结待讨论）', async () => {
    const out = datas(await ra(toItems(fixtures.normal), -1))
    expect(out.every((v) => Number.isNaN(v))).toBe(true)
  })

  it('Infinity 窗口：防御性输出全 NaN，不挂起', async () => {
    const out = datas(await ra(toItems(fixtures.normal), Infinity))
    expect(out.every((v) => Number.isNaN(v))).toBe(true)
  })

  it('极大有限窗口（1e308）：钳制为 w = 序列长度，不挂起', async () => {
    const huge = datas(await ra(toItems(fixtures.normal), 1e308))
    const reference = datas(await ra(toItems(fixtures.normal), 8)) // w = floor(8/2) = 4 = 序列长度 → 全序列窗口
    expect(huge).toEqual(reference)
  })

  it('空数组返回空数组', async () => {
    expect(datas(await ra(toItems(fixtures.empty), 2))).toEqual([])
  })
})

describe('gs (Gaussian)', () => {
  it('sigma = 0：中心权重 exp(0/0) = NaN 污染整核，全部输出 NaN（JS 现状保留；NaN 参数现状为全 NaN，行为冻结待讨论）', async () => {
    const out = datas(await gs(toItems(fixtures.normal), 0))
    expect(out.every((v) => Number.isNaN(v))).toBe(true)
  })

  it('负数 sigma：核大小取 3、权重分母同 |sigma|，对称窗口输出等于中心值', async () => {
    const out = datas(await gs(toItems(fixtures.normal), -3))
    expect(out[1]).toBeCloseTo(20, 5) // 对称输入 + 对称核 → 中心值
  })

  it('缺失值跳过贡献并按剩余权重重归一化', async () => {
    const out = datas(await gs(toItems(fixtures.withMissing), 3))
    // p1 当前点缺失 → NaN；其余点为全窗口（σ=3 → 核宽 19）边界镜像加权，落在数据区间内
    expect(out[1]).toBeNaN()
    expect(out[0]).toBeGreaterThan(10)
    expect(out[0]).toBeLessThan(30)
    expect(out[2]).toBeGreaterThan(20)
    expect(out[2]).toBeLessThan(30)
  })

  it('空数组返回空数组', async () => {
    expect(datas(await gs(toItems(fixtures.empty), 3))).toEqual([])
  })
})

describe('checkpoint（调用方注入的检查点）', () => {
  it('每处理一个数据点前调用一次，参数为当前下标', async () => {
    const calls: number[] = []
    await twe(toItems(fixtures.normal), 0.5, {
      checkpoint: async (index) => {
        calls.push(index)
      }
    })
    expect(calls).toEqual([0, 1, 2, 3])
  })

  it('检查点抛出异常时中止计算并向上抛出', async () => {
    const checkpoint = async (index: number): Promise<void> => {
      if (index === 2) throw new Error('abort at 2')
    }
    await expect(twe(toItems(fixtures.normal), 0.5, { checkpoint })).rejects.toThrow('abort at 2')
  })
})

describe('数值稳定性（safeLerp 凸组合内核）', () => {
  describe('TWE 常数序列位级精确（#1530 回归）', () => {
    // 传入 value = w²，使实现内 sqrt(value) 恰为 issue 里的权重 w
    it.each([
      [0.7, 0.9, 500],
      [2.5, 0.995, 5000],
      [0.618, 0.999, 50000],
      [0, 0.9, 1000],
      [-3.7, 0.9, 1000]
    ])('c=%f, w=%f, N=%i：输出逐点 ===c', async (c, w, n) => {
      const out = datas(await twe(constantSeries(c, n), w * w))
      for (const v of out) expect(v).toBe(c)
    })

    it('常数与缺失混合：有效点 ===c、缺失点 NaN', async () => {
      const out = datas(await twe(constantSeries(2.5, 2000, 11), 0.98))
      out.forEach((v, i) => (i % 11 === 10 ? expect(v).toBeNaN() : expect(v).toBe(2.5)))
    })

    it('首部缺失 [NaN,NaN,5,NaN,5,5,5]：有效点全 ===5', async () => {
      const out = datas(await twe(toItems([NaN, NaN, 5, NaN, 5, 5, 5]), 0.81))
      expect(out).toEqual([NaN, NaN, 5, NaN, 5, 5, 5])
    })
  })

  describe('RA 常数序列位级精确', () => {
    it('value = 2 / 10 / 1e308（钳制为全序列窗口）：输出逐点 ===c', async () => {
      for (const value of [2, 10, 1e308]) {
        const out = datas(await ra(constantSeries(0.1, 200), value))
        for (const v of out) expect(v).toBe(0.1)
      }
    })

    it('常数与缺失混合：有效点 ===c、缺失点 NaN', async () => {
      const out = datas(await ra(constantSeries(0.1, 200, 7), 10))
      out.forEach((v, i) => (i % 7 === 6 ? expect(v).toBeNaN() : expect(v).toBe(0.1)))
    })
  })

  describe('GS 常数序列位级精确', () => {
    it('σ = 1 / 3 / 100 / -3：输出逐点 ===c', async () => {
      for (const sigma of [1, 3, 100, -3]) {
        const out = datas(await gs(constantSeries(0.618, 500), sigma))
        for (const v of out) expect(v).toBe(0.618)
      }
    })

    it('常数与缺失混合：有效点 ===c、缺失点 NaN', async () => {
      const out = datas(await gs(constantSeries(0.618, 500, 13), 3))
      out.forEach((v, i) => (i % 13 === 12 ? expect(v).toBeNaN() : expect(v).toBe(0.618)))
    })
  })

  describe('等价性守卫（与旧双累加器实现对拍）', () => {
    it('TWE：随机序列（含 3% 缺失）新旧输出最大绝对差 ≤ 1e-12', async () => {
      const rng = createRng(42)
      for (const value of [0.5, 0.9, 0.99]) {
        const series = randomSeries(3000, 2.5, 0.001, rng)
        expectEquivalent(datas(await twe(series, value)), tweOld(series, value))
      }
    })

    // RA 窗口累加顺序不同带来 ulp 级舍入噪声，随数据量级与窗口宽度增长（value=100、基线 1000 下实测 ~1.2e-12），
    // 容差按量级放宽到 1e-9（与 #2406 Cloud 侧一致）；代数错误量级为 O(数据幅度)，仍会被牢牢抓住
    it('RA：随机序列（含 3% 缺失）新旧输出最大绝对差 ≤ 1e-9', async () => {
      const rng = createRng(99)
      for (const value of [2, 10, 100]) {
        const series = randomSeries(2000, 1000, 500, rng)
        expectEquivalent(datas(await ra(series, value)), raOld(series, value), 1e-9)
      }
    })

    it('GS：随机序列（含 3% 缺失）新旧输出最大绝对差 ≤ 1e-12', async () => {
      const rng = createRng(7)
      for (const sigma of [1, 3]) {
        const series = randomSeries(1000, 0, 1, rng)
        expectEquivalent(datas(await gs(series, sigma)), gsOld(series, sigma))
      }
    })
  })

  describe('极端值与有界性', () => {
    it('TWE：±MAX_VALUE 异号序列输出全有限（不溢出、不吞点）', async () => {
      const out = datas(await twe(toItems([1.7e308, -1.7e308, 1.7e308, 1.7e308]), 0.25))
      expect(out.every((v) => Number.isFinite(v))).toBe(true)
    })

    it('RA/GS：±MAX_VALUE 异号序列输出全有限', async () => {
      const series = toItems([1.7e308, -1.7e308, 1.7e308, -1.7e308])
      expect(datas(await ra(series, 2)).every((v) => Number.isFinite(v))).toBe(true)
      expect(datas(await gs(series, 3)).every((v) => Number.isFinite(v))).toBe(true)
    })

    it('三算法：有限输入的输出不越出 [min−1ulp, max+1ulp]', async () => {
      const rng = createRng(2024)
      const series = randomSeries(500, 100, 20, rng)
      // 值域边界只统计有限值（序列含缺失点）
      const values = series.map((s) => s.data).filter((v) => Number.isFinite(v))
      const min = Math.min(...values)
      const max = Math.max(...values)
      const slack = 4 * Number.EPSILON * Math.max(1, Math.abs(min), Math.abs(max))
      for (const out of [await twe(series, 0.9), await ra(series, 10), await gs(series, 3)]) {
        out.forEach((item, index) => {
          // 缺失点输出 NaN 是既有契约；值域有界性只针对有效样本的平滑输出
          if (!Number.isFinite(series[index].data)) {
            expect(item.data).toBeNaN()
            return
          }
          expect(item.data).toBeGreaterThanOrEqual(min - slack)
          expect(item.data).toBeLessThanOrEqual(max + slack)
        })
      }
    })
  })
})
