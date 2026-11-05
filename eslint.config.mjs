// smew 自持的 ESLint 配置：本包是纯 TS 库，不引入 Vue 相关规则
// 规则构成：jsdoc / unused-imports / import-sort / no-type-assertion
import eslint from '@eslint/js'
import { jsdoc } from 'eslint-plugin-jsdoc'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import unusedImports from 'eslint-plugin-unused-imports'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    name: 'smew/files-to-ignore',
    // 构建产物目录：wasm-pack 中间产物（pkg）、Rust 编译产物（target）、预构建产物（dist）、生成的类型声明（types）
    ignores: ['pkg/', 'target/', 'dist/', 'types/']
  },
  {
    name: 'smew/build-scripts',
    // 构建脚本跑在 Node 环境，声明其用到的 Node 全局
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        process: 'readonly'
      }
    }
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  jsdoc({
    name: 'smew/jsdoc',
    files: ['**/*.{js,ts}'],
    rules: {
      'jsdoc/require-param': 'error',
      'jsdoc/require-param-description': 'error'
    }
  }),
  {
    name: 'smew/unused-imports',
    plugins: { 'unused-imports': unusedImports },
    rules: {
      // 关闭 TS 自带的未使用变量检查，避免和 unused-imports 重复报错
      '@typescript-eslint/no-unused-vars': 'off',
      // 未使用 import 自动删除
      'unused-imports/no-unused-imports': 'error',
      // 未使用变量仍然提示，但允许 _ 开头
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_'
        }
      ]
    }
  },
  {
    name: 'smew/import-sort',
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'simple-import-sort/imports': 'error'
    }
  },
  {
    name: 'smew/no-type-assertion',
    rules: {
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }]
    }
  }
)
