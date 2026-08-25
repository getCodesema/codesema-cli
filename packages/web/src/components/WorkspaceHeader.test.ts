// D9's announce half, rendered — not computed.
//
// `forgeUnavailableKey` can be unit-tested to death and still show nothing:
// the value has to reach the header's props, survive the `v-if`, and come out
// as a translated sentence. The three failures §6 quater lists are all
// available here — a mapping nobody calls, a prop nobody passes, an English
// technical string served as is — so the assertions are on the RENDERED
// markup, and one of them is on `WorkspaceView.vue`'s own source, which is the
// only place the prop is actually bound.
//
// Harness: the one TaskConversation.test.ts introduced. Bun's built-in `.vue`
// loader keeps only `<script setup>` and drops the template — precisely the
// half under test — so `vue/compiler-sfc` recompiles the SFC with the template
// inlined and `vue/server-renderer` renders it to a string. No DOM. The SFC
// import is DYNAMIC: a static one is hoisted above `Bun.plugin()`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createSSRApp } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { forgeUnavailableKey } from '../composables/useProjects'
import { catalogs, t } from '../i18n'
import type { WorkspaceInfo } from '../types'

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

const ISOLATION: Pick<
  WorkspaceInfo,
  'isolation_available' | 'isolation_default' | 'isolation_reason'
> = {
  isolation_available: false,
  isolation_default: 'policy',
  isolation_reason: 'container isolation was not probed',
}

function info(forge: Partial<WorkspaceInfo>): WorkspaceInfo {
  return { ...ISOLATION, ...forge }
}

async function renderHeader(workspace: WorkspaceInfo | null | undefined): Promise<string> {
  const WorkspaceHeader = (await import('./WorkspaceHeader.vue')).default
  const app = createSSRApp(WorkspaceHeader, {
    needsYou: 0,
    agents: 0,
    ...(workspace === undefined ? {} : { workspace }),
  })
  return renderToString(app)
}

describe('the header states the forge degradation, and names it', () => {
  test.each([
    ['no-remote' as const, 'workspace.forgeReasonNoRemote' as const],
    ['no-cli' as const, 'workspace.forgeReasonNoCli' as const],
    ['cli-error' as const, 'workspace.forgeReasonCliError' as const],
  ])('%s renders the badge with its own sentence', async (reason, key) => {
    const html = await renderHeader(info({ forge_available: false, forge_reason: reason }))
    expect(html).toContain(t('workspace.forgeUnavailable'))
    expect(html).toContain(t(key))
    // The two CLI motifs never render each other's sentence: that is the
    // whole reason they are kept apart from `no-remote` and from one another.
    for (const other of [
      'workspace.forgeReasonNoRemote',
      'workspace.forgeReasonNoCli',
      'workspace.forgeReasonCliError',
    ] as const) {
      if (other !== key) {
        expect(html).not.toContain(t(other))
      }
    }
  })

  test('unavailable with NO motif still says something, and says it is unnamed', async () => {
    const html = await renderHeader(info({ forge_available: false }))
    expect(html).toContain(t('workspace.forgeUnavailable'))
    expect(html).toContain(t('workspace.forgeReasonUnknown'))
  })

  // Round-2 adversarial review, MINEUR 5. `forge_reason` is typed as the
  // union but ARRIVES over the wire from a CLI that may be newer than this
  // bundle. A motif this bundle does not know used to miss the lookup, come
  // back `undefined`, and make the `v-if` false — the badge VANISHED, which
  // is the exact opposite of what the mapping's own comment promised, and
  // the one outcome D9 exists to forbid.
  test('a motif this bundle does not know still shows the badge, never hides it', async () => {
    const html = await renderHeader(
      info({ forge_available: false, forge_reason: 'rate-limited' as never }),
    )
    expect(html).toContain(t('workspace.forgeUnavailable'))
    expect(html).toContain(t('workspace.forgeReasonUnknown'))
  })

  test('the badge carries what still works and what does not (D9 two lists)', async () => {
    const html = await renderHeader(info({ forge_available: false, forge_reason: 'no-cli' }))
    const hint = t('workspace.forgeUnavailableHint')
    // Rendered escaped inside the title attribute; compare on a distinctive
    // fragment that survives entity escaping.
    expect(html).toContain(hint.split('.')[0]?.slice(0, 30) ?? '')
  })
})

describe('and stays silent when there is nothing to state', () => {
  test('a forge that answers announces no degradation at all', async () => {
    const html = await renderHeader(info({ forge_available: true }))
    expect(html).not.toContain(t('workspace.forgeUnavailable'))
  })

  test('an absent fact is UNKNOWN: nothing claimed, in either direction', async () => {
    for (const workspace of [null, undefined, info({})]) {
      const html = await renderHeader(workspace)
      expect(html).not.toContain(t('workspace.forgeUnavailable'))
      // …and, symmetrically, nothing that would read as "the forge is fine".
      expect(html).not.toContain(t('workspace.forgeReasonNoCli'))
    }
  })

  test('the counters the header always showed are untouched', async () => {
    const html = await renderHeader(info({ forge_available: false, forge_reason: 'no-cli' }))
    expect(html).toContain(t('workspace.agentsCount', { n: 0 }))
  })

  // The search moved into the list column, where each list searches its own
  // corpus. A field here on top of those would be a second box over an
  // overlapping third thing.
  test('the header carries no search field of its own', async () => {
    const html = await renderHeader(info({}))
    expect(html).not.toContain(t('workspace.searchPlaceholder'))
    expect(html).not.toContain('wh-search')
    expect(html).not.toContain('⌘K')
  })
})

describe('forgeUnavailableKey — the mapping the badge reads', () => {
  test('null for available and for unknown; a key only for an explicit false', () => {
    expect(forgeUnavailableKey(null)).toBeNull()
    expect(forgeUnavailableKey(info({}))).toBeNull()
    expect(forgeUnavailableKey(info({ forge_available: true }))).toBeNull()
    expect(forgeUnavailableKey(info({ forge_available: false, forge_reason: 'cli-error' }))).toBe(
      'workspace.forgeReasonCliError',
    )
  })

  test('an unknown motif maps to the unnamed wording, never to null', () => {
    for (const reason of ['rate-limited', '', '__proto__', 'toString']) {
      expect(
        forgeUnavailableKey(info({ forge_available: false, forge_reason: reason as never })),
      ).toBe('workspace.forgeReasonUnknown')
    }
  })
})

describe('the wiring, on the source that carries it', () => {
  const VIEW = readFileSync(join(import.meta.dir, 'WorkspaceView.vue'), 'utf8')

  test('WorkspaceView passes the facts of the FILTERED project, not a fixed blob', () => {
    // The prop is bound at all…
    expect(VIEW).toContain(':workspace="headerWorkspace"')
    // …and it follows the filter, so a degraded sibling is not hidden behind
    // the launch repo's healthy answer.
    expect(VIEW).toContain('isolationForProject(filter.value, projects.value, workspace.value)')
  })
})

describe('the sentences exist in BOTH catalogs, and differ', () => {
  test('every forge key is translated, not served in English to a French UI', () => {
    for (const key of [
      'workspace.forgeUnavailable',
      'workspace.forgeReasonNoRemote',
      'workspace.forgeReasonNoCli',
      'workspace.forgeReasonCliError',
      'workspace.forgeReasonUnknown',
      'workspace.forgeUnavailableHint',
    ] as const) {
      expect(catalogs.en?.[key]).toBeDefined()
      expect(catalogs.fr?.[key]).toBeDefined()
      expect(catalogs.fr?.[key]).not.toBe(catalogs.en?.[key])
    }
  })
})
