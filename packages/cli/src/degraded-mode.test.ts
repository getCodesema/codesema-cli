// D9's proof: what codesema still does without a forge, and what it refuses —
// stated, named, and exercised end to end on a real repo that has no remote
// and a PATH that has no `gh` and no `glab`.
//
// Nothing here touches the network or a container. The agent, the review and
// every forge call go through their injection seams; the ONLY real things are
// the git repo in a tmpdir and the PATH lookup that proves the forge binaries
// really are out of reach.

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentRunOptions } from './agent.js'
import type { TaskRecord } from './contract.js'
import {
  FORGE_DEGRADATIONS,
  FORGE_REMOTE_PROBE_TIMEOUT_MS,
  forgeCandidates,
  forgeReasonDetail,
  forgeWorkspaceFacts,
  originProbe,
  probeForgeCli,
  probeOriginRemote,
  UNPROBED_FORGE,
  type ForgeCliStatus,
  type ForgeOrigin,
  type ForgeProbe,
  type ForgeProbeExecFn,
} from './degraded-mode.js'
import {
  forgeIssueReason,
  type ForgeCli,
  type ForgeCliOutcome,
  type ForgeIssueReason,
  type ForgeIssuesExecFn,
} from './forge-issues.js'
import { addProject, type Project } from './projects.js'
import { createTaskManager } from './task-server.js'
import { shipTask, type ShipCliOutcome, type ShipOutcome } from './task-ship.js'
import { taskWorktreesDir } from './task-worktree.js'
import { listTasks, loadTask, readTaskEvents } from './tasks-store.js'

// --- rig ------------------------------------------------------------------

let configDir: string
const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
const cleanups: string[] = []

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'codesema-degraded-cfg-'))
  cleanups.push(configDir)
  process.env.CODESEMA_CONFIG_DIR = configDir
})

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  if (previousConfigDir === undefined) {
    delete process.env.CODESEMA_CONFIG_DIR
  } else {
    process.env.CODESEMA_CONFIG_DIR = previousConfigDir
  }
})

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codesema-degraded-'))
  cleanups.push(dir)
  return dir
}

/** A real git repo with a real commit — and, deliberately, NO remote. */
function makeRepo(): string {
  const repo = makeDir()
  const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  run(['init', '-b', 'main'])
  run(['config', 'user.email', 't@t'])
  run(['config', 'user.name', 't'])
  writeFileSync(join(repo, 'base.txt'), 'a\n')
  run(['add', '-A'])
  run(['commit', '-m', 'init: base'])
  return repo
}

function withOrigin(repo: string, url = 'https://github.com/acme/repo.git'): string {
  execFileSync('git', ['remote', 'add', 'origin', url], { cwd: repo, stdio: 'ignore' })
  return repo
}

function register(repo: string): Project {
  const added = addProject(repo)
  if (!added.ok) {
    throw new Error(added.error)
  }
  return added.project
}

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timeout waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

type ForgeCall = { cli: ForgeCli; args: string[]; cwd: string }

/** The only way a forge binary is ever "run" here: the argv IS the assertion. */
function forgeRig(reply: (call: ForgeCall) => ForgeCliOutcome) {
  const calls: ForgeCall[] = []
  const execFn: ForgeIssuesExecFn = (cli, args, cwd) => {
    calls.push({ cli, args, cwd })
    return Promise.resolve(reply({ cli, args, cwd }))
  }
  return { calls, execFn }
}

const managerOpts = { command: 'claude -p', timeoutMs: 5000 }

// --- I. The vocabulary: three motifs, propagated verbatim -----------------

describe('forgeReasonDetail — the motif verbatim, the message kept', () => {
  test('a motif with nothing to add is the motif, and nothing else', () => {
    for (const reason of FORGE_DEGRADATIONS) {
      expect(forgeReasonDetail(reason)).toBe(reason)
    }
  })

  test('the motif comes FIRST and the producer words are appended untouched', () => {
    const detail = forgeReasonDetail('cli-error', 'gh: API rate limit exceeded')
    expect(detail.startsWith('cli-error')).toBe(true)
    expect(detail).toContain('gh: API rate limit exceeded')
    // Never reworded into a sentence of ours.
    expect(detail).toBe('cli-error: gh: API rate limit exceeded')
  })

  test('no-cli and cli-error are never confusable, with or without words', () => {
    expect(forgeReasonDetail('no-cli')).not.toContain('cli-error')
    expect(forgeReasonDetail('no-cli', 'x').startsWith('cli-error')).toBe(false)
    expect(forgeReasonDetail('cli-error', 'x').startsWith('no-cli')).toBe(false)
  })

  test('blank words add nothing rather than a dangling separator', () => {
    expect(forgeReasonDetail('no-remote', '   ')).toBe('no-remote')
    expect(forgeReasonDetail('no-remote', null)).toBe('no-remote')
  })
})

/**
 * Every member of the forge client's union, spelled out so a test can WALK it.
 * `satisfies` pins each of these as a legal member; noticing a NEW one is the
 * job of `forgeIssueReason`'s exhaustive switch, which stops compiling on an
 * addition.
 */
const ALL_FORGE_ISSUE_REASONS = [
  'no-remote',
  'no-cli',
  'cli-error',
  'invalid-input',
  'unsupported',
] as const satisfies readonly ForgeIssueReason[]

describe('FORGE_DEGRADATIONS — COMPLETE, not merely legal', () => {
  // `satisfies readonly ForgeIssueReason[]` lets a SUBSET compile: a table
  // amputated of 'cli-error' type-checks, and the only two tests that touched
  // it ITERATED it, so a shorter table just made fewer rounds and stayed
  // green. Pinned here against a second, independent source of the same
  // truth — which motifs the bridge to D2 actually codes — rather than
  // against a literal list, which would only restate the table.
  test('it holds exactly the motifs forgeIssueReason gives a D2 code to', () => {
    const coded = ALL_FORGE_ISSUE_REASONS.filter(
      (reason) => forgeIssueReason({ available: false, reason }) !== null,
    )
    const table: string[] = [...FORGE_DEGRADATIONS]
    expect(table.toSorted()).toEqual((coded as readonly string[]).toSorted())
    // Spelled out too, so the failure names the missing member rather than
    // printing two arrays: these three, and each for its own reason.
    expect(FORGE_DEGRADATIONS).toContain('no-remote')
    expect(FORGE_DEGRADATIONS).toContain('no-cli')
    expect(FORGE_DEGRADATIONS).toContain('cli-error')
  })

  test('the two motifs that mean "the forge answered" stay OUT of it', () => {
    expect(FORGE_DEGRADATIONS).not.toContain('invalid-input' as never)
    expect(FORGE_DEGRADATIONS).not.toContain('unsupported' as never)
  })
})

