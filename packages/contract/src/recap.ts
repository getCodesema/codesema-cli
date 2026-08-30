// The normalized task recap (T3.4, decision D10). Same doctrine as the rest of
// the contract: whitelist and truncate, never throw, JSON Schema published
// alongside the sanitizer so the two cannot drift apart unnoticed (the cross
// test in recap.test.ts is what enforces that in practice).
//
// Invariant 4, applied structurally here rather than by filtering: the
// generator (packages/cli/src/task-recap.ts) reads `summary`, `changes[]` and
// `decisions[]` from the model and NOTHING else — every other field below is
// filled from a measurement (a diff, a persisted checks.json, the task record,
// the ship outcome). This module only encodes the SHAPE of that guarantee
// (which fields exist, how they are bounded); the generator is what actually
// withholds the model's own numbers and statuses from them.

import { TASK_PATH_MAX, type CostBasis, type TaskCheckStatus } from './tasks.js'
import {
  CRITERION_VERDICT_EVIDENCE_MAX,
  CRITERION_VERDICT_QUESTION_MAX,
  cutCodePoints,
  NON_BLANK,
  sanitizeCriterionVerdict,
  TICKET_CRITERIA_MAX,
  TICKET_CRITERION_TEXT_MAX,
  type CriterionVerdict,
} from './ticket.js'

/**
 * `TaskCheckStatus` widened with the two whole-run states a recap must be able
 * to name honestly: `'unconfigured'` (nothing was detected or configured — an
 * EMPTY `tests[]` here would be misread as "everything passed", which is
 * exactly the false green the spec forbids) and `'error'` (the check run
 * itself could not happen). Both travel as a single synthetic entry rather
 * than vanishing into an empty list.
 */
export type RecapTestStatus = TaskCheckStatus | 'unconfigured' | 'error'

export type RecapTestEntry = {
  command: string
  status: RecapTestStatus
  /**
   * True ONLY on the synthetic entry the generator inserts for an
   * 'unconfigured'/'error' whole run — where `command` is a readable phrase,
   * not an actual command. Carried in the TYPE, not left for a reader to infer
   * from `command`'s prose, so "is this a real check?" is answerable without
   * parsing a sentence. Absent (never `false`) on every real check entry.
   */
  synthetic?: true
}

/**
 * One criterion's verdict, denormalized for a document that reads on its own,
 * outside any context (DP12): `CriterionVerdict` alone only names the
 * criterion by `criterion_id`, which means nothing without the ticket beside
 * it. `text` is that ticket's own wording, resolved by the generator at build
 * time.
 *
 * `text` is OPTIONAL and not part of `CriterionVerdict` itself: a verdict
 * whose criterion the generator could not resolve (a stale review, a ticket
 * rewritten since) still names a real `criterion_id` and `status` worth
 * keeping — dropping the whole entry for a text lookup miss would discard a
 * fact to protect a caption.
 */
export type RecapCriterionVerdict = CriterionVerdict & {
  text?: string
}

export type RecapRecord = {
  /** Stays 1 as long as no field is removed (contract versioning doctrine, same as TaskRecord and ReviewRecord). */
  version: 1
  /** Model-authored. One of exactly three fields the model may fill (invariant 4) — never a number, a percentage or a status. */
  summary: string
  /** Model-authored bullets of what changed, in words. */
  changes: string[]
  /** Model-authored bullets of the decisions taken along the way. */
  decisions: string[]
  /** Every file touched, read from the `baseline..branch` diff. Never from the model. */
  files: string[]
  /** One entry per check command that actually ran, or a synthetic entry naming an 'unconfigured'/'error' whole run. Never from the model. */
  tests: RecapTestEntry[]
  /**
   * Per-criterion verdicts, denormalized with their text (DP12). OPTIONAL:
   * absence means "this task judged no criteria" — the normal state of a task
   * with no linked ticket, or of one whose review has not produced
   * per-criterion verdicts (T3.2). Never a value the model asserted.
   */
  criteria?: RecapCriterionVerdict[]
  /**
   * Total LLM tokens across the task's turns, SUMMED by the CLI from
   * `TaskTurn.tokens` — a measurement, never a figure the model restates.
   * OPTIONAL, and absence is the honest default: no turn reporting a count
   * means nothing to sum, not a free task.
   */
  tokens?: number
  /**
   * The task's running cost, copied VERBATIM from `TaskRecord.cost_ticks`
   * (T1.8) — never recomputed here. OPTIONAL with the same honest default as
   * on the record: absence means UNKNOWN, not `0`.
   */
  cost_ticks?: number
  /** Provenance of `cost_ticks` (see CostBasis on TaskRecord); meaningless, and therefore absent, without a figure. */
  cost_basis?: CostBasis
  /** The task's branch, read from the record. */
  branch: string
  /**
   * The merge/pull request URL opened at ship time, read from the ship
   * outcome. OPTIONAL: absent before the task has shipped, or when the ship
   * landed without one (no forge CLI, no URL printed) — never a placeholder,
   * never a guess at what the URL would be.
   */
  mr_url?: string
}

