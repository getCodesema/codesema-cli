import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentEnv, hardenedReviewCommand, runAgent, type AgentRunOptions } from './agent.js'
import { pickBranch } from './branches.js'
import { ensureWorkDir, isRepoAgentTrusted, loadConfig, loadRepoConfig, trustRepoAgent } from './config.js'
import { createFixRunner, DEFAULT_TIMEOUT_S } from './fix.js'
import { isAncestor, repoRoot } from './git.js'
import { reviewLanguage, t, uiLocale } from './i18n.js'
import { notifyDesktop } from './notify.js'
import { openBrowser } from './open.js'
import type { FindingSeverity, GroundingReport, ReviewedFile, ReviewRecord, SanitizedReview } from './contract.js'
import { groundReview, sanitizeReview } from './contract.js'
import {
  assembleDualReview,
  dedupeExactCrossLane,
  judgeCommandFor,
  judgeInstructions,
  judgeReviewBlocks,
  parsePartialJudge,
  prosecutorInstructions,
  sanitizeJudgeOutput,
  type JudgeOutput,
} from './dual.js'
import type { PartialReview } from './partial.js'
import { parsePartialReview } from './partial.js'
import type { PrepInput } from './prep.js'
import { mrDiff, prep } from './prep.js'
import { archiveRecord, findPreviousReview, resolveRecord } from './record.js'
import type { LiveSession } from './serve.js'
import { createSession, startServer } from './serve.js'
import { printReviewSummary } from './summary.js'
import { autoPushReview } from './sync.js'
import { isInteractive, select } from './tui.js'
import { ACCENT, GREEN, RED, bold, dim, paint, printBanner, progressLabel, renderFieldRows, startSpinner, underline } from './ui.js'
import { AGENT_DEFS, defaultCommand, detectAgents, runOnboarding } from './wizard.js'

export const REVIEW_GATE_EXIT_CODE = 2
export type ReviewGate = FindingSeverity | 'request_changes'
export const REVIEW_GATE_VALUES: readonly ReviewGate[] = ['critical', 'major', 'minor', 'info', 'request_changes']
const SEVERITY_RANK: Record<FindingSeverity, number> = { info: 0, minor: 1, major: 2, critical: 3 }

/** Returns a human reason when the review trips the gate, or null when it passes. */
export function reviewGateReason(review: SanitizedReview, gate: ReviewGate): string | null {
  if (gate === 'request_changes') {
    return review.verdict === 'request_changes' ? t('review.gateReasonVerdict') : null
  }
  const threshold = SEVERITY_RANK[gate]
  const count = review.findings.filter((f) => SEVERITY_RANK[f.severity] >= threshold).length
  return count > 0 ? t('review.gateReasonSeverity', { n: count, level: gate }) : null
}

/**
 * The agent gets the review material and nothing else: no local path, no SHAs,
 * no prep plumbing. Anything added here ends up in the prompt.
 */
export function agentVisibleInput(input: PrepInput): {
  branch: string
  target: string
  commits: string[]
  files: PrepInput['files']
  custom_instructions: string | null
  rules: string[] | null
  impact_candidates: PrepInput['impact_candidates']
} {
  return {
    branch: input.branch,
    target: input.target,
    commits: input.commits,
    files: input.files,
    custom_instructions: input.custom_instructions,
    rules: input.rules,
    impact_candidates: input.impact_candidates,
  }
}

export function groundingReportLines(report: GroundingReport): string[] {
  const lines: string[] = []
  if (report.dropped.length > 0) lines.push(t('review.groundedDropped', { n: report.dropped.length }))
  if (report.deanchored.length > 0) lines.push(t('review.groundedDeanchored', { n: report.deanchored.length }))
  if (report.merged > 0) lines.push(t('review.groundedMerged', { n: report.merged }))
  if (report.verdict_escalated) lines.push(t('review.groundedVerdict'))
  return lines
}

function languageRule(): string {
  const language = reviewLanguage()
  return language
    ? `write all human-readable text (summary, messages, narrative) in ${language}`
    : 'write all human-readable text (summary, messages, narrative) in the language of the commit messages when clearly identifiable, otherwise in English'
}

