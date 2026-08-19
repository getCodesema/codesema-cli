// Issue payloads as the two forges spell them, plus the argument hardening that
// keeps user text out of the flag namespace. Split out of forge-issues.ts so
// neither file has to be read whole to answer one question: everything here is
// a pure function over strings — no process, no git, no I/O — while
// forge-issues.ts is the ladder that actually runs `gh` / `glab`.
//
// Two rules govern the whole file:
//   1. **Never throw.** Every entry point takes `unknown` and degrades, on the
//      patron of sanitizeTaskRecord (`packages/contract/src/tasks.ts`): a null
//      handed in by a caller that lost its types is data to reject, not a
//      crash (invariant 1).
//   2. **Never a partial array.** The parsers validate field by field like
//      parseGhMrList / parseGlabMrList (`forge-mrs.ts:34` / `:81`) and reject
//      the WHOLE array at the first shape mismatch — J2 builds its unit of
//      work on this list, so half of it is worse than none of it.

/** Strictest of the two forges (GitLab 255, GitHub 256), so a title means the same on both. */
export const ISSUE_TITLE_MAX = 255
/** Well under GitHub's 65 536-character body limit; a description is not a payload. */
export const ISSUE_BODY_MAX = 60_000
/** GitLab caps a label name at 255 characters; GitHub at 50. Take the loose one, reject beyond. */
export const ISSUE_LABEL_MAX = 255
/** How much of an offending label a refusal quotes back: enough to recognise it, not to flood a log. */
const LABEL_QUOTE_MAX = 60

export type ForgeIssueState = 'open' | 'closed'

export type ForgeIssue = {
  number: number
  title: string
  /**
   * '' is a legitimate value, not a degradation: both forges accept an issue
   * with no description, and an absent or null field reads as the empty body
   * it means rather than rejecting the whole payload.
   */
  body: string
  state: ForgeIssueState
  labels: string[]
  author: string
  createdAt: string
  updatedAt: string
  url: string
}

// --- Argument hardening ------------------------------------------------------
//
// Everything goes through execFile with an explicit argv, so the risk is not
// shell injection (there is no shell) but ARGUMENT injection: a title of
// `--repo attacker/evil` handed to `gh issue create --title` would be read as
// the next option by pflag, which takes the following argv element as a flag's
// value whatever it looks like. Two rules answer it, both asserted on the argv
// by the tests:
//   1. user text always rides an ATTACHED value (`--title=…`), which pflag
//      cannot re-read as an option;
//   2. positional identifiers are typed `number` and re-checked at the call
//      site, so an issue id can never start with a dash in the first place.

/** Anything that is not a string reads as the empty string: tolerant in, never a throw. */
function asString(raw: unknown): string {
  return typeof raw === 'string' ? raw : ''
}

/**
 * The C0 range plus DEL, as a predicate rather than a character class: a regex
 * over these code points is exactly what `no-control-regex` forbids, and the
 * predicate names the set instead of spelling it out twice.
 */
function isControlChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return code < 0x20 || code === 0x7f
}

/** Truncates by code points: a UTF-16 slice can split a surrogate pair. */
function truncate(value: string, max: number): string {
  const points = Array.from(value)
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : value
}