describe('forgeCandidates — the ladder the header must read the same way', () => {
  test('a known forge admits exactly the CLI that serves it', () => {
    expect(forgeCandidates('github')).toEqual(['gh'])
    expect(forgeCandidates('gitlab')).toEqual(['glab'])
  })

  test('an unrecognized (self-hosted) remote admits both, gh first', () => {
    expect(forgeCandidates('unknown')).toEqual(['gh', 'glab'])
  })
})

// --- The boot probe -------------------------------------------------------

function probeRig(outcomes: Partial<Record<ForgeCli, ForgeCliOutcome>>) {
  const calls: ForgeCall[] = []
  const execFn: ForgeProbeExecFn = (cli, args, cwd) => {
    calls.push({ cli, args, cwd })
    return Promise.resolve(outcomes[cli] ?? { kind: 'missing' })
  }
  return { calls, execFn }
}

describe('probeForgeCli — machine-wide, once, and offline', () => {
  test('it records BOTH CLIs, not just the first that answered', async () => {
    const rig = probeRig({ gh: { kind: 'ok', stdout: 'gh version 2.46.0' } })
    expect(await probeForgeCli(rig.execFn, '/tmp')).toEqual({
      kind: 'probed',
      gh: { kind: 'ok' },
      // Asked even though gh already answered: which CLI matters is a
      // question of the REPO, and only forgeWorkspaceFacts knows the repo.
      glab: { kind: 'missing' },
    })
    expect(rig.calls.map((c) => c.cli).toSorted()).toEqual(['gh', 'glab'])
    // No network, no token: the probe only asks the binaries to name themselves.
    expect(rig.calls.map((c) => c.args)).toEqual([['--version'], ['--version']])
  })

  test('the two probes are launched TOGETHER, not one after the other', async () => {
    // Each candidate carries its own 8s budget; walking them in a line made
    // the worst case their SUM, on a boot nobody is watching. Proven by
    // holding gh open until glab has been asked: a sequential probe
    // deadlocks here, a parallel one settles.
    let askedGlab: (() => void) | undefined
    const glabAsked = new Promise<void>((resolve) => {
      askedGlab = resolve
    })
    const execFn: ForgeProbeExecFn = async (cli) => {
      if (cli === 'glab') {
        askedGlab?.()
        return { kind: 'missing' }
      }
      await glabAsked
      return { kind: 'ok', stdout: 'gh version 2.46.0' }
    }
    expect(await probeForgeCli(execFn, '/tmp')).toEqual({
      kind: 'probed',
      gh: { kind: 'ok' },
      glab: { kind: 'missing' },
    })
  })

  test('neither installed: both missing — never an error status', async () => {
    const rig = probeRig({})
    expect(await probeForgeCli(rig.execFn, '/tmp')).toEqual({
      kind: 'probed',
      gh: { kind: 'missing' },
      glab: { kind: 'missing' },
    })
  })

  test('installed but broken: an error status carrying the binary own words', async () => {
    const rig = probeRig({ gh: { kind: 'error', message: 'error while loading shared libraries' } })
    const probe = await probeForgeCli(rig.execFn, '/tmp')
    expect(probe.kind === 'probed' && probe.gh.kind).toBe('error')
    expect(probe.kind === 'probed' && probe.gh.kind === 'error' && probe.gh.message).toContain(
      'shared libraries',
    )
    // It ran and failed: that is NOT "no forge CLI installed".
    expect(probe.kind === 'probed' && probe.gh.kind).not.toBe('missing')
  })

  test('an argv the kernel refused is a binary that did not answer, not a missing one', async () => {
    const rig = probeRig({ gh: { kind: 'invalid', message: 'argument list too long' } })
    const probe = await probeForgeCli(rig.execFn, '/tmp')
    expect(probe.kind === 'probed' && probe.gh.kind).toBe('error')
  })

  test('each CLI keeps ITS OWN words: a broken gh never speaks for glab', async () => {
    const rig = probeRig({
      gh: { kind: 'error', message: 'gh is broken' },
      glab: { kind: 'error', message: 'glab is broken too' },
    })
    const probe = await probeForgeCli(rig.execFn, '/tmp')
    expect(probe.kind === 'probed' && probe.gh.kind === 'error' && probe.gh.message).toBe(
      'gh is broken',
    )
    expect(probe.kind === 'probed' && probe.glab.kind === 'error' && probe.glab.message).toBe(
      'glab is broken too',
    )
  })
})