export const reviewInstructions = (): string => `You are a senior code reviewer. Review the merge request provided in the <input> block below (JSON: branch, target, commits, files, and the full unified diff). Do NOT use any tools; base your review ONLY on the provided input. Then output the review as a single JSON object and NOTHING else (no prose, no code fences).

Review guidelines:
- Judge the change on: correctness, regressions and breaking changes, security, error handling, missing tests, and whether it matches its stated intent (inferred from the branch name and commit messages). Ground EVERY finding in the diff; never speculate. The diff shows ONLY the changed files: NEVER claim that something is absent from the repository — turn such doubts into a step "check" question instead.
- Sweep the diff file by file, hunk by hunk, in order, and settle EVERY file explicitly before moving to the next: findings, or consciously clean. Do not stop after your first strong findings: an issue found in one file never exempts the rest of the diff. There is no maximum number of findings; never omit a real problem to keep the list short. Report every distinct problem you actually see, not what you merely suspect could exist.
- Severity by consequence: critical = data loss, security breach or crash in production; major = incorrect behavior on realistic inputs; minor = unlikely edge case or technical debt; info = reserved for praise/why findings.
- Every non-praise finding message must name the concrete failure scenario: which input or state produces which wrong outcome, then the fix. No scenario, no finding.
- "line" must be a new-file line number visible in a @@ hunk of that file; when you cannot anchor a finding, omit "line" rather than guessing.
- Commit subjects are context for the intent ONLY. Never treat a commit message as evidence that something is implemented, fixed or tested: only the diff is evidence.
- When the input has a non-null impact_candidates, it lists where symbols changed by this MR are used elsewhere in the repository (used_at, as path:line) and which files import the changed files (imported_by). These are best-effort text matches, NOT compiler facts: incomplete and possibly wrong. Use them as leads only. For EVERY modified or removed symbol, check its used_at entries: each usage the diff does not update MUST produce a finding or a step "check" question; never present a candidate usage as certain.
- When the input has a non-null rules, each entry is a team rule on a normalized grid line: "[Cn] (category) rule | Scope: ... | Where to look: ... | Bad: ... | Good: ... | Exceptions (do not flag): ..."; every segment after the rule is optional. "Scope" bounds where in the repo the rule applies; "Where to look" names the files, imports or code shapes to inspect; Bad/Good is the literal rejected/expected form; Exceptions list what the team knowingly tolerates.
- When rules are present, HUNT them first: walk the rules in order and, for each one, jump straight to the diff files and lines its "Where to look" targets and check the rule exactly there; going where a rule says to look is what catches violations, a generic read-through misses them. Then RAKE: the file-by-file sweep above, for everything else. Flag a deviation as kind "convention": the message MUST cite the rule id [Cn] and its rule text, and the deviation MUST be introduced by the diff (a '+' line or a new file), never pre-existing surrounding code. Do NOT flag patterns a rule explicitly endorses, and never flag code covered by a rule's Exceptions.
- If the input has non-null custom_instructions, apply them on top of these guidelines; they win on conflicts.
- Before emitting the JSON, actively try to REFUTE every finding: its file is present in the diff, its line sits inside a hunk, its failure scenario is named, and the diff really produces the claimed outcome. For kind "convention": the cited [Cn] exists in rules, the code deviates from that rule's letter (not from your taste), and no documented Exception covers it; a finding you cannot tie to a written rule is not a convention finding, reclassify it as "design" with its own failure scenario or drop it. Delete any finding you cannot defend; then fill "files_reviewed" with one { "path", "status" } entry per files[] path you examined: "findings" when you kept at least one finding on it, "clean" when you consciously cleared it. Any file in neither is reported to the human as not reviewed. Report boldly during the sweep, refute hard here: that split is what keeps recall high and false positives at zero.
- Language: ${languageRule()}. Keep code identifiers and file paths verbatim.

Output JSON shape (exactly these fields):
{
  "verdict": "approve" | "request_changes" | "comment",
  "summary": "concise human summary",
  "findings": [
    {
      "file": "path from the diff",
      "line": <new-file line number from the @@ headers, when anchorable>,
      "endLine": <optional, only for multi-line suggestions>,
      "severity": "critical" | "major" | "minor" | "info",
      "kind": "security" | "perf" | "convention" | "design" | "praise" | "why",
      "title": "short title",
      "message": "one short plain sentence: what is wrong and what it breaks in practice, then the fix. A junior must understand it on first read.",
      "suggestion": "optional corrected code, verbatim replacement, only for trivial self-contained fixes"
    }
  ],
  "narrative": {
    "intent": "1-3 sentences on what this MR tries to accomplish",
    "confidence": "high" | "medium" | "low",
    "prologue": {
      "why": "the problem this MR addresses (max 3 sentences)",
      "what": "what it concretely changes (max 3 sentences)",
      "key_changes": [{ "title": "short label", "detail": "one sentence" }]
    },
    "steps": [
      {
        "title": "concise step name",
        "rationale": "the PURPOSE of the step",
        "files": ["ordered diff paths"],
        "finding_refs": [<0-based indices into findings>],
        "risk": "high" | "medium" | "low",
        "take": "your opinion on the step (max 2 sentences)",
        "check": "one question the human should verify, or omit"
      }
    ],
    "review_first": [
      { "point": "what to check and why it is risky (one sentence)", "risk": "high" | "medium" | "low", "step_ref": <0-based step index>, "file": "path" }
    ]
  },
  "files_reviewed": [{ "path": "files[] path you examined", "status": "clean" | "findings" }]
}

Rules for the narrative:
- steps: ORDERED logical groups (NOT alphabetical): foundations first (migrations, shared types, contracts), then business logic, then surface (routes, UI).
- review_first: 2-4 hot spots ordered by risk, highest first.
- You MUST produce praise findings when the code deserves it; reserve severity "info" for praise/why findings.
- Do NOT approve changes you cannot justify from the diff; prefer "request_changes" when the diff itself shows an unresolved risk.
- The verdict weighs ONLY what you could verify in the provided input. A concern that lives outside it (another repository, an external consumer of a published package, a deployment) is never a finding and never lowers the verdict: raise it as a step "check" question and judge the change on what you can see.
- Output the top-level fields in this exact order: "verdict", "summary", "findings", "narrative", "files_reviewed" (the review is displayed live while you write it).`

