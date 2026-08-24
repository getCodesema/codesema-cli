// SSR-only harness (no DOM): renderToString exercises props-driven markup;
// geometry that only lives in the scoped <style> block (padding, radius,
// direction) is read back from source, same convention as
// forge/ForgeDetailPanel.test.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp, h } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { t } from '../../i18n'
import type { PreviewFile } from '../../types'

const SOURCE = readFileSync(join(import.meta.dir, 'ChangedFileRow.vue'), 'utf8')

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

function file(overrides: Partial<PreviewFile> = {}): PreviewFile {
  return { path: 'src/a.ts', additions: 3, deletions: 1, status: 'modified', ...overrides }
}

type Props = { file: PreviewFile; expanded: boolean; last?: boolean }

async function render(props: Props, slotText?: string): Promise<string> {
  const ChangedFileRow = (await import('./ChangedFileRow.vue')).default
  const app = createSSRApp({
    render: () =>
      h(ChangedFileRow, props, slotText === undefined ? undefined : { default: () => slotText }),
  })
  return renderToString(app)
}

describe('the row button', () => {
  test('renders the path', async () => {
    const html = await render({
      file: file({ path: 'src/components/Widget.vue' }),
      expanded: false,
    })
    expect(html).toContain('src/components/Widget.vue')
  })

  test('a rename shows both paths joined by an arrow', async () => {
    const html = await render({
      file: file({ status: 'renamed', previousPath: 'old/name.ts', path: 'new/name.ts' }),
      expanded: false,
    })
    expect(html).toContain('old/name.ts')
    expect(html).toContain('new/name.ts')
    expect(html).toContain('→')
  })

  test('renders the additions and deletions counters', async () => {
    const html = await render({ file: file({ additions: 12, deletions: 4 }), expanded: false })
    expect(html).toContain('+12')
    expect(html).toContain('−4')
  })

  test('a file with zero additions or deletions still renders the real zero, not a dash', async () => {
    const html = await render({ file: file({ additions: 0, deletions: 5 }), expanded: false })
    expect(html).toContain('+0')
    expect(html).toContain('−5')
  })

  test('aria-expanded reflects the expanded prop', async () => {
    const collapsedHtml = await render({ file: file(), expanded: false })
    expect(collapsedHtml).toContain('aria-expanded="false"')

    const expandedHtml = await render({ file: file(), expanded: true })
    expect(expandedHtml).toContain('aria-expanded="true"')
  })

  test('the button carries aria-controls pointing at the expanded region id', async () => {
    const html = await render({ file: file(), expanded: true })
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1]
    expect(controls).toBeTruthy()
    expect(html).toContain(`id="${controls}"`)
  })
})

describe('a color per status (defect #1 fixed)', () => {
  test.each([
    ['added', 'cfr-status--added'],
    ['modified', 'cfr-status--modified'],
    ['deleted', 'cfr-status--deleted'],
    ['renamed', 'cfr-status--renamed'],
  ] as const)('%s renders its own status class', async (status, expectedClass) => {
    const html = await render({ file: file({ status }), expanded: false })
    expect(html).toContain(expectedClass)
  })

  test('each status has its own distinct color rule, not a shared uniform one', () => {
    expect(SOURCE).toMatch(/\.cfr-status--added\s*\{[^}]*color: var\(--cs-green-text\);/)
    expect(SOURCE).toMatch(/\.cfr-status--modified\s*\{[^}]*color: var\(--cs-amber-text\);/)
    expect(SOURCE).toMatch(/\.cfr-status--deleted\s*\{[^}]*color: var\(--cs-red-text\);/)
    expect(SOURCE).toMatch(/\.cfr-status--renamed\s*\{[^}]*color: var\(--cs-water\);/)
  })

  test.each(['added', 'modified', 'deleted', 'renamed'] as const)(
    '%s renders its translated status label',
    async (status) => {
      const key = `changes.file.status${status[0]?.toUpperCase()}${status.slice(1)}` as const
      const html = await render({ file: file({ status }), expanded: false })
      expect(html).toContain(t(key))
    },
  )
})