describe('probeOriginRemote — a tri-state, because "could not ask" is not "no"', () => {
  test('an origin, with the forge it points at; none without one', () => {
    const repo = makeRepo()
    expect(probeOriginRemote(repo)).toEqual({ kind: 'none' })
    withOrigin(repo)
    expect(probeOriginRemote(repo)).toEqual({ kind: 'origin', hint: 'github' })
  })

  test('the hint comes off the URL, and a self-hosted remote stays unknown', () => {
    expect(probeOriginRemote(withOrigin(makeRepo(), 'git@gitlab.com:acme/repo.git'))).toEqual({
      kind: 'origin',
      hint: 'gitlab',
    })
    expect(probeOriginRemote(withOrigin(makeRepo(), 'git@git.acme.example:acme/repo.git'))).toEqual(
      {
        kind: 'origin',
        hint: 'unknown',
      },
    )
  })

  test('a path that is not a repo answers UNKNOWN, never "no remote"', () => {
    expect(probeOriginRemote(makeDir())).toEqual({ kind: 'unknown' })
  })

  // Round-2 adversarial review, MAJEUR 4. `GET /api/projects` calls this
  // SYNCHRONOUSLY, once per registered project, on the request thread — the
  // first subprocess T2.7 put on that route. Unbounded, one repo whose working
  // tree sits on a suspended network mount freezes the whole HTTP server, for
  // good. Proven with a `git` that never returns rather than argued from the
  // source: the budget is handed in short so the test costs milliseconds.
  test('the probe is BOUNDED: a git that hangs answers "unknown", it does not wait', () => {
    const bin = makeDir()
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nsleep 15\n', { mode: 0o755 })
    const restore = process.env.PATH
    // PREPENDED, not replacing: the shim needs `sleep` to resolve, and a PATH
    // holding only the shim makes it exit 127 instantly — which answers
    // "unknown" too and would let this test pass with no bound at all.
    process.env.PATH = `${bin}:${restore ?? ''}`
    try {
      const started = Date.now()
      // A hung git is "I could not ask", never "there is no remote".
      expect(originProbe(makeDir(), 120)).toEqual({ kind: 'unknown' })
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      if (restore === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = restore
      }
    }
  })

  test('the budget the production probe runs on is a bound, not a formality', () => {
    // The wired-in number, pinned like the published boot deadline is: a
    // refactor pushing it to a minute would leave the test above green.
    expect(FORGE_REMOTE_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5000)
    expect(FORGE_REMOTE_PROBE_TIMEOUT_MS).toBeGreaterThan(0)
  })

  test('a BLANK origin URL is "none" — the same answer the ship refuses with', () => {
    // `git remote set-url origin "   "` is accepted and reported with exit 0
    // (git 2.53.0). Read as "there is an origin", the header announced a forge
    // while every ship on that repo was refused `no-remote`: the two twins
    // contradicting each other about one repo.
    const repo = withOrigin(makeRepo())
    execFileSync('git', ['remote', 'set-url', 'origin', '   '], { cwd: repo, stdio: 'ignore' })
    expect(probeOriginRemote(repo)).toEqual({ kind: 'none' })
  })
})

/** A probe whose two CLIs are set one by one; anything unnamed is missing. */
function probed(states: Partial<Record<ForgeCli, ForgeCliStatus>>): ForgeProbe {
  return {
    kind: 'probed',
    gh: states.gh ?? { kind: 'missing' },
    glab: states.glab ?? { kind: 'missing' },
  }
}

const GH_WORKS = probed({ gh: { kind: 'ok' } })
const GLAB_WORKS = probed({ glab: { kind: 'ok' } })
const GITHUB: ForgeOrigin = { kind: 'origin', hint: 'github' }
const GITLAB: ForgeOrigin = { kind: 'origin', hint: 'gitlab' }
const SELF_HOSTED: ForgeOrigin = { kind: 'origin', hint: 'unknown' }

describe('forgeWorkspaceFacts — absence means unknown, never available', () => {
  test('a repo with no remote is no-remote, whatever the machine has installed', () => {
    for (const probe of [GH_WORKS, UNPROBED_FORGE, probed({})]) {
      expect(forgeWorkspaceFacts(probe, { kind: 'none' })).toEqual({
        forge_available: false,
        forge_reason: 'no-remote',
      })
    }
  })

  test('the machine motif is reported once the repo HAS a remote', () => {
    expect(forgeWorkspaceFacts(probed({}), GITHUB)).toEqual({
      forge_available: false,
      forge_reason: 'no-cli',
    })
    expect(forgeWorkspaceFacts(probed({ gh: { kind: 'error', message: 'boom' } }), GITHUB)).toEqual(
      {
        forge_available: false,
        forge_reason: 'cli-error',
      },
    )
  })

  test('everything answering: available, and NO reason at all', () => {
    expect(forgeWorkspaceFacts(GH_WORKS, GITHUB)).toEqual({ forge_available: true })
    expect(forgeWorkspaceFacts(GLAB_WORKS, GITLAB)).toEqual({ forge_available: true })
  })

  // Round-2 adversarial review, MAJEUR 3. The probe is machine-wide; whether
  // it helps is a question about the REPO. `candidatesFor` never launches gh
  // on a GitLab origin, so a machine with gh alone is `no-cli` there — and
  // the header used to answer `forge_available: true` while every real call
  // on that repo came back `forge_unreachable / no-cli`.
  test('a CLI the repo cannot use is not availability: gh alone on a GitLab origin', () => {
    expect(forgeWorkspaceFacts(GH_WORKS, GITLAB)).toEqual({
      forge_available: false,
      forge_reason: 'no-cli',
    })
    expect(forgeWorkspaceFacts(GLAB_WORKS, GITHUB)).toEqual({
      forge_available: false,
      forge_reason: 'no-cli',
    })
  })

  test('a BROKEN candidate the repo can use is cli-error; a broken one it cannot is not', () => {
    const brokenGh = probed({ gh: { kind: 'error', message: 'boom' } })
    // GitHub origin: gh IS the candidate, and it ran and failed.
    expect(forgeWorkspaceFacts(brokenGh, GITHUB).forge_reason).toBe('cli-error')
    // GitLab origin: gh is never launched there, so its failure says nothing
    // about this repo — what is true here is that glab is not installed.
    expect(forgeWorkspaceFacts(brokenGh, GITLAB).forge_reason).toBe('no-cli')
  })

  test('a self-hosted remote can be served by EITHER CLI', () => {
    expect(forgeWorkspaceFacts(GH_WORKS, SELF_HOSTED)).toEqual({ forge_available: true })
    expect(forgeWorkspaceFacts(GLAB_WORKS, SELF_HOSTED)).toEqual({ forge_available: true })
    expect(forgeWorkspaceFacts(probed({}), SELF_HOSTED).forge_reason).toBe('no-cli')
  })

  test('unprobed, or a repo we could not read: NO field — "unknown", not "fine"', () => {
    expect(forgeWorkspaceFacts(UNPROBED_FORGE, GITHUB)).toEqual({})
    expect(forgeWorkspaceFacts(GH_WORKS, { kind: 'unknown' })).toEqual({})
    // The trap this closes: an absent field read as an optimistic default.
    expect(forgeWorkspaceFacts(UNPROBED_FORGE, GITHUB).forge_available).toBeUndefined()
  })
})

