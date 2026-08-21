import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { saveGlobalConfig, saveRepoConfig } from './config.js'
import { sanitizeTaskRecord, type TaskIssueRef, type TaskStatus } from './contract.js'
import type { ForgeCli, ForgeCliOutcome, ForgeIssuesExecFn } from './forge-issues.js'
import { subprocessEnv } from './git.js'
import {
  CYCLE_LABEL_BY_STATUS,
  CYCLE_LABEL_DESCRIPTION,
  CYCLE_LABELS,
  cycleLabelEvent,
  cycleLabelForStatus,
  cycleLabelPosesInFlight,
  cycleLabelsEnabled,
  isCodesemaLabel,
  recomposeCycleLabels,
  syncCycleLabel,
  type CycleLabel,
} from './task-labels.js'

const GITHUB_REMOTE = 'https://github.com/acme/repo.git'
const GITLAB_REMOTE = 'https://gitlab.com/acme/repo.git'
/** Neither forge is named by this remote, so BOTH candidates are probed — the
 * only shape in which the read and the write can land on different forges. */
const SELF_HOSTED_REMOTE = 'https://forge.example.com/acme/repo.git'

const ISSUE: TaskIssueRef = {
  forge: 'github',
  project: 'acme/repo',
  iid: 42,
  url: 'https://github.com/acme/repo/issues/42',
}

const GLAB_ISSUE: TaskIssueRef = {
  forge: 'gitlab',
  project: 'acme/repo',
  iid: 7,
  url: 'https://gitlab.com/acme/repo/-/issues/7',
}

type Call = { cli: ForgeCli; args: string[]; cwd: string }

/** The only way a forge binary is ever "run" here: the argv IS the assertion. */
function rig(reply: (call: Call) => ForgeCliOutcome) {
  const calls: Call[] = []
  const execFn: ForgeIssuesExecFn = (cli, args, cwd) => {
    const call = { cli, args, cwd }
    calls.push(call)
    return Promise.resolve(reply(call))
  }
  return { calls, execFn }
}

const ghIssueJson = (labels: string[]) =>
  JSON.stringify({
    number: 42,
    title: 'Add sidebar',
    body: 'It needs a sidebar.',
    state: 'OPEN',
    labels: labels.map((name) => ({ name })),
    author: { login: 'octocat' },
    createdAt: '2026-07-20T09:00:00Z',
    updatedAt: '2026-07-28T10:00:00Z',
    url: 'https://github.com/acme/repo/issues/42',
  })

const glabIssueJson = (labels: string[]) =>
  JSON.stringify({
    iid: 7,
    title: 'Fix login',
    description: 'Login is broken.',
    state: 'opened',
    labels,
    author: { username: 'jdoe' },
    created_at: '2026-07-20T09:30:00.123Z',
    updated_at: '2026-07-28T09:30:00.123Z',
    web_url: 'https://gitlab.com/acme/repo/-/issues/7',
  })

const labelCatalog = (names: string[]) => JSON.stringify(names.map((name) => ({ name })))

/**
 * One rig answering a whole pose: the issue's current labels, the repo's label
 * catalog, and an empty OK for every write. Anything else is a failure of the
 * test, not of the code, so it comes back as an error the assertions will see.
 */
function forgeWith(opts: { labels: string[]; catalog: string[]; glab?: boolean }) {
  return rig((call) => {
    const [first, second] = call.args
    if (first === 'issue' && second === 'view') {
      return {
        kind: 'ok',
        stdout: opts.glab ? glabIssueJson(opts.labels) : ghIssueJson(opts.labels),
      }
    }
    if (first === 'label' && second === 'list') {
      return { kind: 'ok', stdout: labelCatalog(opts.catalog) }
    }
    if ((first === 'label' && second === 'create') || first === 'api') {
      return { kind: 'ok', stdout: '' }
    }
    return { kind: 'error', message: `unexpected argv: ${call.args.join(' ')}` }
  })
}

/**
 * Same rig, except that the `issue view` of each pose is held OPEN until it is
 * released by hand. That is the only way to observe what happens WHILE two
 * poses are in flight — whether they overlap, and how many entries the
 * in-flight map is holding — which is precisely what the serialisation and the
 * purge are about and what no assertion on a finished outcome can see.
 */
function gatedRig(reply: (call: Call) => ForgeCliOutcome) {
  const calls: Call[] = []
  const reads: (() => void)[] = []
  const execFn: ForgeIssuesExecFn = (cli, args, cwd) => {
    const call = { cli, args, cwd }
    calls.push(call)
    if (args[0] === 'issue' && args[1] === 'view') {
      return new Promise<ForgeCliOutcome>((resolve) => {
        reads.push(() => {
          resolve(reply(call))
        })
      })
    }
    return Promise.resolve(reply(call))
  }
  const releaseReads = () => {
    for (const release of reads.splice(0)) {
      release()
    }
  }
  return { calls, execFn, releaseReads }
}

function makeRepo(remote: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codesema-cycle-labels-'))
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: subprocessEnv() })
  git(['init', '-b', 'main'])
  git(['remote', 'add', 'origin', remote])
  return dir
}