/** Single-line by construction: every control character becomes a space, runs collapse. */
function toSingleLine(raw: string): string {
  return Array.from(raw, (ch) => (isControlChar(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

export function sanitizeIssueTitle(raw: unknown): string {
  return truncate(toSingleLine(asString(raw)), ISSUE_TITLE_MAX)
}

/** Neutralised, not rejected, and never thrown on: CRLF folds, other controls drop. */
export function sanitizeIssueBody(raw: unknown): string {
  const folded = asString(raw).replace(/\r\n?/g, '\n')
  const kept = Array.from(folded)
    .filter((ch) => ch === '\t' || ch === '\n' || !isControlChar(ch))
    .join('')
  return truncate(kept, ISSUE_BODY_MAX)
}

/** A refused label names itself and says why: a silent drop would change the set. */
export type IssueLabelsCheck = { ok: true; labels: string[] } | { ok: false; detail: string }

function labelRefusal(name: string, why: string): string {
  return `label ${JSON.stringify(truncate(name, LABEL_QUOTE_MAX))} refused: ${why}`
}

/**
 * Refuses the whole call rather than silently changing the label set.
 *
 * The comma is the one asymmetry worth naming here: the READ side accepts it
 * (a forge is free to hand back a label containing a comma, and
 * `parseGhIssueList` / `parseGlabIssueList` keep it), but the WRITE side
 * cannot express it — GitLab's REST contract takes the whole set as ONE
 * comma-separated string. Refusing on both forges is deliberate: a call that
 * succeeds on GitHub and mangles the set on GitLab would be worse than one
 * that consistently says no.
 */
export function sanitizeIssueLabels(raw: unknown): IssueLabelsCheck {
  if (raw === undefined || raw === null) {
    return { ok: true, labels: [] }
  }
  if (!Array.isArray(raw)) {
    return { ok: false, detail: 'labels must be a list of names' }
  }
  const labels: string[] = []
  for (const entry of raw) {
    const name = toSingleLine(asString(entry))
    if (!name) {
      return { ok: false, detail: 'a label is empty once control characters are stripped' }
    }
    if (Array.from(name).length > ISSUE_LABEL_MAX) {
      return {
        ok: false,
        detail: labelRefusal(name, `it is longer than ${ISSUE_LABEL_MAX} characters`),
      }
    }
    if (name.includes(',')) {
      return {
        ok: false,
        detail: labelRefusal(
          name,
          "it contains a comma, and GitLab's API takes the label set as ONE comma-separated string — a comma can be read back from a forge, never written to one",
        ),
      }
    }
    labels.push(name)
  }
  return { ok: true, labels }
}

/**
 * Linux caps a SINGLE argument at MAX_ARG_STRLEN — 32 pages, 128 KiB, the
 * terminating NUL included — and answers E2BIG at spawn time. A 60 000
 * code-point issue body reaches it as soon as the text is multi-byte (60 000
 * emoji are 240 KB), so the limit is not theoretical: it is one `--body=…`
 * away. Measured on this repo's runtime, not recalled from memory.
 */
export const MAX_ARG_BYTES = 128 * 1024 - 1

/**
 * The argv the kernel would refuse, named by SIZE and never by content: a body
 * is not a log line. Null when the whole argv fits.
 */
export function oversizedArg(args: string[]): string | null {
  for (const arg of args) {
    const bytes = Buffer.byteLength(arg, 'utf8')
    if (bytes > MAX_ARG_BYTES) {
      return `argument of ${bytes} bytes exceeds the ${MAX_ARG_BYTES} the kernel accepts`
    }
  }
  return null
}

// --- Parsers -----------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/** Positional issue ids are typed, so they can never be promoted to a flag. */
export function isIssueNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function readRecordProp(record: Record<string, unknown>, key: string): unknown {
  return record[key]
}

function readNested(container: unknown, key: string): unknown {
  return typeof container === 'object' && container !== null
    ? readRecordProp(container as Record<string, unknown>, key)
    : undefined
}

/** The one place the two state vocabularies meet: gh OPEN/CLOSED, glab opened/closed. */
function normalizeState(raw: unknown): ForgeIssueState | null {
  if (typeof raw !== 'string') {
    return null
  }
  const value = raw.toLowerCase()
  if (value === 'open' || value === 'opened') {
    return 'open'
  }
  return value === 'closed' ? 'closed' : null
}

/** '' for an absent/null description, null (= reject everything) for any other shape. */
function optionalText(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return ''
  }
  return typeof raw === 'string' ? raw : null
}

/** GitHub: `labels: [{name, color, …}]`. */
function ghLabelNames(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) {
    return null
  }
  const names: string[] = []
  for (const entry of raw) {
    const name = readNested(entry, 'name')
    if (!isNonEmptyString(name)) {
      return null
    }
    names.push(name)
  }
  return names
}

/** GitLab: `labels: ["bug", "ui"]` — plain strings, not objects. */
function glabLabelNames(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) {
    return null
  }
  const names: string[] = []
  for (const entry of raw) {
    if (!isNonEmptyString(entry)) {
      return null
    }
    names.push(entry)
  }
  return names
}

/**
 * The two forges differ only in where each value LIVES, so the field mapping
 * stays per forge (that is the documentation) while the validation itself is
 * shared: one field wrong and nothing comes back.
 */
type IssueDraft = {
  number: unknown
  title: unknown
  author: unknown
  createdAt: unknown
  updatedAt: unknown
  url: unknown
  /** Already normalised by the caller; null means "reject the whole entry". */
  body: string | null
  state: ForgeIssueState | null
  labels: string[] | null
}

function buildIssue(draft: IssueDraft): ForgeIssue | null {
  const { body, state, labels } = draft
  if (body === null || state === null || labels === null) {
    return null
  }
  const { number, title, author, createdAt, updatedAt, url } = draft
  if (
    !isIssueNumber(number) ||
    !isNonEmptyString(title) ||
    !isNonEmptyString(author) ||
    !isIsoTimestamp(createdAt) ||
    !isIsoTimestamp(updatedAt) ||
    !isNonEmptyString(url)
  ) {
    return null
  }
  return { number, title, body, state, labels, author, createdAt, updatedAt, url }
}

export function ghIssueFrom(entry: unknown): ForgeIssue | null {
  if (typeof entry !== 'object' || entry === null) {
    return null
  }
  const e = entry as Record<string, unknown>
  return buildIssue({
    number: readRecordProp(e, 'number'),
    title: readRecordProp(e, 'title'),
    author: readNested(readRecordProp(e, 'author'), 'login'),
    createdAt: readRecordProp(e, 'createdAt'),
    updatedAt: readRecordProp(e, 'updatedAt'),
    url: readRecordProp(e, 'url'),
    body: optionalText(readRecordProp(e, 'body')),
    state: normalizeState(readRecordProp(e, 'state')),
    labels: ghLabelNames(readRecordProp(e, 'labels')),
  })
}

export function glabIssueFrom(entry: unknown): ForgeIssue | null {
  if (typeof entry !== 'object' || entry === null) {
    return null
  }
  const e = entry as Record<string, unknown>
  return buildIssue({
    number: readRecordProp(e, 'iid'),
    title: readRecordProp(e, 'title'),
    author: readNested(readRecordProp(e, 'author'), 'username'),
    createdAt: readRecordProp(e, 'created_at'),
    updatedAt: readRecordProp(e, 'updated_at'),
    url: readRecordProp(e, 'web_url'),
    body: optionalText(readRecordProp(e, 'description')),
    state: normalizeState(readRecordProp(e, 'state')),
    labels: glabLabelNames(readRecordProp(e, 'labels')),
  })
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    // A truncated payload (the CLI crashed mid-write) lands here: undefined, never a throw.
    return undefined
  }
}

