// Ticket contract: the shape of a ticket body, the DETERMINISTIC lint that
// decides whether it may be launched, and the stable identity of its acceptance
// criteria. Same doctrine as the rest of the contract (index.ts, tasks.ts,
// reasons.ts): whitelist and truncate, never throw.
//
// Two jobs, deliberately separated:
//
//   - `lintTicketBody(raw)` is a GATE on markdown a human or an agent wrote. It
//     refuses, and every refusal NAMES what is wrong. Nothing in it is a
//     judgement call — no model, no heuristic, no clock: the same body always
//     produces the same verdict and the same `problems`, in the same order.
//     That is what makes it usable as the entry of the per-criterion gate that
//     comes later (decision D11). `lintCriteria(list)` applies the criteria half
//     of those rules to a bare list, for the route that revises the criteria of
//     an existing task without resubmitting a whole body.
//   - `sanitizeTicketBody(raw)` is the TOLERANT read-back of a body already
//     accepted, coming off disk or off the wire. It never refuses a whole body
//     for a bound: it truncates, drops what it cannot name, and hands back
//     something representable.
//
// Where the lint applies (decision D6): to the ticket LAUNCHED, at admission
// time on the CLI side — not to the ticket a human is typing in the browser. A
// draft is never linted; nothing in this module runs implicitly. A launch
// refused says why (`formatTicketProblems`), so the author — human or agent —
// can fix the body and retry.
//
// That admission point is NOT wired here, and its absence is deliberate rather
// than an omission: the only caller required to run this gate is the
// task-from-issue path (the code that turns a forge issue into a task), which
// belongs to its own ticket. Until that path exists, this module publishes the
// verdict and its readable reason and nothing in the product refuses a launch —
// which is exactly why the verdict has to be frozen and tested here, before a
// caller starts persisting ids derived from it.
//
// The headings, the minimum of three criteria and the EARS phrasing are
// PUBLISHED data (see `ticketBodySchema`): same doctrine as the reason-code
// table — they may be added to, never renamed nor repurposed, because tickets,
// records and verdicts written months ago keep quoting these exact strings.

/** One of the five sections, as it appears in the markdown and on the body. */
export type TicketSectionEntry = {
  /** The heading line, VERBATIM: the parser matches nothing else. */
  heading: string
  /** The field it lands on in a `TicketBody`. */
  key: string
}

/**
 * The five sections of a ticket body, in their canonical order. That order is
 * not decoration: it is the order every list of `problems` follows, which is
 * half of what makes the lint deterministic.
 */
export const TICKET_SECTIONS = [
  { heading: '**Context**', key: 'context' },
  { heading: '**Goal**', key: 'goal' },
  { heading: '**Scope**', key: 'scope' },
  { heading: '**Acceptance criteria**', key: 'acceptance_criteria' },
  { heading: '**Out of scope**', key: 'out_of_scope' },
] as const satisfies readonly TicketSectionEntry[]

export type TicketSectionHeading = (typeof TICKET_SECTIONS)[number]['heading']
export type TicketSectionKey = (typeof TICKET_SECTIONS)[number]['key']

/** The one section that is a LIST, never prose. */
export const ACCEPTANCE_CRITERIA_HEADING: TicketSectionHeading = '**Acceptance criteria**'

/**
 * One acceptance criterion, structured.
 *
 * `id` is derived from `text` and from nothing else — never from the position
 * in the list. The precedent NOT reproduced here is the positional
 * renumbering of `formatRules` (`[C1]`, `[C2]`, …): inserting a criterion at
 * the top would shift every number, and every verdict already emitted against
 * `[C2]` would silently start pointing at another criterion. With a derived id,
 * the list may be reordered, extended or trimmed freely: a criterion's identity
 * follows its wording, so a verdict keeps naming what it actually judged.
 */
export type AcceptanceCriterion = {
  /** `ac-` followed by 12 lowercase hex chars, derived from `text`. */
  id: string
  /** The criterion, whitespace-normalized and NFC. `id` is always the hash of THIS. */
  text: string
}

/** The closed outcome of judging one acceptance criterion (DP12). */
export type CriterionStatus = 'met' | 'unmet' | 'unclear'

/**
 * One criterion's verdict — DP12: a single type, defined here beside
 * `AcceptanceCriterion` and reused **verbatim** by `ReviewRecord` (T3.2) and by
 * `RecapRecord` (T3.4), so a verdict written by one is readable by the other
 * without a second definition to drift out of sync.
 *
 * The key is `criterion_id`, never `criterion`: an earlier sketch (D10) used
 * `{criterion, status, evidence}`, which named the SAME fact two ways across
 * three consumers — the drift D10 risked is exactly what one shared type here
 * forecloses.
 *
 * `criterion_id` NAMES the criterion (`AcceptanceCriterion.id`); it does not
 * carry the criterion's own text — a verdict always travels beside the ticket
 * that names it, so re-stating the wording here would be a second copy to
 * drift. A consumer that reads on its own without that context (`RecapRecord`)
 * denormalizes the text itself, on top of this type, rather than widening the
 * shared shape for one reader.
 */
export type CriterionVerdict = {
  /** Must satisfy `isAcceptanceCriterionId`; an id the model invented is DISCARDED by the sanitizer, never reconstructed. */
  criterion_id: string
  /** An out-of-enum status DEGRADES to 'unclear' on read — never to 'met', which would fabricate a success. */
  status: CriterionStatus
  /** The reviewer's own quoted grounding for the status. OPTIONAL: a verdict can stand without one. */
  evidence?: string
}

/**
 * A ticket body: the five sections, with the acceptance criteria already
 * structured. The ticket's TITLE is not here — it lives on the task record
 * (`TaskRecord.title`), which is the thing that has an identity; a body is the
 * description part of decision D6's "title + description + criteria".
 */
export type TicketBody = {
  /** Stays 1 as long as no field is removed (contract versioning doctrine). */
  version: 1
  context: string
  goal: string
  scope: string
  /** The `**Acceptance criteria**` section, as the structured list downstream reads. */
  acceptance_criteria: AcceptanceCriterion[]
  out_of_scope: string
}

/** Bound of a prose section (`**Context**`, `**Goal**`, `**Scope**`, `**Out of scope**`). */
export const TICKET_SECTION_MAX = 4_000
/** Bound of one criterion's text: a criterion that needs more is two criteria. */
export const TICKET_CRITERION_TEXT_MAX = 500
/** Ceiling on the list; past it the lint refuses and the sanitizer drops the extras. */
export const TICKET_CRITERIA_MAX = 32
/** Floor: a ticket with fewer criteria has nothing a gate could verify. */
export const TICKET_CRITERIA_MIN = 3

/**
 * Bound of `CriterionVerdict.evidence` (DP12: "bornée par une constante
 * exportée"). Wider than `TICKET_CRITERION_TEXT_MAX` on purpose: evidence
 * quotes a snippet of the diff or the transcript the criterion was judged
 * against, which runs longer than the criterion's own one-line wording.
 */
export const CRITERION_VERDICT_EVIDENCE_MAX = 1_000

/**
 * JSON Schema `pattern` for a string that is neither empty NOR whitespace-only:
 * a non-whitespace first AND last character. It SUBSUMES `minLength: 1` (an
 * empty string cannot match it), so it replaces that keyword rather than
 * sitting beside it.
 *
 * It lives here, beside `CriterionVerdict` itself, for the DP12 reason the type
 * does: `recapRecordSchema` and `reviewRecordSchema` both publish the SAME
 * `criterionVerdict.evidence`, and round 2 of T3.2 landed with recap using this
 * pattern and review using a bare `minLength: 1` — two spellings of one fact,
 * the looser of which accepted `'   '` that no sanitizer ever produces
 * (`sanitizeCriterionVerdict` trims BEFORE it checks for emptiness, and omits
 * the key rather than storing a blank). A schema looser than its own sanitizer
 * is the drift `recap.ts` names as risk n° 1; sharing the constant is what
 * stops the two from drifting again.
 *
 * `ticket.ts` imports nothing, so both schema modules can read it without a
 * cycle.
 */
