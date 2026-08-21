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

/** Same word forge-issues.ts uses for an unreadable CLI answer — duplicated
 * rather than imported, since this file must stay free of any dependency on
 * the ladder that runs the CLIs (top-of-file rule: pure functions only). */
const UNREADABLE = 'unreadable output'

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

// --- Comments (T3.5) ----------------------------------------------------------
//
// Read-only, and read for ONE reason: the recap publication searches the
// existing comments of an issue for its own provenance marker before writing
// (idempotence, design decision 4). The two forges disagree on everything but
// the field that matters:
//
//   | gh 2.46.0                        | glab 1.53.0                          |
//   |----------------------------------|--------------------------------------|
//   | `issue view N --json comments`   | `issue view N --comments -F json`    |
//   | `{ "comments": [ … ] }`          | `{ …issue…, "Notes": [ … ] }`        |
//   | `author.login`, `createdAt`      | `author.username`, `created_at`      |
//   | no system notes in the payload   | system notes ARE in the payload      |
//
// `Notes` is capitalised because glab marshals a Go struct with NO json tag
// on that field (`IssueWithNotes{*gitlab.Issue; Notes []*gitlab.Note}`,
// commands/issuable/view/issuable_view.go, v1.53.0) — verified against the
// source, not recalled.
//
// `system` is REPORTED here and filtered one layer up (`commentsOnly`,
// forge-issues.ts): GitLab's "changed the description" / "added a label"
// lines ARE notes, this parser's job is to say what the forge sent, and
// naming the asymmetry rather than erasing it is D8's rule. The reader that
// searches for a provenance marker drops them, because a note the server
// generated from an activity carries no body anyone supplied and so can never
// hold one — and, more sharply, because counting them would let label churn
// alone push an issue past `ISSUE_COMMENT_LIST_MAX` and cost it its recap for
// good. GitHub has no equivalent in this payload, so it always reads false —
// an honest constant, not a guess.

/**
 * One existing comment of an issue, in the only shape the marker search
 * needs. `body` is the RAW markdown the forge stores, never a rendering: an
 * HTML-comment marker is invisible once rendered and present here.
 */
export type ForgeIssueComment = {
  body: string
  /** Login (gh) / username (glab); '' when the payload names nobody. */
  author: string
  /** ISO timestamp; '' when the payload carries none or an unusable one. */
  createdAt: string
  /** GitLab system note (label change, state change…). Always false on GitHub. */
  system: boolean
}

/**
 * `body` is the ONLY field that decides: an entry without a readable body
 * rejects the whole array (the file's rule 2), because a marker search over a
 * PARTIAL list would answer "absent" for a marker it never looked at and post
 * a duplicate. Everything else degrades to '' — a comment with no author is
 * still a comment whose body must be searched.
 */
function commentFrom(
  entry: unknown,
  loginKey: string,
  createdKey: string,
): ForgeIssueComment | null {
  if (typeof entry !== 'object' || entry === null) {
    return null
  }
  const e = entry as Record<string, unknown>
  const body = readRecordProp(e, 'body')
  if (typeof body !== 'string') {
    return null
  }
  // Both forges nest the author under `author`; gh names the handle `login`,
  // GitLab `username`.
  const author = readNested(readRecordProp(e, 'author'), loginKey)
  const createdAt = readRecordProp(e, createdKey)
  return {
    body,
    author: typeof author === 'string' ? author : '',
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    system: readRecordProp(e, 'system') === true,
  }
}

function parseCommentList(
  entries: unknown,
  from: (entry: unknown) => ForgeIssueComment | null,
): ForgeIssueComment[] | null {
  if (!Array.isArray(entries)) {
    return null
  }
  const comments: ForgeIssueComment[] = []
  for (const entry of entries) {
    const comment = from(entry)
    if (comment === null) {
      return null
    }
    comments.push(comment)
  }
  return comments
}

