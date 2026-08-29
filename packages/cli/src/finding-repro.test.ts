import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Finding } from './contract.js'
import {
  FINDING_REPRO_MAX_EXECUTIONS_PER_TURN,
  FINDING_REPRO_TIMEOUT_SECONDS,
  isBehaviorAsserting,
  verifyFindingRepros,
} from './finding-repro.js'
import type { ExecFn, ExecResult, StepExecutor, StepExecutorInput } from './task-checks.js'

let worktree: string

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), 'codesema-finding-repro-'))
})

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true })
})

const ok = (over: Partial<ExecResult> = {}): ExecResult => ({
  code: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  failure: null,
  ...over,
})

type Call = { file: string; args: string[]; timeoutMs: number }

/** Same rig as task-checks.test.ts's dockerRig: docker exists, `--version`/`kill`/`volume` are plumbing, everything else is the repro command itself (its own last arg). */
function dockerRig(byCommand: (command: string) => ExecResult): { calls: Call[]; exec: ExecFn } {
  const calls: Call[] = []
  const exec: ExecFn = (file, args, opts) => {
    calls.push({ file, args, timeoutMs: opts.timeoutMs })
    if (args[0] === '--version') {
      return Promise.resolve(
        file === 'docker' ? ok({ stdout: 'Docker version 27' }) : ok({ code: 1 }),
      )
    }
    if (args[0] === 'kill' || args[0] === 'volume') {
      return Promise.resolve(ok())
    }
    return Promise.resolve(byCommand(args.at(-1) ?? ''))
  }
  return { calls, exec }
}

function majorFinding(overrides: Partial<Finding> = {}): Finding {
  return { file: 'a.ts', message: 'bug', severity: 'major', ...overrides }
}

describe('isBehaviorAsserting', () => {
  test('major with no kind, or security/perf: asserting', () => {
    expect(isBehaviorAsserting(majorFinding())).toBe(true)
    expect(isBehaviorAsserting(majorFinding({ kind: 'security' }))).toBe(true)
    expect(isBehaviorAsserting(majorFinding({ kind: 'perf' }))).toBe(true)
  })

  test('convention and design are excluded, even at major', () => {
    expect(isBehaviorAsserting(majorFinding({ kind: 'convention' }))).toBe(false)
    expect(isBehaviorAsserting(majorFinding({ kind: 'design' }))).toBe(false)
  })

  test('only severity major counts: critical, minor and info are not asserting', () => {
    expect(isBehaviorAsserting({ ...majorFinding(), severity: 'critical' })).toBe(false)
    expect(isBehaviorAsserting({ ...majorFinding(), severity: 'minor' })).toBe(false)
    expect(isBehaviorAsserting({ ...majorFinding(), severity: 'info' })).toBe(false)
  })

  // The sanitizer never lets kind 'praise'/'why' reach severity 'major' in the
  // first place (sanitizeFindings forces those to 'info'); the predicate
  // itself only excludes 'convention'/'design', so a hand-built finding that
  // bypasses the sanitizer still reads as asserting here — documented, not a
  // second guard against a case that cannot occur through normal input.
  test('praise/why at major (unreachable via the sanitizer) still reads as asserting', () => {
    expect(isBehaviorAsserting(majorFinding({ kind: 'praise' }))).toBe(true)
    expect(isBehaviorAsserting(majorFinding({ kind: 'why' }))).toBe(true)
  })
})

