use wasm_bindgen::prelude::*;

mod algorithms;
mod utils;

/// Time Weighted EMA 平滑
#[wasm_bindgen]
pub fn twe(values: &[f64], smoothing: f64) -> Vec<f64> {
    algorithms::twe::twe(values, smoothing)
}

/// Running Average 平滑
#[wasm_bindgen]
pub fn ra(values: &[f64], value: f64) -> Vec<f64> {
    algorithms::ra::ra(values, value)
}

/// Gaussian 平滑
#[wasm_bindgen]
pub fn gs(values: &[f64], sigma: f64) -> Vec<f64> {
    algorithms::gs::gs(values, sigma)
}
