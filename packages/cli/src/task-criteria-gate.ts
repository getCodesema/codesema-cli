// T3.2 (D11): the acceptance-criteria gate of the end-of-turn review.
//
// The whole point of this module is WHERE the verdict is computed. The model is
// asked for one status per criterion and for an anchored quote; it is never
// asked — and never read — for a percentage, a score or an overall verdict.
// Everything that decides is here, deterministic, on the CLI side:
//
//   - the join is on the ticket's STABLE ids (T2.3), so a criterion the model
//     invented is discarded and a criterion it skipped is still judged;
//   - the grounding of the evidence is the contract's `groundCriterionVerdicts`
//     (the `groundReview` pattern), so a proof that does not exist in the diff
//     does not count as one;
//   - the global verdict is a pure function of the surviving statuses, and it
//     has exactly one passing state.
//
// Deliberately asymmetric (design decision 3): the cost of a false "satisfied"
// is a merged half-finished ticket, the cost of a false "not satisfied" is a
// "needs you". So a doubt blocks.
//
// Named `task-criteria-gate` and not `task-criteria`: that name is taken by
// T2.5's persistence of the human-VALIDATED list, which is the other half of
// the same story — that module decides which criteria exist, this one decides
// whether the branch meets them.

import {
  groundCriterionVerdicts,
  sanitizeCriterionVerdict,
  sanitizeCriterionVerdicts,
  TICKET_CRITERIA_MAX,
  type AcceptanceCriterion,
  type CriteriaGroundingReport,
  type CriterionStatus,
  type CriterionVerdict,
} from './contract.js'

/**
 * How many blocking criterion ids the readable reason names before it stops.
 * A reason is read by a human on a card, and a ticket may carry up to
 * `TICKET_CRITERIA_MAX` (32) of them: past a handful the sentence stops being
 * information and becomes a wall. The COUNTS, which are always complete, are
 * what the sentence leads with.
 */
export const CRITERIA_REASON_IDS_MAX = 6

/**
 * The mandatory chapter appended to the review prompt when the task carries
 * acceptance criteria. One line per criterion WITH ITS STABLE ID: the id is
 * the join key on the way back, and it is derived from the criterion's text
 * (T2.3), never from its position — inserting a criterion at the top renames
 * nothing.
 *
 * The chapter also states, in the prompt itself, that no percentage and no
 * overall verdict is read. That is not a request for good behaviour we then
 * trust: `resolveCriteria` below cannot see those fields even if they are
 * emitted. Saying it in the prompt only stops the model from spending its
 * output on something that goes nowhere.
 */
export function buildCriteriaChapter(criteria: readonly AcceptanceCriterion[]): string {
  return [
    'Acceptance criteria — MANDATORY chapter:',
    'This task is judged criterion by criterion against the list below. Judge EACH criterion against the diff in <input> and nothing else.',
    ...criteria.map((criterion) => `- [${criterion.id}] ${criterion.text}`),
    '',
    'Add ONE more top-level field to the JSON you output, after "files_reviewed":',
    '"criteria": [{ "criterion_id": "one of the ids above, verbatim", "status": "met" | "unmet" | "unclear", "evidence": "<path>:<line> — short quote of that line" }]',
    '',
    'Rules for this chapter:',
    '- Exactly one entry per criterion listed above. Never invent an id and never merge two criteria into one entry: an id absent from the list above is discarded, and a criterion you leave out is judged "unclear" anyway.',
    '- "evidence" MUST START with a path from the diff and a new-file line number visible in one of that file\'s @@ hunks, written exactly as "path:line", and only then your quote. An evidence that does not start with such an anchor is removed and the criterion falls back to "unclear".',
    '- "met" means the diff ITSELF shows the criterion satisfied, at that anchor. A criterion you believe is satisfied but cannot anchor in the diff is "unclear", never "met". A commit message is never evidence.',
    '- Do NOT output a completion percentage, a score, a ratio or an overall criteria verdict. They are not read: the gate is computed from the per-criterion statuses alone.',
  ].join('\n')
}