describe('verifyFindingRepros', () => {
  test('a major finding with no repro is demoted to minor, its own text untouched', async () => {
    const finding = majorFinding({ title: 't', message: 'exact message', suggestion: 'do X' })
    const { exec, calls } = dockerRig(() => ok())

    const result = await verifyFindingRepros([finding], { worktree, execFn: exec })

    expect(result.findings).toEqual([{ ...finding, severity: 'minor' }])
    expect(result.report).toEqual({ demoted: 1, verified: 0 })
    // No repro to run: nothing was ever executed for this finding.
    expect(calls).toHaveLength(0)
  })

  test('a repro whose command exits 0 (not reproduced) is demoted', async () => {
    const finding = majorFinding({ repro: { command: 'exit 0', expected: 'nothing happens' } })
    const { exec } = dockerRig(() => ok({ code: 0 }))

    const result = await verifyFindingRepros([finding], { worktree, execFn: exec })

    expect(result.findings[0]?.severity).toBe('minor')
    expect(result.findings[0]?.repro).toEqual(finding.repro)
    expect(result.report).toEqual({ demoted: 1, verified: 1 })
  })

  test('a repro whose command exits non-zero (reproduced) keeps major, exact same finding', async () => {
    const finding = majorFinding({ repro: { command: 'exit 1', expected: 'the bug fires' } })
    const { exec } = dockerRig(() => ok({ code: 1, stderr: 'boom' }))

    const result = await verifyFindingRepros([finding], { worktree, execFn: exec })

    expect(result.findings[0]).toBe(finding)
    expect(result.report).toEqual({ demoted: 0, verified: 1 })
  })

  test('a repro that times out is demoted, never trusted as a confirmed repro', async () => {
    const finding = majorFinding({ repro: { command: 'sleep 999', expected: 'x' } })
    const { exec, calls } = dockerRig(() => ok({ code: null, timedOut: true }))

    const result = await verifyFindingRepros([finding], { worktree, execFn: exec })

    expect(result.findings[0]?.severity).toBe('minor')
    expect(result.report).toEqual({ demoted: 1, verified: 1 })
    const run = calls.find((c) => c.args.at(-1) === 'sleep 999')
    expect(run?.timeoutMs).toBe(FINDING_REPRO_TIMEOUT_SECONDS * 1000)
  })

  test('an engine failure (no container runtime) demotes rather than throws', async () => {
    const finding = majorFinding({ repro: { command: 'echo hi', expected: 'x' } })
    const exec: ExecFn = () => Promise.resolve(ok({ code: null, failure: 'spawn docker ENOENT' }))

    const result = await verifyFindingRepros([finding], { worktree, execFn: exec })

    expect(result.findings[0]?.severity).toBe('minor')
    expect(result.report).toEqual({ demoted: 1, verified: 1 })
  })

  test('convention and design findings are never touched, even at major with no repro', async () => {
    const convention = majorFinding({ kind: 'convention' })
    const design = majorFinding({ kind: 'design' })
    const { exec, calls } = dockerRig(() => ok())

    const result = await verifyFindingRepros([convention, design], { worktree, execFn: exec })

    expect(result.findings[0]).toBe(convention)
    expect(result.findings[1]).toBe(design)
    expect(result.report).toEqual({ demoted: 0, verified: 0 })
    expect(calls).toHaveLength(0)
  })

  test('minor, info and critical findings are never touched', async () => {
    const minor: Finding = { file: 'a.ts', message: 'm', severity: 'minor' }
    const info: Finding = { file: 'a.ts', message: 'm', severity: 'info' }
    const critical: Finding = { file: 'a.ts', message: 'm', severity: 'critical' }
    const { exec, calls } = dockerRig(() => ok())

    const result = await verifyFindingRepros([minor, info, critical], { worktree, execFn: exec })

    expect(result.findings).toEqual([minor, info, critical])
    expect(result.report).toEqual({ demoted: 0, verified: 0 })
    expect(calls).toHaveLength(0)
  })

  test('the per-turn execution cap: the finding past it is demoted WITHOUT running', async () => {
    const findings = Array.from({ length: FINDING_REPRO_MAX_EXECUTIONS_PER_TURN + 1 }, (_, i) =>
      majorFinding({ repro: { command: `echo finding-${i}`, expected: 'x' } }),
    )
    const { exec, calls } = dockerRig(() => ok({ code: 1 }))

    const result = await verifyFindingRepros(findings, { worktree, execFn: exec })

    expect(result.report.verified).toBe(FINDING_REPRO_MAX_EXECUTIONS_PER_TURN)
    expect(result.report.demoted).toBe(1)
    // The first MAX findings ran for real (exit 1: reproduced) and kept 'major'…
    for (let i = 0; i < FINDING_REPRO_MAX_EXECUTIONS_PER_TURN; i++) {
      expect(result.findings[i]?.severity).toBe('major')
    }
    // …the one past the cap never ran at all, and is demoted regardless.
    expect(result.findings.at(-1)?.severity).toBe('minor')
    const lastCommand = `echo finding-${FINDING_REPRO_MAX_EXECUTIONS_PER_TURN}`
    expect(calls.some((c) => c.args.at(-1) === lastCommand)).toBe(false)
  })

  // task-review.ts wires a `microvmStepExecutor` in here for a 'microvm'
  // task's review: an injected `executor` must be what actually runs the
  // repro, docker/podman detection skipped entirely (task-checks.ts's own
  // `runAdHocCheck` doc comment).
  test('an injected executor runs the repro instead of docker/podman detection', async () => {
    const finding = majorFinding({ repro: { command: 'exit 1', expected: 'the bug fires' } })
    const executorCalls: StepExecutorInput[] = []
    const executor: StepExecutor = (input) => {
      executorCalls.push(input)
      return Promise.resolve({
        code: 1,
        stdout: '',
        stderr: 'boom',
        timedOut: false,
        failure: null,
      })
    }
    const { exec, calls } = dockerRig(() => ok())

    const result = await verifyFindingRepros([finding], { worktree, execFn: exec, executor })

    expect(result.findings[0]).toBe(finding)
    expect(result.report).toEqual({ demoted: 0, verified: 1 })
    expect(executorCalls).toHaveLength(1)
    expect(executorCalls[0]?.command).toBe('exit 1')
    // Docker/podman detection never ran: the injected executor bypasses it
    // entirely, so the docker exec rig saw nothing at all.
    expect(calls).toHaveLength(0)
  })

  test('a finding outside the behavior-asserting set never consumes the execution cap', async () => {
    const findings: Finding[] = [
      ...Array.from({ length: FINDING_REPRO_MAX_EXECUTIONS_PER_TURN }, (_, i) =>
        majorFinding({ repro: { command: `echo x${i}`, expected: 'x' } }),
      ),
      majorFinding({ kind: 'convention' }),
    ]
    const { exec } = dockerRig(() => ok({ code: 1 }))

    const result = await verifyFindingRepros(findings, { worktree, execFn: exec })

    expect(result.findings).toHaveLength(FINDING_REPRO_MAX_EXECUTIONS_PER_TURN + 1)
    // The convention finding sits past 10 already-spent executions and is
    // still untouched: the cap only ever applies inside the asserting branch.
    expect(result.findings.at(-1)?.severity).toBe('major')
    expect(result.findings.at(-1)?.kind).toBe('convention')
    expect(result.report.verified).toBe(FINDING_REPRO_MAX_EXECUTIONS_PER_TURN)
  })
})