describe('the last row (defect: no bottom hairline)', () => {
  test('a middle row carries no --last modifier', async () => {
    const html = await render({ file: file(), expanded: false, last: false })
    expect(html).not.toContain('cfr-root--last')
  })

  test('the last row carries the --last modifier', async () => {
    const html = await render({ file: file(), expanded: false, last: true })
    expect(html).toContain('cfr-root--last')
  })

  test('the --last modifier removes the bottom hairline in CSS', () => {
    expect(SOURCE).toMatch(/\.cfr-root\s*\{[^}]*border-bottom: 1px solid var\(--cs-line\);/)
    expect(SOURCE).toMatch(/\.cfr-root--last\s*\{[^}]*border-bottom: none;/)
  })
})

describe('the expanded slot (fiche §6: top hairline, then the diff)', () => {
  test('collapsed: the slot is not rendered at all', async () => {
    const html = await render({ file: file(), expanded: false }, 'DIFF CONTENT')
    expect(html).not.toContain('DIFF CONTENT')
    expect(html).not.toContain('cfr-expanded')
  })

  test('expanded: the slot renders inside the top-hairline wrapper', async () => {
    const html = await render({ file: file(), expanded: true }, 'DIFF CONTENT')
    expect(html).toContain('cfr-expanded')
    expect(html).toContain('DIFF CONTENT')
  })

  test('the wrapper carries a top hairline, not a bottom one', () => {
    expect(SOURCE).toMatch(/\.cfr-expanded\s*\{[^}]*border-top: 1px solid var\(--cs-line\);/)
  })
})

describe('geometry (fiche §5)', () => {
  test('the button is full width, 12px horizontal / 10px vertical padding, 8px gap', () => {
    expect(SOURCE).toMatch(/\.cfr-button\s*\{[^}]*width: 100%;/)
    expect(SOURCE).toMatch(/\.cfr-button\s*\{[^}]*padding: 10px 12px;/)
    expect(SOURCE).toMatch(/\.cfr-button\s*\{[^}]*gap: 8px;/)
  })

  test('defect #3 fixed: background, border and radius all explicitly neutralized', () => {
    expect(SOURCE).toMatch(/\.cfr-button\s*\{[^}]*background: none;/)
    expect(SOURCE).toMatch(/\.cfr-button\s*\{[^}]*border: none;/)
    expect(SOURCE).toMatch(/\.cfr-button\s*\{[^}]*border-radius: 0;/)
  })

  test('the path is 13px', () => {
    expect(SOURCE).toMatch(/\.cfr-path\s*\{[^}]*font-size: 13px;/)
  })

  test('defect #4 fixed: the path truncates from the start (direction: rtl), never the end', () => {
    expect(SOURCE).toMatch(/\.cfr-path\s*\{[^}]*direction: rtl;/)
    expect(SOURCE).toMatch(/\.cfr-path\s*\{[^}]*text-overflow: ellipsis;/)
    expect(SOURCE).not.toMatch(/\.cfr-path\s*\{[^}]*direction: ltr;/)
  })

  test('the status text is 11px, attenuated size', () => {
    expect(SOURCE).toMatch(/\.cfr-status\s*\{[^}]*font-size: 11px;/)
  })

  test('the counters are 11px', () => {
    expect(SOURCE).toMatch(/\.cfr-counters\s*\{[^}]*font-size: 11px;/)
  })

  test('defect #2 fixed: the counters use tabular figures', () => {
    expect(SOURCE).toMatch(/\.cfr-counters\s*\{[^}]*font-variant-numeric: tabular-nums;/)
  })

  test('the chevron rotates open, does not just swap glyph', () => {
    expect(SOURCE).toMatch(/\.cfr-chevron--open\s*\{[^}]*transform: rotate\(90deg\);/)
  })

  test('never uses animation-fill-mode (project-wide rule)', () => {
    expect(SOURCE).not.toContain('animation-fill-mode')
  })
})
