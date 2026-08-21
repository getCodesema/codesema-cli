// Boot probes (forge CLIs, agent CLIs), run concurrently. Chained, they cost
// the SUM of the per-probe timeouts — up to ~40s before the first screen with
// 8s x 2 forges + 3 agents. Launched together they cost ONE shared window, the
// slowest probe: the per-probe timeout is unchanged (PROBE_TIMEOUT_MS, git.ts),
// only the waiting is shared. And a wait is never silent: past a short delay
// the boot names what it is still waiting for.

import { PROBE_TIMEOUT_MS } from './git.js'
import { t } from './i18n.js'
import { dim } from './ui.js'

/**
 * How long the boot waits before saying out loud what it is waiting for. Short
 * enough that a human notices the pause is explained, long enough that probes
 * answering right away stay silent.
 */
export const PROBE_NOTICE_MS = 400

export type Probe<T> = {
  /** What is being probed, as shown to the user while waiting (e.g. 'glab'). */
  label: string
  /** Launched by runProbes; must never reject for a missing/failing binary. */
  run: () => Promise<T>
}

export type RunProbesOptions = {
  /** Delay before the "still waiting" notice. Defaults to PROBE_NOTICE_MS. */
  noticeMs?: number
  /** Test seam / quiet override for that notice. */
  notify?: (labels: string[]) => void
}

function defaultNotice(labels: string[]): void {
  console.log(
    dim(
      t('probes.waiting', {
        probes: labels.join(', '),
        seconds: Math.round(PROBE_TIMEOUT_MS / 1000),
      }),
    ),
  )
}

/**
 * Runs every probe concurrently and returns their results in input order.
 *
 * The whole point is the first line of the body: every `run()` is called in one
 * synchronous pass, BEFORE anything is awaited, so no probe waits for another's
 * answer to start. The total is therefore bounded by the slowest probe (~8s,
 * one shared window) instead of the sum of the probes.
 */
export async function runProbes<T>(
  probes: readonly Probe<T>[],
  opts: RunProbesOptions = {},
): Promise<T[]> {
  if (probes.length === 0) {
    return []
  }
  const pending = new Set(probes.map((probe) => probe.label))
  // Launch pass: synchronous, no await inside. Do not turn this into a for-await.
  const running = probes.map((probe) =>
    probe.run().finally(() => {
      pending.delete(probe.label)
    }),
  )
  const notify = opts.notify ?? defaultNotice
  const timer = setTimeout(() => {
    if (pending.size > 0) {
      notify([...pending])
    }
  }, opts.noticeMs ?? PROBE_NOTICE_MS)
  try {
    return await Promise.all(running)
  } finally {
    clearTimeout(timer)
  }
}