// --- III. The payload the UI reads ----------------------------------------

describe('GET /api/projects workspace facts (D-d: assert the payload)', () => {
  test('each of the three motifs reaches the payload, with its reason', () => {
    const project = register(makeRepo())
    const cases: { probe: ForgeProbe; origin: ForgeOrigin; reason: string }[] = [
      { probe: GH_WORKS, origin: { kind: 'none' }, reason: 'no-remote' },
      { probe: probed({}), origin: GITHUB, reason: 'no-cli' },
      {
        probe: probed({ gh: { kind: 'error', message: 'boom' } }),
        origin: GITHUB,
        reason: 'cli-error',
      },
    ]
    for (const one of cases) {
      const manager = createTaskManager({
        ...managerOpts,
        forge: one.probe,
        forgeRemoteFn: () => one.origin,
      })
      const info = manager.workspaceInfo(project.id)
      expect(info.forge_available).toBe(false)
      expect(info.forge_reason).toBe(one.reason as never)
      // The isolation facts it rides next to are untouched.
      expect(info.isolation_default).toBe('policy')
    }
  })

  test('a workspace whose forge answers announces NO degradation at all', () => {
    const project = register(withOrigin(makeRepo()))
    const manager = createTaskManager({ ...managerOpts, forge: GH_WORKS })
    const info = manager.workspaceInfo(project.id)
    expect(info.forge_available).toBe(true)
    expect(info.forge_reason).toBeUndefined()
  })

  test('nothing probed: the two fields are ABSENT, so the UI reads "unknown"', () => {
    const project = register(withOrigin(makeRepo()))
    const manager = createTaskManager({ ...managerOpts })
    const info = manager.workspaceInfo(project.id)
    expect(info.forge_available).toBeUndefined()
    expect(info.forge_reason).toBeUndefined()
  })

  test('the default remote probe is REAL: a registered repo with no origin says so', () => {
    const project = register(makeRepo())
    // No `forgeRemoteFn`: this is the production wiring, answering off git.
    const manager = createTaskManager({ ...managerOpts, forge: GH_WORKS })
    expect(manager.workspaceInfo(project.id).forge_reason).toBe('no-remote')
  })

  // The other half of the same production wiring: the default probe reads the
  // origin URL too, so the payload of a GitLab repo on a gh-only machine is
  // the motif its next real call would carry.
  test('the default remote probe reads the FORGE, not just the presence of an origin', () => {
    const gitlab = register(withOrigin(makeRepo(), 'git@gitlab.com:acme/repo.git'))
    const manager = createTaskManager({ ...managerOpts, forge: GH_WORKS })
    const info = manager.workspaceInfo(gitlab.id)
    expect(info.forge_available).toBe(false)
    expect(info.forge_reason).toBe('no-cli')
  })

  test('no project to ask about: unknown, never a launch-repo answer for everyone', () => {
    register(makeRepo())
    const manager = createTaskManager({ ...managerOpts, forge: probed({}) })
    expect(manager.workspaceInfo(null).forge_available).toBeUndefined()
  })
})

// --- I. The title+prompt path survives, and never asks a forge anything ----

