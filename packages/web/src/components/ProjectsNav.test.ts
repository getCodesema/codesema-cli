// Same harness as the forge board tests. The menu track's own geometry
// (236px, an inner card, a footer hairline) lives in the scoped <style>
// block, which this SSR-string render never sees (same limitation as
// everywhere else in this harness): the pixel values are pinned on the raw
// source, like WorkspaceView.test.ts does for its own non-mountable
// concerns. Structure (which wrapper holds what) is checked on the actual
// render.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import type { ConversationNode, ProjectActivity } from '../composables/useProjects'
import type { Project, ProjectCandidate } from '../types'

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

const SOURCE = readFileSync(join(import.meta.dir, 'ProjectsNav.vue'), 'utf8')

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    path: '/repo/one',
    name: 'one',
    added_at: '2026-08-14T00:00:00.000Z',
    ...overrides,
  }
}

type Props = {
  projects: Project[]
  selected: string | null
  activity: ReadonlyMap<string, ProjectActivity>
  tree: ConversationNode[]
  extraBranches: string[]
  focusedKeys: readonly string[]
  addBusy: boolean
  addError: string | null
  removeError: string | null
  candidates: ProjectCandidate[]
}

function props(overrides: Partial<Props> = {}): Props {
  return {
    projects: [project()],
    selected: null,
    activity: new Map(),
    tree: [],
    extraBranches: [],
    focusedKeys: [],
    addBusy: false,
    addError: null,
    removeError: null,
    candidates: [],
    ...overrides,
  }
}

async function render(p: Partial<Props> = {}): Promise<string> {
  const ProjectsNav = (await import('./ProjectsNav.vue')).default
  const app = createSSRApp(ProjectsNav, props(p))
  return renderToString(app)
}

