import type {
  DualStats,
  Finding,
  FindingSeverity,
  ReviewedFile,
  ReviewedFileStatus,
  SanitizedReview,
  Verdict,
} from './contract.js'
import { repairTruncatedJson } from './partial.js'
import { AGENT_DEFS } from './wizard.js'

const SEVERITIES: readonly FindingSeverity[] = ['critical', 'major', 'minor', 'info']
const SEVERITY_ORDER: Record<FindingSeverity, number> = { info: 0, minor: 1, major: 2, critical: 3 }
const VERDICT_ORDER: Record<Verdict, number> = { approve: 0, comment: 1, request_changes: 2 }
const JUDGE_REASON_MAX = 300

export function worstVerdict(a: Verdict, b: Verdict): Verdict {
  return VERDICT_ORDER[b] > VERDICT_ORDER[a] ? b : a
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The judge runs on the same provider as the configured agent, remapped to its
 * mid-tier model (adjudication needs reasoning, not the flagship price).
 * Custom commands are returned unchanged: their model is unknowable.
 */
export function judgeCommandFor(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const bin = first.split('/').pop() ?? ''
  const def = AGENT_DEFS.find((d) => d.bin === bin)
  if (!def) return command
  const flagPattern = new RegExp(`(^|\\s)${escapeRegExp(def.modelFlag)}(?:=|\\s+)\\S+`)
  if (flagPattern.test(command)) {
    return command.replace(flagPattern, `$1${def.modelFlag} ${def.judgeModel}`)
  }
  const stdinMarker = /\s-$/.test(command)
  const base = stdinMarker ? command.slice(0, -2) : command
  return [base, `${def.modelFlag} ${def.judgeModel}`, ...(stdinMarker ? ['-'] : [])].join(' ')
}

export type JudgeDecision = {
  id: string
  action: 'keep' | 'reject'
  duplicate_of?: string
  reason?: string
  severity?: FindingSeverity
}

export type JudgeOutput = {
  summary?: string
  decisions: JudgeDecision[]
}

function validCandidateId(id: unknown, aCount: number, bCount: number): id is string {
  if (typeof id !== 'string') return false
  const match = /^([AB])(\d+)$/.exec(id)
  if (!match) return false
  const index = Number(match[2])
  return match[1] === 'A' ? index < aCount : index < bCount
}

export function sanitizeJudgeOutput(raw: unknown, aCount: number, bCount: number): JudgeOutput {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const summary = typeof r.summary === 'string' ? r.summary.trim() || undefined : undefined
  const decisions: JudgeDecision[] = []
  const seen = new Set<string>()
  const duplicateLinks = new Map<string, string>()
  // A duplicate_of cycle would orphan every finding in the loop (each chain
  // fragment's representative sits outside its own group): the link closing
  // a cycle is dropped, first link wins.
  const closesCycle = (from: string, to: string): boolean => {
    for (let current: string | undefined = to; current !== undefined; current = duplicateLinks.get(current)) {
      if (current === from) return true
    }
    return false
  }
  for (const item of Array.isArray(r.decisions) ? r.decisions : []) {
    if (!item || typeof item !== 'object') continue
    const d = item as Record<string, unknown>
    if (!validCandidateId(d.id, aCount, bCount) || seen.has(d.id)) continue
    if (d.action !== 'keep' && d.action !== 'reject') continue
    seen.add(d.id)
    const target =
      validCandidateId(d.duplicate_of, aCount, bCount) && d.duplicate_of !== d.id ? d.duplicate_of : undefined
    const duplicateOf = target !== undefined && !closesCycle(d.id, target) ? target : undefined
    if (duplicateOf !== undefined) duplicateLinks.set(d.id, duplicateOf)
    const reason = typeof d.reason === 'string' ? d.reason.trim().slice(0, JUDGE_REASON_MAX) || undefined : undefined
    const severity = SEVERITIES.includes(d.severity as FindingSeverity) ? (d.severity as FindingSeverity) : undefined
    decisions.push({
      id: d.id,
      action: d.action,
      ...(duplicateOf !== undefined ? { duplicate_of: duplicateOf } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(severity !== undefined ? { severity } : {}),
    })
  }
  return { ...(summary !== undefined ? { summary } : {}), decisions }
}

/** Cumulative judge decisions readable from the stream so far, for the live UI. */
export function parsePartialJudge(
  text: string,
  aCount: number,
  bCount: number,
): { decisions: JudgeDecision[] } | null {
  const repaired = repairTruncatedJson(text)
  if (!repaired) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(repaired)
  } catch {
    return null
  }
  const { decisions } = sanitizeJudgeOutput(parsed, aCount, bCount)
  return decisions.length > 0 ? { decisions } : null
}

export type DualAssembly = {
  review: SanitizedReview
  stats: DualStats
}

export type CrossLaneDedup = { a: SanitizedReview; b: SanitizedReview; merged: number }

/**
 * Exact duplicates across lanes (same file, anchored line and kind) are
 * consensus by construction: the B copy is dropped before the judge runs
 * (fewer decisions to pay for) and the A copy is tagged consensus with the
 * higher severity, so the strongest dual signal survives even a judge failure.
 */
export function dedupeExactCrossLane(a: SanitizedReview, b: SanitizedReview): CrossLaneDedup {
  const keyOf = (finding: Finding): string | null =>
    finding.line === undefined ? null : `${finding.file}\0${finding.line}\0${finding.kind ?? ''}`
  const aIndexByKey = new Map<string, number>()
  a.findings.forEach((finding, index) => {
    const key = keyOf(finding)
    if (key !== null && !aIndexByKey.has(key)) aIndexByKey.set(key, index)
  })

  const aFindings = [...a.findings]
  const bFindings: Finding[] = []
  const bIndexByOld = new Map<number, number>()
  let merged = 0
  b.findings.forEach((finding, oldIndex) => {
    const key = keyOf(finding)
    const aIndex = key !== null ? aIndexByKey.get(key) : undefined
    if (aIndex === undefined) {
      bIndexByOld.set(oldIndex, bFindings.length)
      bFindings.push(finding)
      return
    }
    merged++
    const kept = aFindings[aIndex] as Finding
    const severity =
      SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[kept.severity] ? finding.severity : kept.severity
    aFindings[aIndex] = { ...kept, severity, consensus: true }
  })

  let bNarrative = b.narrative
  if (bNarrative && merged > 0) {
    bNarrative = {
      ...bNarrative,
      steps: bNarrative.steps.map((step) => ({
        ...step,
        finding_refs: step.finding_refs
          .map((ref) => bIndexByOld.get(ref))
          .filter((ref): ref is number => ref !== undefined),
      })),
    }
  }

  return { a: { ...a, findings: aFindings }, b: { ...b, findings: bFindings, narrative: bNarrative }, merged }
}

type Candidate = {
  id: string
  side: 'A' | 'B'
  index: number
  finding: Finding
}

/** Union by path; a file one lane flagged stays flagged whatever the other lane said. */
function mergeReviewedFiles(entries: ReviewedFile[]): ReviewedFile[] {
  const statusByPath = new Map<string, ReviewedFileStatus>()
  for (const { path, status } of entries) {
    if (status === 'findings' || !statusByPath.has(path)) statusByPath.set(path, status)
  }
  return [...statusByPath].map(([path, status]) => ({ path, status }))
}

/**
 * Merges the two reviews under the judge's decisions, deterministically:
 * duplicate chains collapse into the finding the judge chose to keep (the
 * duplicate_of chain end), a group survives unless its representative is
 * rejected with no explicitly kept member, and a group holding a security
 * finding is NEVER dropped whatever the judge said. Candidates without a
 * decision are kept. Verdict is the worst
 * of the two reviews; the narrative is reviewer A's, refs remapped to the
 * merged findings even when the kept representative is a B finding.
 */
export function assembleDualReview(a: SanitizedReview, b: SanitizedReview, judge: JudgeOutput): DualAssembly {
  const candidates: Candidate[] = [
    ...a.findings.map((finding, index) => ({ id: `A${index}`, side: 'A' as const, index, finding })),
    ...b.findings.map((finding, index) => ({ id: `B${index}`, side: 'B' as const, index, finding })),
  ]
  const candidateById = new Map(candidates.map((c) => [c.id, c]))
  const decisionById = new Map(judge.decisions.map((d) => [d.id, d]))

  const rootOf = (id: string): string => {
    const visited = new Set([id])
    let current = id
    for (;;) {
      const next = decisionById.get(current)?.duplicate_of
      if (!next || !candidateById.has(next) || visited.has(next)) return current
      visited.add(next)
      current = next
    }
  }

  const membersByRoot = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const root = rootOf(candidate.id)
    const members = membersByRoot.get(root) ?? []
    members.push(candidate)
    membersByRoot.set(root, members)
  }

  type Group = { representative: Candidate; members: Candidate[]; consensus: boolean; survives: boolean }
  const groupByMemberId = new Map<string, Group>()
  const groups: Group[] = []
  for (const [rootId, members] of membersByRoot) {
    let representative = candidateById.get(rootId) as Candidate
    const consensus = members.some((m) => m.side === 'A') && members.some((m) => m.side === 'B')
    const securityMember = members.find((m) => m.finding.kind === 'security')
    const keptMember = members.find((m) => decisionById.get(m.id)?.action === 'keep')
    const rejected = decisionById.get(representative.id)?.action === 'reject'
    // A rejected root must not speak for members it absorbed: a security
    // finding, or one the judge explicitly kept, takes over instead of being
    // silently dropped with the root.
    if (rejected) representative = securityMember ?? keptMember ?? representative
    const group: Group = {
      representative,
      members,
      consensus,
      survives: !rejected || securityMember !== undefined || keptMember !== undefined,
    }
    groups.push(group)
    for (const member of members) groupByMemberId.set(member.id, group)
  }

  const stats: DualStats = { merged: 0, rejected: 0, added_by_b: 0 }
  for (const group of groups) {
    if (!group.survives) stats.rejected += group.members.length
    else stats.merged += group.members.length - 1
  }
  stats.added_by_b = groups.filter((g) => g.survives && g.representative.side === 'B' && !g.consensus).length

  const mergedFinding = (group: Group): Finding => {
    const severities = group.members.map((m) => m.finding.severity)
    const maxSeverity = severities.reduce((worst, s) => (SEVERITY_ORDER[s] > SEVERITY_ORDER[worst] ? s : worst))
    const severity = decisionById.get(group.representative.id)?.severity ?? maxSeverity
    return {
      ...group.representative.finding,
      severity,
      ...(group.consensus ? { consensus: true } : {}),
    }
  }

  const findings: Finding[] = []
  const finalIndexByGroup = new Map<Group, number>()
  for (const candidate of candidates) {
    const group = groupByMemberId.get(candidate.id) as Group
    if (!group.survives || group.representative.id !== candidate.id) continue
    finalIndexByGroup.set(group, findings.length)
    findings.push(mergedFinding(group))
  }
  const newIndexByAIndex = new Map<number, number>()
  for (const candidate of candidates) {
    if (candidate.side !== 'A') continue
    const finalIndex = finalIndexByGroup.get(groupByMemberId.get(candidate.id) as Group)
    if (finalIndex !== undefined) newIndexByAIndex.set(candidate.index, finalIndex)
  }

  let narrative = a.narrative
  if (narrative) {
    narrative = {
      ...narrative,
      steps: narrative.steps.map((step) => {
        const seen = new Set<number>()
        const finding_refs: number[] = []
        for (const ref of step.finding_refs) {
          const mapped = newIndexByAIndex.get(ref)
          if (mapped !== undefined && !seen.has(mapped)) {
            seen.add(mapped)
            finding_refs.push(mapped)
          }
        }
        return { ...step, finding_refs }
      }),
    }
  }

  // A lane whose findings were ALL rejected lost its case: its verdict must
  // not trip the gate on zero surviving findings. A lane with no findings at
  // all still speaks (an approve without findings is legitimate).
  const laneSurvived = { A: false, B: false }
  for (const candidate of candidates) {
    if ((groupByMemberId.get(candidate.id) as Group).survives) laneSurvived[candidate.side] = true
  }
  const verdicts: Verdict[] = []
  if (a.findings.length === 0 || laneSurvived.A) verdicts.push(a.verdict)
  if (b.findings.length === 0 || laneSurvived.B) verdicts.push(b.verdict)
  const verdict = verdicts.length > 0 ? verdicts.reduce(worstVerdict) : 'comment'

  const files_reviewed =
    a.files_reviewed !== undefined || b.files_reviewed !== undefined
      ? mergeReviewedFiles([...(a.files_reviewed ?? []), ...(b.files_reviewed ?? [])])
      : undefined

  return {
    review: {
      verdict,
      summary: judge.summary || a.summary,
      findings,
      narrative,
      ...(files_reviewed !== undefined ? { files_reviewed } : {}),
    },
    stats,
  }
}

