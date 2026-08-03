/** @type {import('prettier').Config} */
export default {
  semi: false,
  singleQuote: true,
  printWidth: 100,
  plugins: ['@ianvs/prettier-plugin-sort-imports'],
  importOrder: ['^node:', '^@?\\w', '^\\.'],
  importOrderTypeScriptVersion: '5.0.0',
}
