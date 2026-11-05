//! 三算法（TWE / RA / GS）共用的数值内核
//!
//! `safe_lerp`：把一个新数据按权重融入当前均值——t=0 完全保留原均值，t=1 完全换成新数据，中间取值按比例插值
//! `safe_weight_ratio`：计算新数据该占的权重
//! 两个函数与 TS 同名函数逐行对应：分支次序一致、只用加减乘除，保证两边对同样的输入算出完全相同的浮点数

#[allow(clippy::manual_range_contains)]
pub(crate) fn safe_lerp(a: f64, b: f64, t: f64) -> f64 {
    if !t.is_finite() || t < 0.0 || t > 1.0 {
        return f64::NAN;
    }
    if t == 0.0 {
        return a;
    }
    // 首有效点位级透传依赖此分支，不可删除
    if t == 1.0 {
        return b;
    }
    if a == b {
        return a;
    }
    if (a < 0.0 && b > 0.0) || (a > 0.0 && b < 0.0) {
        return (1.0 - t) * a + t * b;
    }
    a + t * (b - a)
}

/// 安全权重比 `w2 / (w1 + w2)`：先按最大值缩放再相除，权重和相加永不溢出
/// TS 的 `Math.min/max(NaN, x)` 返回 NaN，Rust 的 `f64::min/max` 忽略 NaN，因此所有 NaN 判定都在进入缩放前显式完成，与 TS 分支次序保持一致
pub(crate) fn safe_weight_ratio(w1: f64, w2: f64) -> f64 {
    if !w1.is_finite() || !w2.is_finite() || w1 < 0.0 || w2 < 0.0 {
        return f64::NAN;
    }
    if w2 == 0.0 {
        return 0.0;
    }
    if w1 == 0.0 {
        return 1.0;
    }
    let scale = w1.max(w2);
    w2 / scale / (w1 / scale + w2 / scale)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 位级相等断言：NaN 与 NaN 视为一致，不比较 payload，其余要求 to_bits 完全一致
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

    #[test]
    fn safe_lerp_invalid_weight_returns_nan() {
        assert_bits_eq(safe_lerp(1.0, 2.0, f64::NAN), f64::NAN);
        assert_bits_eq(safe_lerp(1.0, 2.0, f64::INFINITY), f64::NAN);
        assert_bits_eq(safe_lerp(1.0, 2.0, -0.1), f64::NAN);
        assert_bits_eq(safe_lerp(1.0, 2.0, 1.1), f64::NAN);
    }

    #[test]
    fn safe_lerp_endpoint_weights_are_bitwise_pass_through() {
        assert_bits_eq(safe_lerp(1.7e308, 2.5, 0.0), 1.7e308);
        assert_bits_eq(safe_lerp(1.7e308, 2.5, 1.0), 2.5);
    }

    #[test]
    fn safe_lerp_equal_values_return_input_directly() {
        // a == b 快速分支：不执行任何浮点运算
        assert_bits_eq(safe_lerp(0.1, 0.1, 0.3), 0.1);
        assert_bits_eq(safe_lerp(-3.7, -3.7, 0.999), -3.7);
    }

    #[test]
    fn safe_lerp_opposite_extremes_never_overflow() {
        let out = safe_lerp(-1.7e308, 1.7e308, 0.5);
        assert!(out.is_finite());
        assert_bits_eq(out, 0.0);
    }

    #[test]
    fn safe_lerp_regular_case_uses_increment_form() {
        assert_bits_eq(safe_lerp(0.0, 10.0, 0.25), 2.5);
        assert_bits_eq(safe_lerp(10.0, 20.0, 1.0 / 3.0), 10.0 + (1.0 / 3.0) * 10.0);
    }

    #[test]
    fn safe_weight_ratio_invalid_inputs_return_nan() {
        assert_bits_eq(safe_weight_ratio(f64::NAN, 1.0), f64::NAN);
        assert_bits_eq(safe_weight_ratio(1.0, f64::INFINITY), f64::NAN);
        assert_bits_eq(safe_weight_ratio(-1.0, 1.0), f64::NAN);
        // -0.0 与 TS 语义一致：-0 < 0 为 false 且 -0 === 0 为 true → 走 w2 === 0 分支返回 0
        assert_bits_eq(safe_weight_ratio(1.0, -0.0), 0.0);
    }

    #[test]
    fn safe_weight_ratio_zero_weights_short_circuit() {
        assert_bits_eq(safe_weight_ratio(5.0, 0.0), 0.0);
        assert_bits_eq(safe_weight_ratio(0.0, 5.0), 1.0);
    }

    #[test]
    fn safe_weight_ratio_scaled_division_never_overflows() {
        // w1 + w2 本身会上溢，先按最大值缩放再相除
        assert_bits_eq(safe_weight_ratio(1.7e308, 1.7e308), 0.5);
        assert_bits_eq(safe_weight_ratio(3.0, 1.0), 0.25);
    }
}