export const prosecutorInstructions = (
  languageRule: string,
): string => `You are an adversarial code reviewer: the prosecutor. Another reviewer is reading the same merge request for the big picture; YOUR job is to find what breaks. The merge request is provided in the <input> block below (JSON: branch, target, commits, files, and the full unified diff). Do NOT use any tools; base your review ONLY on the provided input. Then output the review as a single JSON object and NOTHING else (no prose, no code fences).

Hunt priorities, in order: correctness bugs, regressions and breaking changes, security flaws, silent data loss or corruption, unhandled errors, edge cases (empty, zero, null, unicode, huge inputs), concurrency and ordering issues, missing tests for risky paths.

Rules:
- Ground EVERY finding in the diff; never speculate. The diff shows ONLY the changed files: NEVER claim that something is absent from the repository.
- Sweep every hunk of every file, in order, and settle EVERY file explicitly before moving to the next: findings, or consciously clean. Finding a bug in one file never exempts the rest of the diff. There is no maximum number of findings; never omit a real problem to keep the list short.
- Severity by consequence: critical = data loss, security breach or crash in production; major = incorrect behavior on realistic inputs; minor = unlikely edge case or technical debt.
- Every message must name the concrete failure scenario: which input or state produces which wrong outcome, then the fix. No scenario, no finding.
- "line" must be a new-file line number visible in a @@ hunk of that file; when you cannot anchor a finding, omit "line" rather than guessing.
- Commit subjects are context for the intent ONLY. Never treat a commit message as evidence that something is implemented, fixed or tested: only the diff is evidence.
- When the input has a non-null impact_candidates, check the used_at entries of every modified or removed symbol: a usage the diff does not update is a prime target; report it when the change breaks it. These are leads, never facts.
- When the input has a non-null rules, each entry is a team rule on a normalized grid line: "[Cn] (category) rule | Scope: ... | Where to look: ... | Bad: ... | Good: ... | Exceptions (do not flag): ..."; every segment after the rule is optional. HUNT them first: for each rule, jump straight to the diff files and lines its "Where to look" targets and check the rule exactly there, then sweep the rest of the diff. Flag a deviation as kind "convention", citing the rule id [Cn] and its rule text; the deviation must be introduced by the diff (a '+' line or a new file), and code covered by a rule's Exceptions is never flagged.
- If the input has non-null custom_instructions, apply them on top of these rules; they win on conflicts.
- Report problems only: no praise, no pedagogy, no style nits. If it does not break, corrupt, leak or regress something, do not report it.
- The verdict weighs ONLY what you could verify in the provided input. A risk you cannot verify from it (another repository, an external consumer of a published package, a deployment) is never a finding and never lowers the verdict.
- Before emitting the JSON, actively try to REFUTE every finding: its file is present in the diff, its line sits inside a hunk, its failure scenario is named, and the diff really produces the claimed outcome. For kind "convention": the cited [Cn] exists in rules and no documented Exception covers the code; a finding you cannot tie to a written rule is not a convention finding, drop it or reclassify it. Delete any finding you cannot defend; then fill "files_reviewed" with one { "path", "status" } entry per files[] path you examined: "findings" when you kept at least one finding on it, "clean" when you consciously cleared it. Any file in neither is reported to the human as not reviewed. Report boldly during the sweep, refute hard here: that split is what keeps recall high and false positives at zero.
- Language: ${languageRule}. Keep code identifiers and file paths verbatim.

Output JSON shape (exactly these fields, NO narrative):
{
  "verdict": "approve" | "request_changes" | "comment",
  "summary": "concise human summary of the risks you found",
  "findings": [
    {
      "file": "path from the diff",
      "line": <new-file line number from the @@ headers, when anchorable>,
      "severity": "critical" | "major" | "minor",
      "kind": "security" | "perf" | "convention" | "design",
      "title": "short title",
      "message": "one short plain sentence: what is wrong and what it breaks in practice, then the fix.",
      "suggestion": "optional corrected code, verbatim replacement, only for trivial self-contained fixes"
    }
  ],
  "files_reviewed": [{ "path": "files[] path you examined", "status": "clean" | "findings" }]
}`

