//! Gaussian 平滑
//!
//! 用 sigma 反算窗口大小（`max(3, floor(sigma × 6))` 并调整为奇数），高斯核按`exp(−x² / 2σ²)` 归一化后，窗口内有效样本逐个按核权重融入均值：
//! 1. `mu` 为当前均值，`W` 为已融入的核权重，新样本占比由 `safe_weight_ratio(W, kernel[j])` 算出
//! 2. 算完一个输出点后 `mu`、`W` 归零——均值不跨窗口延续
//!
//! 对拍标准与 TWE / RA 不同：`exp` 是 IEEE 754 不强制正确舍入的超越函数，JS `Math.exp`
//! 与 Rust `f64::exp` 不保证末位相同，故 GS 按"NaN 位置严格一致 + 有限值容差"对拍，常数序列仍位级精确

use crate::utils::numeric::{safe_lerp, safe_weight_ratio};

/// JS 的 `| 0`（ToInt32）：截断后按 2³² 取模；NaN / ±Infinity → 0
/// Rust 的 `as i32` 会饱和截断而不回绕，极端 sigma 下语义不同，须单独对齐
fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let m = x.trunc().rem_euclid(4_294_967_296.0);
    if m >= 2_147_483_648.0 {
        (m - 4_294_967_296.0) as i32
    } else {
        m as i32
    }
}

/// Gaussian 平滑
///
/// * `values` —— 输入序列，缺失值以 NaN 表示
/// * `sigma` —— 高斯核带宽；σ=0 / NaN 时核被 NaN 污染 → 全部输出 NaN
pub fn gs(values: &[f64], sigma: f64) -> Vec<f64> {
    // 核大小取 max(3, floor(sigma × 6) | 0) 并调整为奇数，与 TS 版逐字对应
    let mut kernel_size = to_int32((sigma * 6.0).floor()).max(3);
    if kernel_size % 2 == 0 {
        kernel_size += 1;
    }
    let half = (kernel_size - 1) / 2;

    // 核权重 exp(−x² / 2σ²) 归一化；σ=0 时中心权重 exp(0/0) = NaN 污染整核
    let kernel: Vec<f64> = (0..kernel_size)
        .map(|i| {
            let x = (i - half) as f64;
            (-(x * x) / (2.0 * sigma * sigma)).exp()
        })
        .collect();
    let sum: f64 = kernel.iter().sum();
    let kernel: Vec<f64> = kernel.iter().map(|&k| k / sum).collect();

    values
        .iter()
        .enumerate()
        .map(|(index, &item)| {
            let mut mu = 0.0;
            let mut w = 0.0;
            for (j, &k) in kernel.iter().enumerate() {
                // 序列两端 clamp 重复使用端点
                let source_index = ((index + j) as isize - half as isize)
                    .clamp(0, values.len() as isize - 1)
                    as usize;
                let x = values[source_index];
                // 缺失值不贡献卷积结果，剩余有效权重重新归一化
                if !x.is_finite() {
                    continue;
                }
                // σ=0 时核为 NaN → t 为 NaN → 输出 NaN，既有契约经 NaN 分支保留
                mu = safe_lerp(mu, x, safe_weight_ratio(w, k));
                w += k;
            }
            // 当前点缺失时保留 NaN，没有有效权重时避免产生无意义的除法结果
            if !item.is_finite() || w == 0.0 {
                f64::NAN
            } else {
                mu
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

    /// σ=0 / NaN：核被 NaN 污染，全部输出 NaN
    #[test]
    fn zero_and_nan_sigma_all_nan() {
        for sigma in [0.0, f64::NAN] {
            let out = gs(&[10.0, 20.0, 30.0, 40.0], sigma);
            assert!(out.iter().all(|v| v.is_nan()), "sigma = {sigma} 应全 NaN");
        }
    }

    /// 负数 sigma：核大小取 3，权重分布同 |σ|，对称窗口输出等于中心值（exp 容差内）
    #[test]
    fn negative_sigma_symmetric_kernel() {
        let out = gs(&[10.0, 20.0, 30.0, 40.0], -3.0);
        assert!((out[1] - 20.0).abs() < 1e-12);
    }

    /// 缺失值跳过贡献；当前点缺失输出 NaN；其余点落在数据值域内
    #[test]
    fn missing_values_skip_and_stay_in_range() {
        let out = gs(&[10.0, f64::NAN, 30.0], 3.0);
        assert!(out[1].is_nan());
        assert!(out[0] > 10.0 && out[0] < 30.0);
        assert!(out[2] > 20.0 && out[2] < 30.0);
    }

    /// 常数序列位级精确（σ = 1 / 3 / 100 / -3）：a == b 分支不经过 exp，输出逐点 ===c
    #[test]
    fn constant_series_is_bitwise_exact() {
        for sigma in [1.0, 3.0, 100.0, -3.0] {
            let input = vec![0.618; 500];
            for &out in gs(&input, sigma).iter() {
                assert_bits_eq(out, 0.618);
            }
        }
    }

    /// 常数与缺失混合：有效点 ===c、缺失点 NaN
    #[test]
    fn constant_series_with_missing_keeps_positions() {
        let input: Vec<f64> = (0..500)
            .map(|i| if i % 13 == 12 { f64::NAN } else { 0.618 })
            .collect();
        for (i, &out) in gs(&input, 3.0).iter().enumerate() {
            if i % 13 == 12 {
                assert!(out.is_nan());
            } else {
                assert_bits_eq(out, 0.618);
            }
        }
    }

    /// 空数组返回空数组；单点透传；±MAX_VALUE 异号序列输出全有限
    #[test]
    fn edge_inputs() {
        let empty: [f64; 0] = [];
        assert!(gs(&empty, 3.0).is_empty());
        let out = gs(&[42.0], 3.0);
        assert!((out[0] - 42.0).abs() < 1e-12);
        let osc = [1.7e308, -1.7e308, 1.7e308, -1.7e308];
        assert!(gs(&osc, 3.0).iter().all(|v| v.is_finite()));
    }

    /// 核大小语义：σ=1 → floor(6)=6 → 偶数化 7；σ=-3 → floor(-18) → max(3, -18) = 3
    #[test]
    fn kernel_size_semantics() {
        // 借 σ=1（7 点核）与 σ=-3（3 点核）在 [0,0,0,7] 上的首点区分核宽：
        // 窄核首点窗口全落在 0 上输出 0，宽核窗口够到末尾的 7 而被拉高
        let narrow = gs(&[0.0, 0.0, 0.0, 7.0], -3.0)[0];
        let wide = gs(&[0.0, 0.0, 0.0, 7.0], 1.0)[0];
        assert!(
            wide > narrow,
            "宽核首点应比窄核高：wide={wide}, narrow={narrow}"
        );
    }
}
