import { describe, expect, it } from 'vitest'

import rsInit, { gs as rsGs, ra as rsRa, twe as rsTwe } from '../dist/wasm.js'
import { gs, ra, twe } from '../ts/smooth'
import { datas, fixtures, toItems } from './fixtures'

// TS ↔ RS 对拍：同一组 fixtures 分别喂给 TS 实现（../ts/smooth）与 RS 实现（dist/wasm.js），断言输出一致。
// 判定标准见 docs/agents/smew.md：
// - TWE / RA：有限值 f64::to_bits() 完全一致，NaN 位置一致（不接受任何容差）
// - GS：缺失点位置与 NaN 语义严格一致，有限值在约定容差内（exp 不强制正确舍入，位级不可证）
// 用例覆盖契约要求：缺失值边界、空数组、全 NaN、单点、参数取滑块 range 两端、随机序列、常数序列

// dist 的 init 幂等（重复调用返回已初始化实例），模块加载即就绪
await rsInit()

/**
 * 可复现的伪随机数发生器（LCG），与 smooth.test.ts 同构，保证对拍样本确定
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
 * 生成带缺失的随机序列：base ± amp 内波动，missingRate 比例的点置为 NaN
 * @param length 序列长度
 * @param base 基线值
 * @param amp 波动幅度
 * @param seed 随机种子
 * @param missingRate 缺失点比例
 */
const randomValues = (length: number, base: number, amp: number, seed: number, missingRate = 0.03): number[] => {
  const rng = createRng(seed)
  return Array.from({ length }, () => (rng() < missingRate ? NaN : base + (rng() * 2 - 1) * amp))
}

/**
 * 位级一致断言（TWE / RA 判定标准）：NaN 位置一一对应，有限值完全相等（不含任何容差）
 * @param tsOut TS 实现输出
 * @param rsOut RS 实现输出
 */
const expectBitwiseParity = (tsOut: number[], rsOut: ArrayLike<number>): void => {
  expect(rsOut.length).toBe(tsOut.length)
  for (let i = 0; i < tsOut.length; i++) {
    if (Number.isNaN(tsOut[i])) {
      expect(Number.isNaN(rsOut[i]), `位置 ${i} 应为 NaN`).toBe(true)
      continue
    }
    expect(Number.isNaN(rsOut[i]), `位置 ${i} 不应为 NaN`).toBe(false)
    // toBe 基于 Object.is：有限值相等 ⟺ to_bits 相等；±0 与数值差异均会被捕获
    expect(rsOut[i], `位置 ${i} 位级不一致: ts=${tsOut[i]} rs=${rsOut[i]}`).toBe(tsOut[i])
  }
}

/**
 * 容差一致断言（GS 判定标准）：NaN 位置严格一致，有限值 abs ≤ 1e-12 或 rel ≤ 1e-9
 * @param tsOut TS 实现输出
 * @param rsOut RS 实现输出
 */
const expectToleranceParity = (tsOut: number[], rsOut: ArrayLike<number>): void => {
  expect(rsOut.length).toBe(tsOut.length)
  for (let i = 0; i < tsOut.length; i++) {
    expect(Number.isNaN(rsOut[i]), `位置 ${i} NaN 位置不一致`).toBe(Number.isNaN(tsOut[i]))
    if (Number.isNaN(tsOut[i])) continue
    const abs = Math.abs(tsOut[i] - rsOut[i])
    const rel = abs / Math.max(Math.abs(tsOut[i]), Math.abs(rsOut[i]), Number.MIN_VALUE)
    expect(abs <= 1e-12 || rel <= 1e-9, `位置 ${i} 超容差: abs=${abs} rel=${rel}`).toBe(true)
  }
}