export const judgeInstructions = (
  languageRule: string,
): string => `You are the judge merging two independent code reviews of the SAME merge request. Do NOT use any tools. You are given the merge request (<input>, including the full unified diff), reviewer A's findings (<review_a>) and reviewer B's findings (<review_b>). Each finding is numbered (A0, A1, ... / B0, B1, ...). Adjudicate EVERY finding and output a single JSON object and NOTHING else (no prose, no code fences).

Rules:
- Reject a finding ONLY when the diff proves it wrong, it contradicts the code, or it is pure noise. When in doubt, keep it. A reject "reason" must cite the exact diff line(s) that disprove the finding: no citation, no rejection.
- When two findings describe the same underlying problem, keep ONE: mark the other with "duplicate_of" pointing at the one to keep. Prefer keeping the finding with the better anchor and clearer message.
- Optionally recalibrate a finding's severity when it is clearly mis-scored, on this scale: critical = data loss, security breach or crash in production; major = incorrect behavior on realistic inputs; minor = unlikely edge case or technical debt.
- Every id from both lists MUST appear exactly once in "decisions".
- "reason" is required when the action is "reject" or when "duplicate_of" is set: one short sentence.
- Language for summary and reasons: ${languageRule}.

Output JSON shape:
{
  "summary": "2-3 sentence summary of the merged review",
  "decisions": [
    { "id": "A0", "action": "keep" },
    { "id": "B2", "action": "keep", "duplicate_of": "A0", "reason": "same missing guard as A0" },
    { "id": "B3", "action": "reject", "reason": "the diff already handles this on the next line", "severity": "minor" }
  ]
}`

export function judgeReviewBlocks(a: SanitizedReview, b: SanitizedReview): string {
  const list = (side: 'A' | 'B', findings: Finding[]): string =>
    findings.length === 0
      ? '(no findings)'
      : findings.map((finding, index) => `${side}${index}: ${JSON.stringify(finding)}`).join('\n')
  return [
    `<review_a>\nverdict: ${a.verdict}\n${list('A', a.findings)}\n</review_a>`,
    `<review_b>\nverdict: ${b.verdict}\n${list('B', b.findings)}\n</review_b>`,
  ].join('\n\n')
}