/** `gh issue view N --json comments` → `{ "comments": [ … ] }`. */
export function parseGhIssueComments(raw: string): ForgeIssueComment[] | null {
  const data = parseJson(raw)
  if (typeof data !== 'object' || data === null) {
    return null
  }
  return parseCommentList(readRecordProp(data as Record<string, unknown>, 'comments'), (entry) =>
    commentFrom(entry, 'login', 'createdAt'),
  )
}

/**
 * `glab issue view N --comments --output json` → the issue's own fields plus
 * `Notes`. An issue payload WITHOUT `Notes` is not an unreadable answer: it is
 * what glab prints when the issue has no note at all, so it reads as the empty
 * list it means rather than rejecting the call (and sending a duplicate
 * comment on the next replay would be the cost of getting that wrong).
 */
export function parseGlabIssueNotes(raw: string): ForgeIssueComment[] | null {
  const data = parseJson(raw)
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const notes = readRecordProp(data as Record<string, unknown>, 'Notes')
  if (notes === undefined || notes === null) {
    return []
  }
  return parseCommentList(notes, (entry) => commentFrom(entry, 'username', 'created_at'))
}

// --- Hierarchy (T2.2, D8) -----------------------------------------------------
//
// GitHub's sub-issues answer through `gh api` (REST) rather than the
// porcelain, so the payload is the RAW REST issue shape, not the camelCase
// gh prints for `issue list --json`: `user.login` (not `author.login`),
// `created_at`/`updated_at` (snake_case), and `html_url` for the page a
// human would open — a raw REST issue's `url` field is the API endpoint,
// and using it here would silently link to the wrong place. Labels keep the
// porcelain shape (`{name}`), because REST and porcelain agree there.

/** `GET .../issues/{n}/sub_issues` entry; validated field by field like every
 * other issue list, one bad entry rejects the WHOLE array. */
export function ghRestIssueFrom(entry: unknown): ForgeIssue | null {
  if (typeof entry !== 'object' || entry === null) {
    return null
  }
  const e = entry as Record<string, unknown>
  return buildIssue({
    number: readRecordProp(e, 'number'),
    title: readRecordProp(e, 'title'),
    author: readNested(readRecordProp(e, 'user'), 'login'),
    createdAt: readRecordProp(e, 'created_at'),
    updatedAt: readRecordProp(e, 'updated_at'),
    url: readRecordProp(e, 'html_url'),
    body: optionalText(readRecordProp(e, 'body')),
    state: normalizeState(readRecordProp(e, 'state')),
    labels: ghLabelNames(readRecordProp(e, 'labels')),
  })
}

/** Parses and validates `gh api .../sub_issues` output; null on any shape mismatch. */
export function parseGhSubIssueList(raw: string): ForgeIssue[] | null {
  return parseIssueList(raw, ghRestIssueFrom)
}

/**
 * GitHub's sub-issues write endpoints (`POST .../sub_issues`,
 * `DELETE .../sub_issue`) take the CHILD's internal database `id` in the
 * body — NOT its repo-scoped `number`, which is what the URL still uses for
 * the PARENT. Reading the wrong field here would silently link the wrong
 * issue, so this is its own narrow parser rather than a field inside
 * `ghRestIssueFrom`. Null on anything that is not a positive integer id.
 */
export function ghIssueDatabaseId(raw: string): number | null {
  const data = parseJson(raw)
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const id = readRecordProp(data as Record<string, unknown>, 'id')
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null
}

/**
 * GitLab's REST `id` (distinct from the issue's project-scoped `iid`) is the
 * SAME internal integer a GraphQL global id is built from
 * (`gid://gitlab/WorkItem/<id>`) — read off `GET projects/:fullpath/issues/<iid>`
 * before either the hierarchy mutation or the children query, both of which
 * only understand the global id. Null on anything that is not a positive
 * integer id.
 */