export const NON_BLANK = '^\\S(?:[\\s\\S]*\\S)?$'

/**
 * Bound of the readable reason `formatTicketProblems` renders. Deliberately the
 * same 2 000 as `TASK_REASON_DETAIL_MAX` (reasons.ts) — a refusal is carried by
 * a `TaskReason.detail`, a flat journal payload and an HTTP body, all bounded
 * there — but declared here as its own constant so this module keeps importing
 * nothing. `ticket.test.ts` locks the two values together.
 */
export const TICKET_PROBLEMS_TEXT_MAX = 2_000

/** EARS trigger keyword, uppercase and verbatim. Exported so prompts quote it. */
export const EARS_TRIGGER = 'WHEN'
/** EARS response keyword, uppercase and verbatim. */
export const EARS_RESPONSE = 'THE SYSTEM SHALL'

const escapeForRegExp = (source: string): string => source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// DERIVED from the two exported keywords, never a second copy of them: they are
// the published definition, so a rule spelling them out again could drift from
// what prompts and messages quote. Case-sensitive on purpose — the keywords are
// a machine marker, not prose, and accepting `when … the system shall …` would
// make the phrasing rule a matter of taste. Applied to already-normalized text,
// so a single space is exact.
const EARS_RE = new RegExp(
  `^${escapeForRegExp(EARS_TRIGGER)} .+ ${escapeForRegExp(EARS_RESPONSE)} .+$`,
)

const CRITERION_ID_PREFIX = 'ac-'
const CRITERION_ID_RE = /^ac-[0-9a-f]{12}$/
/** Matches `- x`, `* x`, `+ x`, `1. x` and `1) x`, with any leading indent. */
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/

const HEADINGS: ReadonlySet<string> = new Set(TICKET_SECTIONS.map((s) => s.heading))

const isHeading = (line: string): line is TicketSectionHeading => HEADINGS.has(line)

/** Guards an id joined into a verdict, a recap row or an HTTP route. */
export function isAcceptanceCriterionId(value: unknown): value is string {
  return typeof value === 'string' && CRITERION_ID_RE.test(value)
}

/**
 * Collapses every whitespace run to one space, trims, and normalizes to Unicode
 * NFC. No truncation.
 *
 * The NFC step is PART OF THE FROZEN ID DEFINITION, not a convenience: the same
 * accented sentence typed on macOS (decomposed, NFD) and pasted back from a
 * forge (composed, NFC) is byte-different but is the same criterion, and must
 * not mint two ids for one wording. Removing this step, or moving it after the
 * hash, would rename every criterion carrying a non-ASCII character — which is
 * the exact failure the derived id exists to prevent.
 */
function collapse(raw: unknown): string {
  return typeof raw === 'string' ? raw.normalize('NFC').replace(/\s+/g, ' ').trim() : ''
}

/**
 * Length in CODE POINTS — the unit every published bound of this contract is
 * stated in. UTF-16 code units are not that unit: one emoji is a single code
 * point and two units, and a bound counted in units would refuse a criterion
 * the spec allows purely for being written in an alphabet outside the BMP.
 *
 * Exported so every OTHER module of the contract that bounds free text (e.g.
 * recap.ts) truncates the same way, instead of growing its own `.slice()`
 * that silently counts UTF-16 units and can split a surrogate pair.
 */
export const codePointLength = (text: string): number => [...text].length

/** Cuts at `max` CODE POINTS. Never splits a surrogate pair. */
export function cutCodePoints(text: string, max: number): string {
  // Fast path: as many code units as code points means nothing astral is here.
  return text.length <= max ? text : [...text].slice(0, max).join('')
}

/**
 * Cuts at `max` UTF-16 CODE UNITS, backing off one unit rather than leaving a
 * lone surrogate. Used for the channels whose own bound is counted in units.
 */
function cutCodeUnits(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  const cut = text.slice(0, max)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

/**
 * `collapse`, the published bound in CODE POINTS, and a final trim: exactly
 * what lands in `text`.
 *
 * The trim after the cut is not cosmetic. Cutting mid-sentence can leave a
 * trailing space, and a stored `text` ending in one would be a value the
 * sanitizer does not reproduce when it reads it back — the id is derived from
 * the collapsed, trimmed form, so `text` must already BE that form for
 * `id === acceptanceCriterionId(text)` to stay true on a truncated criterion.
 */
export function normalizeCriterionText(raw: unknown): string {
  return cutCodePoints(collapse(raw), TICKET_CRITERION_TEXT_MAX).trim()
}

/** Bounds a text to `max` code points, with an honest truncation marker. */
function truncatePoints(text: string, max: number): string {
  return codePointLength(text) <= max ? text : `${cutCodePoints(text, max - 1)}…`
}

/** Bounds a text to `max` code units, with an honest truncation marker. */
function truncateUnits(text: string, max: number): string {
  return text.length <= max ? text : `${cutCodeUnits(text, max - 1)}…`
}

/**
 * Quotes the offending text inside a message — a criterion, or a line that
 * should have been one — bounded to the criterion bound so that NO message can
 * carry more than one criterion's worth of text, however long the input was.
 */
const quoted = (text: string): string => `"${truncatePoints(text, TICKET_CRITERION_TEXT_MAX)}"`

const FNV_OFFSET = 0xcbf2_9ce4_8422_2325n
const FNV_PRIME = 0x0000_0100_0000_01b3n
const U64 = 0xffff_ffff_ffff_ffffn
const ID_MASK = 0xffff_ffff_ffffn

/**
 * The id of a criterion: FNV-1a over the UTF-8 bytes of its NORMALIZED text —
 * whitespace collapsed to single spaces, trimmed, Unicode NFC — low 48 bits,
 * hex. Pure and dependency-free on purpose: this module does no I/O and imports
 * nothing, so the derivation can never depend on a runtime that happens to be
 * there.
 *
 * 48 bits is not a security claim, it is an identity label: with the published
 * ceiling of 32 criteria per ticket, the odds of two colliding inside one
 * ticket are about 2e-12. Every step above is FROZEN — the normalization as
 * much as the hash — because changing any of them would rename every criterion
 * of every ticket already written, which is exactly the failure the derived id
 * exists to prevent. `ticket.test.ts` pins concrete ids for concrete texts, so
 * a change to any step breaks a test instead of a persisted verdict.
 */
export function acceptanceCriterionId(text: string): string {
  let hash = FNV_OFFSET
  for (const byte of new TextEncoder().encode(collapse(text))) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & U64
  }
  return CRITERION_ID_PREFIX + (hash & ID_MASK).toString(16).padStart(12, '0')
}

/**
 * The text an entry claims to carry, whatever form it arrives in: the
 * structured `{ text }` and a bare string alike — an agent that answers a plain
 * list is not a corrupt input. Not truncated, so the lint can see the real
 * length it is about to refuse.
 */
function criterionSource(raw: unknown): unknown {
  if (typeof raw === 'string') {
    return raw
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return (raw as Record<string, unknown>).text
  }
  return null
}

/**
 * Revalidates one criterion. Accepts the structured `{ text }` form and a bare
 * string alike. The `id` on the way in is IGNORED and recomputed: the id is
 * defined as a function of the text, so a stale or tampered one is a claim, not
 * a fact. Null when nothing readable is left. Never throws.
 */
export function sanitizeAcceptanceCriterion(raw: unknown): AcceptanceCriterion | null {
  const text = normalizeCriterionText(criterionSource(raw))
  if (!text) {
    return null
  }
  return { id: acceptanceCriterionId(text), text }
}

/**
 * Revalidates a whole criteria list: unreadable entries dropped, duplicates
 * (same id, hence same text) collapsed onto their first occurrence, and the
 * list capped at `TICKET_CRITERIA_MAX`. Never throws, never returns null — an
 * absent list is an empty one.
 *
 * The deduplication is a CONTRACT GUARANTEE, not an optimization: the ids of
 * the returned list are pairwise distinct, so a per-criterion verdict can key
 * on them. `ticketBodySchema` cannot state that (draft 2020-12 has no
 * "unique by property" keyword — see the note on `uniqueItems`), which is why
 * it is stated, and tested, here.
 */
