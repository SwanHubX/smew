/**
 * @description smew 公共入口 —— 对外只暴露这一份平滑 API
 * 内部包含两套实现，由本入口统一调度（调用方无需感知，也不应 import 内部文件）, 两套实现输出完全一致：
 * - WASM 实现（./dist/wasm.js，Rust 编译产物）：默认优先，速度更快
 * - TS 实现（./ts/smooth.ts）：纯 JS 回退，WASM 未就绪或加载失败时自动顶上
 * 输入只要求对象带 `data: number` 字段（缺失值以 NaN 表示），其余业务字段原样透传
 */
import type { Checkpoint, SmoothInput, SmoothOptions } from './ts/smooth.js';
export type { Checkpoint, SmoothFunc, SmoothInput, SmoothOptions } from './ts/smooth.js';
/** smew 支持的平滑类型 */
export type SmoothType = 'TWE' | 'RA' | 'GS';
/** TWE 配置 */
export interface TWEConfig {
    /** 平滑参数，范围 0~0.99 */
    value: number;
}
/** RA 配置 */
export interface RAConfig {
    /** 窗口参数 */
    value: number;
}
/** GS 配置 */
export interface GSConfig {
    /** 高斯 sigma */
    value: number;
}
/** 平滑类型到配置的映射：第一个参数决定第三个参数的类型 */
export interface SmoothConfigMap {
    TWE: TWEConfig;
    RA: RAConfig;
    GS: GSConfig;
}
/** 按平滑类型取出对应配置类型 */
export type SmoothConfig<K extends SmoothType> = SmoothConfigMap[K];
/**
 * Time Weighted EMA 平滑
 * @param series - 原始序列（缺失值以 NaN 表示）
 * @param value - 平滑参数
 * @param options - 可选项；checkpoint 检查点仅 TS 回退路径逐点响应（WASM 路径单次完整计算，不感知检查点）
 * @returns 与输入等长的平滑结果（data 为平滑值，其余字段原样保留）
 */
export declare const twe: <T extends {
    data: number;
}>(series: T[], value: number, options?: SmoothOptions) => Promise<T[]>;
/**
 * Running Average 平滑
 * @param series - 原始序列（缺失值以 NaN 表示）
 * @param value - 窗口参数
 * @param options - 可选项；checkpoint 检查点仅 TS 回退路径逐点响应（WASM 路径单次完整计算，不感知检查点）
 * @returns 与输入等长的平滑结果（data 为平滑值，其余字段原样保留）
 */
export declare const ra: <T extends {
    data: number;
}>(series: T[], value: number, options?: SmoothOptions) => Promise<T[]>;
/**
 * Gaussian 平滑
 * @param series - 原始序列（缺失值以 NaN 表示）
 * @param value - sigma
 * @param options - 可选项；checkpoint 检查点仅 TS 回退路径逐点响应（WASM 路径单次完整计算，不感知检查点）
 * @returns 与输入等长的平滑结果（data 为平滑值，其余字段原样保留）
 */
export declare const gs: <T extends {
    data: number;
}>(series: T[], value: number, options?: SmoothOptions) => Promise<T[]>;
/**
 * 统一平滑入口：按类型分派到 twe / ra / gs，第三个参数类型由第一个参数决定
 * @param type - 平滑类型
 * @param series - 原始序列（缺失值以 NaN 表示）
 * @param config - 对应平滑类型的配置
 * @param checkpoint - 可选项；checkpoint 检查点仅 TS 回退路径逐点响应（WASM 路径单次完整计算，不感知检查点），抛出异常会中止计算
 * @returns 与输入等长的平滑结果（data 为平滑值，其余字段原样保留）
 */
export declare function smew<T extends SmoothInput, K extends SmoothType>(type: K, series: T[], config: SmoothConfigMap[K], checkpoint?: Checkpoint): Promise<T[]>;
export default smew;
//# sourceMappingURL=index.d.ts.map