export type CriteriaCounts = { met: number; unmet: number; unclear: number }

export type CriteriaOutcome = {
  /** Exactly one entry per criterion of the task, in the ticket's own order. */
  verdicts: CriterionVerdict[]
  /** The only passing state: every criterion `met`, each on a surviving anchor. */
  satisfied: boolean
  counts: CriteriaCounts
  /**
   * How many readable entries named an id this task does not carry. Journaled
   * when non-zero: a reviewer judging criteria that are not on this ticket
   * means the prompt and the record disagree, and that is worth saying rather
   * than absorbing in silence.
   */
  unknown_ids: number
  /**
   * How many criteria no readable entry ever judged — the reviewer returned
   * nothing usable about them: it said nothing, it named them in prose instead
   * of in `criterion_id`, or `criteria` was not even an array. All three land
   * here rather than being folded into the `unclear` tally, because "the
   * reviewer could not conclude" and "nothing came back to read" are different
   * facts about the same number.
   */
  unjudged: number
  /**
   * How many verdicts claimed an evidence whose anchor the diff does not
   * carry. The proof was REMOVED; the criterion is not blamed for the diff.
   */
  dropped_evidence: number
  /** How many verdicts had their status forced down to `unclear` for want of a surviving proof. */
  demoted: number
  /**
   * The reported list arrived at the contract's `TICKET_CRITERIA_MAX` ceiling
   * while criteria of this task went unjudged: `sanitizeCriterionVerdicts`
   * stops reading at that many entries, so a reviewer that filled them with
   * ids this ticket does not carry can push REAL verdicts out of the list
   * before the gate ever sees them. Measured, not assumed — and said, because
   * the tally it produces is otherwise indistinguishable from a reviewer that
   * simply judged nothing.
   */
  overflowed: boolean
  report: CriteriaGroundingReport
}

/**
 * The per-criterion statuses this task's gate actually uses: the model's
 * report, joined onto the task's own criteria list and normalized so that
 * EVERY criterion carries EXACTLY ONE status.
 *
 * Four normalizations, in this order, and each of them is a rule the gate
 * depends on:
 *
 *  1. an entry whose `criterion_id` is not one of THIS task's criteria is
 *     discarded outright — it cannot influence any status, and it is never
 *     "repaired" into one of the real ids;
 *  2. what survives is grounded against the diff (contract side): an evidence
 *     that points nowhere is removed and takes an unproven `met` down with it;
 *  3. a criterion reported twice keeps its FIRST surviving entry, so two
 *     contradictory statuses can never both stand;
 *  4. a criterion the model never mentioned is `unclear` — present in the
 *     result, never absent, because the caller must be able to show a status
 *     for every line of the ticket.
 */
