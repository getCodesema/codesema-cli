// D24: a `major` finding that asserts a concrete behavior is rebutted by
// actually running the repro it claims, instead of trusted on the model's
// word alone — the same discipline D17 already applies to a `[proof:command
// ...]` acceptance criterion (task-criteria-gate.ts's resolveMechanicalCriteria),
// reused here through the same `runAdHocCheck` primitive. Lives in its own
// file, never imported by review.ts or dual.ts of each other, so both can
// import FINDING_REPRO_RULE with no import cycle between them.

import type { Finding } from './contract.js'
import { runAdHocCheck, type ExecFn, type StepExecutor } from './task-checks.js'

/**
 * D24: the rule a reviewer's prompt states verbatim, shared by
 * `reviewInstructions()` (review.ts) and `prosecutorInstructions`
 * (dual.ts) — one sentence, one source, never two rules drifting apart.
 */
export const FINDING_REPRO_RULE =
  'For every "major" finding whose kind is NOT "convention" or "design" (a claim about concrete, checkable behavior, not a taste call), include a "repro": a SELF-VERIFYING "command" whose exit code alone is the verdict (non-zero when the defect you describe is actually present, zero when it is not), plus "expected", one sentence describing what a human running it should see. Never attach a "repro" to a "convention", "design" or praise/why finding: those are judgment calls no command can settle.'

/** Wall-clock budget for one finding's repro command: this runs inline in the review path, the same discipline as D17's AD_HOC_CHECK_DEFAULT_TIMEOUT_SECONDS (task-checks.ts), kept as its own constant because the two are separate concerns that happen to share a value. */
export const FINDING_REPRO_TIMEOUT_SECONDS = 60

/** How many repro commands one review pass may actually execute: an unbounded reviewer output must never turn one review into an unbounded number of container spawns. */
export const FINDING_REPRO_MAX_EXECUTIONS_PER_TURN = 10

/**
 * D24: whether a finding's claim is the kind a repro command can settle —
 * concrete behavior, not a judgment call. `kind` undefined (a plain,
 * pre-D24 finding) counts as asserting: only "convention" and "design" are
 * excluded. `severity` must be exactly "major": "critical" already escalates
 * through `groundReview`, and the sanitizer never lets "praise"/"why" reach
 * "major" in the first place, so excluding them here is unreachable in
 * practice rather than a second guard.
 */
export function isBehaviorAsserting(finding: Finding): boolean {
  return finding.severity === 'major' && finding.kind !== 'convention' && finding.kind !== 'design'
}

export type FindingReproContext = {
  /** The task's worktree: the same sandbox `resolveMechanicalCriteria`'s ad hoc `command` runs in (task-criteria-gate.ts). */
  worktree: string
  execFn?: ExecFn
  /** Where the repro command runs: the docker/podman executor by default, `microvmStepExecutor` for a 'microvm' task's review (task-review.ts). */
  executor?: StepExecutor
}

export type FindingReproReport = {
  /** Findings demoted from 'major' to 'minor' this pass: no repro, a repro that did not reproduce (exit 0), a timeout/engine error, or the per-turn execution cap below. */
  demoted: number
  /** Repro commands actually executed (bounded by FINDING_REPRO_MAX_EXECUTIONS_PER_TURN), whatever their outcome. */
  verified: number
}

export type VerifyFindingReprosResult = {
  findings: Finding[]
  report: FindingReproReport
}

/**
 * D24: rebuts every "major", behavior-asserting finding by actually running
 * the repro it claims. The model's own text (message, title, suggestion,
 * repro) is NEVER modified — the only thing this ever changes is `severity`,
 * and only downward, to 'minor'. A finding outside `isBehaviorAsserting`
 * (not major, or convention/design) is returned as the SAME reference,
 * untouched. Any demotion this pass made is reported in aggregate
 * (`report.demoted`/`report.verified`), never as a marker on the finding
 * itself: the contract's `finding` schema has no room for one
 * (`additionalProperties: false`), and a hand-written marker in the finding's
 * own text would be exactly the model-text edit this function must not do.
 */
export async function verifyFindingRepros(
  findings: readonly Finding[],
  ctx: FindingReproContext,
): Promise<VerifyFindingReprosResult> {
  const report: FindingReproReport = { demoted: 0, verified: 0 }
  const out: Finding[] = []
  for (const finding of findings) {
    if (!isBehaviorAsserting(finding)) {
      out.push(finding)
      continue
    }
    if (!finding.repro) {
      report.demoted++
      out.push({ ...finding, severity: 'minor' })
      continue
    }
    // The cap: a finding past it is demoted WITHOUT running anything, same
    // outcome as an unreproduced claim, so a verbose or adversarial reviewer
    // cannot turn one review into an unbounded number of container spawns.
    if (report.verified >= FINDING_REPRO_MAX_EXECUTIONS_PER_TURN) {
      report.demoted++
      out.push({ ...finding, severity: 'minor' })
      continue
    }
    const result = await runAdHocCheck({
      worktree: ctx.worktree,
      command: finding.repro.command,
      timeoutSeconds: FINDING_REPRO_TIMEOUT_SECONDS,
      ...(ctx.execFn ? { execFn: ctx.execFn } : {}),
      ...(ctx.executor ? { executor: ctx.executor } : {}),
    })
    report.verified++
    // exit_code null covers both a timeout and a synthetic engine failure
    // (runAdHocCheck never throws): neither confirms the claim, so both
    // degrade to "not reproduced" rather than trusting an unconfirmed major.
    if (result.exit_code === null || result.exit_code === 0) {
      report.demoted++
      out.push({ ...finding, severity: 'minor' })
      continue
    }
    out.push(finding)
  }
  return { findings: out, report }
}