export const RECAP_SUMMARY_MAX = 4_000
export const RECAP_CHANGE_MAX = 500
export const RECAP_CHANGES_MAX = 64
export const RECAP_DECISION_MAX = 500
export const RECAP_DECISIONS_MAX = 64
export const RECAP_FILE_PATH_MAX = 1_000
export const RECAP_FILES_MAX = 1_000
export const RECAP_TEST_COMMAND_MAX = 500
export const RECAP_TESTS_MAX = 64
export const RECAP_MR_URL_MAX = 2_000

// Same recipe as ticket.ts's `sectionText`, applied to `summary` and to every
// item of `changes[]`/`decisions[]` — the MULTI-LINE model-authored fields:
// line endings normalized to `\n` FIRST — a LONE `\r` is a line terminator in
// CommonMark exactly like `\n` and `\r\n` are, so leaving it alone would let a
// forged block (a fake `## Acceptance criteria`, a fake `**Merge request:**`
// footer) survive every line-oriented neutralization downstream in
// `task-recap.ts`'s renderer, which only knows the normalized form — then
// trimmed, then cut in CODE POINTS (never `.slice()`, which counts UTF-16
// units and can split a surrogate pair into an ill-formed half), then trimmed
// again since a mid-sentence cut can leave trailing whitespace. A value this
// sanitizer stores must reproduce unchanged when read back.
const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? cutCodePoints(v.replace(/\r\n?/g, '\n').trim(), max).trim() : ''

// Round 4, majeur 1: `branch`, `mr_url`, `files[]`, `tests[].command` and
// `criteria[].text` are NOT model-authored prose — but a document schema is
// published, so `renderRecapMarkdown` must hold for every `RecapRecord` the
// schema admits, not merely the ones this CLI's own generator happens to
// build. A hand-crafted `recap.json`, or one assembled from a repo-declared
// string this contract does not otherwise bound (`.codesema/config.json`'s
// `checks.commands[]`, read by `readChecksConfig`, has no newline filter),
// can carry an embedded line break in any of these five fields. `line()` is
// the ONE-LINE counterpart of `str()`: every Unicode control character
// (`\p{Cc}` — this covers LF, CR, TAB, VT, FF and friends, not merely the
// three CommonMark line-terminator forms `str()` normalizes) becomes a space,
// consecutive whitespace collapses to one (`plainText`'s recipe,
// `checks-setup.ts:141`, plus `ticket.ts`'s own `collapse`), then the result
// is cut in CODE POINTS and trimmed — so these five fields are MONO-LINE BY
// CONSTRUCTION, not "safe by provenance" (the false framing an earlier
// version of this module's doc comment used, and of `task-recap.ts`'s render
// comment).
const line = (v: unknown, max: number): string =>
  typeof v === 'string'
    ? cutCodePoints(
        v
          .replace(/\p{Cc}/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
        max,
      ).trim()
    : ''

function sanitizeStringList(raw: unknown, itemMax: number, listMax: number): string[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const out: string[] = []
  for (const item of raw) {
    if (out.length >= listMax) {
      break
    }
    const s = str(item, itemMax)
    if (s) {
      out.push(s)
    }
  }
  return out
}

/** Same shape as `sanitizeStringList`, but through `line()` — for `files[]`, the one array field that must be mono-line (round 4, majeur 1). */
function sanitizeLineList(raw: unknown, itemMax: number, listMax: number): string[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const out: string[] = []
  for (const item of raw) {
    if (out.length >= listMax) {
      break
    }
    const s = line(item, itemMax)
    if (s) {
      out.push(s)
    }
  }
  return out
}

const RECAP_TEST_STATUSES: ReadonlySet<RecapTestStatus> = new Set([
  'passed',
  'failed',
  'timeout',
  'skipped',
  'unconfigured',
  'error',
])

function sanitizeRecapTestEntry(raw: unknown): RecapTestEntry | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  const command = line(r.command, RECAP_TEST_COMMAND_MAX)
  if (!command || !RECAP_TEST_STATUSES.has(r.status as RecapTestStatus)) {
    return null
  }
  return {
    command,
    status: r.status as RecapTestStatus,
    // Preserved on relecture (round-trip), never invented: only ever true
    // when the value written was itself exactly `true`.
    ...(r.synthetic === true ? { synthetic: true as const } : {}),
  }
}