export function glabIssueDatabaseId(raw: string): number | null {
  const data = parseJson(raw)
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const id = readRecordProp(data as Record<string, unknown>, 'id')
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null
}

/**
 * Same REST answer as `glabIssueDatabaseId`, but also keeps `web_url` (the
 * full absolute URL GitLab's REST API always returns for an issue) so the
 * caller can derive an ORIGIN to prepend to the `webPath` GraphQL's
 * `WorkItemType` hands back for each child — `WorkItemType` has no absolute
 * URL field of its own (`web_path` only; verified against GitLab's GraphQL
 * schema, see `WORKITEM_CHILDREN_QUERY`'s own comment). `new URL` never
 * throws here: a malformed `web_url` degrades to `null`, same as any other
 * shape mismatch in this file.
 */
export function glabIssueRestRef(raw: string): { id: number; origin: string } | null {
  const data = parseJson(raw)
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const record = data as Record<string, unknown>
  const id = readRecordProp(record, 'id')
  const webUrl = readRecordProp(record, 'web_url')
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || typeof webUrl !== 'string') {
    return null
  }
  try {
    return { id, origin: new URL(webUrl).origin }
  } catch {
    return null
  }
}

/** `GET .../issues/{n}/parent` (GitHub) or the `parent { iid }` field of the
 * GraphQL hierarchy widget (GitLab) both answer with just the parent's
 * repo-scoped number — this is the one field either side needs to answer
 * "does this issue already have a real parent on the forge". */
export function ghIssueNumberFromRest(raw: string): number | null {
  const data = parseJson(raw)
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const number = readRecordProp(data as Record<string, unknown>, 'number')
  return isIssueNumber(number) ? number : null
}

/** GitLab's GraphQL `Label` exposes `title`, never the REST API's `name` —
 * one more asymmetry the read side keeps rather than papering over. */
function glabGraphqlLabelTitles(raw: unknown): string[] | null {
  const nodes = readNested(raw, 'nodes')
  if (!Array.isArray(nodes)) {
    return null
  }
  const titles: string[] = []
  for (const entry of nodes) {
    const title = readNested(entry, 'title')
    if (!isNonEmptyString(title)) {
      return null
    }
    titles.push(title)
  }
  return titles
}

/**
 * A `widgets` array answers a UNION: each entry only carries the fields of
 * the inline fragment that matched its own type, so the widget this module
 * wants is found by which KEY it carries, never by array position — a
 * schema that reorders or adds widgets ahead of ours must not silently break
 * this (D8 review, minor: "widget choisi par sa clé et non par position").
 */
function findWidget(widgets: unknown, key: string): Record<string, unknown> | undefined {
  if (!Array.isArray(widgets)) {
    return undefined
  }
  const found = widgets.find(
    (w) => typeof w === 'object' && w !== null && key in (w as Record<string, unknown>),
  )
  return found as Record<string, unknown> | undefined
}

/**
 * One `WorkItemWidgetHierarchy.children.nodes[]` entry, read off
 * `Types::WorkItemType` — NOT `Types::IssueType`, which has no `widgets`
 * field at all (this is CRITIQUE 1's fix: `Query.issue` cannot answer this
 * query, only `Query.workItem` can). `webPath` (relative, nullable) is
 * combined with `origin` (the REST-resolved parent's own host) into an
 * absolute URL; description and labels live on their OWN widgets
 * (`WorkItemWidgetDescription`, `WorkItemWidgetLabels`), never as plain
 * fields of the work item itself.
 */
