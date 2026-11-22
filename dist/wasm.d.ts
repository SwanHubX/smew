/* 本文件由 smew/scripts/inline-wasm.mjs 生成，请勿手改 */

/**
 * Gaussian 平滑
 */
export function gs(values: Float64Array, sigma: number): Float64Array

/**
 * Running Average 平滑
 */
export function ra(values: Float64Array, value: number): Float64Array

/**
 * Time Weighted EMA 平滑
 */
export function twe(values: Float64Array, smoothing: number): Float64Array

/**
 * 初始化内嵌的 WASM 模块（字节已随文件内嵌，无需参数；重复调用返回已初始化实例）
 */
export default function init(): Promise<unknown>