export function sanitizeAcceptanceCriteria(raw: unknown): AcceptanceCriterion[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const out: AcceptanceCriterion[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= TICKET_CRITERIA_MAX) {
      break
    }
    const criterion = sanitizeAcceptanceCriterion(item)
    if (!criterion || seen.has(criterion.id)) {
      continue
    }
    seen.add(criterion.id)
    out.push(criterion)
  }
  return out
}

const CRITERION_STATUSES: ReadonlySet<CriterionStatus> = new Set(['met', 'unmet', 'unclear'])

/**
 * Revalidates one criterion verdict (DP12). Null when `criterion_id` is not
 * `isAcceptanceCriterionId`-shaped — an id the model invented is DISCARDED,
 * never repaired or reconstructed, since there is no text here to recompute it
 * from (unlike `sanitizeAcceptanceCriterion`, this function never mints an id).
 * A `status` outside the closed enum degrades to `'unclear'` rather than
 * dropping the entry — refusing a status we cannot name is honest, refusing
 * the whole verdict for it would throw away a criterion_id and evidence that
 * ARE still readable. Never throws.
 */
export function sanitizeCriterionVerdict(raw: unknown): CriterionVerdict | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  if (!isAcceptanceCriterionId(r.criterion_id)) {
    return null
  }
  const status = CRITERION_STATUSES.has(r.status as CriterionStatus)
    ? (r.status as CriterionStatus)
    : 'unclear'
  // Same recipe as `sectionText`: line endings normalized to `\n` FIRST (a
  // lone `\r` is a line terminator in CommonMark exactly like `\n` — leaving
  // it alone lets a forged block escape any line-oriented neutralization
  // downstream), trimmed, cut in CODE POINTS (never `.slice()`, which counts
  // UTF-16 units and can split a surrogate pair into an ill-formed half),
  // trimmed again since a mid-sentence cut can leave trailing whitespace.
  const evidence =
    typeof r.evidence === 'string'
      ? cutCodePoints(
          r.evidence.replace(/\r\n?/g, '\n').trim(),
          CRITERION_VERDICT_EVIDENCE_MAX,
        ).trim()
      : ''
  return {
    criterion_id: r.criterion_id,
    status,
    ...(evidence ? { evidence } : {}),
  }
}

/**
 * Revalidates a whole list of criterion verdicts: unreadable entries dropped,
 * capped at `TICKET_CRITERIA_MAX` (a verdict list can never outgrow the ticket
 * it judges). Never throws, never returns null — an absent list is an empty
 * one, same doctrine as `sanitizeAcceptanceCriteria`.
 *
 * DEDUPLICATED on `criterion_id`, first occurrence wins — same doctrine as
 * `sanitizeAcceptanceCriteria`'s own dedup, stated there as a CONTRACT
 * GUARANTEE the schema cannot express (draft 2020-12 has no "unique by
 * property" keyword). Without it, a model repeating an id could inflate a
 * ticket's apparent criteria coverage, or leave two contradictory verdicts
 * (`met` and `unmet`) for the SAME criterion for a reader (T3.6's merge gate,
 * a recap) to disagree with itself about.
 */
export function sanitizeCriterionVerdicts(raw: unknown): CriterionVerdict[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const out: CriterionVerdict[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= TICKET_CRITERIA_MAX) {
      break
    }
    const verdict = sanitizeCriterionVerdict(item)
    if (!verdict || seen.has(verdict.criterion_id)) {
      continue
    }
    seen.add(verdict.criterion_id)
    out.push(verdict)
  }
  return out
}

/**
 * A prose section: line endings normalized, trimmed, cut to the published bound
 * in CODE POINTS, then trimmed again — cutting mid-sentence can leave trailing
 * whitespace, and a section the sanitizer stores must be one it reproduces
 * unchanged when it reads it back.
 */
const sectionText = (raw: unknown): string =>
  typeof raw === 'string'
    ? cutCodePoints(raw.replace(/\r\n?/g, '\n').trim(), TICKET_SECTION_MAX).trim()
    : ''

/** The single constructor of a `TicketBody`: the lint and the sanitizer both
 *  go through it, so the two can never produce different shapes. */
function bodyFrom(r: Record<string, unknown>): TicketBody {
  return {
    version: 1,
    context: sectionText(r.context),
    goal: sectionText(r.goal),
    scope: sectionText(r.scope),
    acceptance_criteria: sanitizeAcceptanceCriteria(r.acceptance_criteria),
    out_of_scope: sectionText(r.out_of_scope),
  }
}

/**
 * Revalidates a `TicketBody` read back from disk or off the wire. Null only
 * when the input is not an object — a string, an array, a number and `null`
 * carry no body to salvage. Everything else degrades honestly: unknown fields
 * are dropped, missing sections become empty strings, over-long sections are
 * truncated to the published bound and excess criteria are cut. It does NOT
 * enforce the lint (five non-empty sections, three criteria, EARS): a body that
 * was refused at admission must still be readable afterwards, otherwise the
 * refusal could not be shown next to what caused it. Never throws.
 */
export function sanitizeTicketBody(raw: unknown): TicketBody | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  return bodyFrom(raw as Record<string, unknown>)
}

// --- Canonical serialization (T2.4/DP13) ------------------------------------

/**
 * Schema tag prefixing every hash `canonicalTicketBody` feeds (T2.4/DP13):
 * bumped only when the serialization below itself changes, so a rule change
 * never masquerades as every bound task's ticket having been edited on the
 * forge in the same boot. The hashing itself (sha256) is not this module's
 * job — it stays in the CLI (`task-issue.ts`), which imports this tag rather
 * than inventing its own, so the two can never drift apart.
 */
export const TICKET_BODY_HASH_TAG = 'sha256:t2'

/**
 * Encodes one field as `<utf8-byte-length>:<content>` (netstring-style): the
 * length prefix marks exactly where the field ends, so concatenating several
 * of these can NEVER collide the way joining with a delimiter character can
 * — `"ab"+"c"` and `"a"+"bc"` produce different encodings, because the
 * decoder never has to search for a boundary inside content it does not
 * control. Deliberately not `JSON.stringify`: that would additionally depend
 * on which characters happen to need escaping, an extra axis of "what if a
 * criterion contains a backslash" this scheme has no need to worry about.
 */
function netstring(s: string): string {
  return `${new TextEncoder().encode(s).length}:${s}`
}

/**
 * Normalizes one prose section before it enters a canonical hash (T2.4/DP13,
 * adversarial review majeur 2): Unicode **NFC**, and trailing spaces/tabs
 * stripped from every line. Without this, re-serving the SAME meaning moves
 * the hash on no real edit — an accented word typed decomposed on one
 * platform and composed on another, or a forge editor trimming a markdown
 * hard line break's two trailing spaces — which is exactly the false alarm
 * DP13 exists to rule out. Applied to the four prose sections only:
 * criterion text already goes through `collapse()`'s own NFC and whitespace
 * collapse on the way to its id (see `acceptanceCriterionId`), so this would
 * be redundant there, not wrong — id derivation owns that job, this owns the
 * prose's. Exported so `hashSection` (packages/cli/src/task-issue.ts) applies
 * the IDENTICAL normalization to a single section's own hash: the aggregate
 * hash and the per-section breakdown must never disagree about what counts
 * as "the same text", or a genuine edit could move one without the other.
 */
export function canonicalizeSection(s: string): string {
  return s.normalize('NFC').replace(/[ \t]+$/gm, '')
}

