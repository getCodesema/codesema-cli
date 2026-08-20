// T2.4: binds a task to a forge issue (decision D7 — "the forge is the source
// of truth"). Two independent jobs live here:
//
//   - ADMISSION: turning a caller-supplied issue reference plus the forge's
//     own issue into a task's title, initial prompt and a FROZEN
//     `issue_snapshot` — refusing, by name, on anything the ticket contract's
//     lint (T2.3) would refuse. Nothing is written to disk from this module:
//     the caller (TaskManager.create) owns the "validate everything, then
//     write" doctrine.
//   - RECONCILIATION: recomputing the issue body's canonical hash and
//     comparing it to the frozen one, at the two points D7 allows — boot, and
//     just before a turn's end-of-turn review. Never restarts a turn: the
//     caller decides what a divergence means for the task's status.
//
// DP13 (panel arbitrage on this ticket's own open question, design.md §Risks
// "stability of the hash"): every hash that can DECIDE anything is over the
// ticket contract's CANONICAL form (`canonicalTicketBody`, contract/ticket.ts)
// — never the forge's raw markdown. The raw body still gets its own digest,
// but that one is forensic ONLY (see `hashRawBody`) and never drives a status
// change or a reason code — see `reconcileIssueSnapshot`'s `'cosmetic'` case.
//
// Same doctrine as every other seam module in this repo: never throws by
// contract, and every network call goes through T2.1's injected `execFn` —
// no test here ever spawns gh/glab or touches the network.

import { createHash } from 'node:crypto'
import {
  canonicalizeSection,
  canonicalTicketBody,
  extractAcceptanceCriteria,
  formatTicketProblems,
  lintTicketBody,
  TASK_TITLE_MAX,
  TASK_TURN_TEXT_MAX,
  TICKET_BODY_HASH_TAG,
  TICKET_SECTIONS,
  type IssueForge,
  type ReasonCode,
  type TaskIssueRef,
  type TaskIssueSnapshot,
  type TaskReason,
  type TicketBody,
} from './contract.js'
import {
  forgeIssueReason,
  getIssue,
  type ForgeIssuesExecFn,
  type ForgeUnavailable,
} from './forge-issues.js'
import { taskReason, type AppendTaskEventInput } from './tasks-store.js'

// --- Hashing (DP13): canonical (decides), section (names), raw (forensic) --

