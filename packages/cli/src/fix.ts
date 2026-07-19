import type { AgentRunOptions } from './agent.js'
import { runAgent } from './agent.js'
import type { Finding, ReviewRecord } from './contract.js'
import { tryGit } from './git.js'

export const DEFAULT_TIMEOUT_S = 900

const MAX_SUMMARY_CHARS = 4000

/**
 * The review agent runs read-only; applying fixes needs file-edit permissions.
 * Flags verified against each CLI's official docs (2026-07): claude
 * --permission-mode acceptEdits, codex --sandbox workspace-write, gemini
 * --approval-mode auto_edit. Custom commands are trusted as configured.
 */
export function fixCommandFor(command: string): string {
  if (/^claude(\s|$)/.test(command)) {
    if (command.includes('--permission-mode')) return command
    return `${command} --permission-mode acceptEdits`
  }
  if (/^codex\s+exec(\s|$)/.test(command)) {
    if (command.includes('--sandbox') || command.includes('--full-auto')) return command
    return command.replace(/^codex\s+exec/, 'codex exec --sandbox workspace-write')
  }
  if (/^gemini(\s|$)/.test(command)) {
    if (command.includes('--approval-mode') || command.includes('--yolo')) return command
    return `${command} --approval-mode auto_edit`
  }
  return command
}

function isFixable(finding: Finding): boolean {
  if (finding.kind === 'praise' || finding.kind === 'why') return false
  return finding.severity !== 'info'
}

export function buildAgentFixPrompt(record: ReviewRecord, ids: number[]): string {
  const findings = ids.map((id) => {
    const f = record.review.findings[id]!
    return {
      file: f.file,
      ...(f.line !== undefined ? { line: f.line } : {}),
      ...(f.endLine !== undefined ? { endLine: f.endLine } : {}),
      severity: f.severity,
      ...(f.kind !== undefined ? { kind: f.kind } : {}),
      ...(f.title !== undefined ? { title: f.title } : {}),
      message: f.message,
      ...(f.suggestion !== undefined ? { suggestion: f.suggestion } : {}),
    }
  })
  return [
    'You are applying code review fixes directly to the working tree of this repository.',
    '',
    'Rules:',
    '- Apply ONLY the findings listed below. Change nothing else.',
    '- Line numbers refer to the reviewed diff; re-locate the code if it moved.',
    '- Follow the existing code style of each file.',
    '- When a finding describes a reproducible bug and the repo has a test suite, write the regression test FIRST (it must fail on the current code for the exact reason the finding names), fix, then check it passes. That test is part of applying the finding, not an extra change. Never write a tautological test that restates the implementation or only asserts the code runs.',
    '- After your edits, if the repo has cheap checks (typecheck, unit tests, lint) discoverable from package.json or equivalent, run them and fix what YOUR change broke. Do not chase pre-existing failures. If your environment does not let you run commands, skip this step and say so in the summary.',
    '- Do NOT commit, stage, push, or run destructive commands.',
    '- When done, output a short plain-text summary of what you changed (one line per finding, ending with how you verified: checks run, tests added, or why you could not verify; no JSON, no code fences).',
    '',
    `Branch: ${record.meta.branch} (target: ${record.meta.target})`,
    '',
    `<findings>\n${JSON.stringify(findings, null, 2)}\n</findings>`,
  ].join('\n')
}

export type FixPhase = 'idle' | 'running' | 'done' | 'error'

export type FixStatus = {
  available: true
  phase: FixPhase
  selected: number[]
  started_at?: string
  summary?: string
  error?: string
  head_moved: boolean
}

export type FixStartResult = { ok: true } | { ok: false; code: number; error: string }

export type FixRunner = {
  status: () => FixStatus
  start: (ids: number[]) => FixStartResult
}

export function createFixRunner(opts: {
  getRecord: () => ReviewRecord | null
  cwd: string
  command: string
  timeoutMs: number
  currentHead?: () => string | null
  runAgentFn?: (options: AgentRunOptions) => Promise<string>
}): FixRunner {
  const currentHead = opts.currentHead ?? (() => tryGit(['rev-parse', 'HEAD'], opts.cwd))
  const run = opts.runAgentFn ?? runAgent

  let phase: FixPhase = 'idle'
  let selected: number[] = []
  let startedAt: string | undefined
  let summary: string | undefined
  let error: string | undefined

  function headMoved(): boolean {
    const reviewedSha = opts.getRecord()?.meta.head_sha
    if (!reviewedSha) return false
    const head = currentHead()
    return head !== null && head.trim() !== reviewedSha
  }

  function validate(record: ReviewRecord, ids: number[]): string | null {
    if (!Array.isArray(ids) || ids.length === 0) return 'no findings selected'
    for (const id of ids) {
      if (!Number.isInteger(id)) return 'invalid finding id'
      const finding = record.review.findings[id]
      if (!finding) return 'unknown finding id'
      if (!isFixable(finding)) return 'finding has nothing to fix'
    }
    return null
  }

  return {
    status: () => ({
      available: true,
      phase,
      selected,
      ...(startedAt ? { started_at: startedAt } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(error !== undefined ? { error } : {}),
      head_moved: headMoved(),
    }),
    start(ids) {
      if (phase === 'running') return { ok: false, code: 409, error: 'a fix is already running' }
      const record = opts.getRecord()
      if (!record) return { ok: false, code: 409, error: 'no review available yet' }
      const invalid = validate(record, ids)
      if (invalid) return { ok: false, code: 400, error: invalid }

      phase = 'running'
      selected = [...ids]
      startedAt = new Date().toISOString()
      summary = undefined
      error = undefined

      void run({
        command: fixCommandFor(opts.command),
        prompt: buildAgentFixPrompt(record, selected),
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
      })
        .then((out) => {
          summary = out.trim().slice(0, MAX_SUMMARY_CHARS)
          phase = 'done'
        })
        .catch((err: unknown) => {
          error = err instanceof Error ? err.message : String(err)
          phase = 'error'
        })

      return { ok: true }
    },
  }
}