/**
 * The injective, FIELD-ORDER-FIXED serialization of a `TicketBody`, for
 * hashing (T2.4/DP13: `issue_snapshot.body_hash` is a hash of THIS, never of
 * the forge's raw markdown) and for any other consumer that needs a
 * byte-stable form of "what this ticket body said". Two producers of the same
 * body — issue admission and reconciliation — call this SAME function, so
 * they can never observe two different notions of "changed".
 *
 * Field order is fixed and PUBLISHED, never the insertion order of an object
 * (`JSON.stringify` would silently depend on it): `version`, the four prose
 * sections in `TICKET_SECTIONS` order (each normalized by `canonicalizeSection`)
 * with `acceptance_criteria` skipped in place (it is not prose), the criteria
 * count, then each criterion's `id` and `text`, and finally `out_of_scope`.
 * The count between the prose sections and the criteria is what keeps a
 * truncated criteria list from being read as a shorter one that simply had
 * fewer entries — every field's own netstring length prefix already does
 * that for itself, but the count pins the field COUNT of the list too.
 *
 * Criteria are serialized **sorted by `id`**, never in list order (adversarial
 * review majeur 1): an `id` is derived from a criterion's TEXT and nothing
 * else (T2.3), so reordering the very same criteria is, by that module's own
 * doctrine, not an edit — `ticket.test.ts`'s `reordering the list renames
 * nothing` pins exactly this. Hashing in list order would silently reimport
 * the positional dependency T2.3 froze out, and would do so invisibly: the
 * hash would move while the section/criteria-id diff this module's caller
 * reports has nothing to name, producing the bare "the issue changed" DP13
 * explicitly forbids. Sorting by id is a total, stable order because ids are
 * unique post-dedup (`sanitizeAcceptanceCriteria`).
 */
export function canonicalTicketBody(body: TicketBody): string {
  const parts: string[] = [
    netstring(String(body.version)),
    netstring(canonicalizeSection(body.context)),
    netstring(canonicalizeSection(body.goal)),
    netstring(canonicalizeSection(body.scope)),
    netstring(String(body.acceptance_criteria.length)),
  ]
  const criteria = body.acceptance_criteria.toSorted((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )
  for (const criterion of criteria) {
    parts.push(netstring(criterion.id), netstring(criterion.text))
  }
  parts.push(netstring(canonicalizeSection(body.out_of_scope)))
  return parts.join('')
}

/**
 * How much of a body's criteria list could be read.
 *
 * - `listed` — at least one criterion came back.
 * - `absent` — the body is readable and carries NO criteria (field missing,
 *   `null`, or an empty list). The honest answer to "which criteria does this
 *   ticket have?" is "none", and a caller may offer to draft some.
 * - `unreadable` — the body itself, or its criteria field, is not something
 *   this contract can read (not an object, not a list, or a list whose every
 *   entry carried no text). Nothing can be claimed about the criteria.
 *
 * The two failures are told apart ON PURPOSE: a gate that treats "no criteria"
 * and "criteria we could not read" alike would silently pass a ticket whose
 * criteria were corrupted, which invariant n° 2 forbids.
 */
export type AcceptanceCriteriaStatus = 'listed' | 'absent' | 'unreadable'

export type AcceptanceCriteriaRead = {
  status: AcceptanceCriteriaStatus
  /** The criteria that could be read, possibly empty. Fresh objects, fresh array. */
  criteria: AcceptanceCriterion[]
  /** Entries present but not returned: unreadable, duplicate, or past the cap. */
  dropped: number
}

/**
 * The criteria of a body, WITH the distinction between "this ticket has none"
 * and "these criteria could not be read". Tolerant like everything else here:
 * it takes `unknown`, never throws, and returns FRESH objects in a FRESH array,
 * so a consumer that sorts, annotates or filters cannot write back through into
 * the body it came from.
 */
export function readAcceptanceCriteria(body: unknown): AcceptanceCriteriaRead {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 'unreadable', criteria: [], dropped: 0 }
  }
  const raw = (body as Record<string, unknown>).acceptance_criteria
  if (raw === undefined || raw === null) {
    return { status: 'absent', criteria: [], dropped: 0 }
  }
  if (!Array.isArray(raw)) {
    return { status: 'unreadable', criteria: [], dropped: 0 }
  }
  const criteria = sanitizeAcceptanceCriteria(raw)
  if (raw.length === 0) {
    return { status: 'absent', criteria, dropped: 0 }
  }
  const status: AcceptanceCriteriaStatus = criteria.length === 0 ? 'unreadable' : 'listed'
  return { status, criteria, dropped: raw.length - criteria.length }
}

/**
 * The criteria of a body, as the structured list every downstream consumer
 * reads (the agent prompt, the per-criterion gate, the recap). The terse form
 * of `readAcceptanceCriteria`, for callers that do not need to tell an empty
 * ticket from an unreadable one — those that DO must use that one instead of
 * reading `[]` as an answer.
 */
export function extractAcceptanceCriteria(body: unknown): AcceptanceCriterion[] {
  return readAcceptanceCriteria(body).criteria
}

// --- Proof methods (D17) ------------------------------------------------------

/**
 * How a criterion's verdict may be established, named strictly enough that a
 * caller can act on it mechanically. `judgment` is the escape hatch: the only
 * method with nothing mechanical behind it, for a criterion nothing else can
 * verify. Never a JSON field on `AcceptanceCriterion` (D17): a new field would
 * need every existing producer and consumer of a `TicketBody` updated in
 * lockstep before a single criterion could carry one, where a textual tag
 * inside `text` is legible to all of them the day it starts appearing.
 * Extensible, never renamed: same doctrine as `TICKET_PROBLEM_CODES`.
 */
export const PROOF_METHODS = ['command', 'diff', 'read', 'judgment'] as const

export type ProofMethod = (typeof PROOF_METHODS)[number]

/**
 * One criterion's declared proof: which method judges it, and the argument
 * that method acts on (the command to run, the path a diff must touch, the
 * path or substring a read must find). `argument` is `null` only for
 * `judgment`, the one method with nothing for an argument to name.
 */
export type CriterionProof = {
  method: ProofMethod
  argument: string | null
}

/**
 * Matches a `[proof:<method> <argument>]` tag anchored at the very END of a
 * criterion's text (trailing whitespace tolerated, nothing else: a tag
 * followed by more prose is not at the end and must not match). Tolerant of
 * extra internal whitespace around `<method>` and before `<argument>`, since
 * this tag is typed by hand as often as it is generated. `<argument>` is
 * matched GREEDILY up to the last `]` the anchor allows, so an argument that
 * itself contains a literal `]` (a grep pattern, a JSON snippet in a command)
 * is not cut at the first one.
 */
const CRITERION_PROOF_RE = /\[proof:\s*(\S+)(?:\s+(.+))?\]\s*$/

const PROOF_METHOD_SET: ReadonlySet<string> = new Set(PROOF_METHODS)

/**
 * Reads the `[proof:...]` tag off a criterion's text. Returns `null` when
 * there is none, when it sits anywhere but the end, or when its method is not
 * one of `PROOF_METHODS`: the same never-fabricate rule this contract
 * applies to every closed enum, a method this build does not recognize is
 * refused, not guessed at. `argument` is REQUIRED for `command`/`diff`/`read`
 * (a mechanical check needs something to act on): a tag missing one, or
 * carrying only whitespace, is refused for those three exactly like a missing
 * tag would be. `judgment` is the one method `argument` is optional for.
 *
 * Deliberately compatible with `EARS_RE`: the tag lives inside the response
 * clause's own trailing `.+`, so a criterion carrying one still is, and
 * always was, an ordinary EARS sentence to every reader that does not know
 * about proofs yet (D17: D12, a structured field instead, is not done).
 */
export function parseCriterionProof(text: string): CriterionProof | null {
  const match = CRITERION_PROOF_RE.exec(text)
  if (!match) {
    return null
  }
  const methodToken = match[1] ?? ''
  if (!PROOF_METHOD_SET.has(methodToken)) {
    return null
  }
  const method = methodToken as ProofMethod
  const argument = match[2]?.trim() || null
  if (method !== 'judgment' && !argument) {
    return null
  }
  return { method, argument }
}

// --- Lint -------------------------------------------------------------------

/**
 * What can be wrong with a ticket body. Extensible, never renamed — a refusal
 * stored or logged keeps quoting these strings. The code is DATA that travels
 * next to the readable message: it is ADDED to it, never a replacement for it.
 */