function glabWorkItemChildFrom(entry: unknown, origin: string): ForgeIssue | null {
  if (typeof entry !== 'object' || entry === null) {
    return null
  }
  const e = entry as Record<string, unknown>
  const webPath = readRecordProp(e, 'webPath')
  const descriptionWidget = findWidget(readRecordProp(e, 'widgets'), 'description')
  const labelsWidget = findWidget(readRecordProp(e, 'widgets'), 'labels')
  return buildIssue({
    number: readRecordProp(e, 'iid'),
    title: readRecordProp(e, 'title'),
    author: readNested(readRecordProp(e, 'author'), 'username'),
    createdAt: readRecordProp(e, 'createdAt'),
    updatedAt: readRecordProp(e, 'updatedAt'),
    // webPath is nullable on WorkItemType: a null here rejects this entry
    // (never a fabricated URL), same posture as any other missing field.
    url: typeof webPath === 'string' ? origin + webPath : undefined,
    body: optionalText(descriptionWidget === undefined ? '' : descriptionWidget.description),
    state: normalizeState(readRecordProp(e, 'state')),
    // The Labels widget being ABSENT reads as "no labels" (an optional
    // facet, same posture as an absent description); present-but-malformed
    // still rejects the whole entry, via glabGraphqlLabelTitles.
    labels: labelsWidget === undefined ? [] : glabGraphqlLabelTitles(labelsWidget.labels),
  })
}

/**
 * A GraphQL response is not a plain payload: on top of the union-rejecting
 * shape rules every other parser in this file applies, it carries its OWN
 * two-tier error protocol — a top-level `errors` array (the query/mutation
 * could not even be attempted as written: a syntax mistake, an object
 * `loads:` could not find, an authorization refusal, OR a genuine schema gap)
 * versus a business error nested inside `data.<operation>.errors` (the
 * mutation DID run and was refused). The two are never conflated: the caller
 * in forge-issues.ts turns a RECOGNIZED schema gap into `unsupported` (D8
 * decision 2 — an edition that cannot do this at all) and everything else,
 * top-level or nested, into an honest `cli-error` (something real happened,
 * or this module itself asked something wrong, and either way a retry on
 * the SAME edition is not ruled out the way `unsupported` rules it out).
 */
export type GraphqlOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'unsupported'; message: string }
  | { kind: 'error'; message: string }

/**
 * graphql-ruby's "Field 'x' doesn't exist on type 'Y'" (verified against its
 * own source, `fields_are_defined_on_type.rb`) fires on TWO very different
 * situations that read identically: the entry point this module asks for
 * being genuinely absent from the schema (`Y` is `Query`/`Mutation`), OR a
 * plain typo in a LEAF field this module asks one of ITS OWN widget types
 * for (`Y` is `WorkItemWidgetHierarchy` or similar) — a mistake entirely
 * this module's own, indistinguishable from a real gap by the mention of
 * "WorkItemWidgetHierarchy" alone (an earlier, wider version of this
 * function keyed on exactly that mention, and so read "Field 'childrn'
 * doesn't exist on type 'WorkItemWidgetHierarchy'" — this module's OWN
 * typo — as "the edition can't do this": CRITIQUE 2's failure mode again,
 * merely narrower). Only the FIRST situation is a genuine gap: `workItem`
 * and `workItemUpdate` are the two entry points this module ever asks
 * `Query`/`Mutation` for, both always spelled correctly here, so a report
 * that either does not exist can only mean the schema itself lacks them.
 *
 * Three OTHER graphql-ruby shapes are genuine gaps for the same reason —
 * the name they refuse is always one this module spells correctly, so
 * refusing it can only mean the schema does not have it at all:
 *   - `fragment_types_exist.rb`: "No such type WorkItemWidgetHierarchy, so
 *     it can't be a fragment condition" — one of the three widget types
 *     this module selects via an inline fragment;
 *   - `variables_are_input_types.rb`: the source's own template is
 *     `"#{type_name} isn't a defined input type (on $#{node.name})"` — for
 *     this module's own variables that reads as "WorkItemID isn't a defined
 *     input type (on $id)" (round 4 correction: an earlier version of this
 *     comment quoted only the "isn't a defined input type" prefix as if it
 *     were the WHOLE message, which it never is — the `.includes()` match
 *     below only needs that prefix and still works regardless, but the
 *     comment claiming to be "checked against the source" should actually
 *     be) — the input type of `$id`/`$parentId` in every query and mutation
 *     this module sends;
 *   - `arguments_are_defined.rb`, the INPUT-OBJECT-LITERAL branch (its
 *     `parent_name` case for `Language::Nodes::InputObject`, distinct from
 *     the field-selection branch above): "InputObject 'WorkItemUpdateInput'
 *     doesn't accept argument 'hierarchyWidget'" — `hierarchyWidget` is the
 *     one literal key both of this module's mutations ever set inside
 *     `input: {...}`, always spelled the same way, so this is the exact
 *     shape an edition whose `WorkItemUpdateInput` never grew a hierarchy
 *     widget answers with (an earlier fixture in this module's own test
 *     suite had GUESSED a different, unverified shape for this exact case,
 *     "Field 'hierarchyWidget' doesn't exist on type 'WorkItemUpdateInput'"
 *     — checked against graphql-ruby's source and corrected: that is not
 *     the message this rule actually produces).
 */
