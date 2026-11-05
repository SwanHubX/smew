/**
 * @description 平滑算法的 TS 实现 —— WASM 加载失败时由前端使用
 * 本文件是纯算法：数据量大时的让出主线程、取消等调度策略由调用方通过检查点（checkpoint）注入，库内不感知任何调度细节
 * 数值内核：三算法统一为归一化均值状态 (y, D) / (mu, W)，新数据逐点按权重融入当前均值
 * 常数序列位级透传（#1530）、有限输入必得有限输出（凸组合恒落在已见数据值域内）
 */
/** 平滑输入的最小结构：只要带 data 数值即可（缺失值以 NaN 表示） */
export interface SmoothInput {
    data: number;
}
/**
 * 检查点：每处理一个数据点前调用一次（异步等待其完成）
 * 让出主线程、响应取消等策略由调用方实现；检查点抛出异常会中止整个计算并向上抛出
 */
export type Checkpoint = (index: number) => void | Promise<void>;
/** 平滑可选项 */
export interface SmoothOptions {
    /** 检查点；不传则无任何调度开销、一次性算完 */
    checkpoint?: Checkpoint;
}
/** 平滑函数的统一签名：输入输出同构（data 被替换为平滑值，其余字段原样保留） */
export type SmoothFunc = <T extends SmoothInput>(series: T[], value: number, options?: SmoothOptions) => Promise<T[]>;
export declare const twe: <T extends SmoothInput>(series: T[], value: number, options?: SmoothOptions) => Promise<T[]>;
export declare const ra: <T extends SmoothInput>(series: T[], value: number, options?: SmoothOptions) => Promise<T[]>;
/**
 * @description 高斯平滑，用 sigma 反算窗口大小
 * @param series 系列数据
 * @param value sigma
 * @param options 可选项（checkpoint：每处理一个数据点前异步调用的检查点）
 */
export declare const gs: <T extends SmoothInput>(series: T[], value: number, options?: SmoothOptions) => Promise<T[]>;
//# sourceMappingURL=smooth.d.ts.map