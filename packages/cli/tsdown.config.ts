import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as {
  version: string
}

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node20',
  clean: true,
  dts: false,
  // Shipped unminified on purpose: users of a review tool should be able to
  // audit the exact code that runs on their diff.
  minify: false,
  define: {
    __CODESEMA_VERSION__: JSON.stringify(version),
  },
})
