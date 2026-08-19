// The normalized recap generator (T3.4, decision D10): deterministic-first,
// the facts before the prose. Every factual field has ONE source, written
// down in the ticket's own design.md before any code:
//
//   files[]    <- diff `baseline_sha..branch` (T1.5)
//   tests[]    <- the persisted checks.json (T3.1)
//   criteria[] <- the review's per-criterion verdicts (T3.2, injected — this
//                 ticket lands ahead of T3.2 and has no live source to read,
//                 so the caller supplies it once it exists; absent is the
//                 normal state of a ticketless task, DP12)
//   cost       <- the task record (T1.8), copied, never recomputed
//   branch/mr_url <- the ship outcome
//
// The model is read for EXACTLY THREE fields — summary, changes[], decisions[]
// — via `RecapModelContribution`, whose type carries nothing else. The
// rejection of every other field the model might have produced is
// STRUCTURAL: this module never looks up a `.files`, `.tests`, `.criteria`,
// `.cost_ticks` or `.mr_url` key on the model's output, so invariant 4 ("the
// LLM never produces a verdict, a percentage or a figure that counts") holds
// by construction, not by filtering one out after the fact.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.js'
import {
  isTaskId,
  sanitizeRecap,
  type AcceptanceCriterion,
  type CostBasis,
  type CriterionVerdict,
  type RecapCriterionVerdict,
  type RecapRecord,
  type RecapTestEntry,
  type TaskRecord,
} from './contract.js'
import { tryGit } from './git.js'
import { readTaskChecks, readTaskEvents, taskDir } from './tasks-store.js'

/** Model's own draft of the recap: read for exactly these three keys, structurally nothing else (see module doc). */
export type RecapModelContribution = {
  summary?: string
  changes?: string[]
  decisions?: string[]
}

/**
 * One factual field the generator could not fill from its real source. Named
 * so a consumer can tell WHICH provenance degraded, not just that something
 * did. `'branch'` is the one truly-exceptional case: `sanitizeTaskRecord`
 * does not guard `branch` the way it guards `id` (`str(r.branch, ...)` has no
 * fallback), so a hand-edited or truncated `task.json` CAN reach this
 * generator with an empty branch — reachable, not a hard invariant.
 *
 * `criteria` is deliberately never a degradation field: DP12 states its
 * absence is the NORMAL condition of a task with no linked ticket (or one
 * whose review has not produced per-criterion verdicts yet) — reporting it as
 * a gap on every ticketless task would be a false alarm on every single run,
 * exactly the "always-wrong warning" DP13 rejects for the same reason.
 */
export type RecapDegradation = {
  field: 'files' | 'tests' | 'summary' | 'branch'
  /** Readable reason. This generator has no caller yet (see `generateRecap`'s doc): journaling and API surfacing are for whoever wires one up. */
  reason: string
}

export type GenerateRecapResult = {
  /**
   * `null` ONLY when the task itself has no usable branch to identify a
   * recap by (see `RecapDegradation['branch']`) — there is no honest value to
   * invent for the recap's one identity-bearing field, so the generator
   * refuses rather than fabricating one. Every other degradation still
   * produces a real, honestly-incomplete record.
   */
  recap: RecapRecord | null
  /** Every degradation encountered, in the order the fields were built. Empty when every source was available. */
  degradations: RecapDegradation[]
}

/**
 * Files changed over one git range, argv only (no shell interpolation — same
 * discipline as git.ts). `null` on any git failure (unreachable range, no
 * such worktree/repo at `cwd`): a caller degrades rather than invents.
 */
export type DiffFilesFn = (range: string, cwd: string) => string[] | null