describe('the title+prompt path is untouched by the absence of a forge', () => {
  test('creating without an issue makes ZERO forge calls', async () => {
    const project = register(makeRepo())
    const { calls, execFn } = forgeRig(() => ({ kind: 'missing' }))
    const manager = createTaskManager({
      ...managerOpts,
      issueExecFn: execFn,
      runAgentFn: () => Promise.resolve('done'),
      reviewTurnFn: (record, io) => {
        record.status = 'review_ok'
        io.persist()
        return Promise.resolve()
      },
    })
    const created = await manager.create(project.id, {
      title: 'plain task',
      prompt: 'do the thing',
      autoShip: false,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      throw new Error('unreachable')
    }
    await until(() => loadTask(project.path, created.record.id)?.status === 'review_ok')
    // The whole cycle ran and not one forge round trip was attempted.
    expect(calls).toHaveLength(0)
    expect(created.record.issue).toBeUndefined()
    expect(created.record.issue_snapshot).toBeUndefined()
    await manager.shutdown()
  })
})

describe('a creation FROM an issue is refused cleanly when the forge is unreachable', () => {
  test('no record, no worktree, no queue entry — and the refusal is named', async () => {
    const project = register(makeRepo())
    const { execFn } = forgeRig(() => ({ kind: 'missing' }))
    const manager = createTaskManager({ ...managerOpts, issueExecFn: execFn })

    const created = await manager.create(project.id, {
      autoShip: false,
      issue: {
        forge: 'github',
        project: 'acme/repo',
        iid: 42,
        url: 'https://github.com/acme/repo/issues/42',
      },
    })
    expect(created.ok).toBe(false)
    if (created.ok) {
      throw new Error('unreachable')
    }
    expect(created.code).toBe(502)
    expect(created.reason_code).toBe('forge_unreachable')
    // The readable half is still there and still says what happened.
    expect(created.error.length).toBeGreaterThan(0)
    // Nothing was left behind: not a record, not a worktree, not a queue slot.
    expect(listTasks(project.path)).toHaveLength(0)
    const worktrees = taskWorktreesDir(project.path)
    expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([])
    await manager.shutdown()
  })
})

// --- IV. The offline end-to-end -------------------------------------------

/**
 * A PATH holding `git` and NOTHING else — in particular no `gh` and no
 * `glab`. Filtering the real PATH would not do: on a plain Linux box `gh` and
 * `git` sit in the SAME directory, so dropping the one that has a forge CLI
 * takes git down with it. A directory of our own, with a single symlink,
 * makes the condition exact instead of approximate.
 */
function offlineBinDir(): string {
  const dir = makeDir()
  const git = Bun.which('git')
  if (git === null) {
    throw new Error('git is not on the PATH: this suite cannot run')
  }
  symlinkSync(git, join(dir, 'git'))
  return dir
}

describe('offline end to end: no remote, no gh, no glab', () => {
  test('the workspace boots, runs a task to review_ok, and REFUSES the ship with its reason', async () => {
    const repo = makeRepo() // no remote, on purpose
    const project = register(repo)
    const restore = process.env.PATH
    const bin = offlineBinDir()
    process.env.PATH = bin
    try {
      // The condition is checked, not assumed: this is what "offline" means
      // for the rest of the test, and a PATH that still resolved gh would
      // make the ship refusal prove something else.
      expect(Bun.which('gh', { PATH: bin })).toBeNull()
      expect(Bun.which('glab', { PATH: bin })).toBeNull()
      expect(Bun.which('git', { PATH: bin })).not.toBeNull()

      const manager = createTaskManager({
        ...managerOpts,
        // The agent is injected; nothing spawns, nothing reaches a network.
        runAgentFn: (options: AgentRunOptions) => {
          options.onText?.('working offline')
          return Promise.resolve('done')
        },
        reviewTurnFn: (record, io) => {
          record.status = 'review_ok'
          io.persist()
          return Promise.resolve()
        },
      })
      const created = await manager.create(project.id, {
        title: 'Offline task',
        prompt: 'work with no forge at all',
        autoShip: false,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) {
        throw new Error('unreachable')
      }
      const id = created.record.id
      await until(() => loadTask(repo, id)?.status === 'review_ok')

      // …and the ship is refused, by NAME. `shipTask` is NOT stubbed here:
      // the real one runs, and the only reason it never reaches the network
      // is that it refuses before the push.
      const shipped = await manager.ship(project.id, id)
      expect(shipped.ok).toBe(false)
      if (shipped.ok) {
        throw new Error('unreachable')
      }
      expect(shipped.reason_code).toBe('forge_unreachable')
      expect(shipped.error).toContain('origin remote')
      // The task is NOT marked shipped: nothing was faked.
      expect(loadTask(repo, id)?.status).toBe('review_ok')
      // The refusal is journaled too, with its code (invariant 2's three legs:
      // readable message, journal event, API answer).
      const failure = readTaskEvents(repo, id).findLast((e) => e.type === 'error')
      expect(failure?.reason_code).toBe('forge_unreachable')
      expect(String(failure?.data.message)).toContain('origin remote')
      await manager.shutdown()
    } finally {
      if (restore === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = restore
      }
    }
  })

  test('shipTask itself, on a real repo with no remote, never spawns a forge CLI', async () => {
    const repo = makeRepo()
    const forgeCalls: string[] = []
    const gitCalls: string[][] = []
    const outcome = await shipTask({
      cwd: repo,
      task: {
        version: 1,
        id: 'abcdef123456',
        title: 'Offline',
        status: 'review_ok',
        base: 'main',
        branch: 'codesema/task-offline',
        worktree: join(repo, '.codesema', 'worktrees', 'abcdef123456'),
        agent_session_id: null,
        turns: [],
        review_ref: null,
        work_ms: 0,
        wait_ms: 0,
        auto_ship: false,
        work_on: false,
        isolation: 'policy',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      // Exactly what git answers on a repo with no origin: exit code 2 and
      // its own (localised) sentence — measured on git 2.53.0.
      execGit: (args, cwd) => {
        gitCalls.push(args)
        const probe: ShipCliOutcome =
          args[0] === 'remote'
            ? { kind: 'error', message: "error: No such remote 'origin'", status: 2 }
            : { kind: 'ok', stdout: '' }
        expect(cwd).toBe(repo)
        return Promise.resolve(probe)
      },
      execForge: (cli) => {
        forgeCalls.push(cli)
        return Promise.resolve({ kind: 'ok', stdout: 'https://example.invalid/pr/1' })
      },
    })
    expect(outcome.pushed).toBe(false)
    expect(outcome.pushed === false && outcome.detail).toBe('no-remote')
    expect(forgeCalls).toEqual([])
    expect(gitCalls.map((a) => a[0])).toEqual(['remote'])
  })
})

// --- V. The border of the refusal: what IS a forge we could not reach ------

/** A `review_ok` record, the shape `shipTask` reads. */
function shippableTask(repo: string): TaskRecord {
  return {
    version: 1,
    id: 'abcdef123456',
    title: 'Offline',
    status: 'review_ok',
    base: 'main',
    branch: 'codesema/task-offline',
    worktree: join(repo, '.codesema', 'worktrees', 'abcdef123456'),
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: false,
    work_on: false,
    isolation: 'policy',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

/** Runs the real `shipTask` against a git seam that answers per argv. */
function shipWithGit(
  repo: string,
  answer: (args: string[]) => ShipCliOutcome,
): { outcome: Promise<ShipOutcome>; gitCalls: string[][]; forgeCalls: string[] } {
  const gitCalls: string[][] = []
  const forgeCalls: string[] = []
  const outcome = shipTask({
    cwd: repo,
    task: shippableTask(repo),
    execGit: (args) => {
      gitCalls.push(args)
      return Promise.resolve(answer(args))
    },
    execForge: (cli) => {
      forgeCalls.push(cli)
      return Promise.resolve({ kind: 'ok', stdout: 'https://example.invalid/pr/1' })
    },
  })
  return { outcome, gitCalls, forgeCalls }
}

describe('a ship that could not ASK about the remote never announces "no remote"', () => {
  // Round-2 adversarial review, MAJEUR 1. The probe used to answer a plain
  // boolean, so "git answered: there is no origin" and "git is not installed"
  // (or the cwd is unreadable) came out the same `false`. Measured on a repo
  // that HAS an origin, with a PATH without git: the refusal read "no origin
  // remote is configured for this repo" — the exact "right decision, wrong
  // announcement" mistake degraded-mode.ts writes down.
  test('git missing: the refusal is git own words, with NO forge_unreachable', async () => {
    const repo = makeRepo()
    const run = shipWithGit(repo, () => ({ kind: 'missing' }))
    const outcome = await run.outcome
    expect(outcome.pushed).toBe(false)
    if (outcome.pushed) {
      throw new Error('unreachable')
    }
    expect(outcome.error).toContain('git not found')
    // The claim that was being made about a repo nobody could read:
    expect(outcome.error).not.toContain('origin remote is configured')
    expect(outcome.reasonCode).toBeUndefined()
    expect(outcome.detail).toBeUndefined()
    // …and it fell through to the push, which is what makes that branch
    // reachable at all: `remote get-url` no longer answers for it.
    expect(run.gitCalls.map((a) => a[0])).toEqual(['remote', 'push'])
    expect(run.forgeCalls).toEqual([])
  })

  test('a cwd that is not a repo (exit 128) is "could not ask", not "no remote"', async () => {
    const repo = makeRepo()
    const notARepo: ShipCliOutcome = {
      kind: 'error',
      message: 'fatal: not a git repository (or any of the parent directories): .git',
      status: 128,
    }
    const run = shipWithGit(repo, () => notARepo)
    const outcome = await run.outcome
    expect(outcome.pushed).toBe(false)
    if (outcome.pushed) {
      throw new Error('unreachable')
    }
    expect(outcome.error).toContain('git push failed')
    expect(outcome.error).not.toContain('origin remote is configured')
    expect(outcome.reasonCode).toBeUndefined()
    expect(run.gitCalls.map((a) => a[0])).toEqual(['remote', 'push'])
  })

  test('exit code 2 IS "no such remote", and only that is refused by name', async () => {
    const repo = makeRepo()
    const run = shipWithGit(repo, () => ({
      kind: 'error',
      // Localised on purpose: git translates this sentence, and the rule must
      // not be reading it. Only the exit code decides.
      message: "error: Pas de serveur remote 'origin'",
      status: 2,
    }))
    const outcome = await run.outcome
    expect(outcome.pushed).toBe(false)
    if (outcome.pushed) {
      throw new Error('unreachable')
    }
    expect(outcome.reasonCode).toBe('forge_unreachable')
    expect(outcome.detail).toBe('no-remote')
    // Refused BEFORE the push: no network attempt at all.
    expect(run.gitCalls.map((a) => a[0])).toEqual(['remote'])
  })

  test('an origin whose URL is blank is refused like no origin at all', async () => {
    const repo = makeRepo()
    const run = shipWithGit(repo, (args) =>
      args[0] === 'remote' ? { kind: 'ok', stdout: '   \n' } : { kind: 'ok', stdout: '' },
    )
    const outcome = await run.outcome
    expect(outcome.pushed).toBe(false)
    expect(outcome.pushed === false && outcome.detail).toBe('no-remote')
    expect(run.gitCalls.map((a) => a[0])).toEqual(['remote'])
  })
})

describe('offline: the third motif of D9, and the border around it', () => {
  const HAS_ORIGIN: ShipCliOutcome = { kind: 'ok', stdout: 'https://github.com/acme/repo.git\n' }

  /**
   * Real `git push` stderr, captured on git 2.53.0 under a FRENCH locale —
   * which is the point: git translates its own half ("impossible d'accéder
   * à"), libcurl and OpenSSH do not translate theirs. A rule written on git's
   * words would code these in one language and miss them in another.
   */
  const TRANSPORT = [
    "fatal: impossible d'accéder à 'https://github.com/acme/repo.git/' : Could not resolve host: github.com",
    'ssh: Could not resolve hostname github.com: Name or service not known\nfatal: Impossible de lire le dépôt distant.',
    "fatal: impossible d'accéder à 'https://127.0.0.1:1/acme/repo.git/' : Failed to connect to 127.0.0.1 port 1 after 0 ms: Could not connect to server",
    'ssh: connect to host github.com port 22: Connection refused\nfatal: Impossible de lire le dépôt distant.',
    'ssh: connect to host 2001:db8::1 port 22: Connection timed out\nfatal: Impossible de lire le dépôt distant.',
  ]

  test('a push that never reached the host is named, and keeps git own words', async () => {
    for (const message of TRANSPORT) {
      const repo = makeRepo()
      const run = shipWithGit(repo, (args) =>
        args[0] === 'remote' ? HAS_ORIGIN : { kind: 'error', message, status: 128 },
      )
      const outcome = await run.outcome
      expect(outcome.pushed).toBe(false)
      if (outcome.pushed) {
        throw new Error('unreachable')
      }
      expect(outcome.reasonCode).toBe('forge_unreachable')
      expect(outcome.detail).toBe('offline')
      // Invariant 2: the code is ADDED to the readable half, never instead.
      expect(outcome.error).toContain(message.split('\n')[0] ?? '')
      // The forge was never asked: the push died first.
      expect(run.forgeCalls).toEqual([])
    }
  })

  /**
   * The border, and it is the actual subject: `forge_unreachable` is a
   * RETRYABLE code, and D2 is read to decide whether to try again. Every
   * message below is a remote that ANSWERED — it refused, or the push was
   * rejected — and coding those "unreachable" would tell a machine to keep
   * retrying something that will never work on its own.
   */
  const ANSWERED = [
    {
      name: 'a non-fast-forward rejection',
      message:
        " ! [rejected]        main -> main (fetch first)\nerror: impossible de pousser des références vers 'https://github.com/acme/repo.git'\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally.",
    },
    {
      name: 'an HTTP 403 the forge answered',
      message:
        "remote: forbidden\nfatal: impossible d'accéder à 'https://github.com/acme/repo.git/' : The requested URL returned error: 403",
    },
    {
      name: 'an authentication refusal',
      message:
        "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/repo.git/'",
    },
    {
      name: 'a pre-receive hook that declined',
      message:
        'remote: error: hook declined to update refs/heads/main\nerror: impossible de pousser des références',
    },
  ]

  test('everything the remote ANSWERED stays uncoded — a wrong code is worse than none', async () => {
    for (const one of ANSWERED) {
      const repo = makeRepo()
      const run = shipWithGit(repo, (args) =>
        args[0] === 'remote' ? HAS_ORIGIN : { kind: 'error', message: one.message, status: 1 },
      )
      const outcome = await run.outcome
      expect(outcome.pushed).toBe(false)
      if (outcome.pushed) {
        throw new Error(`unreachable (${one.name})`)
      }
      // The readable half is untouched: nothing is lost by not coding it.
      expect(outcome.error).toContain('git push failed')
      expect(outcome.reasonCode).toBeUndefined()
      expect(outcome.detail).toBeUndefined()
    }
  })

  test('"unable to access" alone is NOT the rule: it wraps a 403 too', async () => {
    // The tempting shortcut. git's wrapper hangs off every libcurl failure,
    // including the ones where the forge answered a status code — so matching
    // it would put `forge_unreachable` on a permission problem.
    const repo = makeRepo()
    const run = shipWithGit(repo, (args) =>
      args[0] === 'remote'
        ? HAS_ORIGIN
        : {
            kind: 'error',
            message:
              "fatal: unable to access 'https://github.com/acme/repo.git/': The requested URL returned error: 403",
            status: 128,
          },
    )
    const outcome = await run.outcome
    expect(outcome.pushed === false && outcome.reasonCode).toBeUndefined()
  })
})

// --- II. The snapshot is the only cache, and it is read-only --------------

/** A gh `issue view --json <fields>` payload, as `parseGhIssue` reads it. */
function ghIssuePayload(body: string): string {
  return JSON.stringify({
    number: 42,
    title: 'Fix flaky worktree cleanup',
    body,
    state: 'OPEN',
    labels: [],
    author: { id: 'u1', is_bot: false, login: 'octocat', name: 'The Octocat' },
    createdAt: '2026-07-20T09:00:00Z',
    updatedAt: '2026-07-28T10:00:00Z',
    url: 'https://github.com/acme/repo/issues/42',
  })
}

const ISSUE_CRITERIA = [
  'WHEN a ticket is launched THE SYSTEM SHALL lint its body',
  'WHEN a section is missing THE SYSTEM SHALL name that section',
  'WHEN the body is conforming THE SYSTEM SHALL accept it',
]

/** A conforming ticket body (five sections, three EARS criteria). */
function conformingTicketBody(): string {
  return [
    '**Context**\n\nTickets are launched from the workspace.',
    '**Goal**\n\nFreeze the ticket format once.',
    '**Scope**\n\npackages/contract/src/ticket.ts',
    `**Acceptance criteria**\n\n${ISSUE_CRITERIA.map((c) => `- ${c}`).join('\n')}`,
    '**Out of scope**\n\nPosting the issue on the forge.',
  ].join('\n\n')
}

const ISSUE_REF = {
  forge: 'github' as const,
  project: 'acme/repo',
  iid: 42,
  url: 'https://github.com/acme/repo/issues/42',
}

/**
 * Every file under any of `roots` whose text holds `needle`, as paths relative
 * to the root it was found under. The point of walking rather than listing
 * known names: a cache written to a file nobody thought of is exactly the
 * failure mode "the snapshot is the only cache" has to catch.
 *
 * SEVERAL roots, because the repo's `.codesema` is not the only place this
 * process writes (round-2 adversarial review, mineur 11): the workspace also
 * owns `CODESEMA_CONFIG_DIR`, and a cache dropped there would have walked
 * straight past a walk that only ever looked at the repo — while the comment
 * promised "a file nobody thought of".
 *
 * `events.jsonl` is skipped, and only it: the journal is an append-only
 * account of what happened (the turn's own prompt is the issue body, so the
 * text is bound to appear there), never a place anything is read BACK from.
 * A cache is defined by being re-read, and nothing re-reads the journal for
 * ticket content.
 */
const JOURNAL_FILE = 'events.jsonl'

function filesUnderContaining(roots: readonly string[], needle: string): string[] {
  const found: string[] = []
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) {
      return
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const rel = prefix === '' ? entry.name : join(prefix, entry.name)
      if (entry.isDirectory()) {
        walk(full, rel)
        continue
      }
      if (!entry.isFile() || entry.name === JOURNAL_FILE) {
        continue
      }
      if (readFileSync(full, 'utf8').includes(needle)) {
        found.push(rel)
      }
    }
  }
  for (const root of roots) {
    walk(root, '')
  }
  return found.toSorted()
}

describe('the cache walk itself covers everything this process writes', () => {
  // Round-2 adversarial review, MINEUR 11. The walk promised "a cache written
  // to a file nobody thought of" while only ever looking under the repo's
  // `.codesema` — a cache dropped in CODESEMA_CONFIG_DIR would have sailed
  // through the assertion that is the whole proof of "the snapshot is the
  // only cache".
  test('a file planted in the config dir IS found', () => {
    const repo = makeRepo()
    writeFileSync(join(configDir, 'planted-issue-cache.json'), JSON.stringify(ISSUE_CRITERIA))
    expect(
      filesUnderContaining([join(repo, '.codesema'), configDir], ISSUE_CRITERIA[0]!),
    ).toContain('planted-issue-cache.json')
  })
})

/**
 * A forge that answers the ADMISSION read and then goes away — exactly the
 * "cut after the launch" the spec names. `after` is what every later call
 * gets, which is what decides the motif the task ends up carrying.
 */
function forgeThenCut(after: (call: ForgeCall) => ForgeCliOutcome) {
  let answered = false
  return forgeRig((call) => {
    if (call.args[1] === 'view' && !answered) {
      answered = true
      return { kind: 'ok', stdout: ghIssuePayload(conformingTicketBody()) }
    }
    return after(call)
  })
}

/** A review stub that lands the task on `status` without spawning a reviewer. */
function settleAt(status: 'review_ok' | 'waiting_for_you') {
  return (record: { status: string }, io: { persist: () => void }) => {
    record.status = status
    io.persist()
    return Promise.resolve()
  }
}

describe('a task bound BEFORE the cut carries on, on its snapshot alone', () => {
  test('it reaches review_ok, warns at the step concerned, and never rewrites the snapshot', async () => {
    const repo = withOrigin(makeRepo())
    const project = register(repo)
    const { execFn } = forgeThenCut(() => ({ kind: 'missing' }))
    const manager = createTaskManager({
      ...managerOpts,
      issueExecFn: execFn,
      runAgentFn: (options: AgentRunOptions) => {
        options.onText?.('working')
        return Promise.resolve('done')
      },
      reviewTurnFn: settleAt('review_ok'),
    })
    const created = await manager.create(project.id, { autoShip: false, issue: ISSUE_REF })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      throw new Error('unreachable')
    }
    const id = created.record.id
    const frozen = structuredClone(created.record.issue_snapshot)
    expect(frozen?.criteria.map((c) => c.text)).toEqual(ISSUE_CRITERIA)

    // Not blocked: the cycle completes on the frozen ticket.
    await until(() => loadTask(repo, id)?.status === 'review_ok')
    const after = loadTask(repo, id)
    if (!after) {
      throw new Error('unreachable')
    }

    // The snapshot is UNCHANGED — read, never written back.
    expect(after.issue_snapshot).toEqual(frozen as never)
    // …and the warning is there, in all three of invariant 2's places: the
    // record's readable reason, the journal, and (through the record and the
    // event, both broadcast) the API.
    expect(after.reason?.code).toBe('forge_unreachable')
    // The motif rides verbatim in the detail, and cannot be read as the other.
    const detail = after.reason?.detail ?? ''
    expect(detail.startsWith('no-cli')).toBe(true)
    expect(detail.startsWith('cli-error')).toBe(false)
    const warning = readTaskEvents(repo, id).find(
      (e) => e.type === 'issue' && e.data.name === 'unreachable',
    )
    expect(warning?.reason_code).toBe('forge_unreachable')
    // DP9: a fact about the ticket, never an 'error' line painting it red.
    expect(readTaskEvents(repo, id).some((e) => e.type === 'error')).toBe(false)

    // NO other cache of the issue was written. Not asserted on a list of
    // filenames (which a new file would silently join) but on the CONTENT:
    // the frozen criteria text must exist in exactly ONE persisted place,
    // the task record itself.
    // Both the repo's own state AND the workspace config dir this process
    // writes to: a cache written outside the repo is still a cache.
    expect(filesUnderContaining([join(repo, '.codesema'), configDir], ISSUE_CRITERIA[0]!)).toEqual([
      join('tasks', id, 'task.json'),
    ])
    await manager.shutdown()
  })

  test('a forge CLI that RAN and failed says cli-error, never no-cli', async () => {
    const repo = withOrigin(makeRepo())
    const project = register(repo)
    const { execFn } = forgeThenCut((call) =>
      call.cli === 'gh' ? { kind: 'error', message: 'HTTP 502: Bad gateway' } : { kind: 'missing' },
    )
    const manager = createTaskManager({
      ...managerOpts,
      issueExecFn: execFn,
      runAgentFn: () => Promise.resolve('done'),
      reviewTurnFn: settleAt('review_ok'),
    })
    const created = await manager.create(project.id, { autoShip: false, issue: ISSUE_REF })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      throw new Error('unreachable')
    }
    await until(() => loadTask(repo, created.record.id)?.status === 'review_ok')
    const detail = loadTask(repo, created.record.id)?.reason?.detail
    expect(detail?.startsWith('cli-error')).toBe(true)
    // The CLI's own words survive next to the motif (invariant 2).
    expect(detail).toContain('Bad gateway')
    await manager.shutdown()
  })
})

describe('D7 — the forge coming back restarts nothing by itself', () => {
  test('a boot that finds the forge again clears the stale reason and starts no turn', async () => {
    const repo = withOrigin(makeRepo())
    const project = register(repo)
    const down = forgeThenCut(() => ({ kind: 'missing' }))
    const first = createTaskManager({
      ...managerOpts,
      issueExecFn: down.execFn,
      runAgentFn: () => Promise.resolve('done'),
      reviewTurnFn: settleAt('waiting_for_you'),
    })
    const created = await first.create(project.id, { autoShip: false, issue: ISSUE_REF })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      throw new Error('unreachable')
    }
    const id = created.record.id
    await until(() => loadTask(repo, id)?.reason?.code === 'forge_unreachable')
    await first.shutdown()
    const turnsBefore = readTaskEvents(repo, id).filter((e) => e.type === 'turn_started').length

    // Second session: the forge answers again, and the ticket has not moved.
    const up = forgeRig(() => ({
      kind: 'ok',
      stdout: ghIssuePayload(conformingTicketBody()),
    }))
    const second = createTaskManager({ ...managerOpts, issueExecFn: up.execFn })
    await until(() => loadTask(repo, id)?.reason === undefined)
    // The stale claim is gone…
    expect(loadTask(repo, id)?.reason).toBeUndefined()
    // …and NOTHING restarted: same status, same number of turns.
    expect(loadTask(repo, id)?.status).toBe('waiting_for_you')
    expect(readTaskEvents(repo, id).filter((e) => e.type === 'turn_started')).toHaveLength(
      turnsBefore,
    )
    await second.shutdown()
  })
})