export const TICKET_PROBLEM_CODES = [
  'body_not_text',
  'section_missing',
  'section_duplicated',
  'section_empty',
  'section_too_long',
  'criteria_not_a_list',
  'criteria_too_few',
  'criteria_too_many',
  'criteria_duplicated',
  'criterion_not_ears',
  'criterion_too_long',
  'criterion_missing_proof',
] as const

export type TicketProblemCode = (typeof TICKET_PROBLEM_CODES)[number]

export type TicketProblem = {
  code: TicketProblemCode
  /** Readable, and it NAMES the thing at fault: the section, the minimum, the criterion. */
  message: string
  /** The section this is about, when it is about one. */
  section?: TicketSectionHeading
  /** The offending criterion's text, when the problem is about one. */
  criterion?: string
}

export type TicketLintResult =
  { ok: true; body: TicketBody } | { ok: false; problems: TicketProblem[] }

/** What `lintCriteria` answers: the structured list, or why it was refused. */
export type TicketCriteriaLintResult =
  { ok: true; criteria: AcceptanceCriterion[] } | { ok: false; problems: TicketProblem[] }

/**
 * Shared options of `lintTicketBody` and `lintCriteria` (D17).
 *
 * `requireProofMethod` defaults to `false`, and that default is the whole
 * lint's behavior before D17 existed, byte-for-byte: nothing changes for a
 * caller that does not pass this. Only `ticket-draft.ts` passes `true`, to gate
 * drafts on carrying a `[proof:...]` tag per criterion; the ADMISSION lint
 * (task-from-issue) and boot-time reconciliation are deliberately left at the
 * default, so an existing ticket written before D17 keeps linting exactly as
 * it always has.
 */
export type TicketLintOptions = {
  requireProofMethod?: boolean
}

type SectionScan = {
  blocks: Map<TicketSectionHeading, string[]>
  duplicated: Set<TicketSectionHeading>
  /** Carried so section text and section length are both taken relative to it. */
  residue: number
}

/** A tab advances to the next multiple of four (CommonMark 0.31.2 § 2.2). */
const TAB_WIDTH = 4

/**
 * Leading whitespace, in COLUMNS: a space is one column, a tab advances to the
 * next multiple of `TAB_WIDTH`.
 *
 * Counting a tab as one CHARACTER is what every renderer disagrees with, and it
 * is not a safe simplification: it puts `\t- b` and `    - b` — which any
 * renderer shows side by side — at levels 1 and 4, so a list whose first item is
 * tabbed reads every space-indented sibling as nested, folds them into the
 * criterion above, and answers `ok` with fewer ids than the author wrote. The
 * parser's remaining divergences are listed on `scanCriteriaLines`.
 *
 * Only spaces and tabs are indentation. A non-breaking space is CONTENT, and
 * that is the deliberate arbitrage: markdown gives it no structural meaning, so
 * counting it as indent would let an invisible character decide which criterion
 * a line belongs to, whereas counting it as content only ever makes this parser
 * read LESS structure than a renderer would — the direction that costs an author
 * a named refusal instead of a silently lost id.
 */
function indentOf(line: string): number {
  let column = 0
  for (const character of line) {
    if (character === ' ') {
      column += 1
    } else if (character === '\t') {
      column += TAB_WIDTH - (column % TAB_WIDTH)
    } else {
      break
    }
  }
  return column
}

/** The indentation shared by every non-blank line, in columns. */
function commonIndent(lines: readonly string[]): number {
  let base = Number.POSITIVE_INFINITY
  for (const line of lines) {
    if (line.trim()) {
      base = Math.min(base, indentOf(line))
    }
  }
  return Number.isFinite(base) ? base : 0
}

/**
 * Rounds a dedent DOWN to a tab stop, which is what keeps the parser's measure
 * of a line and its rewrite of that line in agreement.
 *
 * A tab that survives a dedent is re-anchored at the start of the line, where
 * the next stop is computed afresh: take two columns off `"  \tX"` and the tab
 * that used to end at column 4 now starts at 0 and ends at 4 again — the line
 * lost nothing at all. On an ALIGNED base that cannot happen. A tab beginning
 * before the boundary must end at or before it, the next multiple of four after
 * its start being at most the boundary, so it is consumed whole; and a tab that
 * survives keeps a start column congruent modulo four, hence exactly the same
 * advance. `indentOf(dropIndent(line, base)) === indentOf(line) - base` then
 * holds for every line, which is the property the whole structure is read
 * against: two indentations this module measures at one column stay one column
 * apart afterwards, so a criterion is never folded into its neighbour for having
 * been typed with a tab rather than with spaces.
 *
 * The price is at most three columns left undedented — exactly
 * `BLOCK_MAX_INDENT`, so a heading sitting at the margin of its own body still
 * lands inside the "content, not markup" tolerance, and every other rule here is
 * relative anyway.
 */
const alignToTabStop = (columns: number): number => columns - (columns % TAB_WIDTH)

/**
 * Removes exactly `columns` columns of LEADING whitespace, and touches nothing
 * else: what follows the indent comes back character for character.
 *
 * Whitespace is CONSUMED, never sliced by a count — which is what makes it
 * impossible for this to eat content. The remainder below covers a tab
 * straddling the boundary, as CommonMark does for a partially consumed tab; on
 * the aligned bases this module actually passes (see `alignToTabStop`) no tab
 * can straddle, so every result is a pure SUFFIX of the line it came from and
 * not one byte is ever rewritten.
 */
function dropIndent(line: string, columns: number): string {
  let column = 0
  let index = 0
  while (column < columns && index < line.length) {
    const character = line[index]
    if (character === ' ') {
      column += 1
    } else if (character === '\t') {
      column += TAB_WIDTH - (column % TAB_WIDTH)
    } else {
      break
    }
    index += 1
  }
  return ' '.repeat(Math.max(0, column - columns)) + line.slice(index)
}

/**
 * Prepares a body for scanning: line endings normalized, then the indentation
 * COMMON to every non-blank line removed. Both scanners work on the lines this
 * returns, so they measure indent against the same base.
 *
 * Indentation is MEASURED in columns (`indentOf`) and never rewritten — the
 * dedent below removes whole leading whitespace characters and returns a pure
 * suffix of the line, which holds because the base is rounded to a tab stop
 * first (`alignToTabStop`). Expanding every leading tab to spaces would have
 * been simpler and is wrong twice over:
 * the lines that come out of here are the ones stored on the `TicketBody`, so a
 * Makefile recipe or a tab-indented Python sample quoted in a fenced block would
 * come back with its tabs replaced — silently changing what the author wrote,
 * and making two different samples identical — and the section bounds, measured
 * on that text, would count a tab as the four columns it occupies rather than
 * the one character it is, refusing a section of 3 899 characters while
 * announcing a number found nowhere in it.
 *
 * The dedent is what makes the "four columns is content, not markup" rule below
 * usable on real tickets. A body pasted out of a quoted block, generated with a
 * uniform indent, or written inside a numbered list item is indented in full —
 * every heading of it would sit past the rule and the whole ticket would be
 * refused for five sections it plainly has. Removing what is common to the WHOLE
 * body keeps the rule where it belongs: it now measures a line against the body
 * it lives in, so a sample indented four columns RELATIVE to that body is still
 * read as the content it is.
 *
 * Blank lines are dedented with their neighbours rather than left alone. Only
 * non-blank lines can say what the body's indentation IS, which is why
 * `commonIndent` ignores the blank ones — but a whitespace-only line inside a
 * fenced block is part of that block, and leaving it at six columns while every
 * line around it loses two would store a sample the author never wrote.
 *
 * What the tab stop cannot take off, `residue` carries: 0 to 3 columns that
 * every line still wears. NOTHING may compare against it. A line's meaning is
 * its indent RELATIVE to the margin of its own body — `indentOf(line) - residue`
 * — which is `indentOf(original) - commonIndent`, the very column its author
 * typed it at and the reason shifting a whole body sideways changes nothing.
 * Comparing an absolute indent against a threshold instead is what let a fence
 * at relative column 1 fall past `BLOCK_MAX_INDENT`, taking with it the section
 * heading it was hiding: the sample's quoted `**Out of scope**` became a real
 * section and a body missing one was answered `ok`.
 */
