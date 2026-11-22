/**
 * @description 内嵌脚本：把 wasm-pack 产物（pkg/）转换成单文件 JS 产物（dist/）
 * 做三件事：
 * 1. 读取 pkg/smew_bg.wasm，转成十进制数字数组常量
 * 2. 对胶水 pkg/smew.js 做定点手术：把"按路径加载 .wasm"的默认分支替换为"使用内嵌字节"
 * 3. 输出 dist/wasm.js（胶水 + 内嵌字节）与 dist/wasm.d.ts
 * 运行：npm run build:wasm（smew 目录内执行）
 * 规则：防御式——pkg 产物与预期模式不符时立即报错退出，绝不静默生成坏产物
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const smewRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = path.join(smewRoot, 'pkg')
const distDir = path.join(smewRoot, 'dist')

/** @param {string} message */
function fail(message) {
  console.error(`[smew] inline-wasm 失败：${message}`)
  process.exit(1)
}

// 1. wasm 字节 → 十进制数字数组文本
const wasmPath = path.join(pkgDir, 'smew_bg.wasm')
const wasmBytes = readFileSync(wasmPath)
if (wasmBytes.length === 0) fail(`${wasmPath} 是空文件`)
const wasmBytesCsv = Array.from(wasmBytes).join(',')

// 2. 胶水手术：替换"按路径加载 .wasm"的默认分支（pkg/smew.js 中 __wbg_init 的 if (module_or_path === undefined) 块）
const gluePath = path.join(pkgDir, 'smew.js')
const glue = readFileSync(gluePath, 'utf8')
const urlBranch = `if (module_or_path === undefined) {
        module_or_path = new URL('smew_bg.wasm', import.meta.url);
    }`
if (!glue.includes(urlBranch)) {
  fail(
    '胶水中未找到预期的按路径加载分支，wasm-bindgen 生成物结构可能已变化，请人工核对 pkg/smew.js 后更新本脚本的匹配模式'
  )
}
const embeddedBranch = `if (module_or_path === undefined) {
        // 内嵌产物：字节已随本文件发布，不存在按路径加载 .wasm 的分支
        module_or_path = WASM_BYTES;
    }`
const patchedGlue = glue.replace(urlBranch, embeddedBranch)

// 3. 接口核对：导出签名与冻结的导出层契约（docs/agents/smew.md）不一致时此处报错，提醒同步下方 dist/wasm.d.ts 模板
const typeDecl = readFileSync(path.join(pkgDir, 'smew.d.ts'), 'utf8')
for (const [fn, param] of [
  ['gs', 'sigma'],
  ['ra', 'value'],
  ['twe', 'smoothing']
]) {
  const pattern = new RegExp(`export function ${fn}\\(values: Float64Array, ${param}: number\\): Float64Array;`)
  if (!pattern.test(typeDecl)) {
    fail(`pkg/smew.d.ts 中未找到预期的 ${fn} 签名，接口可能已变更，请同步更新本脚本中的 dist/wasm.d.ts 模板`)
  }
}

// 4. 组装 dist/wasm.js：内嵌字节前置段 + 手术后的胶水
const indexJs = `/* 本文件由 scripts/inline-wasm.mjs 生成，请勿手改；重新生成：npm run build:wasm */

// wasm 字节（十进制数字数组）
const WASM_BYTES = new Uint8Array([${wasmBytesCsv}])

${patchedGlue}
`

// 5. dist/wasm.d.ts 模板（与冻结的导出层接口一致；胶水里的 initSync 不对外承诺）
const indexDts = `/* 本文件由 smew/scripts/inline-wasm.mjs 生成，请勿手改 */

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
`

mkdirSync(distDir, { recursive: true })
writeFileSync(path.join(distDir, 'wasm.js'), indexJs)
writeFileSync(path.join(distDir, 'wasm.d.ts'), indexDts)

const kb = (n) => `${(n / 1024).toFixed(1)} KB`
console.log(
  `[smew] dist 生成完成：wasm.js ${kb(Buffer.byteLength(indexJs))}（wasm ${kb(wasmBytes.length)} → 数字数组）+ wasm.d.ts`
)
