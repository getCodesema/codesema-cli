// SSR-only harness (no DOM): onMounted never runs during renderToString, so
// the collapseKey force-expand trick (fires strictly post-mount) cannot be
// observed this way, it is checked by reading the source instead, same
// convention as forge/ForgeDetailPanel.test.ts for anything scoped CSS or
// lifecycle-only.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { parseDiff, type DiffFile } from '../../composables/useDiff'
import { t } from '../../i18n'

const SOURCE = readFileSync(join(import.meta.dir, 'ChangedFileDiff.vue'), 'utf8')

Bun.plugin({
  name: 'vue-sfc-with-template',
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      const { descriptor } = parse(source, { filename: args.path })
      const compiled = compileScript(descriptor, { id: args.path, inlineTemplate: true })
      return { contents: compiled.content, loader: 'ts' }
    })
  },
})

const SAMPLE_DIFF = [
  '--- a/src/greeter.ts',
  '+++ b/src/greeter.ts',
  '@@ -1,3 +1,3 @@',
  ' function greet() {',
  "-  console.log('hi')",
  "+  console.log('hello, world')",
  ' }',
  '',
].join('\n')

function sampleFiles() {
  return parseDiff(SAMPLE_DIFF).files
}

// DiffView.vue's own "no files" branch calls the global $t (registered in
// main.ts as app.config.globalProperties.$t); a bare createSSRApp does not
// have it, so it must be wired here too, same as the real app does.
async function render(files: DiffFile[] = sampleFiles()): Promise<string> {
  const ChangedFileDiff = (await import('./ChangedFileDiff.vue')).default
  const app = createSSRApp(ChangedFileDiff, { files })
  app.config.globalProperties.$t = t
  return renderToString(app)
}

describe('renders the diff content', () => {
  test('the changed lines show up', async () => {
    const html = await render()
    expect(html).toContain('hello, world')
  })

  test("DiffView's own toolbar (split/unified toggle) is hidden", async () => {
    const html = await render()
    expect(html).not.toContain('diff-toolbar')
  })

  test('an empty file list renders no diff content at all, no crash', async () => {
    const html = await render([])
    expect(html).not.toContain('hello, world')
  })
})

describe("fiche §6: DiffView's own per-file header is not repeated", () => {
  test('the header is hidden from outside, not by editing DiffView.vue', () => {
    expect(SOURCE).toMatch(/:deep\(\.srd-file-head\)\s*\{[^}]*display: none;/)
  })

  test('DiffView.vue itself is only imported, never modified from here', () => {
    expect(SOURCE).toContain("import DiffView from '../DiffView.vue'")
  })
})

describe('big files are forced open (DiffView would otherwise auto-collapse them)', () => {
  test('collapseKey starts at 0 (even = expanded) and a mounted hook bumps it to 2', () => {
    expect(SOURCE).toMatch(/const collapseKey = ref\(0\)/)
    expect(SOURCE).toMatch(/onMounted\(\(\) => \{\s*collapseKey\.value = 2\s*\}\)/)
  })

  test('the bump happens strictly after mount, never before (the watcher only fires on change)', () => {
    const mountedIndex = SOURCE.indexOf('onMounted')
    const bumpIndex = SOURCE.indexOf('collapseKey.value = 2')
    expect(mountedIndex).toBeGreaterThan(-1)
    expect(bumpIndex).toBeGreaterThan(mountedIndex)
  })

  test('DiffView receives the collapseKey ref, not a static prop', () => {
    expect(SOURCE).toContain(':collapse-key="collapseKey"')
  })
})

describe('fiche §6: wraps instead of scrolling horizontally', () => {
  test('unified mode is forced, never left to the shared split/unified preference', () => {
    expect(SOURCE).toContain('mode="unified"')
  })

  test('the diff body never scrolls horizontally', () => {
    expect(SOURCE).toMatch(/:deep\(\.srd-body\)\s*\{[^}]*overflow-x: visible;/)
  })

  test('long unbroken tokens still break rather than overflow', () => {
    expect(SOURCE).toMatch(/:deep\(\.srd-code\)\s*\{[^}]*overflow-wrap: anywhere;/)
  })
})

describe('the redundant per-file card chrome is neutralized once its header is gone', () => {
  test('border, radius and background are all reset', () => {
    expect(SOURCE).toMatch(/:deep\(\.srd-file\)\s*\{[^}]*border: none;/)
    expect(SOURCE).toMatch(/:deep\(\.srd-file\)\s*\{[^}]*border-radius: 0;/)
    expect(SOURCE).toMatch(/:deep\(\.srd-file\)\s*\{[^}]*background: none;/)
  })
})

describe('never uses animation-fill-mode (project-wide rule)', () => {
  test('the source contains no animation-fill-mode', () => {
    expect(SOURCE).not.toContain('animation-fill-mode')
  })
})
