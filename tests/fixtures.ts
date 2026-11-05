/**
 * @description 对拍与行为测试的公共测试材料
 * 本目录作为独立库的测试，不 import cloud 项目的任何代码：测试输入只要求对象带 `data: number` 字段，与库的公共接口保持同一约束。
 */

/** 测试输入的最小结构（与库的 SmoothInput 约束一致） */
export interface FixtureItem {
  data: number
  index: number
}

/** 把纯 data 数组包装成测试输入
 * @param datas - 纯 data 数组
 * @returns 测试输入列表
 */
export const toItems = (datas: number[]): FixtureItem[] => datas.map((data, index) => ({ data, index }))

/** 提取输出的 data 序列，便于断言
 * @param items - 平滑输出的结果列表
 * @returns data 数值序列
 */
export const datas = (items: { data: number }[]) => items.map((item) => item.data)

/** 公共 fixtures：纯 data 数组（缺失值以 NaN 表示），测试时经 toItems 包装一次 */
export const fixtures: Record<string, number[]> = {
  empty: [],
  normal: [10, 20, 30, 40],
  withMissing: [10, NaN, 30],
  allNaN: [NaN, NaN, NaN],
  single: [42]
}