export function resolveCriteria(
  criteria: readonly AcceptanceCriterion[],
  reported: readonly CriterionVerdict[] | undefined,
  diff: string,
): CriteriaOutcome {
  const known = new Set(criteria.map((criterion) => criterion.id))
  // Re-sanitized ENTRY BY ENTRY rather than through `sanitizeCriterionVerdicts`
  // on the whole list, and that is round 2's mineur 5, not a stylistic
  // preference: `sanitizeCriterionVerdicts` stops reading at
  // `TICKET_CRITERIA_MAX` ENTRIES, so a reviewer that opens its list with 32
  // well-formed ids this ticket does not carry pushes every REAL verdict past
  // the ceiling — measured: three anchored `met` silently became three
  // `unclear`, and no counter said so. Splitting first and capping the OWN
  // entries afterwards keeps the same bound on what is kept while making the
  // ceiling fall on the noise instead of on the work.
  //
  // It also still re-applies the contract's own rules — invented id dropped,
  // out-of-enum status down to 'unclear' — on every caller, including a
  // hand-written archive: this function is the gate's entry point and MUST NOT
  // throw whatever it is handed (invariant n° 1). The bound that matters — how
  // many verdicts are KEPT — is unchanged and still the contract's; only the
  // SCAN is now linear in what the caller hands over, and the production caller
  // reads a list `sanitizeReview` already capped at `TICKET_CRITERIA_MAX`.
  const raw = Array.isArray(reported) ? reported : []
  const own: CriterionVerdict[] = []
  const unknown = new Set<string>()
  for (const entry of raw) {
    const verdict = sanitizeCriterionVerdict(entry)
    if (!verdict) {
      // Junk the contract could not read at all: never a claim about a
      // criterion, only noise. Counted nowhere — the criteria it failed to
      // name show up as `unjudged` below, which is the honest description.
      continue
    }
    if (known.has(verdict.criterion_id)) {
      own.push(verdict)
    } else {
      unknown.add(verdict.criterion_id)
    }
  }
  // The dedup and the cap, both of them the contract's, applied to this
  // ticket's OWN entries: first occurrence wins, at most one full ticket's
  // worth of verdicts.
  const claimed = sanitizeCriterionVerdicts(own)
  const grounded = groundCriterionVerdicts(claimed, diff)
  // A plain set, no first-wins guard: `sanitizeCriterionVerdicts` above has
  // ALREADY deduplicated on `criterion_id`, first occurrence wins — a contract
  // GUARANTEE its own doc states (the JSON Schema cannot express "unique by
  // property"). Grounding maps one verdict to one verdict and the filter only
  // removes, so the ids reaching this loop are pairwise distinct and a guard
  // here would be a branch no input can enter — a mutation campaign found it
  // unkillable, which is the honest definition of dead.
  const byId = new Map<string, CriterionVerdict>()
  for (const verdict of grounded.verdicts) {
    byId.set(verdict.criterion_id, verdict)
  }
  const verdicts = criteria.map(
    (criterion): CriterionVerdict =>
      byId.get(criterion.id) ?? { criterion_id: criterion.id, status: 'unclear' },
  )
  const counts: CriteriaCounts = { met: 0, unmet: 0, unclear: 0 }
  for (const verdict of verdicts) {
    counts[verdict.status] += 1
  }
  const unjudged = criteria.filter((criterion) => !byId.has(criterion.id)).length
  return {
    verdicts,
    // INVARIANT n° 4, as code: the only thing consulted is the tally of the
    // statuses computed above. Nothing the model asserted about the WHOLE —
    // "all satisfied", "90% done" — has any path to this boolean.
    satisfied: verdicts.length > 0 && counts.met === verdicts.length,
    counts,
    // Readable entries naming an id this task does not carry, counted once per
    // distinct id.
    unknown_ids: unknown.size,
    unjudged,
    dropped_evidence: grounded.report.dropped_evidence.length,
    demoted: grounded.report.demoted.length,
    // The ceiling was REACHED (`>=`, not `>`) and something of this ticket went
    // unjudged: only then can the cut have eaten a real verdict. `>=` is what
    // makes this fire on the production path at all — the archive this gate
    // reads has already been through `sanitizeReview`, which caps the list at
    // exactly `TICKET_CRITERIA_MAX`, so a longer one never reaches here. A
    // reviewer that returned a full, correct list of 32 is not accused of
    // overflowing: nothing went unjudged.
    overflowed: raw.length >= TICKET_CRITERIA_MAX && unjudged > 0,
    report: grounded.report,
  }
}