const defaultDiffFiles: DiffFilesFn = (range, cwd) => {
  // Same argv shape as the diff readers already in this package (prep.ts,
  // preview.ts): `-c core.quotePath=false` so a non-ASCII path comes back as
  // itself instead of a quoted octal escape (`"caf\303\251.ts"`), and `-- .`
  // so `range` can never be misread as a pathspec.
  const out = tryGit(['-c', 'core.quotePath=false', 'diff', '--name-only', range, '--', '.'], cwd)
  if (out === null) {
    return null
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export type GenerateRecapOptions = {
  /**
   * MAIN repo root — git and the task store are both read from here, never
   * from the task's worktree: by the time a recap is generated the worktree
   * may already be gone (a shipped task's cleanup), while `baseline_sha` and
   * `branch` are ordinary refs the main repo can always resolve.
   */
  cwd: string
  task: TaskRecord
  /** The model's draft; read for summary/changes/decisions ONLY. `null`/absent is a legitimate "the model produced nothing usable". */
  modelOutput?: RecapModelContribution | null
  /** Per-criterion verdicts already produced by the review (T3.2). Absent is normal (DP12) — see `RecapDegradation`. */
  criteriaVerdicts?: CriterionVerdict[]
  /** The ticket's own acceptance criteria, to resolve `criterion_id` -> `text` for the denormalized entry (DP12). */
  acceptanceCriteria?: AcceptanceCriterion[]
  // --- I/O seams (§ 0.4): every real dependency is injectable, the defaults
  // drive real git / the real task store.
  diffFilesFn?: DiffFilesFn
  readTaskChecksFn?: typeof readTaskChecks
  readTaskEventsFn?: typeof readTaskEvents
}

function buildFiles(opts: GenerateRecapOptions, degradations: RecapDegradation[]): string[] {
  const diffFiles = opts.diffFilesFn ?? defaultDiffFiles
  const { branch, baseline_sha: baseline, base } = opts.task
  if (baseline) {
    const files = diffFiles(`${baseline}..${branch}`, opts.cwd)
    if (files !== null) {
      return files
    }
    degradations.push({
      field: 'files',
      reason: `git diff failed for ${baseline}..${branch}: files[] left empty`,
    })
    return []
  }
  // No baseline recorded (a record written before T1.5, or a lineage that
  // never got one): fall back to the wider base...branch range, same
  // degrade-and-SAY choice task-review.ts makes for its own review range
  // (baselineFallbackReason). A diff computed from git over an imprecise
  // range is still a FACT, only a less precise one; an empty files[] here
  // would under-claim just as dishonestly as an invented list would
  // over-claim.
  const range = `${base}...${branch}`
  const files = diffFiles(range, opts.cwd)
  if (files === null) {
    // The fallback ALSO failed: files[] really is empty, and the reason must
    // say so — claiming "measured from X" for a measurement that in fact
    // never produced anything is a false announcement of a true decision, not
    // a rounding error.
    degradations.push({
      field: 'files',
      reason: `no baseline_sha recorded for this task, and git diff over the fallback range ${range} also failed: files[] left empty`,
    })
    return []
  }
  degradations.push({
    field: 'files',
    reason: `no baseline_sha recorded for this task: files[] measured from ${range}, which may also include commits that predate this conversation`,
  })
  return files
}

function buildTests(
  opts: GenerateRecapOptions,
  degradations: RecapDegradation[],
): RecapTestEntry[] {
  const readChecks = opts.readTaskChecksFn ?? readTaskChecks
  const checks = readChecks(opts.cwd, opts.task.id)
  if (!checks) {
    degradations.push({
      field: 'tests',
      reason: 'no checks.json persisted for this task: tests[] left empty',
    })
    return []
  }
  // Whole-run states that an empty tests[] would misrepresent: an empty list
  // reads as "nothing to show" but a naive `every(passed)` over it is
  // vacuously true, i.e. a silent green. One synthetic entry names the state
  // instead — 'unconfigured' is never shown as passing, 'error' is named.
  if (checks.status === 'unconfigured') {
    return [
      { command: '(no checks configured for this repo)', status: 'unconfigured', synthetic: true },
    ]
  }
  if (checks.status === 'error') {
    return [
      { command: checks.error?.trim() || 'check run failed', status: 'error', synthetic: true },
    ]
  }
  return checks.checks.map((check) => ({ command: check.command, status: check.status }))
}

/** Denormalizes `text` onto each verdict (DP12), best-effort: a verdict whose criterion cannot be resolved keeps its id and status, simply without a caption. */
function buildCriteria(opts: GenerateRecapOptions): RecapCriterionVerdict[] | undefined {
  const verdicts = opts.criteriaVerdicts
  if (!verdicts || verdicts.length === 0) {
    return undefined
  }
  const textById = new Map((opts.acceptanceCriteria ?? []).map((c) => [c.id, c.text]))
  return verdicts.map((verdict) => {
    const text = textById.get(verdict.criterion_id)
    return { ...verdict, ...(text ? { text } : {}) }
  })
}

type RecapCost = { tokens?: number; cost_ticks?: number; cost_basis?: CostBasis }

/**
 * Reads cost straight off the record, never recomputing `cost_ticks` (T1.8
 * already sums it there). `tokens` has no such aggregate on `TaskRecord`
 * (only per-turn) — summing the turns' own counters is still reading a
 * measurement the CLI already made, never a figure the model states.
 */
function buildCost(task: TaskRecord): RecapCost {
  // A hand-edited or truncated task.json can lose `turns` the same way it can
  // lose `branch` (see generateRecap's doc on the reachable-null-branch
  // path): `Array.isArray` here, not a bare `.filter`, so that file reaches
  // an honest empty cost instead of throwing through a "NEVER throws"
  // generator.
  const turns = Array.isArray(task.turns) ? task.turns : []
  const withTokens = turns.filter((turn) => typeof turn?.tokens === 'number')
  const tokens =
    withTokens.length > 0
      ? withTokens.reduce((sum, turn) => sum + (turn.tokens ?? 0), 0)
      : undefined
  return {
    ...(tokens !== undefined ? { tokens } : {}),
    ...(task.cost_ticks !== undefined ? { cost_ticks: task.cost_ticks } : {}),
    ...(task.cost_basis !== undefined ? { cost_basis: task.cost_basis } : {}),
  }
}

/** The URL of the LATEST 'shipped' event's payload, if any — mr_url never lives on TaskRecord itself (see task-server.ts), only on the journal line the ship wrote. */
function buildMrUrl(opts: GenerateRecapOptions): string | undefined {
  const readEvents = opts.readTaskEventsFn ?? readTaskEvents
  const events = readEvents(opts.cwd, opts.task.id)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'shipped') {
      const url = event.data.mr_url
      return typeof url === 'string' && url ? url : undefined
    }
  }
  return undefined
}

