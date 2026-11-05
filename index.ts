/**
 * @description smew 公共入口 —— 对外只暴露这一份平滑 API
 * 内部包含两套实现，由本入口统一调度（调用方无需感知，也不应 import 内部文件）, 两套实现输出完全一致：
 * - WASM 实现（./dist/index.js，Rust 编译产物）：默认优先，速度更快
 * - TS 实现（./ts/smooth.ts）：纯 JS 回退，WASM 未就绪或加载失败时自动顶上
 * 输入只要求对象带 `data: number` 字段（缺失值以 NaN 表示），其余业务字段原样透传
 */
import type { Checkpoint, SmoothInput, SmoothOptions } from './ts/smooth'
import * as tsImpl from './ts/smooth'

export type { Checkpoint, SmoothFunc, SmoothInput, SmoothOptions } from './ts/smooth'

/** smew 支持的平滑类型 */
export type SmoothType = 'TWE' | 'RA' | 'GS'

/** TWE 配置 */
export interface TWEConfig {
  /** 平滑参数，范围 0~0.99 */
  value: number
}

/** RA 配置 */
export interface RAConfig {
  /** 窗口参数 */
  value: number
}

/** GS 配置 */
export interface GSConfig {
  /** 高斯 sigma */
  value: number
}

/** 平滑类型到配置的映射：第一个参数决定第三个参数的类型 */
export interface SmoothConfigMap {
  TWE: TWEConfig
  RA: RAConfig
  GS: GSConfig
}

/** 按平滑类型取出对应配置类型 */
export type SmoothConfig<K extends SmoothType> = SmoothConfigMap[K]

/** WASM 模块的导出形态（dist/index.js） */
interface WasmModule {
  default: () => Promise<unknown>
  twe: (values: Float64Array, smoothing: number) => Float64Array
  ra: (values: Float64Array, value: number) => Float64Array
  gs: (values: Float64Array, sigma: number) => Float64Array
}

// 当前可用的 WASM 模块：null 表示未就绪或加载失败（此时所有调用回退 TS 实现）
let wasmModule: WasmModule | null = null
// 初始化只执行一次：并发调用共享同一个初始化 Promise（成功或失败都只处理一次）
let wasmInit: Promise<void> | null = null

function initWasm(): Promise<void> {
  if (wasmInit) return wasmInit
  // 环境不支持 WebAssembly 时直接回退，避免无谓下载 dist 产物
  if (typeof WebAssembly === 'undefined') {
    console.warn('[smew] 当前环境不支持 WebAssembly，平滑使用 TS 回退实现')
    wasmInit = Promise.resolve()
    return wasmInit
  }
  // 产物已随仓库提交（dist/index.js，字节内嵌），静态路径让打包器正常解析并切出异步 chunk
  wasmInit = import('./dist/index.js')
    .then(async (wasm: WasmModule) => {
      await wasm.default()
      wasmModule = wasm
    })
    .catch(() => {
      console.warn('[smew] WASM 加载失败，平滑使用 TS 回退实现')
    })
  return wasmInit
}

// 模块加载即开始后台初始化 WASM，首次平滑调用若 WASM 未就绪，自动走 TS 回退
void initWasm()

/**
 * 把序列提取成 WASM 入参（缺失值以 NaN 表示）
 * @param series  原始序列
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
 * 把 WASM 输出按位置组装回去（data 替换为平滑值，其余业务字段原样保留）
 * @param series - 原始序列
 * @param out - WASM 输出的数值序列
 * @returns 组装后的序列
 */
const withSmoothedData = <T extends { data: number }>(series: T[], out: ArrayLike<number>): T[] =>
  series.map((item, i) => ({
    ...item,
    data: out[i]
  }))

function runWithWasm<T extends { data: number }>(
  wasmFn: (values: Float64Array, param: number) => Float64Array,
  series: T[],
  param: number
): T[] {
  return withSmoothedData(series, wasmFn(toValues(series), param))
}

/**
 * Time Weighted EMA 平滑
 * @param series - 原始序列（缺失值以 NaN 表示）
 * @param value - 平滑参数
 * @param options - 可选项；checkpoint 检查点仅 TS 回退路径逐点响应（WASM 路径单次完整计算，不感知检查点）
 * @returns 与输入等长的平滑结果（data 为平滑值，其余字段原样保留）
 */
export const twe = async <T extends { data: number }>(
  series: T[],
  value: number,
  options?: SmoothOptions
): Promise<T[]> => {
  if (wasmModule) return runWithWasm(wasmModule.twe, series, value)
  return tsImpl.twe(series, value, options)
}

/**
 * Running Average 平滑
 * @param series - 原始序列（缺失值以 NaN 表示）
 * @param value - 窗口参数
 * @param options - 可选项；checkpoint 检查点仅 TS 回退路径逐点响应（WASM 路径单次完整计算，不感知检查点）
 * @returns 与输入等长的平滑结果（data 为平滑值，其余字段原样保留）
 */
export const ra = async <T extends { data: number }>(
  series: T[],
  value: number,
  options?: SmoothOptions
): Promise<T[]> => {
  if (wasmModule) return runWithWasm(wasmModule.ra, series, value)
  return tsImpl.ra(series, value, options)
}

/**
 * Gaussian 平滑
 * @param series - 原始序列（缺失值以 NaN 表示）
 * @param value - sigma
 * @param options - 可选项；checkpoint 检查点仅 TS 回退路径逐点响应（WASM 路径单次完整计算，不感知检查点）
 * @returns 与输入等长的平滑结果（data 为平滑值，其余字段原样保留）
 */
export const gs = async <T extends { data: number }>(
  series: T[],
  value: number,
  options?: SmoothOptions
): Promise<T[]> => {
  if (wasmModule) return runWithWasm(wasmModule.gs, series, value)
  return tsImpl.gs(series, value, options)
}

/**
 * 统一平滑入口：按类型分派到 twe / ra / gs，第三个参数类型由第一个参数决定
 * @param type - 平滑类型
 * @param series - 原始序列（缺失值以 NaN 表示）
 * @param config - 对应平滑类型的配置
 * @param checkpoint - 可选项；checkpoint 检查点仅 TS 回退路径逐点响应（WASM 路径单次完整计算，不感知检查点），抛出异常会中止计算
 * @returns 与输入等长的平滑结果（data 为平滑值，其余字段原样保留）
 */
export function smew<T extends SmoothInput, K extends SmoothType>(
  type: K,
  series: T[],
  config: SmoothConfigMap[K],
  checkpoint?: Checkpoint
): Promise<T[]>
export function smew<T extends SmoothInput>(
  type: SmoothType,
  series: T[],
  config: SmoothConfigMap[SmoothType],
  checkpoint?: Checkpoint
): Promise<T[]> {
  const options = checkpoint === undefined ? undefined : { checkpoint }
  switch (type) {
    case 'TWE':
      return twe(series, config.value, options)
    case 'RA':
      return ra(series, config.value, options)
    case 'GS':
      return gs(series, config.value, options)
  }
}

export default smew