type NormalizedBody = {
  lines: string[]
  /** Columns the aligned dedent could not remove: 0 to 3, the same on every line. */
  residue: number
}

function normalizeBodyLines(raw: string): NormalizedBody {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  const indent = commonIndent(lines)
  const base = alignToTabStop(indent)
  return {
    lines: base === 0 ? lines : lines.map((line) => dropIndent(line, base)),
    residue: indent - base,
  }
}

/** A line's indent as its AUTHOR wrote it: relative to the body's own margin. */
const relativeIndent = (line: string, residue: number): number => indentOf(line) - residue

/**
 * The text of a section, as its author wrote it relative to their own margin:
 * the residue the aligned dedent had to leave behind is taken off here.
 *
 * It is taken off the STORED text, not just the measured one, so that the
 * length a refusal announces stays the length of the string this contract
 * hands back — the two must never be two different numbers. This is also the
 * one place a tab may be rewritten: a tab straddling the residue becomes the
 * columns it still owed, in spaces, exactly as CommonMark resolves a partially
 * consumed tab. It cannot reach the parser, which reads the aligned lines.
 */
const sectionTextOf = (block: readonly string[], residue: number): string =>
  block
    .map((line) => dropIndent(line, residue))
    .join('\n')
    .trim()

/** An open fenced code block: its delimiter character and its opening length. */
type FenceState = { char: string; length: number } | null