const GLAB_MISSING_ENTRY_POINTS: ReadonlyArray<{ field: string; onType: string }> = [
  { field: 'workitem', onType: 'query' },
  { field: 'workitemupdate', onType: 'mutation' },
]
const GLAB_MISSING_FRAGMENT_TYPES = [
  'workitemwidgethierarchy',
  'workitemwidgetdescription',
  'workitemwidgetlabels',
]
const GLAB_MISSING_INPUT_TYPES = ['workitemid']
const GLAB_MISSING_INPUT_ARGUMENTS: ReadonlyArray<{ onType: string; argument: string }> = [
  { onType: 'workitemupdateinput', argument: 'hierarchywidget' },
]

function looksLikeSchemaGap(message: string): boolean {
  const lower = message.toLowerCase()
  const entryPointGone = GLAB_MISSING_ENTRY_POINTS.some(({ field, onType }) =>
    lower.includes(`field '${field}' doesn't exist on type '${onType}'`),
  )
  const fragmentTypeGone = GLAB_MISSING_FRAGMENT_TYPES.some(
    (t) => lower.includes(`no such type ${t}`) && lower.includes("can't be a fragment condition"),
  )
  const inputTypeGone = GLAB_MISSING_INPUT_TYPES.some((t) =>
    lower.includes(`${t} isn't a defined input type`),
  )
  const inputArgumentGone = GLAB_MISSING_INPUT_ARGUMENTS.some(
    ({ onType, argument }) =>
      lower.includes(`inputobject '${onType}'`) &&
      lower.includes(`doesn't accept argument '${argument}'`),
  )
  return entryPointGone || fragmentTypeGone || inputTypeGone || inputArgumentGone
}

type TopLevelErrors = { message: string; schemaGap: boolean }

function graphqlTopLevelErrors(parsed: unknown): TopLevelErrors | null {
  const errors = readNested(parsed, 'errors')
  if (!Array.isArray(errors) || errors.length === 0) {
    return null
  }
  const messages = errors
    .map((e) => readNested(e, 'message'))
    .filter((m): m is string => isNonEmptyString(m))
  const message = messages.length > 0 ? messages.join('; ') : 'the schema refused the query'
  return { message, schemaGap: messages.some(looksLikeSchemaGap) }
}

/** Parses `glab api graphql` output for the hierarchy mutation
 * (`workItemUpdate`, the only mutation this module ever sends), telling a
 * RECOGNIZED schema-level "this edition cannot do that" (see
 * `looksLikeSchemaGap`) apart from a business rejection the mutation itself
 * raised, and apart from any OTHER top-level GraphQL error. */