function sanitizeRecapTests(raw: unknown): RecapTestEntry[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const out: RecapTestEntry[] = []
  for (const item of raw) {
    if (out.length >= RECAP_TESTS_MAX) {
      break
    }
    const entry = sanitizeRecapTestEntry(item)
    if (entry) {
      out.push(entry)
    }
  }
  return out
}

/**
 * `sanitizeCriterionVerdict` (ticket.ts) plus the denormalized `text` — same
 * discard rule as its base: an unrecognizable `criterion_id` drops the whole
 * entry, `text` is bounded independently and kept only when non-empty.
 */
function sanitizeRecapCriterion(raw: unknown): RecapCriterionVerdict | null {
  const verdict = sanitizeCriterionVerdict(raw)
  if (!verdict) {
    return null
  }
  const r = raw as Record<string, unknown>
  const text = line(r.text, TICKET_CRITERION_TEXT_MAX)
  return { ...verdict, ...(text ? { text } : {}) }
}

/**
 * Whole list, bounded at `TICKET_CRITERIA_MAX` (a verdict list can never
 * outgrow the ticket it judges) and DEDUPLICATED on `criterion_id`, first
 * occurrence wins — same doctrine as `sanitizeCriterionVerdicts` (ticket.ts),
 * restated here because this function decorates each entry with `text` and so
 * does not delegate to it wholesale. A repeated id must never let a model
 * inflate a ticket's apparent coverage, or leave two contradictory verdicts
 * (`met` and `unmet`) standing for the same criterion.
 *
 * Returns `null` — not `[]` — when nothing survives, so the caller can OMIT
 * the key: an empty `criteria: []` would read as "reviewed, zero criteria to
 * judge", which is never true (a ticket always carries `TICKET_CRITERIA_MIN`
 * or more); absence is the only honest way to say "no verdicts here".
 */
function sanitizeRecapCriteria(raw: unknown): RecapCriterionVerdict[] | null {
  if (!Array.isArray(raw)) {
    return null
  }
  const out: RecapCriterionVerdict[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= TICKET_CRITERIA_MAX) {
      break
    }
    const criterion = sanitizeRecapCriterion(item)
    if (!criterion || seen.has(criterion.criterion_id)) {
      continue
    }
    seen.add(criterion.criterion_id)
    out.push(criterion)
  }
  return out.length > 0 ? out : null
}

/**
 * `tokens`' predicate: a non-negative safe integer, `-0` refused explicitly
 * (same reasoning as tasks.ts's `optionalCostTicks`, duplicated here rather
 * than exported from there — this ticket does not otherwise touch that
 * module's public surface). Anything else means UNKNOWN, never `0`.
 */
function optionalNonNegativeInt(v: unknown): number | null {
  return Number.isSafeInteger(v) && (v as number) >= 0 && !Object.is(v, -0) ? (v as number) : null
}

const RECAP_COST_BASES: ReadonlySet<CostBasis> = new Set(['harness', 'lower_bound'])

