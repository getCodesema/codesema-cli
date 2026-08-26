// SSR-only harness (no DOM). filesState arrives as a controlled prop
// (owned by ChangesPanel.vue elsewhere), so every one of its phases is
// directly testable here, this component never fetches on its own.
// Interaction (expanding a row, the diff fetch it triggers, the 140ms
// delayed mount) needs a real click and a real timer and is out of reach of
// renderToString, same accepted gap as every other interactive component in
// this codebase (see forge/ForgeSplitter.test.ts's own note on this).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import type { ChangedFilesState } from '../../composables/useChangedFiles'
import { t } from '../../i18n'
import type { PreviewResult } from '../../types'

const SOURCE = readFileSync(join(import.meta.dir, 'ChangedFileList.vue'), 'utf8')

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

function preview(overrides: Partial<PreviewResult> = {}): PreviewResult {
  return {
    branch: 'feat/x',
    target: 'main',
    commits: [],
    files: [
      { path: 'src/a.ts', additions: 3, deletions: 1, status: 'modified' },
      { path: 'src/b.ts', additions: 10, deletions: 0, status: 'added' },
    ],
    diffStats: { files: 2, additions: 13, deletions: 1 },
    ...overrides,
  }
}

type Props = { filesState: ChangedFilesState; mrNumber: number; project?: string }

async function render(props: Props): Promise<string> {
  const ChangedFileList = (await import('./ChangedFileList.vue')).default
  const app = createSSRApp(ChangedFileList, props)
  return renderToString(app)
}

describe('loading / idle', () => {
  test('idle renders the same spinner as loading (nothing requested yet still looks like "about to load")', async () => {
    const idleHtml = await render({ filesState: { phase: 'idle' }, mrNumber: 42 })
    const loadingHtml = await render({ filesState: { phase: 'loading' }, mrNumber: 42 })
    expect(idleHtml).toContain('cfl-spinner')
    expect(loadingHtml).toContain('cfl-spinner')
    expect(idleHtml).toContain(t('changes.fileList.loading'))
  })

  test('no rows and no error markup while loading', async () => {
    const html = await render({ filesState: { phase: 'loading' }, mrNumber: 42 })
    expect(html).not.toContain('cfl-rows')
    expect(html).not.toContain('cfl-error-title')
  })
})

describe('error (fiche §7: capped scrollable detail, a retry action)', () => {
  test('renders the alert icon, a title, the detail, and a retry button', async () => {
    const html = await render({
      filesState: { phase: 'error', message: 'HTTP 500' },
      mrNumber: 42,
    })
    expect(html).toContain(t('changes.fileList.loadError'))
    expect(html).toContain('HTTP 500')
    expect(html).toContain('class="cfl-retry"')
    expect(html).toContain(t('changes.fileList.retry'))
  })

  test('the detail sits in its own capped, scrollable frame', () => {
    expect(SOURCE).toMatch(/\.cfl-error-detail\s*\{[^}]*max-height: 120px;/)
    expect(SOURCE).toMatch(/\.cfl-error-detail\s*\{[^}]*overflow-y: auto;/)
  })

  test('a long error message is not truncated, only the frame is capped', async () => {
    const long = 'a very long transport error message '.repeat(20)
    const html = await render({ filesState: { phase: 'error', message: long }, mrNumber: 42 })
    expect(html).toContain(long.trim())
  })
})

describe('loaded, no files', () => {
  test('shows the shared empty-tab body, no summary line, no rows', async () => {
    const html = await render({
      filesState: {
        phase: 'loaded',
        preview: preview({ files: [], diffStats: { files: 0, additions: 0, deletions: 0 } }),
      },
      mrNumber: 42,
    })
    expect(html).toContain(t('changes.fileList.empty'))
    expect(html).not.toContain('cfl-summary')
    expect(html).not.toContain('cfl-rows')
  })
})

describe('loaded, with files (fiche §5: sticky header with totals, flat list)', () => {
  test('the summary line shows the file count and both totals', async () => {
    const html = await render({ filesState: { phase: 'loaded', preview: preview() }, mrNumber: 42 })
    expect(html).toContain(t('changes.fileList.summary', { n: 2 }, 2))
    expect(html).toContain('+13')
    expect(html).toContain('−1')
  })

  test('the summary line is sticky, pinned to the top', () => {
    expect(SOURCE).toMatch(/\.cfl-summary\s*\{[^}]*position: sticky;/)
    expect(SOURCE).toMatch(/\.cfl-summary\s*\{[^}]*top: 0;/)
  })

  test('renders one row per file, flat (no tree/indentation markup)', async () => {
    const html = await render({ filesState: { phase: 'loaded', preview: preview() }, mrNumber: 42 })
    expect(html).toContain('src/a.ts')
    expect(html).toContain('src/b.ts')
    expect(html).not.toContain('cfl-dir')
    expect(html).not.toContain('cfl-tree')
  })

  test('every row starts collapsed: no diff content mounted on first render', async () => {
    const html = await render({ filesState: { phase: 'loaded', preview: preview() }, mrNumber: 42 })
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('aria-expanded="true"')
  })

  test('the list container scrolls its own overflow, height bounded by its parent', () => {
    expect(SOURCE).toMatch(/\.cfl-root\s*\{[^}]*overflow-y: auto;/)
    expect(SOURCE).toMatch(/\.cfl-root\s*\{[^}]*height: 100%;/)
  })
})

describe('the diff mount delay is wired to the shared 140ms constant', () => {
  test('imports DIFF_MOUNT_DELAY_MS from ChangesLogic rather than a literal', () => {
    expect(SOURCE).toContain('DIFF_MOUNT_DELAY_MS')
    expect(SOURCE).toContain("from './ChangesLogic'")
  })

  test('pending timers are cleared on unmount, never leaked', () => {
    expect(SOURCE).toMatch(/onUnmounted\(\(\) => \{[\s\S]*clearTimeout\(timer\)/)
  })
})

describe('never uses animation-fill-mode (project-wide rule)', () => {
  test('the source contains no animation-fill-mode', () => {
    expect(SOURCE).not.toContain('animation-fill-mode')
  })
})