describe('a degraded ship names its motif ON THE RECORD, not only in its note', () => {
  test('the reason detail carries the motif verbatim AND keeps the readable note', async () => {
    const repo = makeRepo()
    const project = register(repo)
    const NOTE =
      'no forge CLI (gh or glab) available — branch pushed, open the merge request manually'
    const manager = createTaskManager({
      ...managerOpts,
      runAgentFn: () => Promise.resolve('done'),
      reviewTurnFn: settleAt('review_ok'),
      // The ship itself is stubbed: what is under test is the WIRE from the
      // outcome's motif to the record's reason, which is what a reader of the
      // card sees months later — the note alone would leave `no-cli` and
      // `cli-error` indistinguishable to anything but a human eye.
      shipTaskFn: () =>
        Promise.resolve({
          pushed: true,
          mrUrl: null,
          note: NOTE,
          reasonCode: 'forge_unreachable',
          detail: 'no-cli',
        } as const),
    })
    const created = await manager.create(project.id, {
      title: 'Ship without a forge CLI',
      prompt: 'go',
      autoShip: false,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      throw new Error('unreachable')
    }
    const id = created.record.id
    await until(() => loadTask(repo, id)?.status === 'review_ok')
    expect((await manager.ship(project.id, id)).ok).toBe(true)

    const reason = loadTask(repo, id)?.reason
    expect(reason?.code).toBe('forge_unreachable')
    const detail = reason?.detail ?? ''
    // The motif, verbatim and FIRST.
    expect(detail.startsWith('no-cli')).toBe(true)
    expect(detail.startsWith('cli-error')).toBe(false)
    // …and the message that was already produced is not replaced by it.
    expect(detail).toContain('open the merge request manually')
    await manager.shutdown()
  })
})