export function parseGlabHierarchyMutation(raw: string): GraphqlOutcome<true> {
  const data = parseJson(raw)
  if (typeof data !== 'object' || data === null) {
    return { kind: 'error', message: UNREADABLE }
  }
  const topLevel = graphqlTopLevelErrors(data)
  if (topLevel !== null) {
    return topLevel.schemaGap
      ? { kind: 'unsupported', message: topLevel.message }
      : { kind: 'error', message: topLevel.message }
  }
  const payload = readNested(readNested(data, 'data'), 'workItemUpdate')
  if (typeof payload !== 'object' || payload === null) {
    return { kind: 'error', message: UNREADABLE }
  }
  const errors = readNested(payload, 'errors')
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors.filter((m): m is string => isNonEmptyString(m))
    return {
      kind: 'error',
      message: messages.length > 0 ? messages.join('; ') : 'the mutation was refused',
    }
  }
  return { kind: 'ok', value: true }
}

/**
 * The GraphQL query text, kept here (not forge-issues.ts) so the fields it
 * asks for and the fields the parser below reads stay next to each other and
 * cannot silently drift apart. Enters through `Query.workItem(id:)`, NEVER
 * `Query.issue(id:)` — `Types::IssueType` (CE `app/graphql/types/issue_type.rb`,
 * EE `ee/app/graphql/ee/types/issue_type.rb`) has no `widgets` field at all;
 * only `Types::WorkItemType` does. `first: 100` is GitLab's own
 * `default_max_page_size`: asking for more is silently CLAMPED to 100, never
 * refused, so asking for the true cap (200) would have looked like a legal
 * request that quietly returned less — `after` walks the cursor instead.
 */
export const GLAB_HIERARCHY_CHILDREN_QUERY =
  'query($id: WorkItemID!, $after: String) { workItem(id: $id) { widgets { ... on WorkItemWidgetHierarchy { children(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { iid title state webPath author { username } createdAt updatedAt widgets { ... on WorkItemWidgetDescription { description } ... on WorkItemWidgetLabels { labels { nodes { title } } } } } } } } } }'

export type GraphqlChildrenPage = {
  issues: ForgeIssue[]
  hasNextPage: boolean
  endCursor: string | null
}

/** Parses one page of `GLAB_HIERARCHY_CHILDREN_QUERY`'s answer, walking down
 * to `data.workItem.widgets[].children` — the ONE widget entry among the
 * union that carries a `children` connection, found by key (`findWidget`),
 * never by position. `workItem: null` (a bad id) degrades to UNREADABLE,
 * never a throw; a schema without the widget type at all fails the query
 * itself, caught above by the top-level `errors` check. */
export function parseGlabHierarchyChildren(
  raw: string,
  origin: string,
): GraphqlOutcome<GraphqlChildrenPage> {
  const data = parseJson(raw)
  if (typeof data !== 'object' || data === null) {
    return { kind: 'error', message: UNREADABLE }
  }
  const topLevel = graphqlTopLevelErrors(data)
  if (topLevel !== null) {
    return topLevel.schemaGap
      ? { kind: 'unsupported', message: topLevel.message }
      : { kind: 'error', message: topLevel.message }
  }
  const workItem = readNested(readNested(data, 'data'), 'workItem')
  if (typeof workItem !== 'object' || workItem === null) {
    return { kind: 'error', message: UNREADABLE }
  }
  const hierarchy = findWidget(
    readRecordProp(workItem as Record<string, unknown>, 'widgets'),
    'children',
  )
  const children = hierarchy === undefined ? undefined : hierarchy.children
  // No hierarchy widget in the answer (and no top-level error either): read
  // as "no children" rather than refused — under-claiming is the safe
  // direction (invariant: never assert a link that is not there).
  if (children === undefined) {
    return { kind: 'ok', value: { issues: [], hasNextPage: false, endCursor: null } }
  }
  const nodes = readNested(children, 'nodes')
  if (!Array.isArray(nodes)) {
    return { kind: 'error', message: UNREADABLE }
  }
  const issues: ForgeIssue[] = []
  for (const entry of nodes) {
    const child = glabWorkItemChildFrom(entry, origin)
    if (child === null) {
      // One bad entry rejects the WHOLE array: never a partial list (same
      // rule as parseIssueList).
      return { kind: 'error', message: UNREADABLE }
    }
    issues.push(child)
  }
  const pageInfo = readNested(children, 'pageInfo')
  const hasNextPage = readNested(pageInfo, 'hasNextPage')
  const endCursor = readNested(pageInfo, 'endCursor')
  return {
    kind: 'ok',
    value: {
      issues,
      hasNextPage: hasNextPage === true,
      endCursor: isNonEmptyString(endCursor) ? endCursor : null,
    },
  }
}