function parseIssueList(
  raw: string,
  from: (entry: unknown) => ForgeIssue | null,
): ForgeIssue[] | null {
  const data = parseJson(raw)
  if (!Array.isArray(data)) {
    return null
  }
  const issues: ForgeIssue[] = []
  for (const entry of data) {
    const issue = from(entry)
    if (issue === null) {
      // One bad entry rejects the WHOLE array: never a partial list.
      return null
    }
    issues.push(issue)
  }
  return issues
}

/** Parses and validates `gh issue list --json …` output; null on any shape mismatch. */
export function parseGhIssueList(raw: string): ForgeIssue[] | null {
  return parseIssueList(raw, ghIssueFrom)
}

/** Parses and validates `glab issue list --output json` output; null on any shape mismatch. */
export function parseGlabIssueList(raw: string): ForgeIssue[] | null {
  return parseIssueList(raw, glabIssueFrom)
}

export function parseGhIssue(raw: string): ForgeIssue | null {
  return ghIssueFrom(parseJson(raw))
}

export function parseGlabIssue(raw: string): ForgeIssue | null {
  return glabIssueFrom(parseJson(raw))
}

/**
 * First URL in the CLI output: both `gh issue create` and `glab issue create`
 * print the created issue's URL on stdout (verified gh 2.46.0 / glab 1.53.0).
 * `http://` counts as well as `https://` — a self-hosted GitLab behind a
 * reverse proxy is routinely configured on plain HTTP, and dropping its URL
 * would lose the link to an issue that exists. Null when the tool succeeded
 * but printed none: that is a success with nothing to link to.
 */
export function extractIssueUrl(raw: string): string | null {
  const match = /https?:\/\/\S+/.exec(raw)
  return match ? match[0].replace(/[.,)\]]+$/, '') : null
}