/**
 * Reads EXACTLY `summary`, `changes[]` and `decisions[]` off the model's
 * output — see the module doc. `modelOutput` absent/null degrades the three
 * prose fields to their honest empty defaults; this function only BUILDS the
 * raw values, it does not decide whether they degrade — see the round-4
 * fix on `generateRecap`, below, on why.
 */
function buildModelFields(opts: GenerateRecapOptions): {
  summary: string
  changes: string[]
  decisions: string[]
} {
  const model = opts.modelOutput
  const summary = model && typeof model.summary === 'string' ? model.summary : ''
  const changes =
    model && Array.isArray(model.changes)
      ? model.changes.filter((c): c is string => typeof c === 'string')
      : []
  const decisions =
    model && Array.isArray(model.decisions)
      ? model.decisions.filter((d): d is string => typeof d === 'string')
      : []
  return { summary, changes, decisions }
}

/**
 * Builds a `RecapRecord` for one task. Every factual field is read from its
 * ONE source (see module doc); the model contributes only prose. NEVER
 * throws.
 *
 * This generator has NO CALLER yet (T3.4 lands ahead of T3.2's per-criterion
 * verdicts and of any route/turn that would invoke it): `degradations` is
 * therefore only RETURNED, never journaled or pushed onto an API surface from
 * here. That is deliberate, not an omission — the same rule this project
 * applies whenever a module has no consumer yet: the reason for a
 * degradation belongs in the return value, and the journal-event and
 * API-surfacing legs of invariant 2 are the responsibility of whichever
 * caller wires this generator into the task pipeline. Adding a journal event
 * type today, for a path nothing exercises, would be a sixth enum member
 * nobody can yet observe firing correctly.
 */
