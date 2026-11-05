//! Time Weighted EMA 平滑
//!
//! 归一化均值状态 `(y, D)` + safeLerp 凸组合：`y` 为当前平滑输出，`D` 为已累计权重
//! 每个有效数据点递推 `D = w·D + 1`、`y = safe_lerp(y, x, 1/D)`，状态即输出
//! 与 TS 正本（`smew/ts/smooth.ts`）位级一致：相同遍历顺序、相同浮点运算顺序

use crate::utils::numeric::safe_lerp;

/// Time Weighted EMA 平滑
///
/// * `values` —— 输入序列，缺失值以 NaN 表示
/// * `smoothing` —— 平滑度，实际权重取 `min(sqrt(smoothing), 0.999)`
///   NaN 参数按 0 透传、负数参数（sqrt 为 NaN）→ 全部输出 NaN，与 TS 版逐条对齐
pub fn twe(values: &[f64], smoothing: f64) -> Vec<f64> {
    // NaN 参数按 0 透传；负数参数 sqrt 为 NaN → 权重 NaN → 全部输出 NaN
    // Rust 的 f64::min 会忽略 NaN，必须显式分支保持一致
    let weight = if smoothing.is_nan() {
        0.0
    } else {
        let s = smoothing.sqrt();
        if s.is_nan() { s } else { s.min(0.999) }
    };
    // 归一化状态：y 为当前平滑输出，D 为已累计权重；初始值为 0（首个有效点 t = 1，safe_lerp 原样存入）
    let mut y = 0.0;
    let mut d = 0.0;

    values
        .iter()
        .map(|&x| {
            // 缺失值不更新递推状态，避免 NaN 污染后续有效点
            if x.is_finite() {
                d = weight * d + 1.0;
                // 首个有效点 d == 1 → t == 1 → safe_lerp 原样返回该点；常数线此后每步命中 a == b 位级透传
                y = safe_lerp(y, x, 1.0 / d);
                y
            } else {
                f64::NAN
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 位级相等断言：NaN 与 NaN 视为一致（不比较 payload），其余要求 to_bits 完全一致
    fn assert_bits_eq(actual: f64, expected: f64) {
        assert!(
            actual.to_bits() == expected.to_bits() || (actual.is_nan() && expected.is_nan()),
            "expected {} ({:x}), got {} ({:x})",
            expected,
            expected.to_bits(),
            actual,
            actual.to_bits()
        );
    }

    /// 常数序列位级精确：输出逐点与常数 to_bits 一致（#1530 回归，与 TS 测试同参数）
    #[test]
    fn constant_series_is_bitwise_exact() {
        for (c, smoothing, n) in [
            (0.7, 0.81, 500),         // w = 0.9，issue 原参数
            (2.5, 0.990025, 5000),    // w = 0.995
            (0.618, 0.998001, 50000), // w = 0.999
            (0.0, 0.81, 1000),
            (-3.7, 0.81, 1000),
        ] {
            let input = vec![c; n];
            for &out in twe(&input, smoothing).iter() {
                assert_bits_eq(out, c);
            }
        }
    }

    /// 常数与缺失混合：有效点 ===c、缺失点 NaN
    #[test]
    fn constant_series_with_missing_keeps_positions() {
        let input: Vec<f64> = (0..2000)
            .map(|i| if i % 11 == 10 { f64::NAN } else { 2.5 })
            .collect();
        for (i, &out) in twe(&input, 0.98).iter().enumerate() {
            if i % 11 == 10 {
                assert!(out.is_nan());
            } else {
                assert_bits_eq(out, 2.5);
            }
        }
    }

    /// 首部缺失：有效点全 ===5，缺失位置不变
    #[test]
    fn leading_missing_bitwise_exact() {
        let input = [f64::NAN, f64::NAN, 5.0, f64::NAN, 5.0, 5.0, 5.0];
        let out = twe(&input, 0.81);
        assert!(out[0].is_nan() && out[1].is_nan() && out[3].is_nan());
        assert_bits_eq(out[2], 5.0);
        assert_bits_eq(out[4], 5.0);
        assert_bits_eq(out[5], 5.0);
        assert_bits_eq(out[6], 5.0);
    }

    /// NaN 参数按 0 透传；负数参数权重 NaN → 全部输出 NaN
    #[test]
    fn invalid_smoothing_contract() {
        // smoothing = NaN：按 0 处理 → 原样透传（缺失点仍 NaN）
        let out = twe(&[10.0, f64::NAN, 30.0], f64::NAN);
        assert_bits_eq(out[0], 10.0);
        assert!(out[1].is_nan());
        assert_bits_eq(out[2], 30.0);
        // smoothing < 0：sqrt 为 NaN → 权重 NaN → 全部输出 NaN（含首个有效点）
        let out = twe(&[10.0, 20.0, 30.0, 40.0], -1.0);
        assert!(out.iter().all(|v| v.is_nan()));
    }

    /// 缺失点输出 NaN 且不更新状态，后续有效点继续计算。
    /// 期望值直接取 vitest 打印过的 TS 实际输出（21.715728752538098）做跨语言位级锚点
    #[test]
    fn missing_point_keeps_state_and_output_nan() {
        let out = twe(&[10.0, f64::NAN, 30.0], 0.5);
        assert_bits_eq(out[0], 10.0);
        assert!(out[1].is_nan());
        assert_bits_eq(out[2], 21.715728752538098);
    }

    /// 空数组返回空数组；单点原样透传（t=1 位级）
    #[test]
    fn empty_and_single_input() {
        let empty: [f64; 0] = [];
        assert!(twe(&empty, 0.5).is_empty());
        let out = twe(&[42.0], 0.5);
        assert_bits_eq(out[0], 42.0);
    }

    /// ±MAX_VALUE 异号序列输出全有限（凸组合不上溢）
    #[test]
    fn opposite_extremes_stay_finite() {
        let out = twe(&[1.7e308, -1.7e308, 1.7e308, 1.7e308], 0.25);
        assert!(out.iter().all(|v| v.is_finite()));
    }
}