/** Three or more backticks or tildes, plus whatever follows on the line. */
const FENCE_RE = /^(`{3,}|~{3,})(.*)$/

/**
 * CommonMark: a block marker may be indented by up to three spaces. At four,
 * the line belongs to an INDENTED CODE BLOCK and is content, not markup.
 *
 * It applies to both things this parser recognizes. A fence read at four spaces
 * would let a legitimate indented block open one that swallows every heading
 * after it, turning a conforming ticket into a refusal naming four missing
 * sections. A heading read at four spaces would mint a section out of a heading
 * a code sample was merely showing — the same phantom-section bug the fence
 * tracking exists to prevent, arriving through the other door.
 */
const BLOCK_MAX_INDENT = 3

/**
 * The indent past which the criteria section stops reading fences. There is
 * none: inside a LIST OF CRITERIA a fenced sample is never part of a criterion,
 * whatever column it sits at, so it is named rather than folded into the text —
 * and hence into the id — of the criterion above it. The 0-3 rule exists to
 * protect PROSE sections from having their samples read as markup; the criteria
 * section has no prose to protect.
 */
const ANY_INDENT = Number.POSITIVE_INFINITY

/** The delimiter `trimmed` opens a fence with, or `''` when it opens none. */
function fenceOpenedBy(trimmed: string): string {
  const match = FENCE_RE.exec(trimmed)
  if (!match) {
    return ''
  }
  const marker = match[1] ?? ''
  // A backtick fence's info string may not itself contain a backtick
  // (CommonMark), which is what keeps a line of inline code from opening one.
  return marker.startsWith('`') && (match[2] ?? '').includes('`') ? '' : marker
}

/** A closing fence: the same character, at least as long, and nothing else. */
function fenceClosedBy(state: { char: string; length: number }, trimmed: string): boolean {
  const match = FENCE_RE.exec(trimmed)
  const marker = match?.[1] ?? ''
  return (
    marker.startsWith(state.char) &&
    marker.length >= state.length &&
    (match?.[2] ?? '').trim().length === 0
  )
}

/**
 * Advances the fenced-code state by one line, and says whether that line is
 * INSIDE a fence (delimiters included).
 *
 * A heading, a list marker or a wrapped line quoted inside a fence is source
 * being shown, not markup being declared: a ticket whose `**Context**` pastes
 * the ticket template must not be read as one carrying a second `**Goal**`, nor
 * refused for a duplicate section it never had. An unterminated fence swallows
 * the rest of the body — honestly so: the sections it hides are then reported
 * missing, by name.
 */
function stepFence(
  state: FenceState,
  line: string,
  maxIndent: number,
): { state: FenceState; fenced: boolean } {
  const trimmed = line.trim()
  // Past `maxIndent`, the delimiter is code being shown inside an indented
  // block — it neither opens nor closes a fence.
  const overIndented = indentOf(line) > maxIndent
  if (state) {
    const closes = !overIndented && fenceClosedBy(state, trimmed)
    return { state: closes ? null : state, fenced: true }
  }
  const marker = overIndented ? '' : fenceOpenedBy(trimmed)
  if (!marker) {
    return { state: null, fenced: false }
  }
  return { state: { char: marker[0] ?? '', length: marker.length }, fenced: true }
}

/** Splits an ALREADY NORMALIZED body (see `normalizeBodyLines`) into sections. */
function scanSections(body: NormalizedBody): SectionScan {
  const blocks = new Map<TicketSectionHeading, string[]>()
  const duplicated = new Set<TicketSectionHeading>()
  let current: string[] | null = null
  let fence: FenceState = null
  for (const line of body.lines) {
    const trimmed = line.trim()
    // Both thresholds are RELATIVE to the body's own margin. Against the
    // absolute indent, a body whose margin left a residue would move its own
    // fences and headings out of the tolerance one at a time.
    const step = stepFence(fence, line, BLOCK_MAX_INDENT + body.residue)
    fence = step.state
    // Indented past three relative to the body, the line is code being shown
    // inside an indented block: a heading it quotes declares no section.
    if (
      !step.fenced &&
      relativeIndent(line, body.residue) <= BLOCK_MAX_INDENT &&
      isHeading(trimmed)
    ) {
      const existing = blocks.get(trimmed)
      if (existing) {
        duplicated.add(trimmed)
        current = existing
      } else {
        current = []
        blocks.set(trimmed, current)
      }
      continue
    }
    if (current) {
      current.push(line)
    }
  }
  return { blocks, duplicated, residue: body.residue }
}

/**
 * How far past the LEVEL OF THE LIST a line must be indented to belong to the
 * criterion above it instead of standing next to it: the width of a marker and
 * its space, `- `.
 *
 * CommonMark says a sub-list starts at the CONTENT column of its parent item,
 * which is the parent's own indent plus its marker width. This contract reads
 * that column from the list's level rather than from each item's own marker, so
 * an ordered marker of any width (`10. `) or a stray extra space cannot move it.
 */
const NESTED_INDENT = 2

type CriteriaScan = {
  /** One entry per criterion, in body order, markers stripped. */
  items: string[]
  /** What the section carries that is not part of any item, in line order. */
  rejected: CriteriaReject[]
}

/** A line of the criteria section that carries no criterion, and why. */
type CriteriaReject = {
  line: string
  /** True for a list item with nothing in it (`- `), false for anything else. */
  empty: boolean
}

type CriteriaScanState = CriteriaScan & {
  /**
   * The indent of the LIST, fixed by its first item and never moved again.
   *
   * Reading the reference off the last item pushed is what let a single
   * de-indented bullet in the middle of a flat list turn every bullet after it
   * into a sub-bullet of itself: the criteria that followed were concatenated
   * into one text under one id, their own ids never minted, and the lint said
   * `ok`. The level of a list is a property of the list, not of its last line.
   */
  level: number
  /** True while the criterion above can still absorb an indented wrapped line. */
  open: boolean
  /** True while inside a run of stray lines, so one paragraph is one problem. */
  straying: boolean
}

function appendToLast(state: CriteriaScanState, text: string): void {
  const last = state.items.length - 1
  state.items[last] = `${state.items[last] ?? ''} ${text}`
}

/** Is a line at indent `at` nested under the list, rather than part of it? */
const isNested = (at: number, level: number): boolean => at >= level + NESTED_INDENT

/**
 * One list-marker line: a new criterion, a SUB-BULLET of the one above it, or
 * an item with nothing in it.
 *
 * A sub-bullet belongs to its criterion. Promoting it would mint an id for half
 * a sentence — a fragment no gate could ever verify — and the criterion above
 * would silently lose the detail that qualified it. A bullet indented by less
 * than a full marker width is NOT a sub-bullet: it is a sibling that happens to
 * be typed crookedly, and it keeps its own identity.
 */
function takeListItem(state: CriteriaScanState, line: string, text: string): void {
  const at = indentOf(line)
  if (!collapse(text)) {
    // An empty bullet is the one line that used to slip through "a list and
    // only a list" without a word. It carries no criterion: say so.
    state.rejected.push({ line: line.trim(), empty: true })
    state.open = false
    state.straying = false
    return
  }
  if (state.items.length === 0) {
    // The FIRST item fixes the level of the list, once and for all.
    state.level = at
    state.items.push(text)
  } else if (isNested(at, state.level)) {
    appendToLast(state, text)
  } else {
    state.items.push(text)
  }
  state.open = true
  state.straying = false
}

/**
 * A line carrying no list marker. It continues the criterion above ONLY when it
 * is nested under the list and directly follows it: that is a wrapped sentence.
 * Anything else — prose after the list, a paragraph between two lists, an
 * introduction before the first item — is STRAY and gets named. It is never
 * absorbed: absorbed prose would change the criterion's text, hence its id,
 * hence the identity a verdict was already keyed on, and the lint would say
 * `ok` while doing it.
 */
function takePlainLine(state: CriteriaScanState, line: string, trimmed: string): void {
  if (state.open && isNested(indentOf(line), state.level)) {
    appendToLast(state, trimmed)
    return
  }
  if (!state.straying) {
    state.rejected.push({ line: trimmed, empty: false })
  }
  state.open = false
  state.straying = true
}

/**
 * Splits the criteria block into list entries and everything that is not one.
 *
 * Its input is the block `scanSections` collected, so the lines are already
 * normalized: body dedented on a tab stop, indent measured in columns, and the
 * text of every line left exactly as its author typed it.
 *
 * This is a criteria-list reader, not a markdown implementation, and it says
 * where it parts with CommonMark rather than pretending otherwise. Nesting
 * starts at a fixed two columns past the list's level rather than at each item's
 * own content column; a lazy continuation — a wrapped line typed flush with the
 * left margin — is a refusal here instead of part of the item above; a fenced
 * sample is named at any indent instead of belonging to the item it sits under
 * (`ANY_INDENT`); blockquotes and HTML blocks are not modelled. Every divergence
 * is the same trade: a line that cannot be read as belonging to a criterion is
 * NAMED, never folded into one — never into its text, and so never into its id.
 */
function scanCriteriaLines(lines: readonly string[]): CriteriaScan {
  const state: CriteriaScanState = {
    items: [],
    rejected: [],
    level: 0,
    open: false,
    straying: false,
  }
  let fence: FenceState = null
  for (const line of lines) {
    const trimmed = line.trim()
    const wasFenced = fence !== null
    const step = stepFence(fence, line, ANY_INDENT)
    fence = step.state
    if (step.fenced) {
      // A fenced block is code being shown, never a criterion: named once, on
      // its opening line, then swallowed whole.
      if (!wasFenced) {
        state.rejected.push({ line: trimmed, empty: false })
      }
      state.open = false
      state.straying = false
      continue
    }
    if (!trimmed) {
      state.open = false
      state.straying = false
      continue
    }
    const match = LIST_ITEM_RE.exec(line)
    if (match) {
      takeListItem(state, line, match[1] ?? '')
      continue
    }
    takePlainLine(state, line, trimmed)
  }
  return { items: state.items, rejected: state.rejected }
}

const problem = (
  code: TicketProblemCode,
  message: string,
  extra: { section?: TicketSectionHeading; criterion?: string } = {},
): TicketProblem => ({
  code,
  message,
  ...(extra.section ? { section: extra.section } : {}),
  ...(extra.criterion ? { criterion: extra.criterion } : {}),
})

function problemsForSection(scan: SectionScan, heading: TicketSectionHeading): TicketProblem[] {
  const block = scan.blocks.get(heading)
  if (!block) {
    return [problem('section_missing', `missing section ${heading}`, { section: heading })]
  }
  const out: TicketProblem[] = []
  if (scan.duplicated.has(heading)) {
    out.push(
      problem('section_duplicated', `section ${heading} appears more than once`, {
        section: heading,
      }),
    )
  }
  const text = sectionTextOf(block, scan.residue)
  // Bound measured on the NFC form (T2.4, round-2 adversarial review, mineur):
  // `canonicalizeSection` normalizes to NFC before hashing/comparing, so an
  // UNEDITED section merely re-served in a decomposed (NFD) form must not
  // grow past TICKET_SECTION_MAX purely from the composition it happened to
  // arrive in — that would trip section_too_long on content nobody touched.
  const length = codePointLength(text.normalize('NFC'))
  if (!text) {
    out.push(problem('section_empty', `section ${heading} is empty`, { section: heading }))
  } else if (heading !== ACCEPTANCE_CRITERIA_HEADING && length > TICKET_SECTION_MAX) {
    out.push(
      problem(
        'section_too_long',
        `section ${heading} is ${length} characters long, over the ${TICKET_SECTION_MAX} allowed`,
        { section: heading },
      ),
    )
  }
  return out
}

/**
 * Resolved lint behavior for the criteria rules below. Never partial: callers
 * always pass a fully-defaulted object, so nothing here re-decides what
 * `requireProofMethod`'s own absence means.
 */
type CriteriaLintOptions = {
  requireProofMethod: boolean
}

function problemsForCriterion(
  text: string,
  seen: Set<string>,
  opts: CriteriaLintOptions,
): TicketProblem[] {
  const out: TicketProblem[] = []
  // Counted in CODE POINTS, the unit the bound is published in: an emoji is one
  // character of a criterion, not two, and the refusal must say the same.
  const length = codePointLength(text)
  if (length > TICKET_CRITERION_TEXT_MAX) {
    out.push(
      problem(
        'criterion_too_long',
        `acceptance criterion is ${length} characters long, over the ${TICKET_CRITERION_TEXT_MAX} allowed: ${quoted(text)}`,
        { criterion: text },
      ),
    )
  }
  if (!EARS_RE.test(text)) {
    out.push(
      problem(
        'criterion_not_ears',
        `acceptance criterion does not follow "${EARS_TRIGGER} … ${EARS_RESPONSE} …": ${quoted(text)}`,
        { criterion: text },
      ),
    )
  }
  // Off by default (byte-identical to the lint's pre-D17 behavior): only
  // `ticket-draft.ts` opts in today. When it does, a criterion with no valid
  // `[proof:<method> <argument>]` tag is refused by name, same as a criterion
  // that fails EARS.
  if (opts.requireProofMethod && !parseCriterionProof(text)) {
    out.push(
      problem(
        'criterion_missing_proof',
        `acceptance criterion has no valid "[proof:<method> <argument>]" tag: ${quoted(text)}`,
        { criterion: text },
      ),
    )
  }
  const id = acceptanceCriterionId(text)
  if (seen.has(id)) {
    out.push(
      problem('criteria_duplicated', `acceptance criterion appears twice: ${quoted(text)}`, {
        criterion: text,
      }),
    )
  }
  seen.add(id)
  return out
}

/**
 * The rules that apply to the criteria THEMSELVES (count, bound, EARS,
 * duplicates, proof), shared verbatim by `lintTicketBody` and `lintCriteria`
 * so a body and a bare list can never be judged by two different standards.
 */
function problemsForCriteriaTexts(
  texts: readonly string[],
  opts: CriteriaLintOptions,
): TicketProblem[] {
  const problems: TicketProblem[] = []
  if (texts.length < TICKET_CRITERIA_MIN) {
    problems.push(
      problem(
        'criteria_too_few',
        `${texts.length} acceptance criteria found, at least ${TICKET_CRITERIA_MIN} are required`,
        { section: ACCEPTANCE_CRITERIA_HEADING },
      ),
    )
  } else if (texts.length > TICKET_CRITERIA_MAX) {
    problems.push(
      problem(
        'criteria_too_many',
        `${texts.length} acceptance criteria found, at most ${TICKET_CRITERIA_MAX} are allowed`,
        { section: ACCEPTANCE_CRITERIA_HEADING },
      ),
    )
  }
  const seen = new Set<string>()
  for (const text of texts) {
    problems.push(...problemsForCriterion(text, seen, opts))
  }
  return problems
}

function problemsForCriteria(
  scan: SectionScan,
  opts: CriteriaLintOptions,
): { problems: TicketProblem[]; items: string[] } {
  const block = scan.blocks.get(ACCEPTANCE_CRITERIA_HEADING)
  // A missing section is already reported by `problemsForSection`; saying it
  // twice would only pad the refusal.
  if (!block) {
    return { problems: [], items: [] }
  }
  const { items, rejected } = scanCriteriaLines(block)
  const problems: TicketProblem[] = rejected.map(({ line, empty }) =>
    problem(
      'criteria_not_a_list',
      empty
        ? `section ${ACCEPTANCE_CRITERIA_HEADING} carries a list item with no criterion in it: ${quoted(line)}`
        : `section ${ACCEPTANCE_CRITERIA_HEADING} must be a list, and this line is not an item: ${quoted(line)}`,
      { section: ACCEPTANCE_CRITERIA_HEADING },
    ),
  )
  // No filter here: an item that carries no text was already named above, so
  // nothing silently disappears between the section and the count.
  const texts = items.map((item) => collapse(item))
  problems.push(...problemsForCriteriaTexts(texts, opts))
  return { problems, items: texts }
}

/**
 * The gate on a ticket about to be launched (decision D6). Deterministic: the
 * same markdown always yields the same verdict and the same `problems`, in the
 * same order — sections first, in their canonical order, then the criteria of
 * the list in the order they appear. No model, no heuristic, no clock.
 *
 * Admission is wired by the TASK-FROM-ISSUE PATH — the code that turns a forge
 * issue into a task is the one caller required to run this gate, and it belongs
 * to its own ticket. Nothing calls it implicitly: a body being typed in a
 * browser reaches no caller of it, by construction rather than by a flag.
 *
 * Never throws: `raw` that is not a non-empty string is a refusal like any
 * other, with its own code.
 */
export function lintTicketBody(raw: unknown, opts: TicketLintOptions = {}): TicketLintResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return {
      ok: false,
      problems: [problem('body_not_text', 'the ticket body must be a non-empty markdown text')],
    }
  }
  const scan = scanSections(normalizeBodyLines(raw))
  const problems: TicketProblem[] = []
  for (const { heading } of TICKET_SECTIONS) {
    problems.push(...problemsForSection(scan, heading))
  }
  const criteria = problemsForCriteria(scan, {
    requireProofMethod: opts.requireProofMethod ?? false,
  })
  problems.push(...criteria.problems)
  if (problems.length > 0) {
    return { ok: false, problems }
  }
  const text = (heading: TicketSectionHeading): string =>
    sectionTextOf(scan.blocks.get(heading) ?? [], scan.residue)
  return {
    ok: true,
    body: bodyFrom({
      context: text('**Context**'),
      goal: text('**Goal**'),
      scope: text('**Scope**'),
      acceptance_criteria: criteria.items,
      out_of_scope: text('**Out of scope**'),
    }),
  }
}

/** Names what arrived instead of a criterion, so the refusal says it in words. */
function typeName(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  if (value === undefined) {
    return 'nothing'
  }
  if (Array.isArray(value)) {
    return 'an array'
  }
  const type = typeof value
  return type === 'object' ? 'an object' : `a ${type}`
}

/**
 * The same criteria rules as `lintTicketBody`, on a BARE LIST: the entry point
 * for the route that revises the criteria of an existing task without
 * resubmitting a whole body. Entries may be bare strings or the structured
 * `{ text }` form. A refusal carries the same `problems`, so the route answers
 * with the very reason the lint gave.
 *
 * An entry carrying no readable text is REFUSED by name, at its position — it
 * is never quietly dropped. Filtering it out first would let a submission of
 * five entries, two of them unreadable, pass as a conforming list of three: the
 * gate would have judged a list the caller never sent. Same doctrine as the
 * body path, where an empty bullet is named rather than skipped.
 *
 * Never throws: anything that is not a list is a refusal with its own code.
 */
export function lintCriteria(raw: unknown, opts: TicketLintOptions = {}): TicketCriteriaLintResult {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      problems: [
        problem(
          'criteria_not_a_list',
          `the acceptance criteria must be a list, and this is ${typeName(raw)}`,
          { section: ACCEPTANCE_CRITERIA_HEADING },
        ),
      ],
    }
  }
  const problems: TicketProblem[] = []
  const texts: string[] = []
  raw.forEach((item, index) => {
    const text = collapse(criterionSource(item))
    if (text) {
      texts.push(text)
      return
    }
    problems.push(
      problem(
        'criteria_not_a_list',
        `acceptance criterion ${index + 1} carries no text: it is ${typeName(item)}`,
        { section: ACCEPTANCE_CRITERIA_HEADING },
      ),
    )
  })
  problems.push(
    ...problemsForCriteriaTexts(texts, { requireProofMethod: opts.requireProofMethod ?? false }),
  )
  if (problems.length > 0) {
    return { ok: false, problems }
  }
  return { ok: true, criteria: sanitizeAcceptanceCriteria(texts) }
}

/**
 * The readable reason behind a refused launch: every problem, in order, each
 * with its code appended. The code is ADDED to the message, never a stand-in
 * for it — a refusal a human reads must still say what to fix in words.
 *
 * Bounded to `TICKET_PROBLEMS_TEXT_MAX` with a trailing `…`, because the
 * channels that carry it are bounded too (a reason's `detail`, a flat journal
 * payload, an HTTP body): a refusal listing thirty-odd bad criteria must arrive
 * visibly cut rather than silently clipped by whoever stores it. Counted in
 * CODE UNITS here, unlike the contract's own bounds — that is the unit those
 * channels count in, and a reason must fit them without being cut twice — but
 * still never through the middle of a surrogate pair.
 */
export function formatTicketProblems(problems: readonly TicketProblem[]): string {
  return truncateUnits(
    problems.map((p) => `${p.message} [${p.code}]`).join('; '),
    TICKET_PROBLEMS_TEXT_MAX,
  )
}

// --- Published schema -------------------------------------------------------

/**
 * JSON Schema (draft 2020-12) of a ticket body, for consumers validating what
 * codesema wrote. Same family and same job as `reviewRecordSchema`: it must
 * accept EXACTLY what `sanitizeTicketBody` produces and nothing else, which is
 * what keeps the two representations of this contract from drifting apart —
 * the bounds below are the exported constants themselves, not copies of them.
 */
export const ticketBodySchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://codesema.com/schemas/ticket-body.json',
  title: 'Codesema ticket body',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'context', 'goal', 'scope', 'acceptance_criteria', 'out_of_scope'],
  properties: {
    version: { const: 1 },
    context: { $ref: '#/$defs/section' },
    goal: { $ref: '#/$defs/section' },
    scope: { $ref: '#/$defs/section' },
    acceptance_criteria: {
      type: 'array',
      maxItems: TICKET_CRITERIA_MAX,
      // Refuses two IDENTICAL entries. It does NOT refuse two entries sharing
      // an id while differing in text: draft 2020-12 has no "unique by
      // property" keyword, `uniqueItems` compares whole items, and no keyword
      // can state that `id` is a function of `text` either. The guarantee a
      // per-criterion verdict needs — pairwise distinct ids — is therefore made
      // on the producing side, by `sanitizeAcceptanceCriteria`, which keys its
      // deduplication on the id and recomputes it from the text. This schema
      // validates what codesema wrote; it is not a second implementation of it.
      uniqueItems: true,
      items: { $ref: '#/$defs/criterion' },
    },
    out_of_scope: { $ref: '#/$defs/section' },
  },
  $defs: {
    section: { type: 'string', maxLength: TICKET_SECTION_MAX },
    criterion: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'text'],
      properties: {
        id: { type: 'string', pattern: '^ac-[0-9a-f]{12}$' },
        text: { type: 'string', minLength: 1, maxLength: TICKET_CRITERION_TEXT_MAX },
      },
    },
  },
} as const