export function generateRecap(opts: GenerateRecapOptions): GenerateRecapResult {
  const degradations: RecapDegradation[] = []
  const files = buildFiles(opts, degradations)
  const tests = buildTests(opts, degradations)
  const criteria = buildCriteria(opts)
  const cost = buildCost(opts.task)
  const mrUrl = buildMrUrl(opts)
  const model = buildModelFields(opts)

  const raw = {
    version: 1 as const,
    ...model,
    files,
    tests,
    ...(criteria ? { criteria } : {}),
    ...cost,
    branch: opts.task.branch,
    ...(mrUrl ? { mr_url: mrUrl } : {}),
  }
  const recap = sanitizeRecap(raw)
  if (!recap) {
    // REACHABLE: sanitizeTaskRecord guards `id` but not `branch`
    // (`str(r.branch, TASK_PATH_MAX)` has no fallback), so a hand-edited or
    // truncated task.json can carry a TaskRecord with an empty branch. There
    // is no honest value to invent for the recap's one identity-bearing
    // field, so the generator refuses rather than fabricating one.
    degradations.push({
      field: 'branch',
      reason: 'task record has no usable branch: no recap can be identified or produced for it',
    })
    return { recap: null, degradations }
  }
  // Round 4, majeur 2: decided on the SANITIZED record, not on `model`'s raw
  // values. `buildModelFields` above can hand back a summary/changes/
  // decisions that LOOK non-empty (`'   '`, `'\n\n'`, a list of blank
  // entries) yet sanitize down to nothing through `sanitizeRecap` (`str()`
  // trims, `sanitizeStringList` drops a blank entry outright) — testing the
  // raw values, as an earlier version of this function did, silently
  // reported `degradations: []` on exactly those inputs: a generator
  // claiming every source was available when in truth nothing usable came
  // out of the model.
  if (recap.summary === '' && recap.changes.length === 0 && recap.decisions.length === 0) {
    degradations.push({
      field: 'summary',
      reason: opts.modelOutput
        ? 'model output present but summary/changes/decisions were not usable after sanitizing: left empty'
        : 'no model output available for this recap: summary/changes/decisions left empty',
    })
  }
  return { recap, degradations }
}

// --- Persistence: .codesema/tasks/<id>/recap.json ---------------------------
// Same recipe as checks.json (tasks-store.ts): atomic tmp+rename write
// (writeJsonAtomic, invariant 5), relecture through sanitizeRecap only, never
// a bare JSON.parse. Absence of the file is a NORMAL state — a task that has
// not reached recap generation yet — never surfaced as an error.

function recapPath(cwd: string, id: string): string {
  return join(taskDir(cwd, id), 'recap.json')
}

/**
 * Atomic rewrite of recap.json. The payload is sanitized before writing so
 * the file on disk is always bounded and always what `recapRecordSchema`
 * accepts; the sanitized copy is returned so the caller broadcasts exactly
 * what was persisted, same contract as `writeTaskChecks`.
 */
export function writeTaskRecap(cwd: string, id: string, recap: RecapRecord): RecapRecord {
  if (!isTaskId(id)) {
    throw new Error(`invalid task id: ${id}`)
  }
  const clean = sanitizeRecap(recap)
  if (!clean) {
    // Unreachable through the typed input; a hard invariant like writeTaskChecks's.
    throw new Error('invalid task recap')
  }
  writeJsonAtomic(recapPath(cwd, id), clean)
  return clean
}

/**
 * Latest recap.json of a task. `null` on an unknown id, a task never
 * recapped, an unreadable file or unusable content — a caller turns that into
 * "no recap yet", never a crash. This is the ONLY sanctioned way to read
 * recap.json back: a bare `JSON.parse` would trust the file, which
 * `sanitizeRecap` exists precisely so nothing has to.
 */
export function readTaskRecap(cwd: string, id: string): RecapRecord | null {
  if (!isTaskId(id)) {
    return null
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(recapPath(cwd, id), 'utf8'))
  } catch {
    return null
  }
  return sanitizeRecap(raw)
}

// --- Rendering: renderRecapMarkdown ------------------------------------------
// A PURE function of the record alone (design.md § 5): no I/O, no model call,
// no data outside `RecapRecord`. This is the frontier with T3.5 — publishing
// posts this output as-is, with no reformatting decision left to make.

const TEST_STATUS_LABEL: Record<RecapTestEntry['status'], string> = {
  passed: 'passed',
  failed: 'failed',
  timeout: 'timeout',
  skipped: 'skipped',
  unconfigured: 'unconfigured',
  error: 'error',
}