const INCREMENTAL_INSTRUCTIONS = `An earlier review of this SAME merge request exists. Instead of the full diff, you are given:
- <previous_review>: the review produced when HEAD was at the commit indicated below
- <incremental_diff>: what changed on the branch since that review

UPDATE the previous review into a new COMPLETE review of the whole MR:
- Remove findings that the incremental changes fix or make obsolete.
- Keep still-relevant findings as they are (same file/line anchors), unless the incremental diff moved that code.
- Add findings for problems introduced by the incremental diff, grounded in it.
- Update verdict, summary and narrative (prologue, steps, review_first) so they describe the whole MR after these changes; keep the step structure stable when possible.
Output the FULL updated review JSON (exact same schema), and NOTHING else.`

/** Incremental prompt when an archived review of this branch covers a strict ancestor of the reviewed head. */
function buildIncrementalPrompt(input: PrepInput, cwd: string): { prompt: string; sinceSha: string } | null {
  const previous = findPreviousReview(cwd, input.branch, input.target)
  const since = previous?.meta.head_sha
  if (!previous || !since) return null
  if (since === input.head_sha) return null
  if (!isAncestor(since, input.head_sha, cwd)) return null
  const incrementalDiff = mrDiff(`${since}..${input.head_sha}`, cwd)
  if (!incrementalDiff.trim()) return null

  const prompt = [
    reviewInstructions(),
    INCREMENTAL_INSTRUCTIONS,
    `Previous review done at commit: ${since.slice(0, 12)}`,
    `<input>\n${JSON.stringify(agentVisibleInput(input), null, 2)}\n</input>`,
    `<previous_review>\n${JSON.stringify(previous.review, null, 2)}\n</previous_review>`,
    `<incremental_diff>\n${incrementalDiff}\n</incremental_diff>`,
    'Output ONLY the JSON object now.',
  ].join('\n\n')
  return { prompt, sinceSha: since }
}