/** `1 criterion` / `3 criteria` — a count and the word that agrees with it. */
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * WHY those criteria are not satisfied, when the reason is something other
 * than the reviewer's own judgement. Round 2, majeur 1(b): the gate already
 * MEASURED every one of these — `dropped_evidence`, `demoted`, `unjudged`,
 * `unknown_ids`, the 32-entry ceiling — and then told nobody, so
 * "3 acceptance criteria are not satisfied (3 unclear)" read exactly the same
 * whether the reviewer had weighed the work and doubted, or whether nothing
 * usable had come back at all. That is the argument this file already made
 * for `diff_unreadable`, and it was made for one case and not for its twin
 * three lines away: the honest decision, announced dishonestly.
 *
 * Empty when the tally really does mean what it says.
 */
function criteriaBlockingCauses(outcome: CriteriaOutcome): string[] {
  const causes: string[] = []
  // Leads, and swallows the anchor causes below: when the diff could not be
  // indexed, NOTHING was checkable, so "the evidence pointed nowhere" would
  // blame the reviewer for a failure that is entirely on our side.
  if (outcome.report.diff_unreadable) {
    causes.push('the reviewed diff could not be indexed, so no evidence could be checked')
  } else {
    if (outcome.dropped_evidence > 0) {
      causes.push(
        `${plural(outcome.dropped_evidence, 'evidence quote', 'evidence quotes')} pointed at a line this diff does not carry`,
      )
    }
    if (outcome.demoted > 0) {
      causes.push(
        `${plural(outcome.demoted, 'verdict', 'verdicts')} fell back to 'unclear' for want of a surviving proof`,
      )
    }
  }
  if (outcome.unjudged > 0) {
    causes.push(
      `${plural(outcome.unjudged, 'criterion', 'criteria')} got no verdict back from the reviewer at all`,
    )
  }
  if (outcome.unknown_ids > 0) {
    causes.push(
      `the reviewer also judged ${plural(outcome.unknown_ids, 'id', 'ids')} this task does not carry`,
    )
  }
  if (outcome.overflowed) {
    causes.push(
      `the reported list reached its ${TICKET_CRITERIA_MAX}-entry ceiling, so real verdicts may have been cut from it`,
    )
  }
  return causes
}

/**
 * The readable sentence the `criteria_unmet` code is ADDED to, never a
 * replacement for (invariant n° 2). It leads with the complete counts — the
 * part that is always exact — then names as many blocking criteria as it
 * reasonably can, so a human knows WHICH ones without opening the archive, and
 * closes on WHY when the counts alone would misdescribe the situation.
 */
export function criteriaUnmetDetail(outcome: CriteriaOutcome): string {
  const blocking = outcome.verdicts.filter((verdict) => verdict.status !== 'met')
  const parts: string[] = []
  if (outcome.counts.unmet > 0) {
    parts.push(`${outcome.counts.unmet} unmet`)
  }
  if (outcome.counts.unclear > 0) {
    parts.push(`${outcome.counts.unclear} unclear`)
  }
  const named = blocking
    .slice(0, CRITERIA_REASON_IDS_MAX)
    .map((verdict) => `${verdict.criterion_id}: ${verdict.status}`)
    .join(', ')
  const more = blocking.length > CRITERIA_REASON_IDS_MAX ? ', …' : ''
  const causes = criteriaBlockingCauses(outcome)
  const why = causes.length > 0 ? ` — ${causes.join('; ')}` : ''
  return `${blocking.length} of ${outcome.verdicts.length} acceptance criteria are not satisfied (${parts.join(', ')}) — ${named}${more}${why}`
}

/**
 * The chapter T3.3's automatic fix turn appends to the review's own fix prompt
 * when the criteria gate is what blocks. Null when nothing blocks — every
 * criterion `met`, or a task that carries none — so the caller can tell
 * "nothing to say" from "an empty chapter".
 *
 * It exists because `buildAgentFixPrompt` only knows how to speak about
 * FINDINGS: a review that approved the code and still failed this gate
 * produces no finding at all, and a round of the loop spent on an empty
 * `<findings>[]` would name no work. The criterion's own TEXT travels here,
 * not just its id — the id is a join key, not an instruction.
 *
 * The statuses read are the gate's OWN normalized verdicts (`resolveCriteria`
 * wrote them onto the archived review), never the model's raw report.
 */
