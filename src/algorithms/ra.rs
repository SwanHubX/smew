//! Running Average 平滑
//!
//! 每个输出点取当前点前后各 half 个点的窗口，把窗口内的有效样本逐个按权重融入均值：
//! 1. `mu` 为当前均值，`count` 为已融入的有效样本数，新样本占比由 `safe_weight_ratio(count, 1)` 算出
//! 2. 算完一个输出点后 `mu`、`count` 归零——每个输出点的窗口互不相干，均值不跨窗口延续
//!
//! 与 TS 正本（`smew/ts/smooth.ts`）位级一致：相同遍历顺序、相同浮点运算顺序

use crate::utils::numeric::{safe_lerp, safe_weight_ratio};

/// Running Average 平滑
///
/// * `values` —— 输入序列，缺失值以 NaN 表示
/// * `value` —— 窗口参数，实际窗口长度为 `2 × floor(value / 2) + 1`
pub fn ra(values: &[f64], value: f64) -> Vec<f64> {
    let w = (value / 2.0).floor();
    // 非有限窗口（如 ±Infinity / NaN 参数）无法构成有效循环区间，按非法参数直接输出全 NaN，避免宿主挂起
    if !w.is_finite() {
        return vec![f64::NAN; values.len()];
    }
    // 负窗口归一为 -1：start > end 空循环 → 全 NaN，与 TS 正本一致
    // 正窗口钳制到序列长度：w ≥ len 时窗口本就覆盖全序列，输出不变
    let half = if w < 0.0 {
        -1
    } else {
        w.min(values.len() as f64) as isize
    };

    values
        .iter()
        .enumerate()
        .map(|(index, &item)| {
            let start = index as isize - half;
            let end = index as isize + half;
            // 折叠状态每个输出点重置：mu 为窗口有效样本的均值，count 为有效样本数
            let mut mu = 0.0;
            let mut count = 0.0;
            for i in start..=end {
                // 序列两端 clamp 重复使用端点
                let now_index = (i.max(0) as usize).min(values.len() - 1);
                let x = values[now_index];
                // 缺失值不参与加权，使用有效样本数作为权重，避免结果被缺失值拉低
                if !x.is_finite() {
                    continue;
                }
                // 首个有效样本 t === 1 原样返回；常数窗口此后每步命中 a === b 位级透传
                mu = safe_lerp(mu, x, safe_weight_ratio(count, 1.0));
                count += 1.0;
            }
            // 当前点缺失时保持 NaN，窗口无有效样本时也无法计算平均值
            if !item.is_finite() || count == 0.0 {
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

    /// value = 0 / 1 时窗口仅自身，原样透传
    #[test]
    fn passthrough_on_self_window() {
        let input = [10.0, 20.0, 30.0, 40.0];
        let out = ra(&input, 0.0);
        for (i, &v) in out.iter().enumerate() {
            assert_bits_eq(v, input[i]);
        }
        let out = ra(&input, 1.0);
        for (i, &v) in out.iter().enumerate() {
            assert_bits_eq(v, input[i]);
        }
    }

    /// 窗口 3（value = 2）：边界 clamp 重复使用端点，折叠结果等于窗口均值（容差内）
    #[test]
    fn window_of_three_matches_mean() {
        let out = ra(&[10.0, 20.0, 30.0, 40.0], 2.0);
        assert!((out[0] - 40.0 / 3.0).abs() < 1e-12); // [10,10,20]
        assert!((out[1] - 20.0).abs() < 1e-12); // [10,20,30]
        assert_bits_eq(out[2], 30.0); // [20,30,40] 对称窗口位级精确
        assert!((out[3] - 110.0 / 3.0).abs() < 1e-12); // [30,40,40]
    }

    /// 窗口内缺失值跳过；当前点缺失输出 NaN（与 TS 断言同值，位级）
    #[test]
    fn missing_values_skip_and_current_nan() {
        let out = ra(&[10.0, f64::NAN, 30.0], 2.0);
        assert_bits_eq(out[0], 10.0); // [10,10,NaN] → 有效 10
        assert!(out[1].is_nan()); // 当前点缺失 → NaN
        assert_bits_eq(out[2], 30.0); // [NaN,30,30] → 有效 30
    }

    /// 负数窗口 / Infinity / NaN 参数：全部输出 NaN，不挂起
    #[test]
    fn invalid_window_contract() {
        // -1e300 为"有限大负数"：穿过 is_finite 守卫、as isize 饱和到 isize::MIN，
        // 曾触发 debug 减法下溢 panic / release 窗口退化，与 TS 全 NaN 不一致，故单列
        for bad in [-1.0, -1e300, f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
            let out = ra(&[10.0, 20.0, 30.0, 40.0], bad);
            assert!(out.iter().all(|v| v.is_nan()), "value = {bad} 应全 NaN");
        }
    }

    /// 常数序列位级精确：value = 2 / 10 / 1e308（钳制为全序列窗口）逐点 ===c
    #[test]
    fn constant_series_is_bitwise_exact() {
        for value in [2.0, 10.0, 1e308] {
            let input = vec![0.1; 200];
            for &out in ra(&input, value).iter() {
                assert_bits_eq(out, 0.1);
            }
        }
    }

    /// 常数与缺失混合：有效点 ===c、缺失点 NaN
    #[test]
    fn constant_series_with_missing_keeps_positions() {
        let input: Vec<f64> = (0..200)
            .map(|i| if i % 7 == 6 { f64::NAN } else { 0.1 })
            .collect();
        for (i, &out) in ra(&input, 10.0).iter().enumerate() {
            if i % 7 == 6 {
                assert!(out.is_nan());
            } else {
                assert_bits_eq(out, 0.1);
            }
        }
    }

    /// 极大有限窗口（1e308）钳制为全序列窗口，输出与 value = 8（w = 4 = 序列长度）位级一致
    #[test]
    fn huge_window_clamped_to_length() {
        let input = [10.0, 20.0, 30.0, 40.0];
        let huge = ra(&input, 1e308);
        let reference = ra(&input, 8.0);
        for (i, &v) in huge.iter().enumerate() {
            assert_bits_eq(v, reference[i]);
        }
    }

    /// 空数组返回空数组；单点透传；±MAX_VALUE 异号序列输出全有限
    #[test]
    fn edge_inputs() {
        let empty: [f64; 0] = [];
        assert!(ra(&empty, 2.0).is_empty());
        let out = ra(&[42.0], 2.0);
        assert_bits_eq(out[0], 42.0);
        let osc = [1.7e308, -1.7e308, 1.7e308, -1.7e308];
        assert!(ra(&osc, 2.0).iter().all(|v| v.is_finite()));
    }
}