/**
 * `cost_ticks` and `cost_basis` are one fact in two keys (tasks.ts doctrine):
 * they survive or fall TOGETHER. A basis with no figure describes nothing; a
 * figure with an unnamed basis cannot be interpreted (the harness's own
 * estimate, or this build's input-and-cache floor?).
 */
function sanitizeRecapCost(
  rawTicks: unknown,
  rawBasis: unknown,
): { cost_ticks: number; cost_basis: CostBasis } | null {
  const ticks = optionalNonNegativeInt(rawTicks)
  const basis = RECAP_COST_BASES.has(rawBasis as CostBasis) ? (rawBasis as CostBasis) : null
  return ticks === null || basis === null ? null : { cost_ticks: ticks, cost_basis: basis }
}

/**
 * Revalidates a `RecapRecord` read back from disk (`recap.json`) or produced
 * by the generator. Whitelist and truncate, NEVER throws. Returns `null` only
 * when the input carries no usable `branch` — the recap's one identity-bearing
 * field, same role `id` plays for `sanitizeTaskRecord`: a recap that cannot
 * name its own branch is not a degraded recap, it is not a recap.
 */
export function sanitizeRecap(raw: unknown): RecapRecord | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  const branch = line(r.branch, TASK_PATH_MAX)
  if (!branch) {
    return null
  }
  const cost = sanitizeRecapCost(r.cost_ticks, r.cost_basis)
  const tokens = optionalNonNegativeInt(r.tokens)
  const criteria = sanitizeRecapCriteria(r.criteria)
  const mrUrl = line(r.mr_url, RECAP_MR_URL_MAX)
  return {
    version: 1,
    summary: str(r.summary, RECAP_SUMMARY_MAX),
    changes: sanitizeStringList(r.changes, RECAP_CHANGE_MAX, RECAP_CHANGES_MAX),
    decisions: sanitizeStringList(r.decisions, RECAP_DECISION_MAX, RECAP_DECISIONS_MAX),
    files: sanitizeLineList(r.files, RECAP_FILE_PATH_MAX, RECAP_FILES_MAX),
    tests: sanitizeRecapTests(r.tests),
    ...(criteria ? { criteria } : {}),
    ...(tokens !== null ? { tokens } : {}),
    ...cost,
    branch,
    ...(mrUrl ? { mr_url: mrUrl } : {}),
  }
}

/**
 * JSON Schema (draft 2020-12) for a `RecapRecord`, on the exact patron of
 * `reviewRecordSchema` (index.ts) and `ticketBodySchema` (this package).
 *
 * The guarantee it makes, stated precisely (round 5, mineur — the previous
 * wording claimed it accepted "EXACTLY what `sanitizeRecap` produces and
 * nothing else", and the second half of that is false BY CONSTRUCTION):
 *
 *  - forward, and total: EVERY `sanitizeRecap` output validates. This is what
 *    the cross test in `recap.test.ts` locks, and it is the direction that
 *    matters for a consumer reading a `recap.json` this CLI wrote.
 *  - backward, and partial: the schema refuses every SHAPE the sanitizer
 *    refuses — an unknown key, a wrong type, an out-of-enum status, a value
 *    past a bound, an empty or whitespace-only string where the sanitizer
 *    drops or omits the key, a control character in a mono-line field. It
 *    does NOT make every schema-valid document a FIXED POINT of
 *    `sanitizeRecap`: JSON Schema has no way to express `line()`'s whitespace
 *    collapse, so `'a  b'` (two spaces) validates here and comes back as
 *    `'a b'` — reshaped, never rejected, and never a safety difference since
 *    the renderer applies its own second layer regardless.
 *
 * What both directions together buy is the thing design.md names as this
 * ticket's top long-run risk: schema and sanitizer cannot drift into
 * DISAGREEMENT about what a recap is, only about how many spaces it has.
 */