export function unmetCriteriaFixChapter(
  criteria: readonly AcceptanceCriterion[],
  verdicts: readonly CriterionVerdict[] | undefined,
): string | null {
  const status = new Map((verdicts ?? []).map((verdict) => [verdict.criterion_id, verdict.status]))
  // A criterion the archive says nothing about is NOT assumed satisfied:
  // `resolveCriteria` reads a missing entry as `unclear`, and this chapter has
  // to name exactly what the gate blocked on.
  const blocking = criteria.filter((criterion) => (status.get(criterion.id) ?? 'unclear') !== 'met')
  if (blocking.length === 0) {
    return null
  }
  return [
    'Acceptance criteria still not satisfied — MANDATORY:',
    'This branch is judged criterion by criterion. The ones below are NOT satisfied by the diff yet. The rules above still apply, the "do not commit" one included.',
    ...blocking.map(
      (criterion) =>
        `- [${criterion.id}] (${status.get(criterion.id) ?? 'unclear'}) ${criterion.text}`,
    ),
    '',
    'Make the diff itself show each of them. A criterion judged "unclear" was not disproved: it could not be anchored in the diff at all, so either implement it or make the evidence visible in the code you change.',
  ].join('\n')
}

/**
 * Which of two dual lanes' statuses stands for one criterion. Ranked by how
 * much it blocks, most blocking last: a lane that positively identified a
 * failure (`unmet`) beats a lane that shrugged (`unclear`), which beats a lane
 * that claimed success (`met`).
 *
 * This is a CLI-side reconciliation, not a vote: two reviewers disagreeing
 * about a criterion is exactly the case where the gate must not resolve to
 * "satisfied".
 */
const STATUS_BLOCKING_RANK: Record<CriterionStatus, number> = { met: 0, unclear: 1, unmet: 2 }

/**
 * Two lanes' criterion verdicts folded into one list (dual review). The
 * pessimistic status wins, and the evidence kept is the one belonging to the
 * status that won — so a surviving anchor never travels under a status it did
 * not support.
 *
 * ARBITRATED, round 2, mineur 6 — the rule is pessimistic between STATUSES THE
 * TWO LANES BOTH STATED, and one lane's SILENCE about a criterion is not a
 * doubt. A criterion lane A never mentioned and lane B judged `met` on a
 * surviving anchor comes out `met`, which makes dual mode no stricter than
 * simple mode on that criterion, where the same single reviewer's word would
 * also stand.
 *
 * The stricter reading — "a criterion only one lane spoke about is `unclear`"
 * — was considered and REFUSED, because it re-opens the exact failure this
 * ticket's round 2 had to close on the other side: it makes a lane that stays
 * quiet (a truncated answer, a prosecutor that skipped the chapter, a lane
 * that died) block every ticketed task in dual mode, with a human as the only
 * way out. A grounded proof is a proof whichever lane found it; a lane that
 * said nothing has objected to nothing.
 *
 * What that leaves is NOT a hole in the gate: `resolveCriteria` still forces
 * every criterion NEITHER lane spoke about to `unclear`, and still grounds
 * every surviving evidence against the diff. The only relaxation is which of
 * two reviewers had to find the proof.
 */
export function mergeCriterionVerdicts(
  a: readonly CriterionVerdict[] | undefined,
  b: readonly CriterionVerdict[] | undefined,
): CriterionVerdict[] {
  const merged = new Map<string, CriterionVerdict>()
  for (const verdict of [...(a ?? []), ...(b ?? [])]) {
    const seen = merged.get(verdict.criterion_id)
    if (!seen || STATUS_BLOCKING_RANK[verdict.status] > STATUS_BLOCKING_RANK[seen.status]) {
      merged.set(verdict.criterion_id, verdict)
    }
  }
  return [...merged.values()]
}
