import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { defineConfig } from 'tsup'

// 源码的动态 import 写作 ./dist/wasm.js，产物视角是 ./wasm.js
// 改写发生在 esbuild 解析之前，external 必须匹配 './wasm.js'，否则 WASM 会被内联
export default defineConfig({
  entry: ['index.ts'],
  format: ['esm'],
  external: ['./wasm.js'],
  esbuildPlugins: [
    {
      name: 'rewrite-wasm-import-for-dist',
      setup(build) {
        build.onLoad({ filter: /index\.ts$/ }, async (args) => {
          const source = await readFile(args.path, 'utf8')
          // 找不到改写目标说明源码的导入写法已变，静默跳过会让 WASM 被内联进产物，直接失败
          if (!source.includes("'./dist/wasm.js'")) {
            throw new Error(`${args.path} 里找不到 './dist/wasm.js' 动态导入，tsup.config.ts 的改写规则需要同步更新`)
          }
          return {
            contents: source.replace("'./dist/wasm.js'", "'./wasm.js'"),
            resolveDir: dirname(args.path),
            loader: 'ts'
          }
        })
      }
    }
  ]
})