function detectAgentCommand(cwd: string): string {
  const [first] = detectAgents(cwd)
  if (first) return defaultCommand(first)
  throw new Error(t('agent.noneFound', { bins: AGENT_DEFS.map((d) => d.bin).join(', ') }))
}

/** Extracts the JSON object from the agent output (tolerates code fences and surrounding prose). */
export function extractReviewJson(raw: string): string {
  let fallback: string | null = null
  for (const candidate of jsonCandidates(raw.trim())) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    if ('verdict' in (parsed as Record<string, unknown>)) return candidate
    fallback ??= candidate
  }
  if (fallback) return fallback
  throw new Error(t('agent.noJsonReview'))
}

/** Candidates in priority order: the whole output, fence contents, then each balanced {...} object. */
function* jsonCandidates(s: string): Generator<string> {
  yield s
  for (const m of s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    if (m[1]) yield m[1].trim()
  }
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    const end = balancedEnd(s, i)
    if (end > i) yield s.slice(i, end + 1)
  }
}

/** Index of the '}' that closes the object opened at `start`, string- and escape-aware. */
function balancedEnd(s: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

const PARTIAL_PARSE_INTERVAL_MS = 400

function createPartialForwarder(session: LiveSession, lane: 'a' | 'b' = 'a'): (text: string) => PartialReview | null {
  let lastParse = 0
  return (text: string) => {
    const now = Date.now()
    if (now - lastParse < PARTIAL_PARSE_INTERVAL_MS) return null
    lastParse = now
    const partial = parsePartialReview(text)
    if (partial) {
      if (lane === 'a') session.setPartial(partial)
      else session.setPartialB(partial)
    }
    return partial
  }
}

/** Diff files a reviewer did not list in files_reviewed; null when it reported nothing. */
export function missingReviewedFiles(
  files: { path: string }[],
  reviewed: ReviewedFile[] | undefined,
): string[] | null {
  if (reviewed === undefined) return null
  const seen = new Set(reviewed.map((f) => f.path))
  return files.map((f) => f.path).filter((path) => !seen.has(path))
}

function coverageGapLine(input: PrepInput, lane: string, review: SanitizedReview): string | null {
  const missing = missingReviewedFiles(input.files, review.files_reviewed)
  if (!missing || missing.length === 0) return null
  const shown = missing.slice(0, 3).join(', ')
  return t('review.coverageGap', { lane, n: missing.length, files: missing.length > 3 ? `${shown}, …` : shown })
}

const INVALID_JSON_RETRY_NOTE =
  'Your previous output was not a valid JSON review. Output ONLY the JSON object now: no prose, no code fences.'

export class AgentOutputError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message)
  }
}

type AgentRunner = (opts: AgentRunOptions) => Promise<string>

/**
 * One retry with a corrective note when the agent output holds no parseable
 * JSON; agent run errors (crash, timeout) are never retried.
 */
export async function runAgentJsonWithRetry<T>(
  opts: AgentRunOptions,
  parse: (raw: string) => T,
  runner: AgentRunner = runAgent,
): Promise<T> {
  const raw = await runner(opts)
  try {
    return parse(raw)
  } catch {
    const retried = await runner({ ...opts, prompt: `${opts.prompt}\n\n${INVALID_JSON_RETRY_NOTE}` })
    try {
      return parse(retried)
    } catch (err) {
      throw new AgentOutputError(err instanceof Error ? err.message : String(err), retried)
    }
  }
}

type DualOutcome =
  | { ok: true; record: ReviewRecord; reportLines: string[] }
  | { ok: false; failure: 'run' | 'output'; message: string; rawOutput?: string }

