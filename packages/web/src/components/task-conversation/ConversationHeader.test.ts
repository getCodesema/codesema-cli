// The header's silence pass, asserted on the RENDERED markup.
//
// Every rule below is a colour or a surface rule, and none of them survives a
// unit test of a composable: the phrase's tone, the boxes that became text,
// the fold on the asked sentence and the tab counters all live in the
// template. Harness: the one TaskConversation.test.ts introduced — Bun's
// built-in `.vue` loader drops the template, so `vue/compiler-sfc` recompiles
// the SFC with it inlined and `vue/server-renderer` renders it to a string.
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { conversationMeta } from '../../composables/useConversationMeta'
import { G } from '../../glyphs'
import { t } from '../../i18n'
import type { TaskRecord, TaskStatus } from '../../types'

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

function record(partial: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    id: 'a1b2c3d4e5f6',
    title: 'Add a hello markdown file',
    status: 'running',
    base: 'main',
    branch: 'codesema/task-add-hello-markdown-file',
    worktree: '/tmp/w',
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 31_000,
    wait_ms: 0,
    auto_ship: false,
    created_at: '2026-08-13T10:00:00.000Z',
    updated_at: '2026-08-13T10:00:00.000Z',
    ...partial,
  }
}

type HeaderOptions = {
  record?: Partial<TaskRecord>
  diffTabLabel?: string
  checksTabText?: string
  checksToneClass?: string
}

async function renderHeader(options: HeaderOptions = {}): Promise<string> {
  const ConversationHeader = (await import('./ConversationHeader.vue')).default
  const ok = async () => ({ ok: true as const })
  const app = createSSRApp(ConversationHeader, {
    state: {
      projectId: 'p1',
      record: record(options.record),
      events: [],
      liveText: '',
      liveMessages: [],
      liveTokens: 0,
      liveLoadCap: null,
      checks: null,
    },
    projectName: 'codesema-bench',
    projectKind: 'repo',
    repoProjects: [],
    attach: ok,
    interrupt: ok,
    resume: ok,
    ship: ok,
    tab: 'conversation',
    tabs: [
      { id: 'conversation', enabled: true },
      { id: 'diff', enabled: true },
      { id: 'checks', enabled: true },
    ],
    diffTabLabel: options.diffTabLabel ?? t('workspace.tabDiffCount', { n: 1 }, 1),
    checksTabText: options.checksTabText ?? `${t('workspace.tabChecks')} ${G.ok}`,
    checksToneClass: options.checksToneClass ?? 'cv-tab--checks-pass',
    actionError: null,
  })
  return renderToString(app)
}

/** The element carrying the given class, from the rendered HTML. */
function tagWith(html: string, className: string): string {
  const match = html.match(new RegExp(`<[a-z]+[^>]*class="[^"]*${className}[^"]*"[^>]*>`))
  if (!match) {
    throw new Error(`no element with class ${className} in the rendered header`)
  }
  return match[0]
}

describe('the meta line is one line of plain text', () => {
  test('project, branch, isolation and work read as text joined by the separator', async () => {
    const html = await renderHeader()
    const line = html.slice(html.indexOf('cv-sub'), html.indexOf('cv-tabs'))
    expect(line).toContain('codesema-bench')
    expect(line).toContain('codesema/task-add-hello-markdown-file')
    expect(line).toContain(t('workspace.isolationPolicy'))
    expect(line).toContain(t('workspace.workTime', { t: t('workspace.durSeconds', { n: 31 }) }))
    expect(line).toContain(G.sep)
  })

  // The mutation this kills: giving the isolation word its badge box back.
  test('no chip is a box: nothing on the line carries a border of its own', async () => {
    const SOURCE = await Bun.file(new URL('./ConversationHeader.vue', import.meta.url)).text()
    const style = SOURCE.slice(SOURCE.indexOf('<style'))
    expect(style).not.toContain('border: 1px solid currentColor')
    const html = await renderHeader()
    expect(html).not.toContain('badge')
    expect(html).not.toContain('cv-iso--')
  })
})

describe('only a state a human must act on takes a colour', () => {
  test.each([
    ['running' as const, false],
    ['queued' as const, false],
    ['review_ok' as const, false],
    ['waiting_for_you' as const, true],
    ['review_ko' as const, true],
    ['failed' as const, true],
  ])('%s tones the phrase only when it is warn or err', async (status, toned) => {
    const html = await renderHeader({ record: { status } })
    const phrase = tagWith(html, 'cv-phrase')
    expect(/data-tone="(warn|err)"/.test(phrase)).toBe(toned)
  })

  test('the dot keeps its tone in every state: it is the one always-on signal', async () => {
    for (const status of ['running', 'review_ok', 'waiting_for_you'] as TaskStatus[]) {
      const html = await renderHeader({ record: { status } })
      expect(tagWith(html, 'cv-dot')).toMatch(/data-tone="\w+"/)
    }
  })

  // A blocked task used to raise a second glyph next to the dot; the dot's
  // own amber says it once.
  test('a waiting task raises no extra attention glyph beside the dot', async () => {
    const html = await renderHeader({ record: { status: 'waiting_for_you' } })
    const line = html.slice(html.indexOf('cv-title-row'), html.indexOf('cv-actions'))
    expect(line).not.toContain(`>${G.attention}<`)
    expect(line).toContain('cv-dot status" data-tone="warn"')
  })
})