describe('menu geometry: pixel-accurate track and row dimensions', () => {
  test('the track is 236px wide, not the earlier 210px', () => {
    expect(SOURCE).toContain('width: 236px;')
    expect(SOURCE).not.toContain('width: 210px;')
  })

  test('the collapsed-rail width (74px) is documented as out of scope, not silently dropped', () => {
    expect(SOURCE).toContain('74px')
  })

  test('the nav row is 36px tall, 12px/8px padding, 8px radius', () => {
    expect(SOURCE).toContain('height: 36px;')
    expect(SOURCE).toContain('padding: 8px 12px;')
  })

  test('the group subheader is 13px/500, no uppercase transform any more', () => {
    // Scoped to `.pn-label` itself: `.pn-detected-label` (the add-form's own
    // "Detected repos" caption) is a different element, untouched by this
    // spec point, and still legitimately uppercase.
    const groupLabel = SOURCE.slice(
      SOURCE.indexOf('.pn-label {'),
      SOURCE.indexOf('.pn-label--inline'),
    )
    expect(groupLabel).toContain('font-size: 13px;')
    expect(groupLabel).toContain('font-weight: 500;')
    expect(groupLabel).not.toContain('text-transform: uppercase;')
  })

  test('the count pastille is a filled pill: min-width 18px, height 16px, full radius, 12px bold', () => {
    expect(SOURCE).toContain('min-width: 18px;')
    expect(SOURCE).toContain('height: 16px;')
    expect(SOURCE).toContain('border-radius: 999px;')
    expect(SOURCE).toContain('font-size: 12px;')
    expect(SOURCE).toContain('font-weight: 700;')
  })

  test('the active states carry no border or side bar: background and text only', () => {
    const allActive = SOURCE.slice(
      SOURCE.indexOf('.pn-all--active {'),
      SOURCE.indexOf('.pn-count-pill {'),
    )
    expect(allActive).not.toContain('border-color')
    const projectActive = SOURCE.slice(
      SOURCE.indexOf('.pn-project--active {'),
      SOURCE.indexOf('/* The icon slot'),
    )
    expect(projectActive).not.toContain('border-color')
  })

  test('no hex literal was introduced: every color is a --cs-* token', () => {
    const styleBlock = SOURCE.slice(SOURCE.indexOf('<style scoped>'))
    expect(/#[0-9a-fA-F]{3,8}\b/.test(styleBlock)).toBe(false)
  })

  test('the menu footer is set off by a hairline above it', () => {
    expect(SOURCE).toContain('.pn-footer {')
    const footer = SOURCE.slice(SOURCE.indexOf('.pn-footer {'), SOURCE.indexOf('.pn-add {'))
    expect(footer).toContain('border-top: 1px solid')
  })
})

describe('icons: one per row type, matching our own semantics', () => {
  test('the five icons are imported from @lucide/vue', () => {
    expect(SOURCE).toContain(
      "import { GitBranch, GitPullRequest, LayoutGrid, MessageSquare, Plus } from '@lucide/vue'",
    )
  })

  test('"All projects" carries the overview icon, "Add a project" the plus icon', () => {
    expect(SOURCE).toContain('<LayoutGrid class="pn-row-icon" aria-hidden="true" />')
    expect(SOURCE.match(/<LayoutGrid /g)?.length).toBe(1)
    expect(SOURCE).toContain('<Plus class="pn-row-icon" aria-hidden="true" />')
    expect(SOURCE.match(/<Plus /g)?.length).toBe(1)
  })

  test('the conversations section carries the conversation icon once, on its own header', () => {
    expect(SOURCE.match(/<MessageSquare /g)?.length).toBe(1)
  })

  test('the branches disclosure, its rows, and a branch-kind tree node carry the branch icon', () => {
    // 1: the "Branches (N)" disclosure header. 2: each plain branch row inside
    // it. 3: a branch-kind node in the conversations tree (the fourth
    // GitBranch appearance belongs to its v-else sibling of GitPullRequest).
    expect(SOURCE.match(/<GitBranch /g)?.length).toBe(3)
  })

  test('a merge-request node in the conversations tree carries the merge-request icon, not the conversation one', () => {
    expect(SOURCE.match(/<GitPullRequest /g)?.length).toBe(1)
    const node = SOURCE.slice(
      SOURCE.indexOf('<!-- The label is the branch itself'),
      SOURCE.indexOf('<span class="pn-node-label">{{ nodeLabel(node) }}'),
    )
    expect(node).toContain('<GitPullRequest v-if="node.kind === \'mr\'"')
    expect(node).toContain('<GitBranch v-else')
  })

  test('a project row keeps its identity dot instead of stacking a generic repo icon', () => {
    const projectRow = SOURCE.slice(SOURCE.indexOf('class="pn-project"'), SOURCE.indexOf('pn-name'))
    expect(projectRow).toContain('class="pn-dot"')
    expect(projectRow).not.toMatch(/<(LayoutGrid|Plus|MessageSquare|GitBranch|GitPullRequest) /)
  })
})

describe('rows carry no border: `border: none` is explicit, never a bare omission', () => {
  // A native <button> falls back to the browser's own 2px outset border the
  // instant `border` is left undeclared: this project imports no Tailwind
  // preflight to reset that (see style.css). Every nav row must say
  // `border: none` in the source, not just look borderless in a screenshot.
  test('"All projects" declares `border: none`, not a bare omission', () => {
    const block = SOURCE.slice(SOURCE.indexOf('.pn-all {'), SOURCE.indexOf('.pn-all:hover'))
    expect(block).toContain('border: none;')
  })

  test('a project row declares `border: none`, not a bare omission', () => {
    const block = SOURCE.slice(SOURCE.indexOf('.pn-project {'), SOURCE.indexOf('.pn-project:hover'))
    expect(block).toContain('border: none;')
  })

  test('the add-project row declares `border: none`', () => {
    const block = SOURCE.slice(SOURCE.indexOf('.pn-add {'), SOURCE.indexOf('.pn-add:hover'))
    expect(block).toContain('border: none;')
  })
})

describe('navigation rows share one text size: 14px / 500 / 20px line height', () => {
  test('"All projects" matches the project rows, not its former 12.5px', () => {
    const block = SOURCE.slice(SOURCE.indexOf('.pn-all {'), SOURCE.indexOf('.pn-all:hover'))
    expect(block).toContain('font-size: 14px;')
    expect(block).toContain('font-weight: 500;')
    expect(block).toContain('line-height: 20px;')
    expect(block).not.toContain('font-size: 12.5px;')
  })

  test('a project row is 14px / 500 / 20px', () => {
    const block = SOURCE.slice(SOURCE.indexOf('.pn-project {'), SOURCE.indexOf('.pn-project:hover'))
    expect(block).toContain('font-size: 14px;')
    expect(block).toContain('font-weight: 500;')
    expect(block).toContain('line-height: 20px;')
  })

  test('the add-project row is 14px / 500 / 20px, not its former 12px', () => {
    const block = SOURCE.slice(SOURCE.indexOf('.pn-add {'), SOURCE.indexOf('.pn-add:hover'))
    expect(block).toContain('font-size: 14px;')
    expect(block).toContain('font-weight: 500;')
    expect(block).toContain('line-height: 20px;')
    expect(block).not.toContain('font-size: 12px;')
  })
})

describe('the add-project row has the exact anatomy of every other navigation row', () => {
  test('36px tall, 8px/12px padding, 8px radius: not its former 29px/7-10/7px', () => {
    const block = SOURCE.slice(SOURCE.indexOf('.pn-add {'), SOURCE.indexOf('.pn-add:hover'))
    expect(block).toContain('height: 36px;')
    expect(block).toContain('padding: 8px 12px;')
    expect(block).toContain('border-radius: 8px;')
    expect(block).not.toContain('height: 29px;')
    expect(block).not.toContain('padding: 7px 10px;')
    expect(block).not.toContain('border-radius: 7px;')
  })

  test('carries the same 16px icon slot as the other rows', async () => {
    const html = await render()
    const iconSlotCount = html.match(/class="pn-icon-slot"/g)?.length ?? 0
    // "All projects" + one project row + the add-project row.
    expect(iconSlotCount).toBe(3)
  })
})

describe('header: brand mark and name, no functional collapse control', () => {
  test('the header block exists with a 28px/8px-radius mark', () => {
    expect(SOURCE).toContain('.pn-header {')
    const mark = SOURCE.slice(
      SOURCE.indexOf('.pn-brand-mark {'),
      SOURCE.indexOf('.pn-brand-name {'),
    )
    expect(mark).toContain('width: 28px;')
    expect(mark).toContain('height: 28px;')
    expect(mark).toContain('border-radius: 8px;')
  })

  test('renders the brand name ahead of the "All projects" row', async () => {
    const html = await render()
    const headerAt = html.indexOf('class="pn-header"')
    const brandAt = html.indexOf('codesema')
    const allLabelAt = html.indexOf('class="pn-all-label"')
    expect(headerAt).toBeGreaterThan(-1)
    expect(brandAt).toBeGreaterThan(headerAt)
    expect(allLabelAt).toBeGreaterThan(brandAt)
  })
})

describe('hairlines: exactly two in the whole menu, under the header and above the footer', () => {
  test('no hairline is left between the other groups', () => {
    const styleBlock = SOURCE.slice(SOURCE.indexOf('<style scoped>'))
    const hairlines = styleBlock.match(/border-(top|bottom): 1px solid var\(--cs-line\);/g) ?? []
    expect(hairlines.length).toBe(2)
  })

  test('the conversations tree no longer carries its own hairline above it', () => {
    const block = SOURCE.slice(SOURCE.indexOf('.pn-tree {'), SOURCE.indexOf('.pn-tree-head {'))
    expect(block).not.toMatch(/\bborder-top:/)
  })
})

describe('structure: the card/list/footer wrappers actually exist in the render', () => {
  test('the inner card wraps the whole menu body', async () => {
    const html = await render()
    expect(html).toContain('class="pn-card"')
  })

  test('project rows are grouped in their own list wrapper', async () => {
    const html = await render({
      projects: [project({ id: 'a' }), project({ id: 'b', name: 'two' })],
    })
    expect(html).toContain('class="pn-list"')
    expect(html).toContain('one')
    expect(html).toContain('two')
  })

  test('the add-project control sits inside the footer wrapper', async () => {
    const html = await render()
    const footerAt = html.indexOf('class="pn-footer"')
    const addAt = html.indexOf('class="pn-add"')
    expect(footerAt).toBeGreaterThan(-1)
    expect(addAt).toBeGreaterThan(footerAt)
  })
})
