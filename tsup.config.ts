import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { defineConfig } from 'tsup'

// 源码位于仓库根，动态 import 写作 ./dist/wasm.js；构建入口输出到 dist/，同一路径需从产物视角改写为 ./wasm.js。
// --external 保证该 import 不被内联（懒加载/回退/守卫依赖它），这里只修正路径字面量。
export default defineConfig({
  entry: ['index.ts'],
  format: ['esm'],
  external: ['./dist/wasm.js'],
  esbuildPlugins: [
    {
      name: 'rewrite-wasm-import-for-dist',
      setup(build) {
        build.onLoad({ filter: /index\.ts$/ }, async (args) => ({
          contents: (await readFile(args.path, 'utf8')).replace("'./dist/wasm.js'", "'./wasm.js'"),
          resolveDir: dirname(args.path),
          loader: 'ts'
        }))
      }
    }
  ]
})