describe('the asked sentence is folded, not printed', () => {
  test('the toggle is closed by default and names what it would open', async () => {
    const html = await renderHeader()
    const toggle = tagWith(html, 'cv-prompt-toggle')
    expect(toggle).toContain('aria-expanded="false"')
    expect(html).toContain(t('workspace.showPrompt'))
    expect(html).toContain(G.collapse)
    // Still in the markup — hidden, so opening it costs no fetch and the
    // sentence stays findable by the browser's own search.
    expect(tagWith(html, 'cv-full-title')).toContain('display:none')
    expect(html).toContain('Add a hello markdown file')
  })

  // The blocker's sentence is a real state, so it is NOT folded away.
  test('a refusal keeps its own sentence in the open, in its tone', async () => {
    const detail = 'this branch could not be compared with its target locally'
    const html = await renderHeader({
      record: { status: 'waiting_for_you', reason: { code: 'branch_diverged', detail } },
    })
    expect(html).toContain(detail)
    expect(tagWith(html, 'cv-reason')).not.toContain('display:none')
  })
})

describe('the tab bar counts quietly', () => {
  test('the counter is split off the label so it can keep its own grey', async () => {
    const html = await renderHeader()
    const tabs = html.slice(html.indexOf('cv-tabs'))
    expect(tabs).toContain('cv-tab-count')
    expect(tabs).toContain(t('workspace.tabConversation'))
    expect(tabs).toContain(G.ok)
  })

  test('a passing checks tab carries no tone; a failing one does', async () => {
    const passing = await renderHeader()
    expect(passing).not.toContain('cv-tab--checks-fail')
    const failing = await renderHeader({
      checksTabText: `${t('workspace.tabChecks')} ${G.fail}`,
      checksToneClass: 'cv-tab--checks-fail',
    })
    expect(failing).toContain('cv-tab--checks-fail')
  })

  test('the tone never lands on the whole button, only on its counter', async () => {
    const html = await renderHeader({
      checksTabText: `${t('workspace.tabChecks')} ${G.fail}`,
      checksToneClass: 'cv-tab--checks-fail',
    })
    const button = html.match(/<button[^>]*cv-tab[^>]*>(?![\s\S]*?<button)/)
    expect(button).not.toBeNull()
    expect(tagWith(html, 'cv-tab-count cv-tab--checks-fail')).toContain('span')
  })
})

describe('conversationMeta — what the line is built from', () => {
  test('a repo conversation lists project, branch, isolation and work, in order', () => {
    const items = conversationMeta(record(), 'codesema-bench', 'repo')
    expect(items.map((item) => item.key)).toEqual(['project', 'branch', 'isolation', 'work'])
    expect(items[1]?.text).toBe(`${G.branch} codesema/task-add-hello-markdown-file`)
    expect(items[2]?.hint).toBe(t('workspace.isolationPolicyHint'))
  })

  test('the wait only appears once there is one to report', () => {
    const idle = conversationMeta(record(), 'r', 'repo')
    expect(idle.some((item) => item.key === 'wait')).toBe(false)
    const waited = conversationMeta(record({ wait_ms: 5_000 }), 'r', 'repo')
    expect(waited.at(-1)?.key).toBe('wait')
  })

  test('a scratch conversation names its attachments, or says it has none', () => {
    const none = conversationMeta(record(), 'scratch', 'scratch')
    expect(none[0]?.text).toBe(t('workspace.noRepoAttached'))
    const attached = conversationMeta(
      record({
        attachments: [
          {
            project_id: 'p2',
            name: 'repo',
            branch: 'b',
            repo: '/tmp/r',
            worktree: '/tmp/w2',
            base: 'main',
          },
        ],
      }),
      'scratch',
      'scratch',
    )
    expect(attached.slice(0, 2).map((item) => item.text)).toEqual(['repo', `${G.branch} b`])
  })

  test('no item carries a tone: the line is identity, never a state', () => {
    for (const item of conversationMeta(record({ wait_ms: 1 }), 'r', 'repo')) {
      expect(item.kind).not.toBe('state')
    }
  })
})