// --- Neutralizing the model's prose ------------------------------------------
// Invariant 4 is structural in the DATA (task-recap.ts's own generator reads
// no other key off the model's output) but a document is not its data: a
// `summary` containing a blank line followed by `## Acceptance criteria` or
// `**Merge request:** https://evil.example/pr/1` renders as a live section of
// THIS document, typographically indistinguishable from — and, embedded
// early in `summary`, positioned BEFORE — the real one. `summary`,
// `changes[]` and `decisions[]` are the only fields the model may fill; they
// are also the only ones run through this before they reach the page.

/**
 * Any CommonMark line terminator: LF, CRLF, or a lone CR — the spec treats
 * all three as an equivalent end-of-line, so splitting on `\n` alone lets a
 * lone `\r` carry a "new line" straight through unneutralized (round 2,
 * majeur 1: the round 1 fix only shrank the escape to `\n`, it did not close
 * it). `str()` in recap.ts and `sanitizeCriterionVerdict.evidence` in
 * ticket.ts already normalize `\r\n?` -> `\n` at the DATA layer before this
 * module ever sees the text; this split is the second, independent layer —
 * defense in depth, not a duplicate of that guarantee.
 */
const LINE_TERMINATOR_RE = /\r\n|\r|\n/

/**
 * A leading run of a markdown block-opening character — ATX heading, block
 * quote, thematic break / setext underline, list or code-fence marker, table
 * pipe, or the `<` that opens an HTML block/tag — up to 3 spaces of indent
 * (draft CommonMark still treats that as "start of line").
 */