// `NON_BLANK` (imported from ticket.ts) is what every string below that the
// sanitizer refuses to emit empty OR whitespace-only carries, in place of a
// bare `minLength: 1` — round 4, majeur 3: `sanitizeStringList`/`str`/`line`
// all TRIM before checking for emptiness, so `'   '` was schema-valid yet
// silently dropped (an array item), OMITTED (`mr_url`, `criteria[].text` /
// `.evidence`) or NULLING THE WHOLE RECORD (`branch`) on the way back through
// the one sanctioned reader.
//
// T3.2 round 2, mineur 3: it moved to ticket.ts rather than staying local
// here, because `reviewRecordSchema` publishes the same `criterionVerdict`
// and had drifted to exactly that bare `minLength: 1`. One fact, one spelling.

// Round 4, majeur 1: the mono-line counterpart of NON_BLANK, for the five
// fields `line()` (above) now bounds — `branch`, `mr_url`, `files[]` items,
// `testEntry.command`, `criterionVerdict.text`. A negative lookahead refuses
// ANY Unicode control character (`\x00-\x1F`, `\x7F-\x9F` — the `\p{Cc}`
// range `line()` maps to a space) anywhere in the string, combined with the
// same non-blank boundary as NON_BLANK.
//
// Round 5, majeur 1: the lookahead's own reach is `[\s\S]*`, NOT `.*`. In
// ECMA-262 without the `s` flag — and `ajv` compiles a schema `pattern` with
// `u`, not `s` — `.` stops at EVERY line terminator, U+2028 (LINE SEPARATOR)
// and U+2029 (PARAGRAPH SEPARATOR) included. Those two are `Zl`/`Zp`, so they
// are NOT in `\p{Cc}` and the character class below did not catch them
// either: with `.*`, every control character placed AFTER a U+2028/U+2029 was
// invisible to the lookahead, and a record whose five mono-line fields all
// carried `"… \n## Acceptance criteria"` behind one validated clean. The
// published guarantee — the one a third-party producer reads — was false even
// though both of this CLI's own layers scrub the value.
//
// U+2028/U+2029 are themselves in the refused class: `line()` folds them to a
// space already (JS `\s` matches both), so admitting them here would make the
// schema looser than the one sanctioned reader, the exact drift design.md
// names as the top long-run risk.
//
// The two halves are deliberately REDUNDANT, and this is stated here rather
// than left for a future reader to rediscover: the class now covers all four
// characters `.` refuses to cross (`\n`, `\r`, U+2028, U+2029), so swapping
// `[\s\S]*` back to `.*` today changes no verdict and no test reddens on that
// single mutation alone. What `[\s\S]*` buys is that the guarantee stops
// DEPENDING on the class staying complete: the day someone trims U+2028/U+2029
// out of it — they are `Zl`/`Zp`, not `Cc`, which is the very reasoning that
// produced this hole — the lookahead still sees the whole string. Do not
// "simplify" it back. Reverting BOTH halves (the round-4 form) reddens three
// tests in recap.test.ts.
const NON_BLANK_MONO_LINE =
  '^(?![\\s\\S]*[\\x00-\\x1F\\x7F-\\x9F\\u2028\\u2029])\\S(?:[\\s\\S]*\\S)?$'

