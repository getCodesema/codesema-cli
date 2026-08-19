import { describe, expect, test } from 'bun:test'
import { setLanguage, t } from './i18n.js'
import { PROBE_NOTICE_MS, runProbes, type Probe } from './probes.js'

/** A probe whose answer is released by hand, so "launched" and "answered" are distinguishable. */
function heldProbe(label: string, log: string[]) {
  let release: (value: string | null) => void = () => {}
  const probe: Probe<string | null> = {
    label,
    run: () => {
      log.push(label)
      return new Promise<string | null>((resolve) => {
        release = resolve
      })
    },
  }
  return { probe, release: (value: string | null) => release(value) }
}

describe('runProbes', () => {
  test('every probe is launched before the first one answers', async () => {
    const launched: string[] = []
    const a = heldProbe('glab', launched)
    const b = heldProbe('gh', launched)
    const c = heldProbe('claude', launched)

    const pending = runProbes([a.probe, b.probe, c.probe], { notify: () => {} })
    // Not a single await yet: the launch pass is synchronous by design.
    expect(launched).toEqual(['glab', 'gh', 'claude'])

    a.release('one')
    b.release(null)
    c.release('three')
    expect(await pending).toEqual(['one', null, 'three'])
  })

  test('one expiring probe never delays the launch of the others', async () => {
    const launched: string[] = []
    let launchedWhenFirstExpired = -1
    const probes: Probe<string | null>[] = ['glab', 'gh', 'claude', 'codex', 'gemini'].map(
      (label) => ({
        label,
        run: async () => {
          launched.push(label)
          await Promise.resolve()
          if (launchedWhenFirstExpired < 0) {
            // This probe just hit its timeout (tryExecAsync answers null).
            launchedWhenFirstExpired = launched.length
          }
          return null
        },
      }),
    )

    expect(await runProbes(probes, { notify: () => {} })).toEqual([null, null, null, null, null])
    // All five were already running when the first one expired: the boot pays
    // ONE shared window, not the sum of five 8s timeouts.
    expect(launchedWhenFirstExpired).toBe(5)
  })

  test('results keep the input order whatever the answer order', async () => {
    const launched: string[] = []
    const a = heldProbe('a', launched)
    const b = heldProbe('b', launched)

    const pending = runProbes([a.probe, b.probe], { notify: () => {} })
    b.release('second-answered-first')
    a.release('first')
    expect(await pending).toEqual(['first', 'second-answered-first'])
  })

  test('an empty probe list is a no-op', async () => {
    expect(await runProbes([], { notify: () => {} })).toEqual([])
  })

  test('a wait is never silent: the boot names what it is still waiting for', async () => {
    const notices: string[][] = []
    const launched: string[] = []
    const slow = heldProbe('glab', launched)
    const fast: Probe<string | null> = { label: 'gh', run: () => Promise.resolve(null) }

    const pending = runProbes([slow.probe, fast], {
      noticeMs: 1,
      notify: (labels) => notices.push(labels),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Only the probe still in flight is named — invariant 2, no silent wait.
    expect(notices).toEqual([['glab']])

    slow.release(null)
    await pending
  })

  test('probes that answer right away stay silent', async () => {
    const notices: string[][] = []
    const probes: Probe<string | null>[] = [
      { label: 'glab', run: () => Promise.resolve(null) },
      { label: 'gh', run: () => Promise.resolve('main') },
    ]
    await runProbes(probes, { noticeMs: 5, notify: (labels) => notices.push(labels) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(notices).toEqual([])
    expect(PROBE_NOTICE_MS).toBeGreaterThan(0)
  })

  test('the default notice is a readable, translated sentence naming the probes', () => {
    const en = t('probes.waiting', { probes: 'glab, gh', seconds: 8 })
    expect(en).toContain('glab, gh')
    expect(en).toContain('8')
    setLanguage('fr')
    try {
      const fr = t('probes.waiting', { probes: 'glab, gh', seconds: 8 })
      expect(fr).toContain('glab, gh')
      expect(fr).not.toBe(en)
    } finally {
      setLanguage(null)
    }
  })
})