describe('cycle labels (T3.7)', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string
  const repos: string[] = []

  /** A fresh project, opted in or not, with a real git remote the ladder reads. */
  const project = (opts: { enabled?: boolean | undefined; remote?: string } = {}): string => {
    const dir = makeRepo(opts.remote ?? GITHUB_REMOTE)
    repos.push(dir)
    if (opts.enabled !== undefined) {
      saveRepoConfig(dir, { forgeCycleLabels: opts.enabled })
    }
    return dir
  }

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-cycle-cfg-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
    for (const dir of repos.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // --- I. The opt-in, and the total short circuit behind it -------------------

  describe('opt-in by project, disabled by default', () => {
    test('a whole cycle without opt-in never even BUILDS a forge call', async () => {
      const cwd = project()
      const r = rig(() => ({ kind: 'error', message: 'the exec must never be reached' }))
      const targets: CycleLabel[] = [
        ...(Object.keys(CYCLE_LABEL_BY_STATUS) as TaskStatus[]).map(cycleLabelForStatus),
        'codesema:merged',
      ]
      for (const label of targets) {
        expect(await syncCycleLabel({ cwd, issue: ISSUE, label, execFn: r.execFn })).toEqual({
          kind: 'disabled',
        })
      }
      // Not "ignored": never asked. Zero calls, across the admission-to-merge run.
      expect(r.calls).toEqual([])
    })

    test('a repo opt-in reaches its OWN project and not its neighbour', async () => {
      const a = project({ enabled: true })
      const b = project()
      const ra = forgeWith({ labels: ['bug'], catalog: ['bug', 'codesema:in-progress'] })
      const rb = rig(() => ({ kind: 'error', message: 'B never asks anything' }))
      const posed = await syncCycleLabel({
        cwd: a,
        issue: ISSUE,
        label: 'codesema:in-progress',
        execFn: ra.execFn,
      })
      expect(posed).toMatchObject({ kind: 'posed', label: 'codesema:in-progress' })
      expect(
        await syncCycleLabel({
          cwd: b,
          issue: ISSUE,
          label: 'codesema:in-progress',
          execFn: rb.execFn,
        }),
      ).toEqual({ kind: 'disabled' })
      expect(rb.calls).toEqual([])
    })

    test('the global file can switch it on, and a repo file can switch it back off', () => {
      const off = project({ enabled: false })
      const silent = project()
      saveGlobalConfig({ forgeCycleLabels: true })
      // The repo's `false` is a project saying no, and it outranks the global yes.
      expect(cycleLabelsEnabled(off)).toBe(false)
      expect(cycleLabelsEnabled(silent)).toBe(true)
      expect(cycleLabelsEnabled(null)).toBe(true)
    })

    test('nothing declared anywhere resolves to disabled', () => {
      expect(cycleLabelsEnabled(project())).toBe(false)
      expect(cycleLabelsEnabled(null)).toBe(false)
    })

    test('an opted-in task with no issue attempts nothing at all', async () => {
      const cwd = project({ enabled: true })
      const r = rig(() => ({ kind: 'error', message: 'nothing to pose on' }))
      for (const issue of [null, undefined]) {
        expect(
          await syncCycleLabel({ cwd, issue, label: 'codesema:queued', execFn: r.execFn }),
        ).toEqual({ kind: 'no_issue' })
      }
      expect(r.calls).toEqual([])
    })
  })

  // --- II. The table ----------------------------------------------------------

  describe('status → label', () => {
    test('every status of the contract maps to exactly one of the five labels', () => {
      const statuses = Object.keys(CYCLE_LABEL_BY_STATUS) as TaskStatus[]
      // The contract declares nine; `Record<TaskStatus, CycleLabel>` is what
      // forbids a gap (a tenth status would not compile), and this pins that
      // no key here is a status the contract does not know: a typo'd key would
      // be coerced away by the record sanitizer.
      expect(statuses).toHaveLength(9)
      for (const status of statuses) {
        const record = sanitizeTaskRecord({ id: '0123456789ab', status })
        expect({ status, kept: record?.status }).toEqual({ status, kept: status })
        expect(CYCLE_LABELS).toContain(cycleLabelForStatus(status))
      }
    })

    test('no status means "merged": that label is posed by the merge, never derived', () => {
      const posed = new Set(Object.values(CYCLE_LABEL_BY_STATUS))
      expect(posed.has('codesema:merged')).toBe(false)
      // The other four are all reachable from a status — a table that mapped
      // everything onto one label would satisfy the check above and not this one.
      expect([...posed].toSorted()).toEqual([
        'codesema:blocked',
        'codesema:in-progress',
        'codesema:queued',
        'codesema:reviewing',
      ])
    })

    test('the four ways a task needs a person share one label, and work does not', () => {
      for (const status of ['waiting_for_you', 'review_ko', 'failed', 'interrupted'] as const) {
        expect(cycleLabelForStatus(status)).toBe('codesema:blocked')
      }
      expect(cycleLabelForStatus('queued')).toBe('codesema:queued')
      expect(cycleLabelForStatus('running')).toBe('codesema:in-progress')
      // Shipped is NOT merged: the MR is open and waiting for a human.
      expect(cycleLabelForStatus('shipped')).toBe('codesema:reviewing')
      expect(cycleLabelForStatus('review_ok')).toBe('codesema:reviewing')
    })
  })

  // --- III. Recomposition: the destruction this ticket exists to avoid --------

  describe('recomposition', () => {
    test('the prefix decides ownership, and only the prefix', () => {
      expect(isCodesemaLabel('codesema:queued')).toBe(true)
      expect(isCodesemaLabel('codesema:something-else')).toBe(true)
      // No colon: not a cycle label, whatever it looks like.
      expect(isCodesemaLabel('codesema-legacy')).toBe(false)
      expect(isCodesemaLabel('priority::high')).toBe(false)
    })

    test('a different CASING of the prefix is still ours, and still only the prefix', () => {
      for (const name of ['Codesema:queued', 'CODESEMA:in-progress', 'CodeSema:blocked']) {
        expect({ name, ours: isCodesemaLabel(name) }).toEqual({ name, ours: true })
      }
      // Recognising it is what stops it from surviving the recomposition and
      // sitting next to the label just posed — an issue showing two
      // cycle-looking labels at once, which is the state this repairs.
      expect(recomposeCycleLabels(['bug', 'Codesema:queued'], 'codesema:in-progress')).toEqual([
        'bug',
        'codesema:in-progress',
      ])
      // The boundary has not moved: it is still the prefix, colon included.
      for (const name of ['Codesema-legacy', 'CODESEMA', 'codesemax:queued', 'my-codesema:x']) {
        expect({ name, ours: isCodesemaLabel(name) }).toEqual({ name, ours: false })
      }
      expect(recomposeCycleLabels(['Codesema-legacy'], 'codesema:queued')).toEqual([
        'Codesema-legacy',
        'codesema:queued',
      ])
    })

    test('foreign labels are re-emitted verbatim, in order, and only ours change', () => {
      expect(
        recomposeCycleLabels(
          ['bug', 'codesema:queued', 'priority::high', 'codesema-legacy'],
          'codesema:in-progress',
        ),
      ).toEqual(['bug', 'priority::high', 'codesema-legacy', 'codesema:in-progress'])
    })

    test('every other codesema label goes, however many there were', () => {
      expect(
        recomposeCycleLabels(
          ['codesema:queued', 'codesema:reviewing', 'codesema:blocked'],
          'codesema:in-progress',
        ),
      ).toEqual(['codesema:in-progress'])
    })

    test('an issue already on exactly the target needs no write', () => {
      expect(recomposeCycleLabels(['bug', 'codesema:reviewing'], 'codesema:reviewing')).toBeNull()
      // Carrying the target is not enough: a second cycle label is the very
      // state this repairs.
      expect(
        recomposeCycleLabels(['codesema:reviewing', 'codesema:queued'], 'codesema:reviewing'),
      ).toEqual(['codesema:reviewing'])
    })
  })

  // --- IV. The pose, on both forges ------------------------------------------

  describe('posing', () => {
    test('queued → in-progress keeps every business label and swaps only ours', async () => {
      const cwd = project({ enabled: true })
      const r = forgeWith({
        labels: ['bug', 'priority::high', 'codesema:queued'],
        catalog: ['bug', 'codesema:queued', 'codesema:in-progress'],
      })
      const outcome = await syncCycleLabel({
        cwd,
        issue: ISSUE,
        label: 'codesema:in-progress',
        execFn: r.execFn,
      })
      expect(outcome).toEqual({
        kind: 'posed',
        label: 'codesema:in-progress',
        labels: ['bug', 'priority::high', 'codesema:in-progress'],
        created: false,
      })
      expect(r.calls.map((c) => c.args[0])).toEqual(['issue', 'label', 'api'])
      expect(r.calls[0]?.args).toEqual([
        'issue',
        'view',
        '42',
        '--json',
        'number,title,body,state,labels,author,createdAt,updatedAt,url',
      ])
      expect(r.calls[2]?.args).toEqual([
        'api',
        'repos/{owner}/{repo}/issues/42/labels',
        '--method',
        'PUT',
        '--raw-field=labels[]=bug',
        '--raw-field=labels[]=priority::high',
        '--raw-field=labels[]=codesema:in-progress',
      ])
      // Every argument is attached: a label can never be promoted to a flag.
      for (const call of r.calls) {
        expect(call.cli).toBe('gh')
        expect(call.args.some((arg) => arg === 'bug' || arg === 'priority::high')).toBe(false)
      }
    })

    test('an issue carrying a REAL number of labels keeps every one of them', async () => {
      const cwd = project({ enabled: true })
      // Seven foreign labels, which is an ordinary issue on any busy
      // repository — and one more than every other pose in this file had. A
      // recomposition that only started dropping names past the third would
      // have been invisible everywhere else.
      const foreign = [
        'bug',
        'priority::high',
        'area/api',
        'needs-design',
        'good first issue',
        'P1',
        'codesema-legacy',
      ]
      const r = forgeWith({
        labels: [...foreign.slice(0, 3), 'codesema:queued', ...foreign.slice(3)],
        catalog: ['codesema:reviewing'],
      })
      const outcome = await syncCycleLabel({
        cwd,
        issue: ISSUE,
        label: 'codesema:reviewing',
        execFn: r.execFn,
      })
      expect(outcome).toEqual({
        kind: 'posed',
        label: 'codesema:reviewing',
        labels: [...foreign, 'codesema:reviewing'],
        created: false,
      })
      // And the argv carries all eight, in that order: the outcome and the
      // write must not be able to disagree.
      expect(r.calls.at(-1)?.args).toEqual([
        'api',
        'repos/{owner}/{repo}/issues/42/labels',
        '--method',
        'PUT',
        ...[...foreign, 'codesema:reviewing'].map((name) => `--raw-field=labels[]=${name}`),
      ])
    })

    test('a codesema-legacy label survives a transition untouched', async () => {
      const cwd = project({ enabled: true })
      const r = forgeWith({
        labels: ['codesema-legacy', 'codesema:queued'],
        catalog: ['codesema:reviewing'],
      })
      await syncCycleLabel({ cwd, issue: ISSUE, label: 'codesema:reviewing', execFn: r.execFn })
      const write = r.calls.at(-1)?.args ?? []
      expect(write).toContain('--raw-field=labels[]=codesema-legacy')
      expect(write).toContain('--raw-field=labels[]=codesema:reviewing')
      expect(write.join(' ')).not.toContain('codesema:queued')
    })

    test('the whole cycle: one label at a time, ending on merged', async () => {
      const cwd = project({ enabled: true })
      let onIssue = ['bug']
      const r = rig((call) => {
        const [first, second] = call.args
        if (first === 'issue' && second === 'view') {
          return { kind: 'ok', stdout: ghIssueJson(onIssue) }
        }
        if (first === 'label' && second === 'list') {
          return { kind: 'ok', stdout: labelCatalog([...CYCLE_LABELS]) }
        }
        onIssue = call.args
          .filter((arg) => arg.startsWith('--raw-field=labels[]='))
          .map((arg) => arg.slice('--raw-field=labels[]='.length))
        return { kind: 'ok', stdout: '' }
      })
      const walk: CycleLabel[] = [
        cycleLabelForStatus('queued'),
        cycleLabelForStatus('running'),
        cycleLabelForStatus('reviewing'),
        'codesema:merged',
      ]
      const seen: string[][] = []
      for (const label of walk) {
        await syncCycleLabel({ cwd, issue: ISSUE, label, execFn: r.execFn })
        seen.push([...onIssue])
        expect(onIssue.filter(isCodesemaLabel)).toEqual([label])
        expect(onIssue).toContain('bug')
      }
      expect(seen.at(-1)).toEqual(['bug', 'codesema:merged'])
    })

    test('GitLab takes the same set through its own one-string idiom', async () => {
      const cwd = project({ enabled: true, remote: GITLAB_REMOTE })
      const r = forgeWith({
        labels: ['bug', 'codesema:queued'],
        catalog: ['bug', 'codesema:reviewing'],
        glab: true,
      })
      await syncCycleLabel({
        cwd,
        issue: GLAB_ISSUE,
        label: 'codesema:reviewing',
        execFn: r.execFn,
      })
      expect(r.calls.map((c) => c.cli)).toEqual(['glab', 'glab', 'glab'])
      expect(r.calls[2]?.args).toEqual([
        'api',
        'projects/:fullpath/issues/7',
        '--method',
        'PUT',
        '--raw-field=labels=bug,codesema:reviewing',
      ])
    })
  })

  // --- V. The two idempotences ------------------------------------------------

  describe('idempotence', () => {
    test('a label already on the issue is not re-posed: the read is the only call', async () => {
      const cwd = project({ enabled: true })
      const r = forgeWith({
        labels: ['bug', 'codesema:reviewing'],
        catalog: ['codesema:reviewing'],
      })
      expect(
        await syncCycleLabel({ cwd, issue: ISSUE, label: 'codesema:reviewing', execFn: r.execFn }),
      ).toEqual({ kind: 'unchanged', label: 'codesema:reviewing' })
      expect(r.calls.map((c) => c.args[0])).toEqual(['issue'])
    })

    test('two transitions onto the same label write once in total', async () => {
      const cwd = project({ enabled: true })
      let onIssue = ['codesema:queued']
      const r = rig((call) => {
        const [first, second] = call.args
        if (first === 'issue' && second === 'view') {
          return { kind: 'ok', stdout: ghIssueJson(onIssue) }
        }
        if (first === 'label' && second === 'list') {
          return { kind: 'ok', stdout: labelCatalog(['codesema:reviewing']) }
        }
        onIssue = ['codesema:reviewing']
        return { kind: 'ok', stdout: '' }
      })
      // review_ok and reviewing share a label: the second transition finds the
      // issue already where it wants it.
      await syncCycleLabel({
        cwd,
        issue: ISSUE,
        label: cycleLabelForStatus('reviewing'),
        execFn: r.execFn,
      })
      await syncCycleLabel({
        cwd,
        issue: ISSUE,
        label: cycleLabelForStatus('review_ok'),
        execFn: r.execFn,
      })
      expect(r.calls.filter((c) => c.args[0] === 'api')).toHaveLength(1)
    })

    test('a missing label is created once, then posed', async () => {
      const cwd = project({ enabled: true })
      const r = forgeWith({ labels: ['bug'], catalog: ['bug'] })
      const outcome = await syncCycleLabel({
        cwd,
        issue: ISSUE,
        label: 'codesema:in-progress',
        execFn: r.execFn,
      })
      expect(outcome).toMatchObject({ kind: 'posed', created: true })
      expect(r.calls.map((c) => c.args.slice(0, 2))).toEqual([
        ['issue', 'view'],
        ['label', 'list'],
        ['label', 'create'],
        ['api', 'repos/{owner}/{repo}/issues/42/labels'],
      ])
      expect(r.calls[1]?.args).toEqual(['label', 'list', '--limit', '201', '--json', 'name'])
      expect(r.calls[2]?.args).toEqual([
        'label',
        'create',
        'codesema:in-progress',
        '--color=5B4B8A',
        `--description=${CYCLE_LABEL_DESCRIPTION}`,
      ])
    })

    test('a label the catalog already carries is never created a second time', async () => {
      const cwd = project({ enabled: true })
      const r = forgeWith({ labels: ['bug'], catalog: ['bug', 'codesema:in-progress'] })
      expect(
        await syncCycleLabel({
          cwd,
          issue: ISSUE,
          label: 'codesema:in-progress',
          execFn: r.execFn,
        }),
      ).toMatchObject({ kind: 'posed', created: false })
      expect(r.calls.some((c) => c.args[1] === 'create')).toBe(false)
    })

    test('a catalog capped by its own limit never provokes a creation on a guess', async () => {
      const cwd = project({ enabled: true })
      const many = Array.from({ length: 201 }, (_, i) => `label-${String(i)}`)
      const r = forgeWith({ labels: ['bug'], catalog: many })
      const outcome = await syncCycleLabel({
        cwd,
        issue: ISSUE,
        label: 'codesema:in-progress',
        execFn: r.execFn,
      })
      // The name is absent from what came back, and that proves nothing past
      // the cap — so the pose goes ahead without inventing a creation.
      expect(outcome).toMatchObject({ kind: 'posed', created: false })
      expect(r.calls.some((c) => c.args[1] === 'create')).toBe(false)
      expect(r.calls.some((c) => c.args[0] === 'api')).toBe(true)
    })

    test('two poses fired at once on the same issue never interleave', async () => {
      const cwd = project({ enabled: true })
      const order: string[] = []
      let onIssue = ['codesema:queued']
      const r = rig((call) => {
        const [first, second] = call.args
        if (first === 'issue' && second === 'view') {
          order.push(`read:${onIssue.filter(isCodesemaLabel).join(',')}`)
          return { kind: 'ok', stdout: ghIssueJson(onIssue) }
        }
        if (first === 'label' && second === 'list') {
          return { kind: 'ok', stdout: labelCatalog([...CYCLE_LABELS]) }
        }
        onIssue = call.args
          .filter((arg) => arg.startsWith('--raw-field=labels[]='))
          .map((arg) => arg.slice('--raw-field=labels[]='.length))
        order.push(`write:${onIssue.join(',')}`)
        return { kind: 'ok', stdout: '' }
      })
      await Promise.all([
        syncCycleLabel({ cwd, issue: ISSUE, label: 'codesema:in-progress', execFn: r.execFn }),
        syncCycleLabel({ cwd, issue: ISSUE, label: 'codesema:reviewing', execFn: r.execFn }),
      ])
      // Each pose reads the state the previous one left, so the last write is
      // the last transition — never a race that ends on the earlier label.
      expect(order).toEqual([
        'read:codesema:queued',
        'write:codesema:in-progress',
        'read:codesema:in-progress',
        'write:codesema:reviewing',
      ])
      expect(onIssue).toEqual(['codesema:reviewing'])
    })
  })

  // --- VI. Failing is never blocking -----------------------------------------

  describe('degradation', () => {
    test('a forge that cannot be read writes NOTHING and says forge_unreachable', async () => {
      const cwd = project({ enabled: true })
      const r = rig(() => ({ kind: 'error', message: 'HTTP 401: Bad credentials' }))
      const outcome = await syncCycleLabel({
        cwd,
        issue: ISSUE,
        label: 'codesema:in-progress',
        execFn: r.execFn,
      })
      expect(outcome).toMatchObject({
        kind: 'failed',
        at: 'read',
        reason: { code: 'forge_unreachable' },
      })
      // The set could not be read, so re-emitting it is impossible: a write
      // here would have erased every label the issue carries.
      expect(r.calls.every((c) => c.args[0] === 'issue')).toBe(true)
      const event = cycleLabelEvent(outcome)
      expect(event?.type).toBe('issue')
      expect(event?.data.name).toBe('label_not_posed')
      expect(event?.reason_code).toBe('forge_unreachable')
      expect(String(event?.data.message)).toContain('Bad credentials')
    })

    test('no gh and no glab at all (ENOENT) propagates no exception', async () => {
      const cwd = project({ enabled: true, remote: 'https://forge.example.com/acme/repo.git' })
      const r = rig(() => ({ kind: 'missing' }))
      const outcome = await syncCycleLabel({
        cwd,
        issue: ISSUE,
        label: 'codesema:queued',
        execFn: r.execFn,
      })
      expect(outcome).toMatchObject({
        kind: 'failed',
        at: 'read',
        reason: { code: 'forge_unreachable', detail: 'no-cli' },
      })
      expect(r.calls.map((c) => c.cli)).toEqual(['gh', 'glab'])
    })

    test('a creation that fails stops before the pose and stays non-blocking', async () => {
      const cwd = project({ enabled: true })
      const r = rig((call) => {
        const [first, second] = call.args
        if (first === 'issue' && second === 'view') {
          return { kind: 'ok', stdout: ghIssueJson(['bug']) }
        }
        if (first === 'label' && second === 'list') {
          return { kind: 'ok', stdout: labelCatalog(['bug']) }
        }
        return { kind: 'error', message: 'label creation refused' }
      })
      const outcome = await syncCycleLabel({
        cwd,
        issue: ISSUE,
        label: 'codesema:blocked',
        execFn: r.execFn,
      })
      expect(outcome).toMatchObject({ kind: 'failed', at: 'create' })
      expect(r.calls.some((c) => c.args[0] === 'api')).toBe(false)
    })

    test('a write that fails names the write, and the event carries the code', async () => {
      const cwd = project({ enabled: true })
      const r = rig((call) => {
        const [first, second] = call.args
        if (first === 'issue' && second === 'view') {
          return { kind: 'ok', stdout: ghIssueJson(['bug']) }
        }
        if (first === 'label' && second === 'list') {
          return { kind: 'ok', stdout: labelCatalog(['codesema:queued']) }
        }
        return { kind: 'error', message: 'HTTP 502' }
      })
      const outcome = await syncCycleLabel({
        cwd,
        issue: ISSUE,
        label: 'codesema:queued',
        execFn: r.execFn,
      })
      expect(outcome).toMatchObject({
        kind: 'failed',
        at: 'write',
        label: 'codesema:queued',
        reason: { code: 'forge_unreachable' },
      })
      expect(cycleLabelEvent(outcome)?.data.step).toBe('write')
    })

    test('a refusal decided locally is NOT reported as a forge outage', async () => {
      const cwd = project({ enabled: true })
      // A business label carrying a comma: GitLab's REST contract takes the
      // whole set as ONE comma-separated string, so `setLabels` refuses before
      // launching anything. Nothing was asked of a forge, so nothing may claim
      // one was unreachable — but the failure is still stated, with its words.
      const r = forgeWith({ labels: ['needs, triage'], catalog: ['codesema:queued'] })
      const outcome = await syncCycleLabel({
        cwd,
        issue: ISSUE,
        label: 'codesema:queued',
        execFn: r.execFn,
      })
      expect(outcome).toMatchObject({ kind: 'failed', at: 'write', reason: null })
      const event = cycleLabelEvent(outcome)
      expect(event?.reason_code).toBeUndefined()
      expect(String(event?.data.message)).toContain('comma-separated')
    })

    test('nothing but a failure is worth a journal line', async () => {
      const cwd = project({ enabled: true })
      const r = forgeWith({ labels: ['codesema:queued'], catalog: [...CYCLE_LABELS] })
      for (const outcome of [
        await syncCycleLabel({ cwd, issue: ISSUE, label: 'codesema:queued', execFn: r.execFn }),
        await syncCycleLabel({ cwd, issue: null, label: 'codesema:queued', execFn: r.execFn }),
        await syncCycleLabel({ cwd: project(), issue: ISSUE, label: 'codesema:queued' }),
      ]) {
        expect(cycleLabelEvent(outcome)).toBeNull()
      }
    })

    test('a catalog that cannot be READ stops before the total replacement', async () => {
      const cwd = project({ enabled: true })
      const r = rig((call) => {
        const [first, second] = call.args
        if (first === 'issue' && second === 'view') {
          return { kind: 'ok', stdout: ghIssueJson(['bug']) }
        }
        if (first === 'label' && second === 'list') {
          return { kind: 'error', message: 'HTTP 401: Bad credentials' }
        }
        return { kind: 'ok', stdout: '' }
      })
      const outcome = await syncCycleLabel({
        cwd,
        issue: ISSUE,
        label: 'codesema:in-progress',
        execFn: r.execFn,
      })
      // The OTHER way round from a truncated catalog, and deliberately: a
      // catalog that answers nothing usually means the forge is not answering,
      // and the call that would come next REPLACES the issue's whole label
      // set. Carrying on here would be the one blind write this module forbids.
      expect(outcome).toMatchObject({
        kind: 'failed',
        at: 'create',
        reason: { code: 'forge_unreachable' },
      })
      expect(r.calls.some((c) => c.args[1] === 'create')).toBe(false)
      expect(r.calls.some((c) => c.args[0] === 'api')).toBe(false)
    })
  })

  // --- VII. The catalog can be WRONG, not merely short (MAJEUR 3) -------------

  describe('a creation refused because the label is already there', () => {
    /** A pose whose catalog claims the label is missing while the forge knows better. */
    const withStaleCatalog = (createFails: string) =>
      rig((call) => {
        const [first, second] = call.args
        if (first === 'issue' && second === 'view') {
          return { kind: 'ok', stdout: ghIssueJson(['bug']) }
        }
        if (first === 'label' && second === 'list') {
          return { kind: 'ok', stdout: labelCatalog(['bug']) }
        }
        if (first === 'label' && second === 'create') {
          return { kind: 'error', message: createFails }
        }
        return { kind: 'ok', stdout: '' }
      })

    test('falls back on the POSE, in each forge own words', async () => {
      for (const said of [
        // GitHub REST, through `gh label create`.
        'HTTP 422: Validation Failed (already_exists)',
        // gh porcelain refusing on its own.
        'label "codesema:in-progress" already exists; use `--force` to update its color and description',
        // GitLab REST, through `glab label create`.
        'HTTP 409: Label already exists',
        'title has already been taken',
      ]) {
        const cwd = project({ enabled: true })
        const r = withStaleCatalog(said)
        const outcome = await syncCycleLabel({
          cwd,
          issue: ISSUE,
          label: 'codesema:in-progress',
          execFn: r.execFn,
        })
        // The spec sentence, honoured to the letter: no second creation, NO
        // error raised, and the label simply posed. A catalog can be wrong
        // three ways — a race, a casing collision, a payload that only looked
        // empty — and none of them is a reason to leave the issue unlabelled.
        expect({ said, outcome }).toEqual({
          said,
          outcome: {
            kind: 'posed',
            label: 'codesema:in-progress',
            labels: ['bug', 'codesema:in-progress'],
            created: false,
          },
        })
        expect({ said, wrote: r.calls.some((c) => c.args[0] === 'api') }).toEqual({
          said,
          wrote: true,
        })
        expect({ said, creations: r.calls.filter((c) => c.args[1] === 'create').length }).toEqual({
          said,
          creations: 1,
        })
      }
    })

    test('and a repeat transition never re-fails: the failure is not permanent', async () => {
      const cwd = project({ enabled: true })
      const r = withStaleCatalog('HTTP 422: Validation Failed (already_exists)')
      for (const label of ['codesema:in-progress', 'codesema:reviewing'] as const) {
        expect(await syncCycleLabel({ cwd, issue: ISSUE, label, execFn: r.execFn })).toMatchObject({
          kind: 'posed',
          label,
        })
      }
    })

    test('any OTHER refusal is still a failure, and still stops the pose', async () => {
      const cwd = project({ enabled: true })
      // The fallback widens on the forge's own words and on nothing else: a
      // permission refusal, a rate limit, an outage — none of them says the
      // label is there, so none of them may be read as if it did.
      for (const said of [
        'HTTP 403: Resource not accessible by integration',
        'HTTP 502',
        'label creation refused',
      ]) {
        const r = withStaleCatalog(said)
        const outcome = await syncCycleLabel({
          cwd,
          issue: ISSUE,
          label: 'codesema:in-progress',
          execFn: r.execFn,
        })
        expect({ said, outcome }).toMatchObject({ said, outcome: { kind: 'failed', at: 'create' } })
        expect({ said, wrote: r.calls.some((c) => c.args[0] === 'api') }).toEqual({
          said,
          wrote: false,
        })
      }
    })
  })

  // --- VIII. Read here, write HERE: one forge for the whole triple ------------

  describe('the triple never splits across two forges (MAJEUR 2)', () => {
    /** gh unreachable, glab answering everything: the reproduction's shape. */
    const glabAnswers = (catalog: string[]) =>
      rig((call) => {
        if (call.cli === 'gh') {
          return { kind: 'error', message: 'HTTP 502' }
        }
        const [first, second] = call.args
        if (first === 'issue' && second === 'view') {
          return { kind: 'ok', stdout: glabIssueJson(['gitlab-only-label']) }
        }
        if (first === 'label' && second === 'list') {
          return { kind: 'ok', stdout: labelCatalog(catalog) }
        }
        return { kind: 'ok', stdout: '' }
      })

    test('a set read on GitLab is never PUT onto GitHub', async () => {
      const cwd = project({ enabled: true, remote: SELF_HOSTED_REMOTE })
      const r = glabAnswers(['codesema:in-progress'])
      const outcome = await syncCycleLabel({
        cwd,
        issue: GLAB_ISSUE,
        label: 'codesema:in-progress',
        execFn: r.execFn,
      })
      expect(outcome).toEqual({
        kind: 'posed',
        label: 'codesema:in-progress',
        labels: ['gitlab-only-label', 'codesema:in-progress'],
        created: false,
      })
      // gh is asked exactly once — the read it failed — and never again. An
      // unpinned write would take `gitlab-only-label` and PUT it, whole, onto
      // GitHub's copy of issue 7, erasing every label that one carried:
      // `setLabels` REPLACES, so the degraded mode of this class is not a
      // missing label, it is somebody else's labels gone.
      expect(r.calls.map((c) => c.cli)).toEqual(['gh', 'glab', 'glab', 'glab'])
      expect(r.calls.at(-1)?.args).toEqual([
        'api',
        'projects/:fullpath/issues/7',
        '--method',
        'PUT',
        '--raw-field=labels=gitlab-only-label,codesema:in-progress',
      ])
    })

    test('the catalog and the creation are pinned by that same read', async () => {
      const cwd = project({ enabled: true, remote: SELF_HOSTED_REMOTE })
      // An empty catalog, so the creation really happens. Asking GitHub what
      // labels the repository holds, or creating the label there, would answer
      // and serve a forge this pose is not writing to.
      const r = glabAnswers([])
      expect(
        await syncCycleLabel({
          cwd,
          issue: GLAB_ISSUE,
          label: 'codesema:in-progress',
          execFn: r.execFn,
        }),
      ).toMatchObject({ kind: 'posed', created: true })
      expect(r.calls.map((c) => c.cli)).toEqual(['gh', 'glab', 'glab', 'glab', 'glab'])
      expect(r.calls.map((c) => c.args.slice(0, 2))).toEqual([
        ['issue', 'view'],
        ['issue', 'view'],
        ['label', 'list'],
        ['label', 'create'],
        ['api', 'projects/:fullpath/issues/7'],
      ])
    })
  })

  // --- IX. What only the machinery can be asked -------------------------------

  describe('serialisation, in flight and after', () => {
    const catalogued = (call: Call): ForgeCliOutcome => {
      const [first, second] = call.args
      if (first === 'issue' && second === 'view') {
        return { kind: 'ok', stdout: ghIssueJson(['bug']) }
      }
      if (first === 'label' && second === 'list') {
        return { kind: 'ok', stdout: labelCatalog([...CYCLE_LABELS]) }
      }
      return { kind: 'ok', stdout: '' }
    }

    test('two different issues never wait on each other', async () => {
      const cwd = project({ enabled: true })
      const r = gatedRig(catalogued)
      // Same project, two tasks. The key is per ISSUE, so both reads must be
      // out on the wire at once; keyed on the project alone, the second pose
      // would still be queued behind the first and nothing would have been
      // asked for issue 7 yet.
      const both = Promise.all([
        syncCycleLabel({ cwd, issue: ISSUE, label: 'codesema:in-progress', execFn: r.execFn }),
        syncCycleLabel({ cwd, issue: GLAB_ISSUE, label: 'codesema:reviewing', execFn: r.execFn }),
      ])
      expect(r.calls.map((c) => c.args[2])).toEqual(['42', '7'])
      expect(cycleLabelPosesInFlight()).toBe(2)
      r.releaseReads()
      expect(await both).toMatchObject([{ kind: 'posed' }, { kind: 'posed' }])
    })

    test('nothing accumulates: every settled pose takes its entry with it', async () => {
      const cwd = project({ enabled: true })
      const r = rig(catalogued)
      expect(cycleLabelPosesInFlight()).toBe(0)
      const poses = [ISSUE, GLAB_ISSUE].map((issue) =>
        syncCycleLabel({ cwd, issue, label: 'codesema:queued', execFn: r.execFn }),
      )
      // Entered, then LEFT. Without the release the map would be a leak that
      // grows by one entry per transition for the life of the workspace, and
      // every other assertion in this file would still be green.
      expect(cycleLabelPosesInFlight()).toBe(2)
      await Promise.all(poses)
      expect(cycleLabelPosesInFlight()).toBe(0)
    })

    test('a pose whose seam THREW takes no later transition down with it', async () => {
      const cwd = project({ enabled: true })
      let asked = 0
      const calls: string[] = []
      const execFn: ForgeIssuesExecFn = (cli, args, cwd2) => {
        asked += 1
        calls.push(args.slice(0, 2).join(' '))
        // Not a typed outcome: a REJECTION, which the seam contract says
        // cannot happen and an injected `execFn` can always do anyway.
        return asked === 1
          ? Promise.reject(new Error('the seam itself broke'))
          : Promise.resolve(catalogued({ cli, args, cwd: cwd2 }))
      }
      const [first, second] = await Promise.all([
        syncCycleLabel({ cwd, issue: ISSUE, label: 'codesema:in-progress', execFn }),
        syncCycleLabel({ cwd, issue: ISSUE, label: 'codesema:reviewing', execFn }),
      ])
      // Never throws, literally: the rejection comes back as an outcome, at a
      // step that names the seam and with NO reason code — nothing out there
      // was proven unreachable, so nothing claims a forge outage.
      expect(first).toEqual({
        kind: 'failed',
        label: 'codesema:in-progress',
        at: 'internal',
        reason: null,
        detail: 'the forge seam threw instead of answering: the seam itself broke',
      })
      // And the second transition, chained behind the rejected one, RAN. A
      // `then(run)` without its rejection arm would have let one broken call
      // silence every later pose on that issue for as long as the process
      // lived.
      expect(second).toMatchObject({ kind: 'posed', label: 'codesema:reviewing' })
      expect(calls[0]).toBe('issue view')
      expect(cycleLabelPosesInFlight()).toBe(0)
      // The failure is still stated, and still without a code.
      const event = cycleLabelEvent(first)
      expect(event?.data.step).toBe('internal')
      expect(event?.reason_code).toBeUndefined()
    })
  })
})