export const recapRecordSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://codesema.com/schemas/recap-record.json',
  title: 'Codesema task recap',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'summary', 'changes', 'decisions', 'files', 'tests', 'branch'],
  properties: {
    version: { const: 1 },
    summary: { type: 'string', maxLength: RECAP_SUMMARY_MAX },
    // NON_BLANK on changes[]/decisions[] items: multi-line model prose stays
    // ALLOWED to carry an internal line break (neutralized at render time,
    // task-recap.ts) — only a whitespace-only or empty entry is refused,
    // matching sanitizeStringList's own drop rule.
    changes: {
      type: 'array',
      maxItems: RECAP_CHANGES_MAX,
      items: { type: 'string', maxLength: RECAP_CHANGE_MAX, pattern: NON_BLANK },
    },
    decisions: {
      type: 'array',
      maxItems: RECAP_DECISIONS_MAX,
      items: { type: 'string', maxLength: RECAP_DECISION_MAX, pattern: NON_BLANK },
    },
    // NON_BLANK_MONO_LINE: files[] is bounded through line(), so a schema
    // that allowed an embedded newline here would accept a document the
    // sanctioned reader (sanitizeRecap) already refuses to reproduce as-is.
    files: {
      type: 'array',
      maxItems: RECAP_FILES_MAX,
      items: { type: 'string', maxLength: RECAP_FILE_PATH_MAX, pattern: NON_BLANK_MONO_LINE },
    },
    tests: {
      type: 'array',
      maxItems: RECAP_TESTS_MAX,
      items: { $ref: '#/$defs/testEntry' },
    },
    criteria: {
      type: 'array',
      minItems: 1,
      maxItems: TICKET_CRITERIA_MAX,
      // Catches a literal duplicate item outright. It does NOT catch two
      // entries sharing a criterion_id while differing in status/evidence —
      // draft 2020-12 has no "unique by property" keyword, same documented
      // gap as ticketBodySchema.acceptance_criteria. The stronger guarantee
      // (pairwise distinct criterion_id) is made, and tested, on the
      // producing side: sanitizeRecapCriteria (this file, recap.test.ts).
      uniqueItems: true,
      items: { $ref: '#/$defs/criterionVerdict' },
    },
    // Round 4, mineur: Number.isSafeInteger (optionalNonNegativeInt, below)
    // already refuses anything past 2^53-1 and returns absence rather than a
    // silently-dropped figure — but the SCHEMA did not say so, and
    // `9007199254740992` validated as a plain `integer` with no upper bound.
    tokens: { type: 'integer', minimum: 0, maximum: 9_007_199_254_740_991 },
    cost_ticks: { type: 'integer', minimum: 0, maximum: 9_007_199_254_740_991 },
    cost_basis: { enum: ['harness', 'lower_bound'] },
    // NON_BLANK_MONO_LINE on both: sanitizeRecap NEVER produces an empty OR
    // whitespace-only string on either (an unusable branch nulls the whole
    // record; mr_url is OMITTED, not blanked, when it has nothing to say),
    // and both are bounded through line() — no embedded line break can
    // survive the sanctioned reader either. A schema looser than that would
    // accept documents sanitizeRecap refuses or reshapes on the way back in
    // — exactly the drift this ticket's own design.md names as its top risk.
    // recap.test.ts's reverse cross test locks this.
    branch: { type: 'string', maxLength: TASK_PATH_MAX, pattern: NON_BLANK_MONO_LINE },
    mr_url: { type: 'string', maxLength: RECAP_MR_URL_MAX, pattern: NON_BLANK_MONO_LINE },
  },
  $defs: {
    testEntry: {
      type: 'object',
      additionalProperties: false,
      required: ['command', 'status'],
      properties: {
        command: {
          type: 'string',
          maxLength: RECAP_TEST_COMMAND_MAX,
          pattern: NON_BLANK_MONO_LINE,
        },
        status: { enum: ['passed', 'failed', 'timeout', 'skipped', 'unconfigured', 'error'] },
        synthetic: { const: true },
      },
    },
    criterionVerdict: {
      type: 'object',
      additionalProperties: false,
      required: ['criterion_id', 'status'],
      properties: {
        criterion_id: { type: 'string', pattern: '^ac-[0-9a-f]{12}$' },
        status: { enum: ['met', 'unmet', 'unclear'] },
        // `evidence` stays multi-line-capable prose (quoted grounding, DP12):
        // NON_BLANK only.
        evidence: {
          type: 'string',
          maxLength: CRITERION_VERDICT_EVIDENCE_MAX,
          pattern: NON_BLANK,
        },
        // D26, same $def as `reviewRecordSchema`'s own criterionVerdict: the
        // reviewer's question when the verdict is 'unclear'.
        question: {
          type: 'string',
          maxLength: CRITERION_VERDICT_QUESTION_MAX,
          pattern: NON_BLANK,
        },
        // `text` is bounded through line() (round 4, majeur 1): NON_BLANK_MONO_LINE.
        text: {
          type: 'string',
          maxLength: TICKET_CRITERION_TEXT_MAX,
          pattern: NON_BLANK_MONO_LINE,
        },
      },
    },
  },
} as const