function hashUtf8(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/**
 * The PRIMARY divergence gate: `canonicalTicketBody(body)`, hashed and tagged
 * with `TICKET_BODY_HASH_TAG`. Two producers call this SAME function —
 * `admitIssue` and `reconcileIssueSnapshot` — so they can never disagree on
 * what "the body's canonical hash" means.
 */
export function hashCanonicalBody(body: TicketBody): string {
  return `${TICKET_BODY_HASH_TAG}:${hashUtf8(canonicalTicketBody(body))}`
}

/**
 * One section's canonical hash — a single field needs no injective join,
 * unlike the whole body. Normalized through the SAME `canonicalizeSection`
 * (contract/ticket.ts) `canonicalTicketBody` applies to its own copy of this
 * text (adversarial review majeur 2): if the two ever normalized
 * differently, a real edit could move the aggregate hash while the
 * per-section breakdown stayed silent, or vice versa — the "two halves of
 * the snapshot speak different languages" DP13 was written to rule out.
 */
function hashSection(text: string): string {
  return `${TICKET_BODY_HASH_TAG}:${hashUtf8(canonicalizeSection(text))}`
}

/** `TaskIssueSnapshot.section_hashes`'s shape, computed fresh from a linted body. */
export type SectionHashes = {
  context: string
  goal: string
  scope: string
  out_of_scope: string
}

export function hashSections(body: TicketBody): SectionHashes {
  return {
    context: hashSection(body.context),
    goal: hashSection(body.goal),
    scope: hashSection(body.scope),
    out_of_scope: hashSection(body.out_of_scope),
  }
}

/**
 * FORENSIC ONLY (DP13): sha256 of the exact, un-normalized body the forge
 * returned, tagged `sha256:raw` so it can never be mistaken for — or compared
 * against — a canonical hash. NEVER used to decide a status change or a
 * reason code; its one job is to let reconciliation tell "the raw markdown
 * moved but the canonical meaning did not" from "nothing moved at all".
 */
export function hashRawBody(raw: string): string {
  return `sha256:raw:${hashUtf8(raw)}`
}

/**
 * An EXACT signal that the raw issue body carries content the canonical form
 * does not capture: something before the first recognized heading. Revised
 * after adversarial review (majeur/mineur, "the exact measure is both
 * possible and simpler than the heuristic"): content AFTER the five sections
 * is not a blind spot at all — `**Out of scope**` is the last heading T2.3's
 * scanner looks for, so trailing prose is absorbed into that section's text
 * and IS covered by the hash — and `lintTicketBody` REFUSES a body whose
 * `section_too_long`/`criteria_too_many` would need truncating rather than
 * silently truncating it, so the "truncated content" half of DP13's blind
 * spot cannot be reached by anything that got past the lint in the first
 * place. The only real gap is a stray prefix before the ticket even starts —
 * an "IMPORTANT: …" line pasted above the template — which this finds by a
 * plain search for the first literal heading marker, the same markers T2.3
 * publishes as `TICKET_SECTIONS`. Deliberately not fence/indent-aware like
 * T2.3's own scanner (that precision belongs to T2.3, not to a disclosure-only
 * signal here): a heading quoted inside a fenced sample before the real one
 * would read as "no gap" when there technically is a few characters of
 * fence syntax outside the sections, which costs nothing this mechanism ever
 * claimed to catch and is a smaller error than the length heuristic it
 * replaces.
 */
function hasContentOutsideSections(raw: string): boolean {
  let earliest = -1
  for (const { heading } of TICKET_SECTIONS) {
    const idx = raw.indexOf(heading)
    if (idx !== -1 && (earliest === -1 || idx < earliest)) {
      earliest = idx
    }
  }
  if (earliest === -1) {
    // No recognized heading at all: `lintTicketBody` will already have
    // refused this body (section_missing on all five) before `admitIssue`
    // ever reaches this call, so nothing here has anything to disclose.
    return false
  }
  return raw.slice(0, earliest).trim().length > 0
}

// --- Admission: validating the raw reference --------------------------------

const ISSUE_FORGES = new Set<IssueForge>(['github', 'gitlab'])

/** Shape of the issue reference as it arrives from the wire: everything unknown. */
export type IssueRefInput = {
  forge: unknown
  project: unknown
  iid: unknown
  url: unknown
}

export type IssueRefValidation = { ok: true; ref: TaskIssueRef } | { ok: false; error: string }

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Validates a CALLER-SUPPLIED issue reference before any effect, and REFUSES
 * by name rather than silently dropping — the admission-time twin of
 * `sanitizeIssueRef` (contract/tasks.ts), which tolerates the very same
 * shapes on read-back but must never throw or explain itself. Same split as
 * `lintTicketBody` vs `sanitizeTicketBody` in ticket.ts.
 *
 * `iid` must be a decimal integer and NOTHING else: a numeric-looking string
 * ("12", "0x1f") or a float (1.5) is refused, never coerced — coercion here
 * would accept exactly the malformed inputs decision D7's validation exists
 * to name.
 */
export function validateIssueRef(raw: IssueRefInput): IssueRefValidation {
  if (!ISSUE_FORGES.has(raw.forge as IssueForge)) {
    return { ok: false, error: `unknown forge '${String(raw.forge)}'` }
  }
  const project = typeof raw.project === 'string' ? raw.project.trim() : ''
  if (!project) {
    return { ok: false, error: 'issue.project is required' }
  }
  if (!Number.isInteger(raw.iid) || (raw.iid as number) <= 0) {
    return {
      ok: false,
      error: `issue.iid must be a positive decimal integer, got ${JSON.stringify(raw.iid)}`,
    }
  }
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  if (!url || !isHttpUrl(url)) {
    return { ok: false, error: `issue.url is not a valid http(s) URL: ${JSON.stringify(raw.url)}` }
  }
  return {
    ok: true,
    ref: { forge: raw.forge as IssueForge, project, iid: raw.iid as number, url },
  }
}

/** Readable sentence for a forge call that could not be made, or did not answer. */
function issueUnavailableMessage(result: ForgeUnavailable): string {
  switch (result.reason) {
    case 'no-remote':
      return 'this project has no git remote to read the issue from'
    case 'no-cli':
      return 'no forge CLI (gh or glab) is available to read the issue'
    case 'invalid-input':
      return result.detail ?? 'the issue reference is invalid'
    case 'cli-error':
      return result.detail ?? 'the forge CLI failed while reading the issue'
    // T2.2 widened ForgeIssueReason under this switch. Said honestly: this is
    // not an outage and not a refusal, it is a forge edition that cannot
    // answer the call at all — and, like every other branch here, it maps to
    // no D2 code of its own (forgeIssueReason returns null for it), so the
    // caller's fallback still poses `forge_unreachable`: we did not read it.
    case 'unsupported':
      return result.detail ?? 'this forge edition cannot answer the call that reads the issue'
  }
}

export type IssueAdmission =
  | {
      ok: true
      title: string
      prompt: string
      snapshot: TaskIssueSnapshot
      /** T2.4/DP13: true when the raw body carries content this ticket's edit-detector cannot see. Purely informational. */
      coverage_gap: boolean
    }
  | {
      ok: false
      /** 400: refused before any forge call, or the issue/lint itself is unusable. 502: the forge could not be read. */
      code: 400 | 502
      error: string
      reason_code?: ReasonCode
    }

/**
 * Reads the issue, lints its body (T2.3) and freezes the snapshot — the ONE
 * network round trip decision 5 of design.md requires admission to make
 * BEFORE any effect. Never writes anything: `TaskManager.create` only calls
 * this once every synchronous guard (title/base/branch, isolation) already
 * passed, and only proceeds to `createTask` when this returns `ok: true`.
 */
export async function admitIssue(opts: {
  cwd: string
  ref: TaskIssueRef
  execFn?: ForgeIssuesExecFn
}): Promise<IssueAdmission> {
  const result = await getIssue({
    cwd: opts.cwd,
    number: opts.ref.iid,
    ...(opts.execFn ? { execFn: opts.execFn } : {}),
  })
  if (!result.available) {
    const reason = forgeIssueReason(result)
    return {
      ok: false,
      code: result.reason === 'invalid-input' ? 400 : 502,
      error: issueUnavailableMessage(result),
      ...(reason ? { reason_code: reason.code } : {}),
    }
  }
  // Same discipline as the direct title+prompt path (task-server.ts `create`):
  // reject rather than truncate, so a silently shortened title never diverges
  // from what the issue actually says.
  const title = result.issue.title.trim()
  if (!title) {
    return { ok: false, code: 400, error: 'the issue has no title' }
  }
  if (title.length > TASK_TITLE_MAX) {
    return { ok: false, code: 400, error: `issue title too long (max ${TASK_TITLE_MAX})` }
  }
  const lint = lintTicketBody(result.issue.body)
  if (!lint.ok) {
    return { ok: false, code: 400, error: formatTicketProblems(lint.problems) }
  }
  // The RAW body (post-lint, pre-reconstruction) is what becomes the task's
  // initial prompt: T2.5 is the ticket that replaces this with the real
  // prompt-injection template built from the structured criteria. Until then,
  // the linted markdown itself is the most honest instruction to hand the
  // agent — never silently truncated, since dropping the tail would silently
  // drop instructions.
  const prompt = result.issue.body.trim()
  if (prompt.length > TASK_TURN_TEXT_MAX) {
    return {
      ok: false,
      code: 400,
      error: `issue body too long to use as the initial prompt (max ${TASK_TURN_TEXT_MAX} chars)`,
    }
  }
  return {
    ok: true,
    title,
    prompt,
    snapshot: {
      body_hash: hashCanonicalBody(lint.body),
      section_hashes: hashSections(lint.body),
      criteria: extractAcceptanceCriteria(lint.body),
      raw_body_hash: hashRawBody(result.issue.body),
      taken_at: new Date().toISOString(),
    },
    coverage_gap: hasContentOutsideSections(result.issue.body),
  }
}

// --- Reconciliation: has the issue moved since the snapshot was taken? -----

export type IssueSectionKey = 'context' | 'goal' | 'scope' | 'out_of_scope'
const SECTION_KEYS: readonly IssueSectionKey[] = ['context', 'goal', 'scope', 'out_of_scope']

export type IssueReconcile =
  | { kind: 'unchanged' }
  /** Raw body moved, canonical meaning did not: neutral, no status change, no reason_code (DP13). */
  | { kind: 'cosmetic' }
  /**
   * Canonical meaning moved: which sections, and which criteria ids
   * appeared/disappeared. `sections_unknown` is true only when the frozen
   * snapshot carries no `section_hashes` breakdown to compare against (it is
   * optional — see `TaskIssueSnapshot`) — the divergence is still real and
   * still reported, but WHICH prose section moved cannot be named; `sections`
   * is then always `[]`, which must never be read as "no section changed".
   */
  | {
      kind: 'edited'
      sections: IssueSectionKey[]
      sections_unknown: boolean
      criteria_added: string[]
      criteria_removed: string[]
    }
  /** The live body no longer passes T2.3's lint — a DISTINCT cause from 'edited'. */
  | { kind: 'not_ticket'; message: string }
  | { kind: 'unreachable'; reason: TaskReason }

/**
 * Recomputes the issue's canonical hash and compares it to the frozen
 * snapshot — the ONE check both reconciliation points (boot, pre-review) run.
 * Never decides what a divergence means for the task's status: that
 * transition belongs to the caller, which is what keeps "aucun tour ne
 * redémarre seul" true regardless of where this is called from.
 */
export async function reconcileIssueSnapshot(opts: {
  cwd: string
  issue: TaskIssueRef
  snapshot: TaskIssueSnapshot
  execFn?: ForgeIssuesExecFn
}): Promise<IssueReconcile> {
  const result = await getIssue({
    cwd: opts.cwd,
    number: opts.issue.iid,
    ...(opts.execFn ? { execFn: opts.execFn } : {}),
  })
  if (!result.available) {
    // invariant 2: forge_unreachable is always chosen here, even for the
    // 'invalid-input' branch that `forgeIssueReason` maps to no code — the
    // issue reference was validated once, at admission, so an invalid-input
    // outcome here can only mean the forge itself started rejecting a call it
    // used to accept, which reads as unreachable to a task that is not
    // creating anything new.
    const reason =
      forgeIssueReason(result) ?? taskReason('forge_unreachable', issueUnavailableMessage(result))
    return { kind: 'unreachable', reason }
  }
  const lint = lintTicketBody(result.issue.body)
  if (!lint.ok) {
    return { kind: 'not_ticket', message: formatTicketProblems(lint.problems) }
  }
  const bodyHash = hashCanonicalBody(lint.body)
  if (bodyHash === opts.snapshot.body_hash) {
    // DP13: the raw digest is compared ONLY here, and only to decide between
    // silence and a neutral line — never to decide 'edited', never to touch
    // status or reason_code.
    if (
      opts.snapshot.raw_body_hash &&
      hashRawBody(result.issue.body) !== opts.snapshot.raw_body_hash
    ) {
      return { kind: 'cosmetic' }
    }
    return { kind: 'unchanged' }
  }
  const snapshotSections = opts.snapshot.section_hashes
  const freshSections = hashSections(lint.body)
  const sections = snapshotSections
    ? SECTION_KEYS.filter((key) => freshSections[key] !== snapshotSections[key])
    : []
  const freshIds = new Set(lint.body.acceptance_criteria.map((c) => c.id))
  const oldIds = new Set(opts.snapshot.criteria.map((c) => c.id))
  const criteria_added = [...freshIds].filter((id) => !oldIds.has(id))
  const criteria_removed = [...oldIds].filter((id) => !freshIds.has(id))
  return {
    kind: 'edited',
    sections,
    sections_unknown: !snapshotSections,
    criteria_added,
    criteria_removed,
  }
}

// --- Journal events (DP9: the type names the DOMAIN, data.name the cause) --

/** Emitted once, right after a task is created from an issue. */
export function issueBoundEvent(snapshot: TaskIssueSnapshot): AppendTaskEventInput {
  return {
    type: 'issue',
    data: {
      name: 'bound',
      body_hash: snapshot.body_hash,
      ...(snapshot.raw_body_hash ? { raw_digest: snapshot.raw_body_hash } : {}),
      message:
        'task created from a forge issue: its ticket body and acceptance criteria are frozen in issue_snapshot',
    },
  }
}

export const ISSUE_COVERAGE_GAP_MESSAGE =
  'this issue carries content outside the five sections the ticket contract reads (or a section/criterion may sit near the contract bound): edits there will not be detected as a ticket change'

/** Emitted at admission ONLY when `IssueAdmission.coverage_gap` is true. */
export function issueCoverageGapEvent(): AppendTaskEventInput {
  return { type: 'issue', data: { name: 'coverage_gap', message: ISSUE_COVERAGE_GAP_MESSAGE } }
}

/**
 * The journal line for a fact about the bound issue itself, mirroring
 * `costEvent` (task-runner.ts) exactly: the DOMAIN type ('issue'), the
 * specific cause in `data.name`.
 *
 * `'unreachable'` is one of those causes, not an exception to them (DP15
 * enumerates it alongside `bound`, `edited`, `not_ticket` and `cosmetic`).
 * It used to be routed onto `type: 'error'`; that was wrong twice over. The
 * tone: DP9 forbids painting a non-event red, and this IS a non-event for
 * the task — it carries on unmodified on its existing snapshot, nothing is
 * refused, nothing is asked of anyone. And the language: `SUMMARY_KEYS.error`
 * probes `['message','error','summary']`, so the English sentence built here
 * reached a French journal verbatim, on EVERY ticketed task, at every boot of
 * a machine with no `gh`/`glab` (brief §6 quater, "the raw English technical
 * message served as is"). On `'issue'` the web renders from `data.name`
 * through its own catalog key instead.
 *
 * `reason_code` is a field of its own, independent of `type`: the event still
 * carries `forge_unreachable` for the API and CLI readers (invariant 2's
 * third leg), which is what routing through `error` was really buying.
 */
export function issueReconcileEvent(
  outcome: Extract<IssueReconcile, { kind: 'cosmetic' | 'edited' | 'not_ticket' | 'unreachable' }>,
): AppendTaskEventInput {
  switch (outcome.kind) {
    case 'cosmetic':
      return {
        type: 'issue',
        data: {
          name: 'cosmetic',
          message:
            'the issue was edited on the forge, but its meaning under the ticket contract did not change: no section or acceptance criterion moved',
        },
      }
    case 'edited': {
      // Round-4 adversarial review, majeur 1: these three fields are the
      // MACHINE-READABLE diff, not a rendered sentence — a comma-joined list,
      // EMPTY when nothing moved on that axis, plus a separate
      // `sections_unknown` flag. They used to carry English parentheticals
      // ('(none)', '(unknown: this snapshot carries no section breakdown)')
      // that the French journal then displayed verbatim: a value a UI has to
      // translate must never arrive pre-worded (brief §6 quater, "the raw
      // English technical message served as is"). `message` below keeps the
      // whole English sentence for the API and CLI readers that have no
      // catalog; the web renders from these fields instead
      // (issueEventText, useTaskBoard.ts).
      //
      // A snapshot with no section_hashes breakdown cannot say "none changed"
      // — that would claim the opposite of what is true (the body_hash gate
      // already proved something did), hence the distinct flag rather than an
      // empty list.
      const sections = outcome.sections_unknown ? '' : outcome.sections.join(',')
      const added = outcome.criteria_added.join(',')
      const removed = outcome.criteria_removed.join(',')
      const saidSections = outcome.sections_unknown
        ? '(unknown: this snapshot carries no section breakdown)'
        : sections || '(none)'
      return {
        type: 'issue',
        data: {
          name: 'edited',
          sections,
          ...(outcome.sections_unknown ? { sections_unknown: true } : {}),
          criteria_added: added,
          criteria_removed: removed,
          message: `the issue was edited on the forge since this task's ticket was frozen — sections changed: ${saidSections}; criteria added: ${added || '(none)'}; criteria removed: ${removed || '(none)'}`,
        },
      }
    }
    case 'not_ticket':
      return {
        type: 'issue',
        data: {
          name: 'not_ticket',
          message: `the issue no longer passes the ticket contract's lint: ${outcome.message}`,
        },
      }
    case 'unreachable':
      return {
        type: 'issue',
        data: {
          name: 'unreachable',
          // DP13: "forge injoignable → on continue sur le snapshot, et AUCUNE
          // affirmation sur la dérive". The producer's own words are kept
          // verbatim next to the code (invariant 2: the code is added to the
          // readable message, never substituted for it) — this field is read
          // by the API and the CLI, never by the web journal, which renders
          // the translated line from `data.name`.
          message: `the forge could not be read to compare this task's ticket (${outcome.reason.detail ?? outcome.reason.code}); the task carries on unmodified on its existing snapshot, and nothing is claimed about whether the issue moved`,
        },
        reason_code: outcome.reason.code,
      }
  }
}

export const ISSUE_SNAPSHOT_UNREADABLE_MESSAGE =
  'this task still names a forge issue but its frozen ticket snapshot could not be read back (an unknown hash tag, or a malformed record): codesema can no longer tell whether that issue has been edited, and this task is excluded from edit detection until it is re-bound'

/**
 * Round-4 adversarial review, majeur 2. `sanitizeIssueSnapshot`
 * (contract/tasks.ts) drops the WHOLE `issue_snapshot` when `body_hash` is not
 * tagged with the tag THIS build produces — which is exactly what a future
 * bump of `TICKET_BODY_HASH_TAG` does to every task frozen by the previous
 * one. `TaskRecord.issue` survives that drop, so the task keeps CLAIMING it
 * carries a ticket while both recomparison points (boot, pre-review) skip it
 * forever on their `!record.issue_snapshot` guard — and the first rewrite of
 * the record persists the sanitized version, erasing the snapshot from disk.
 *
 * Silence there is the failure mode invariant 2 forbids, so the boot pass says
 * it: this line, plus a workspace notice. Deliberately NO reason_code (DP10:
 * the table stays at ten codes, and DP14's first condition fails — nothing is
 * stopped or refused, the task runs exactly as before, it is only the EDIT
 * DETECTOR that retired).
 */
export function issueSnapshotUnreadableEvent(): AppendTaskEventInput {
  return {
    type: 'issue',
    data: { name: 'snapshot_unreadable', message: ISSUE_SNAPSHOT_UNREADABLE_MESSAGE },
  }
}