const LINE_START_MARKDOWN_RE = /^( {0,3})([#>*+\-=_~`|<])/

/** A leading ordered-list marker: 1-9 digits then `.` or `)`, up to 3 spaces of indent. */
const LINE_START_ORDERED_LIST_RE = /^( {0,3})(\d{1,9})([.)])/

/** Backslash-escapes a line-opening markdown marker so raw model text can never open a new block of this document (an ATX heading, a blockquote, a thematic break, a list, an ordered list, a fence, a table, an HTML block). */
function escapeMarkdownLineStarts(text: string): string {
  return text
    .split(LINE_TERMINATOR_RE)
    .map((line) => {
      const ordered = line.match(LINE_START_ORDERED_LIST_RE)
      if (ordered) {
        const [whole, indent, digits, delim] = ordered
        return `${indent}${digits}\\${delim}${line.slice(whole.length)}`
      }
      return line.replace(
        LINE_START_MARKDOWN_RE,
        (_m, indent: string, ch: string) => `${indent}\\${ch}`,
      )
    })
    .join('\n')
}

/**
 * Wraps model prose in a markdown blockquote, one line (including blank
 * ones) at a time, so an embedded literal newline — in ANY of its three
 * CommonMark forms (LF, CRLF, lone CR) — can never let it fall back out to
 * the top level of the document: a quote glued together like this only ends
 * where THIS function ends it.
 */
function quoteModelText(text: string): string {
  return escapeMarkdownLineStarts(text)
    .split(LINE_TERMINATOR_RE)
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n')
}

/**
 * Collapses every CommonMark line terminator (LF, CRLF, lone CR) — plus the
 * whitespace touching it — to a single space. Shared by every place that
 * must fold model prose onto one physical line before escaping it.
 */
function collapseToOneLine(text: string): string {
  return text.replace(/\s*(?:\r\n|\r|\n)\s*/g, ' ').trim()
}

/** Collapses model-authored text to one line, then escapes it — the shared neutralization for anything that must render as inline text (a bullet, a criterion label, a criterion's evidence). */
function neutralizeModelLine(text: string): string {
  return escapeMarkdownLineStarts(collapseToOneLine(text))
}

/**
 * One model-authored bullet. A bullet is inherently ONE line: any embedded
 * line break is collapsed to a space rather than rendered literally, which
 * would either break the list structure or, the moment the next line starts
 * with a block-opening character, splice a new element into the document.
 * The survivor is then escaped like any other model text.
 */
function renderModelBullet(item: string): string {
  return `- ${neutralizeModelLine(item)}`
}

function renderModelList(items: readonly string[]): string {
  return items.map((item) => renderModelBullet(item)).join('\n')
}

/**
 * Renders `text` as a markdown inline code span, safe even when `text` itself
 * contains one or more backticks (a branch name technically can): picks a
 * fence one backtick longer than any run already inside it, per CommonMark's
 * own rule for escaping a code span.
 */
function inlineCode(text: string): string {
  const longestRun = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(longestRun + 1)
  const pad = longestRun > 0 ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/**
 * `files[]`, in inline code. A path is code, so `inlineCode` neutralizes any
 * markdown it happens to carry for free; `collapseToOneLine` is the second,
 * independent layer (`recap.ts`'s `line()` already forces the DATA to be
 * mono-line — round 4, majeur 1) so a `RecapRecord` assembled by hand still
 * renders honestly even if it bypassed `sanitizeRecap`.
 */
function renderList(items: readonly string[]): string {
  return items.map((item) => `- ${inlineCode(collapseToOneLine(item))}`).join('\n')
}

/**
 * `tests[]`, one bullet per entry: the STATUS comes from a closed enum
 * (`TEST_STATUS_LABEL`, nothing a repo or a model can shape), the COMMAND
 * goes through the very same treatment as a `files[]` path — `inlineCode`
 * over `collapseToOneLine`.
 *
 * Round 5, majeur 2 — it did NOT, until this round. `files[]` got the code
 * span at round 4 on the reasoning that "a path is a string an agent can
 * shape freely", and this function was left one line away from it — and
 * `tests[].command` is that same class of string, named EXPLICITLY by the
 * same requirement: a repo-declared `.codesema/config.json` `checks.commands[]`
 * entry (`readChecksConfig`, `repo-config.ts`, no newline filter), or the
 * readable cause carried on the `synthetic` entry built from `checks.error`.
 * Left plain, `bun test ![](https://evil.example/pixel.png)` rendered a LIVE
 * remote image, and `[click here](https://evil.example/phish)` a LIVE link,
 * inside the MR description T3.5 posts — on a record that passes both the
 * schema and `sanitizeRecap` untouched, since neither is markdown-aware.
 * A code span is the whole fix: markdown inside it is inert, and `inlineCode`
 * picks a fence longer than any backtick run already present.
 */
function renderTests(tests: readonly RecapTestEntry[]): string {
  return tests
    .map((t) => `- [${TEST_STATUS_LABEL[t.status]}] ${inlineCode(collapseToOneLine(t.command))}`)
    .join('\n')
}

/**
 * `text` (denormalized from the ticket body, T2.x) and `evidence` (the
 * reviewer's own quoted grounding, T3.2, DP12) are BOTH model-authored prose,
 * exactly like `summary`/`changes`/`decisions` — the doc comment that used to
 * sit above this function claimed otherwise ("plain rendering is safe, there
 * is no untrusted prose left to neutralize") and that claim was false (round
 * 2, majeur 2). Both are neutralized the same way model text is everywhere
 * else in this module: collapsed to one line, then escaped.
 */
function renderCriteria(criteria: readonly RecapCriterionVerdict[]): string {
  return criteria
    .map((c) => {
      const label = neutralizeModelLine(c.text ?? c.criterion_id)
      const line = `- [${c.status}] ${label}`
      return c.evidence ? `${line}\n  evidence: ${neutralizeModelLine(c.evidence)}` : line
    })
    .join('\n')
}

function renderCost(recap: RecapRecord): string | null {
  const parts: string[] = []
  if (recap.tokens !== undefined) {
    parts.push(`${recap.tokens} tokens`)
  }
  if (recap.cost_ticks !== undefined && recap.cost_basis !== undefined) {
    parts.push(`${recap.cost_ticks} ticks (${recap.cost_basis})`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * Renders a `RecapRecord` as markdown, stable for a given input (same record
 * in, same string out, every time — no timestamps, no locale-dependent number
 * formatting). Sections with nothing to say (no changes, no criteria, no
 * cost, no mr_url) are OMITTED rather than rendered empty or with an invented
 * placeholder — invariants 1 and 2 applied to prose, not just to data.
 */
export function renderRecapMarkdown(recap: RecapRecord): string {
  const sections: string[] = []
  // Model-authored: quoted, so an embedded '## Acceptance criteria', a fake
  // '**Merge request:**' footer line, or any other forged block can only ever
  // render as quoted text nested inside THIS section — never as a live
  // element of the document positioned ahead of the real one.
  sections.push(
    `## Summary\n\n${recap.summary ? quoteModelText(recap.summary) : '_No summary available._'}`,
  )
  if (recap.changes.length > 0) {
    sections.push(`## Changes\n\n${renderModelList(recap.changes)}`)
  }
  if (recap.decisions.length > 0) {
    sections.push(`## Decisions\n\n${renderModelList(recap.decisions)}`)
  }
  // `files[]`, `tests[].command`, `cost`, `branch` and `mr_url` are CLI-
  // MEASURED, never model-authored — but that provenance alone is NOT what
  // makes them safe to render plain (round 4, majeur 1: an earlier version of
  // this comment claimed exactly that, and it was false as a safety
  // argument — `renderRecapMarkdown` is documented as a pure function of the
  // PUBLISHED `RecapRecord` schema, so it must hold for every record that
  // schema admits, not only the ones this CLI's own generator happens to
  // produce; a hand-crafted recap.json, or a repo-declared checks command
  // with no newline filter, both reach this renderer through the very same
  // door). What actually makes these five fields safe is that `recap.ts`'s
  // sanitizer constrains `branch`, `mr_url`, `files[]` and `tests[].command`
  // to be MONO-LINE BY CONSTRUCTION (`line()`, `recap.ts`) — no CommonMark
  // line terminator, no control character of any kind can survive in them.
  // `renderList`/`renderTests`/the footer below apply `collapseToOneLine` AND
  // `inlineCode` — on `files[]`, on `tests[].command`, on `branch` and on
  // `mr_url` alike (round 5, majeur 2: the code span used to stop at
  // `files[]`, leaving the other three to render live markdown) — as a
  // SECOND, independent layer — same two-layer doctrine already applied to `summary`/`changes`/
  // `decisions` — so a `RecapRecord` built by hand, bypassing `sanitizeRecap`
  // entirely, still renders honestly. `criteria[]` is NOT in this set —
  // `.text` and `.evidence` are model prose (see renderCriteria's own doc)
  // and are neutralized inside that function, not here. `cost` needs neither
  // layer: it is numbers and a closed enum, nothing a model or a repo could
  // shape into markup.
  sections.push(
    `## Files (${recap.files.length})\n\n${recap.files.length > 0 ? renderList(recap.files) : '_None._'}`,
  )
  sections.push(
    `## Tests\n\n${recap.tests.length > 0 ? renderTests(recap.tests) : '_No checks recorded._'}`,
  )
  if (recap.criteria && recap.criteria.length > 0) {
    sections.push(`## Acceptance criteria\n\n${renderCriteria(recap.criteria)}`)
  }
  const cost = renderCost(recap)
  if (cost) {
    sections.push(`## Cost\n\n${cost}`)
  }
  // `branch`/`mr_url`: same two-layer doctrine as above — `collapseToOneLine`
  // first (independent of `line()` already having run in `recap.ts`), then
  // `inlineCode` on BOTH, so a stray backtick cannot break out of its own
  // code span and no markdown the value carries stays live.
  //
  // Round 5, majeur 2: `mr_url` was rendered plain, and it is read off a
  // journal event's `data.mr_url` — a forge CLI's stdout, not a value this
  // contract shapes — so `https://real.example/1 ![](https://evil.example/
  // pixel.png)` put a live remote tracker in the very footer a reader trusts
  // most. A code span is preferred over a `<…>` autolink here: an autolink is
  // only inert while the value has no space and no `>`, and `collapseToOneLine`
  // does not remove interior spaces, so a URL followed by injected markdown
  // would fall out of the autolink and render live. The cost is that the URL
  // is no longer auto-linked by the forge; the URL itself stays verbatim and
  // copyable, which is what "consumable without reformatting" requires.
  const footer = [`**Branch:** ${inlineCode(collapseToOneLine(recap.branch))}`]
  if (recap.mr_url) {
    footer.push(`**Merge request:** ${inlineCode(collapseToOneLine(recap.mr_url))}`)
  }
  sections.push(footer.join('\n'))
  return sections.join('\n\n')
}
