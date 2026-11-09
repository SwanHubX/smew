// ts/smooth.ts
var isValidData = (value) => Number.isFinite(value);
var safeLerp = (a, b, t) => {
  if (!Number.isFinite(t) || t < 0 || t > 1) return NaN;
  if (t === 0) return a;
  if (t === 1) return b;
  if (a === b) return a;
  if (a < 0 && b > 0 || a > 0 && b < 0) return (1 - t) * a + t * b;
  return a + t * (b - a);
};
var safeWeightRatio = (w1, w2) => {
  if (!Number.isFinite(w1) || !Number.isFinite(w2) || w1 < 0 || w2 < 0) return NaN;
  if (w2 === 0) return 0;
  if (w1 === 0) return 1;
  const scale = Math.max(w1, w2);
  return w2 / scale / (w1 / scale + w2 / scale);
};
var twe = async (series, value, options) => {
  const result = [];
  const smoothingWeight = Number.isNaN(value) ? 0 : Math.min(Math.sqrt(value), 0.999);
  let y = 0;
  let D = 0;
  const checkpoint = options?.checkpoint;
  for (let index = 0; index < series.length; index++) {
    if (checkpoint !== void 0) await checkpoint(index);
    const item = series[index];
    if (isValidData(item.data)) {
      D = smoothingWeight * D + 1;
      y = safeLerp(y, item.data, 1 / D);
    }
    result.push({
      // 保留原始缺失点的位置，下一个有效点继续使用最近一次有效状态
      ...item,
      data: isValidData(item.data) ? y : NaN,
      origin: item.data
    });
  }
  return result;
};
var ra = async (series, value, options) => {
  const result = [];
  const w = Math.floor(value / 2);
  if (!Number.isFinite(w)) {
    return series.map((item) => ({ ...item, data: NaN, origin: item.data }));
  }
  const half = Math.min(w, series.length);
  const checkpoint = options?.checkpoint;
  for (let index = 0; index < series.length; index++) {
    if (checkpoint !== void 0) await checkpoint(index);
    const item = series[index];
    let mu = 0;
    let W = 0;
    for (let i = index - half; i <= index + half; i++) {
      const nowIndex = Math.min(Math.max(i, 0), series.length - 1);
      const value2 = series[nowIndex].data;
      if (!isValidData(value2)) continue;
      mu = safeLerp(mu, value2, safeWeightRatio(W, 1));
      W++;
    }
    result.push({
      // 当前点缺失时保持 NaN，窗口无有效样本时也无法计算平均值
      ...item,
      data: !isValidData(item.data) || W === 0 ? NaN : mu,
      origin: item.data
    });
  }
  return result;
};
var gs = async (series, value, options) => {
  const result = [];
  let kernelSize = Math.max(3, Math.floor(value * 6) | 0);
  if (kernelSize % 2 === 0) kernelSize++;
  const half = (kernelSize - 1) / 2;
  const kernel = new Array(kernelSize);
  let sum = 0;
  for (let i = 0; i < kernelSize; i++) {
    const x = i - half;
    const val = Math.exp(-(x * x) / (2 * value * value));
    kernel[i] = val;
    sum += val;
  }
  for (let i = 0; i < kernelSize; i++) kernel[i] /= sum;
  const checkpoint = options?.checkpoint;
  for (let index = 0; index < series.length; index++) {
    if (checkpoint !== void 0) await checkpoint(index);
    const item = series[index];
    let mu = 0;
    let W = 0;
    for (let j = 0; j < kernelSize; j++) {
      const sourceIndex = Math.min(Math.max(index + j - half, 0), series.length - 1);
      const value2 = series[sourceIndex].data;
      if (!isValidData(value2)) continue;
      mu = safeLerp(mu, value2, safeWeightRatio(W, kernel[j]));
      W += kernel[j];
    }
    result.push({
      // 当前点缺失时保留 NaN，没有有效权重时避免产生无意义的除法结果
      ...item,
      data: !isValidData(item.data) || W === 0 ? NaN : mu,
      origin: item.data
    });
  }
  return result;
};

// index.ts
var wasmModule = null;
var wasmInit = null;
function initWasm() {
  if (wasmInit) return wasmInit;
  if (typeof WebAssembly === "undefined") {
    console.warn("[smew] \u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301 WebAssembly\uFF0C\u5E73\u6ED1\u4F7F\u7528 TS \u56DE\u9000\u5B9E\u73B0");
    wasmInit = Promise.resolve();
    return wasmInit;
  }
  wasmInit = import("./dist/wasm.js").then(async (wasm) => {
    await wasm.default();
    wasmModule = wasm;
  }).catch(() => {
    console.warn("[smew] WASM \u52A0\u8F7D\u5931\u8D25\uFF0C\u5E73\u6ED1\u4F7F\u7528 TS \u56DE\u9000\u5B9E\u73B0");
  });
  return wasmInit;
}
void initWasm();
var toValues = (series) => {
  const values = new Float64Array(series.length);
  series.forEach((item, i) => {
    values[i] = item.data;
  });
  return values;
};
var withSmoothedData = (series, out) => series.map((item, i) => ({
  ...item,
  data: out[i]
}));
function runWithWasm(wasmFn, series, param) {
  return withSmoothedData(series, wasmFn(toValues(series), param));
}
var twe2 = async (series, value, options) => {
  if (wasmModule) return runWithWasm(wasmModule.twe, series, value);
  return twe(series, value, options);
};
var ra2 = async (series, value, options) => {
  if (wasmModule) return runWithWasm(wasmModule.ra, series, value);
  return ra(series, value, options);
};
var gs2 = async (series, value, options) => {
  if (wasmModule) return runWithWasm(wasmModule.gs, series, value);
  return gs(series, value, options);
};
function smew(type, series, config, checkpoint) {
  const options = checkpoint === void 0 ? void 0 : { checkpoint };
  switch (type) {
    case "TWE":
      return twe2(series, config.value, options);
    case "RA":
      return ra2(series, config.value, options);
    case "GS":
      return gs2(series, config.value, options);
  }
}
var index_default = smew;
export {
  index_default as default,
  gs2 as gs,
  ra2 as ra,
  smew,
  twe2 as twe
};