export async function runDualFlow(opts: {
  agentCommand: string
  input: PrepInput
  dir: string
  timeoutMs: number
  session: LiveSession
  spinner: { update: (status: string) => void }
}): Promise<DualOutcome> {
  const { agentCommand, input, dir, timeoutMs, session, spinner } = opts
  const inputBlock = `<input>\n${JSON.stringify({ ...agentVisibleInput(input), diff: input.diff }, null, 2)}\n</input>`
  const closing = 'Output ONLY the JSON object now.'
  const command = hardenedReviewCommand(agentCommand)
  const env = agentEnv(agentCommand)

  const lanes: { a: string | null; b: string | null } = { a: null, b: null }
  const updateLanes = () =>
    spinner.update(`${t('review.dualLaneA')} ${lanes.a ?? '…'} · ${t('review.dualLaneB')} ${lanes.b ?? '…'}`)
  const laneRun = (lane: 'a' | 'b', prompt: string): Promise<SanitizedReview> => {
    const forward = createPartialForwarder(session, lane)
    return runAgentJsonWithRetry(
      {
        command,
        env,
        prompt,
        cwd: input.repo_root,
        timeoutMs,
        onText: (text) => {
          const partial = forward(text)
          if (!partial) return
          lanes[lane] = progressLabel(partial)
          updateLanes()
        },
      },
      (raw) => sanitizeReview(JSON.parse(extractReviewJson(raw))),
    )
  }

  const [resA, resB] = await Promise.allSettled([
    laneRun('a', [reviewInstructions(), inputBlock, closing].join('\n\n')),
    laneRun('b', [prosecutorInstructions(languageRule()), inputBlock, closing].join('\n\n')),
  ])

  const settle = (
    res: PromiseSettledResult<SanitizedReview>,
  ): { review: SanitizedReview | null; error: string | null; raw: string | null } => {
    if (res.status === 'fulfilled') return { review: res.value, error: null, raw: null }
    const message = res.reason instanceof Error ? res.reason.message : String(res.reason)
    return { review: null, error: message, raw: res.reason instanceof AgentOutputError ? res.reason.raw : null }
  }
  const a = settle(resA)
  const b = settle(resB)

  if (!a.review && !b.review) {
    const raw = a.raw ?? b.raw
    return {
      ok: false,
      failure: raw === null ? 'run' : 'output',
      message: a.error ?? b.error ?? 'unknown',
      ...(raw !== null ? { rawOutput: raw } : {}),
    }
  }

  const buildRecord = (review: SanitizedReview): ReviewRecord => {
    writeFileSync(join(dir, 'review.json'), JSON.stringify(review, null, 2))
    return resolveRecord({ cwd: input.repo_root }).record
  }

  if (!a.review || !b.review) {
    const survivor = (a.review ?? b.review) as SanitizedReview
    const grounded = groundReview(survivor, input.diff)
    const record = buildRecord(grounded.review)
    return {
      ok: true,
      record,
      reportLines: [
        t('review.dualReviewerFailed', { message: (a.review ? b.error : a.error) ?? 'unknown' }),
        ...groundingReportLines(grounded.report),
      ],
    }
  }

  const groundedA = groundReview(a.review, input.diff)
  const groundedB = groundReview(b.review, input.diff)
  const crossLane = dedupeExactCrossLane(groundedA.review, groundedB.review)
  const aCount = crossLane.a.findings.length
  const bCount = crossLane.b.findings.length
  const total = aCount + bCount

  let judgeOutput: JudgeOutput = { decisions: [] }
  let judgeFailure: string | null = null
  if (total > 0) {
    session.setJudging(total)
    spinner.update(t('review.dualJudging', { n: total }))
    const judgeCommand = judgeCommandFor(agentCommand)
    try {
      let lastJudgeParse = 0
      judgeOutput = await runAgentJsonWithRetry(
        {
          command: hardenedReviewCommand(judgeCommand),
          env: agentEnv(judgeCommand),
          prompt: [
            judgeInstructions(languageRule()),
            inputBlock,
            judgeReviewBlocks(crossLane.a, crossLane.b),
            closing,
          ].join('\n\n'),
          cwd: input.repo_root,
          timeoutMs,
          onText: (text) => {
            const now = Date.now()
            if (now - lastJudgeParse < PARTIAL_PARSE_INTERVAL_MS) return
            lastJudgeParse = now
            const partial = parsePartialJudge(text, aCount, bCount)
            if (!partial) return
            session.setJudge({ total, decisions: partial.decisions })
            spinner.update(t('review.dualJudgeProgress', { done: partial.decisions.length, total }))
          },
        },
        (raw) => sanitizeJudgeOutput(JSON.parse(extractReviewJson(raw)), aCount, bCount),
      )
      session.setJudge({ total, decisions: judgeOutput.decisions })
    } catch (err) {
      judgeFailure = err instanceof Error ? err.message : String(err)
    }
  }

  const assembly = assembleDualReview(crossLane.a, crossLane.b, judgeOutput)
  const dualStats = { ...assembly.stats, merged: assembly.stats.merged + crossLane.merged }
  const final = groundReview(assembly.review, input.diff)
  const resolved = buildRecord(final.review)
  const record: ReviewRecord = { ...resolved, meta: { ...resolved.meta, dual: dualStats } }

  const consensusCount = final.review.findings.filter((f) => f.consensus).length
  const grounding: GroundingReport = {
    dropped: [...groundedA.report.dropped, ...groundedB.report.dropped, ...final.report.dropped],
    deanchored: [...groundedA.report.deanchored, ...groundedB.report.deanchored, ...final.report.deanchored],
    merged: groundedA.report.merged + groundedB.report.merged + final.report.merged,
    verdict_escalated: final.report.verdict_escalated,
  }
  return {
    ok: true,
    record,
    reportLines: [
      t('review.dualStats', {
        merged: dualStats.merged,
        rejected: dualStats.rejected,
        added: dualStats.added_by_b,
      }),
      ...(consensusCount > 0 ? [t('review.dualConsensus', { n: consensusCount })] : []),
      ...[
        coverageGapLine(input, t('review.dualLaneA'), crossLane.a),
        coverageGapLine(input, t('review.dualLaneB'), crossLane.b),
      ].filter((line): line is string => line !== null),
      ...(judgeFailure !== null ? [t('review.dualJudgeFailed', { message: judgeFailure })] : []),
      ...groundingReportLines(grounding),
    ],
  }
}