describe('parity: TS 与 RS 实现一致性', () => {
  describe('TWE（f64::to_bits 位级一致）', () => {
    const cases = [
      { name: '常规序列', values: fixtures.normal, smoothing: 0.5 },
      { name: '含缺失序列', values: fixtures.withMissing, smoothing: 0.5 },
      { name: '全 NaN 序列', values: fixtures.allNaN, smoothing: 0.99 },
      { name: '单点', values: fixtures.single, smoothing: 0.99 },
      { name: '滑块 range 下端（0 → 透传）', values: fixtures.normal, smoothing: 0 },
      // 3000 点随机波动 + 3% 缺失，多组权重
      { name: '随机序列 @0.5', values: randomValues(3000, 2.5, 0.001, 42), smoothing: 0.5 },
      { name: '随机序列 @0.98', values: randomValues(3000, 2.5, 0.001, 42), smoothing: 0.98 },
      // #1530 issue 参数：常数线位级一致
      { name: '常数序列（c=0.7, w=0.9）', values: Array.from({ length: 500 }, () => 0.7), smoothing: 0.81 }
    ]

    it.each(cases)('$name', async ({ values, smoothing }) => {
      expectBitwiseParity(datas(await twe(toItems(values), smoothing)), rsTwe(new Float64Array(values), smoothing))
    })

    it('空数组返回空数组', async () => {
      const out = await twe(toItems(fixtures.empty), 0.5)
      expect(rsTwe(new Float64Array(0), 0.5)).toHaveLength(out.length)
    })
  })

  describe('RA（f64::to_bits 位级一致）', () => {
    const cases = [
      { name: '常规序列 @2', values: fixtures.normal, value: 2 },
      { name: '含缺失序列 @2', values: fixtures.withMissing, value: 2 },
      { name: '全 NaN 序列 @10', values: fixtures.allNaN, value: 10 },
      { name: '单点 @2', values: fixtures.single, value: 2 },
      { name: '滑块 range 下端（0 → 透传）', values: fixtures.normal, value: 0 },
      { name: '滑块 range 上端（100）', values: fixtures.normal, value: 100 },
      { name: '极端负参数（-1e300 → 全 NaN）', values: fixtures.normal, value: -1e300 },
      { name: '随机序列 @2', values: randomValues(2000, 1000, 500, 99), value: 2 },
      { name: '随机序列 @10', values: randomValues(2000, 1000, 500, 99), value: 10 },
      { name: '随机序列 @100', values: randomValues(2000, 1000, 500, 99), value: 100 },
      { name: '常数序列（c=0.1）@10', values: Array.from({ length: 200 }, () => 0.1), value: 10 }
    ]

    it.each(cases)('$name', async ({ values, value }) => {
      expectBitwiseParity(datas(await ra(toItems(values), value)), rsRa(new Float64Array(values), value))
    })

    it('空数组返回空数组', async () => {
      const out = await ra(toItems(fixtures.empty), 2)
      expect(rsRa(new Float64Array(0), 2)).toHaveLength(out.length)
    })
  })

  describe('GS（NaN 位置严格一致 + 有限值容差）', () => {
    const cases = [
      { name: '常规序列 @1', values: fixtures.normal, sigma: 1 },
      { name: '含缺失序列 @3', values: fixtures.withMissing, sigma: 3 },
      { name: '全 NaN 序列 @3', values: fixtures.allNaN, sigma: 3 },
      { name: '单点 @3', values: fixtures.single, sigma: 3 },
      { name: '滑块 range 上端（100）', values: fixtures.normal, sigma: 100 },
      { name: '随机序列 @1', values: randomValues(1000, 0, 1, 7), sigma: 1 },
      { name: '随机序列 @3', values: randomValues(1000, 0, 1, 7), sigma: 3 },
      { name: '常数序列（c=0.618）@3', values: Array.from({ length: 500 }, () => 0.618), sigma: 3 }
    ]

    it.each(cases)('$name', async ({ values, sigma }) => {
      expectToleranceParity(datas(await gs(toItems(values), sigma)), rsGs(new Float64Array(values), sigma))
    })

    it('空数组返回空数组', async () => {
      const out = await gs(toItems(fixtures.empty), 3)
      expect(rsGs(new Float64Array(0), 3)).toHaveLength(out.length)
    })
  })
})
