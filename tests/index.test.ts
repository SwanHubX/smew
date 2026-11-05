import { describe, expect, it } from 'vitest'

import smew, { gs, ra, twe } from '../index'
import { datas, toItems } from './fixtures'

/**
 * 按容差比较两条输出序列；NaN 只要求位置一致
 * @param actual 统一入口输出
 * @param expected 单算法入口输出
 */
const expectClose = (actual: number[], expected: number[]): void => {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((value, index) => {
    if (Number.isNaN(expected[index])) {
      expect(value).toBeNaN()
      return
    }
    expect(value).toBeCloseTo(expected[index], 10)
  })
}

describe('smew（统一入口）', () => {
  const series = toItems([10, 20, 30, 40])

  it('TWE：按类型与配置分派', async () => {
    expectClose(datas(await smew('TWE', series, { value: 0.5 })), datas(await twe(series, 0.5)))
  })

  it('RA：按类型与配置分派', async () => {
    expectClose(datas(await smew('RA', series, { value: 3 })), datas(await ra(series, 3)))
  })

  it('GS：按类型与配置分派', async () => {
    expectClose(datas(await smew('GS', series, { value: 1 })), datas(await gs(series, 1)))
  })
})