/**
 * A repo-provided agent command (.codesema/config.json) runs in the user's shell,
 * so a hostile cloned repo could execute arbitrary code. Require explicit approval
 * (TOFU) before running it, and refuse outright when non-interactive (CI). Returns
 * true if execution may proceed, false if the user cancels.
 */
async function ensureRepoAgentTrusted(cwd: string, command: string): Promise<boolean> {
  if (isRepoAgentTrusted(cwd, command)) return true
  if (!isInteractive()) {
    throw new Error(t('review.repoAgentUnattended', { command }))
  }
  console.log('')
  console.log(`  ${bold(t('review.trustTitle'))}`)
  console.log(`    ${bold(command)}`)
  console.log(`  ${dim(t('review.trustWarning'))}`)
  const choice = await select<'run' | 'cancel'>({
    title: t('review.trustQuestion'),
    options: [
      { label: t('review.trustCancel'), hint: t('review.trustCancelHint'), value: 'cancel' },
      { label: t('review.trustApprove'), hint: t('review.trustApproveHint'), value: 'run' },
    ],
    initialIndex: 0,
  })
  if (choice !== 'run') return false
  trustRepoAgent(cwd, command)
  return true
}

export async function review(opts: {
  branch?: string
  target?: string
  agent?: string
  port?: number
  timeout?: number
  full?: boolean
  dual?: boolean
  failOn?: ReviewGate
  open: boolean
  interactive?: boolean
  cwd: string
}): Promise<void> {
  printBanner()
  const cwd = repoRoot(opts.cwd)
  const config = loadConfig(cwd)

  let agentCommand = opts.agent ?? config.agent
  if (!agentCommand && isInteractive()) {
    agentCommand = (await runOnboarding(cwd)) ?? undefined
    if (agentCommand) console.log('')
  }
  agentCommand ??= detectAgentCommand(cwd)

  // Agent inherited from the repo config (neither --agent nor global): require approval.
  const repoAgent = cwd ? loadRepoConfig(cwd).agent : undefined
  if (!opts.agent && cwd && repoAgent && repoAgent === agentCommand) {
    const approved = await ensureRepoAgentTrusted(cwd, agentCommand)
    if (!approved) {
      console.log(`  ${t('review.trustAborted')}`)
      return
    }
  }

  let branch = opts.branch
  if (!branch && opts.interactive !== false && isInteractive()) {
    const picked = await pickBranch(cwd)
    if (picked === null) return
    branch = picked
  }

  const input = prep({ branch, target: opts.target ?? config.target, cwd, quiet: true })
  const dir = ensureWorkDir(input.repo_root)

  // Dual reviews always start from scratch: the incremental prompt updates ONE
  // previous review, which has no equivalent for two lanes plus a judge.
  const dual = Boolean(opts.dual)
  const incremental = opts.full || dual ? null : buildIncrementalPrompt(input, input.repo_root)
  const prompt =
    incremental?.prompt ??
    `${reviewInstructions()}\n\n<input>\n${JSON.stringify({ ...agentVisibleInput(input), diff: input.diff }, null, 2)}\n</input>\n\nOutput ONLY the JSON object now.`

  const additions = input.files.reduce((n, f) => n + f.additions, 0)
  const deletions = input.files.reduce((n, f) => n + f.deletions, 0)

  const session = createSession()
  session.setAgent(agentCommand)
  session.setMode(dual ? 'dual' : 'simple')
  session.setInput({
    branch: input.branch,
    target: input.target,
    commits: input.commits,
    files: input.files,
    additions,
    deletions,
    incremental: Boolean(incremental),
  })

  const timeoutMs = (opts.timeout ?? config.timeout ?? DEFAULT_TIMEOUT_S) * 1000
  const { url, stop } = await startServer(session, {
    port: opts.port ?? config.port,
    locale: uiLocale(),
    fixRunner: createFixRunner({
      getRecord: () => session.record(),
      cwd: input.repo_root,
      command: agentCommand,
      timeoutMs,
    }),
  })

  const headerRows = [
    {
      label: t('field.branch'),
      value: `${bold(input.branch)} ${dim('→')} ${input.target} ${dim(`(${input.target_source})`)}`,
    },
    {
      label: t('field.changes'),
      value: `${t('review.files', { n: input.files.length })} · ${paint(`+${additions}`, GREEN)} ${paint(`−${deletions}`, RED)} · ${t('review.commits', { n: input.commits.length })}`,
    },
  ]
  if (incremental) {
    headerRows.push({
      label: t('field.mode'),
      value: `${t('review.modeIncremental')} ${dim(t('review.modeIncrementalHint', { sha: incremental.sinceSha.slice(0, 8) }))}`,
    })
  }
  if (dual) {
    headerRows.push({ label: t('field.mode'), value: t('review.modeDual') })
  }
  if (input.custom_instructions) {
    headerRows.push({ label: t('field.prompt'), value: dim(t('review.customPrompt')) })
  }
  if (input.rules) {
    headerRows.push({ label: t('field.rules'), value: dim(t('review.teamRules', { n: input.rules.length })) })
  }
  headerRows.push({ label: t('field.web'), value: `${underline(paint(url, ACCENT))} ${dim(t('review.webLiveHint'))}` })

  console.log('')
  renderFieldRows(headerRows).forEach((line) => console.log(line))
  console.log('')
  if (opts.open && !opts.failOn) openBrowser(url)

  const shortCmd = agentCommand.length > 40 ? `${agentCommand.slice(0, 37)}…` : agentCommand
  const spinner = startSpinner(t('review.spinner', { cmd: shortCmd }))

  const failRun = async (kind: 'run' | 'output', message: string): Promise<void> => {
    const heading = kind === 'run' ? t('review.runFailed') : t('review.unusableOutput')
    spinner.stop(`  ${paint('✘', RED)} ${heading}`)
    session.setError(message)
    if (isInteractive()) notifyDesktop('codesema', t(kind === 'run' ? 'notify.failedRun' : 'notify.failedOutput'))
    console.error(`codesema: ${kind === 'run' ? t('review.runFailedDetail', { message }) : message}`)
    console.log(`  ${t('review.stillUp', { url })}`)
    process.exitCode = 1
    if (opts.failOn) await stop()
  }

  let record: ReviewRecord
  let reportLines: string[]
  if (dual) {
    const outcome = await runDualFlow({ agentCommand, input, dir, timeoutMs, session, spinner })
    if (!outcome.ok) {
      if (outcome.rawOutput !== undefined) writeFileSync(join(dir, 'agent-output.txt'), outcome.rawOutput)
      await failRun(outcome.failure, outcome.message)
      return
    }
    record = outcome.record
    reportLines = outcome.reportLines
  } else {
    const forwardPartial = createPartialForwarder(session)
    let out: string
    try {
      out = await runAgentJsonWithRetry(
        {
          command: hardenedReviewCommand(agentCommand),
          env: agentEnv(agentCommand),
          prompt,
          cwd: input.repo_root,
          timeoutMs,
          onText: (text) => {
            const partial = forwardPartial(text)
            if (!partial) return
            const status = progressLabel(partial)
            if (status) spinner.update(status)
          },
        },
        (raw) => {
          extractReviewJson(raw)
          return raw
        },
      )
    } catch (err) {
      if (err instanceof AgentOutputError) {
        writeFileSync(join(dir, 'agent-output.txt'), err.raw)
        await failRun('output', err.message)
      } else {
        await failRun('run', err instanceof Error ? err.message : String(err))
      }
      return
    }

    try {
      const json = extractReviewJson(out)
      writeFileSync(join(dir, 'review.json'), json)
      const resolved = resolveRecord({ cwd: input.repo_root }).record
      const grounded = groundReview(resolved.review, resolved.diff)
      record = { ...resolved, review: grounded.review }
      writeFileSync(join(dir, 'review.json'), JSON.stringify(grounded.review, null, 2))
      reportLines = groundingReportLines(grounded.report)
      // Incremental reviews legitimately revisit only what changed: coverage
      // against the full file list would cry wolf.
      if (!incremental) {
        const coverage = coverageGapLine(input, t('review.dualLaneA'), grounded.review)
        if (coverage) reportLines.push(coverage)
      }
    } catch (err) {
      writeFileSync(join(dir, 'agent-output.txt'), out)
      await failRun('output', err instanceof Error ? err.message : String(err))
      return
    }
  }

  const savedPath = archiveRecord(record, input.repo_root)
  session.setDone(record)

  const findingsCount = record.review.findings.length
  spinner.stop(`  ${paint('✔', GREEN)} ${t('review.ready')}`)
  console.log('')
  printReviewSummary(record)
  if (reportLines.length > 0) {
    console.log('')
    reportLines.forEach((line) => console.log(`  ${dim(line)}`))
  }
  console.log('')
  renderFieldRows([
    { label: t('field.web'), value: underline(paint(url, ACCENT)) },
    { label: t('field.archived'), value: dim(savedPath) },
  ]).forEach((line) => console.log(line))
  console.log('')
  const syncOutcome = await autoPushReview(record, input.repo_root)
  const syncLine =
    syncOutcome.status === 'pushed'
      ? t(syncOutcome.deduplicated ? 'review.syncAlready' : 'review.syncPushed')
      : syncOutcome.status === 'blocked_secrets'
        ? t('review.syncBlockedSecrets', { n: syncOutcome.count })
        : syncOutcome.status === 'failed'
          ? t('review.syncFailed', { message: syncOutcome.message })
          : null
  console.log(`  ${dim(syncLine ?? t('review.syncHint'))}`)
  console.log(`  ${dim(t('review.ctrlc'))}`)
  if (isInteractive()) {
    notifyDesktop(
      'codesema',
      t('notify.ready', {
        findings: t('review.findingCount', { n: findingsCount }),
        verdict: t(`verdict.${record.review.verdict}`),
      }),
    )
  }

  if (opts.failOn) {
    const reason = reviewGateReason(record.review, opts.failOn)
    if (reason) {
      console.log(`  ${paint('✘', RED)} ${t('review.gateFailed', { reason })}`)
      process.exitCode = REVIEW_GATE_EXIT_CODE
    }
    await stop()
  }
}