/** `WorkItemWidgetHierarchy.parent { iid }` — GitHub's mirror is the plain
 * REST `GET .../parent`, read by `ghIssueNumberFromRest`. `parent: null`
 * (no hierarchy widget, or a work item with no parent) is a legitimate `ok`
 * with `value: null`, never an error. */
export const GLAB_HIERARCHY_PARENT_QUERY =
  'query($id: WorkItemID!) { workItem(id: $id) { widgets { ... on WorkItemWidgetHierarchy { parent { iid } } } } }'

export function parseGlabHierarchyParent(raw: string): GraphqlOutcome<number | null> {
  const data = parseJson(raw)
  if (typeof data !== 'object' || data === null) {
    return { kind: 'error', message: UNREADABLE }
  }
  const topLevel = graphqlTopLevelErrors(data)
  if (topLevel !== null) {
    return topLevel.schemaGap
      ? { kind: 'unsupported', message: topLevel.message }
      : { kind: 'error', message: topLevel.message }
  }
  const workItem = readNested(readNested(data, 'data'), 'workItem')
  if (typeof workItem !== 'object' || workItem === null) {
    return { kind: 'error', message: UNREADABLE }
  }
  const hierarchy = findWidget(
    readRecordProp(workItem as Record<string, unknown>, 'widgets'),
    'parent',
  )
  const parent = hierarchy === undefined ? null : hierarchy.parent
  if (parent === null || parent === undefined) {
    return { kind: 'ok', value: null }
  }
  const iid = readNested(parent, 'iid')
  return isIssueNumber(iid) ? { kind: 'ok', value: iid } : { kind: 'error', message: UNREADABLE }
}

/** `WorkItemWidgetHierarchy.children(first: 1)` — the cheapest possible
 * existence probe, never the full list, for the mirror one-level guard ("a
 * parent-with-children cannot become someone's child either"). */
export const GLAB_HIERARCHY_HAS_CHILDREN_QUERY =
  'query($id: WorkItemID!) { workItem(id: $id) { widgets { ... on WorkItemWidgetHierarchy { children(first: 1) { nodes { iid } } } } } }'

export function parseGlabHierarchyHasChildren(raw: string): GraphqlOutcome<boolean> {
  const data = parseJson(raw)
  if (typeof data !== 'object' || data === null) {
    return { kind: 'error', message: UNREADABLE }
  }
  const topLevel = graphqlTopLevelErrors(data)
  if (topLevel !== null) {
    return topLevel.schemaGap
      ? { kind: 'unsupported', message: topLevel.message }
      : { kind: 'error', message: topLevel.message }
  }
  const workItem = readNested(readNested(data, 'data'), 'workItem')
  if (typeof workItem !== 'object' || workItem === null) {
    return { kind: 'error', message: UNREADABLE }
  }
  const hierarchy = findWidget(
    readRecordProp(workItem as Record<string, unknown>, 'widgets'),
    'children',
  )
  if (hierarchy === undefined) {
    return { kind: 'ok', value: false }
  }
  const nodes = readNested(hierarchy.children, 'nodes')
  return Array.isArray(nodes)
    ? { kind: 'ok', value: nodes.length > 0 }
    : { kind: 'error', message: UNREADABLE }
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
