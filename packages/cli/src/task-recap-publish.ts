// Posting the recap on the forge (T3.5, decision D10): the closing comment on
// the linked issue, then — and only then, and only when someone else tells us
// the merge happened — the closure of that issue.
//
// What this module deliberately does NOT do:
//
//   - it never decides whether the merge happened. `merged` is a FACT handed
//     in by T3.6, which owns D12's four conditions. Reading the MR's state
//     here to decide for ourselves would put the merge decision in two places,
//     which is exactly the SaaS `decideAutoMerge` shape J3 rejects;
//   - it never edits an existing comment. The provenance marker is a reason to
//     ABSTAIN, never to update (design decision 4, and the ticket's own
//     out-of-scope list);
//   - it never keeps an "already published" flag on this machine. The forge is
//     the source of truth (D7): a copied `recap.json`, a reinstalled machine
//     or a replayed task must not produce a second comment, and a comment
//     deleted by hand on the forge must be postable again. Both fall out of
//     searching for the marker on the forge and nowhere else;
//   - it never fails the task. Publishing a recap is communication, downstream
//     of every gate; a forge that will not take it degrades honestly
//     (`forge_unreachable` + a readable reason + a journal line) and leaves
//     `recap.json` untouched on disk (design decision 6).
//
// It has NO CALLER yet: T3.6 owns the merge and is therefore the only thing
// that can supply `merged`. Said here rather than left to be discovered,
// because the previous ticket in this chain shipped a generator with no caller
// while claiming otherwise.

import {
  detectDiffSecrets,
  type RecapRecord,
  type SecretMatch,
  type TaskEvent,
  type TaskReason,
  type TaskRecord,
} from './contract.js'
import {
  closeIssue,
  commentIssue,
  forgeIssueReason,
  listIssueComments,
  type ForgeIssuesExecFn,
  type ForgeUnavailable,
} from './forge-issues.js'
import { readTaskRecap, renderRecapMarkdown } from './task-recap.js'
import { appendTaskEvent, taskReason } from './tasks-store.js'

// --- The provenance marker ----------------------------------------------------

/**
 * The marker's stable half. It is a CONTRACT WITH THE FORGE, not an
 * implementation detail: a comment posted by any past or future version of
 * codesema is recognised by this string alone, so it is never reworded — the
 * day it changes, every issue already commented gets a duplicate.
 */
export const RECAP_MARKER_PREFIX = 'codesema-recap:'

/**
 * An HTML comment, and the FIRST line of the body, both for reasons that cost
 * a duplicate comment if they are undone:
 *
 *   - HTML comment: it is invisible once the forge renders the markdown (a
 *     visible footer would be noise on every ticket) while the RAW body the
 *     API hands back — the only thing the search reads — still carries it
 *     verbatim. Neither forge strips it on write;
 *   - first line: `sanitizeIssueBody` truncates a body at `ISSUE_BODY_MAX`
 *     from the END, and so does every forge's own body limit. A marker in the
 *     footer of an oversized recap is a marker that can be cut off, and a
 *     marker that can be cut off is idempotence that can be lost.
 *
 * Per task, not per issue: two tasks bound to the same ticket each post their
 * own recap.
 */
export function recapMarker(taskId: string): string {
  return `<!-- ${RECAP_MARKER_PREFIX}${taskId} -->`
}

/**
 * Any CommonMark line terminator, the same three forms `renderRecapMarkdown`
 * splits on: a forge that normalised CRLF, or a client that posted a lone CR,
 * must not move the marker off the line it was written on.
 */
const MARKER_LINE_TERMINATOR_RE = /\r\n|\r|\n/

/**
 * Whether THIS task's recap is already on the issue — anchored on the FIRST
 * NON-EMPTY LINE of the raw body, which is the only place `buildRecapComment`
 * ever writes it.
 *
 * It used to be a plain `body.includes()`, and that was a hole whose
 * consequence is IRREVERSIBLE on the forge. `## Summary` quotes the model's
 * prose, and `renderRecapMarkdown` escapes only the LINE-OPENING character of
 * it: a model that writes `see <!-- codesema-recap:<other id> --> for context`
 * gets that text published verbatim inside task A's own comment. Task B then
 * read its own marker back off A's comment, concluded its recap was already
 * posted, abstained for good — and, `merged` being true, CLOSED the issue.
 * That is precisely the "an issue closed without its recap is a ticket closed
 * without a trace" design decision 3 forbids, reached by believing a trace
 * that was never written.
 *
 * What stays tolerated is exactly what a body WE produced can pick up on the
 * way: leading blank lines, either line-terminator form, and whitespace
 * around the marker on its own line. What stops being tolerated is every
 * position this module never writes it in — a later line, inside a fence,
 * behind a `> ` quote, embedded mid-sentence — because none of those can be
 * this machine's own marker and all of them are reachable by prose it merely
 * carried.
 */
export function hasRecapMarker(body: string, taskId: string): boolean {
  const marker = recapMarker(taskId)
  for (const line of body.split(MARKER_LINE_TERMINATOR_RE)) {
    const trimmed = line.trim()
    if (trimmed !== '') {
      return trimmed === marker
    }
  }
  return false
}

// --- The secret gate ----------------------------------------------------------

/** How many matches a blocked message quotes: enough to act on, not a dump. */
const RECAP_SECRET_DETAIL_MAX = 3

/**
 * `detectDiffSecrets` only ever LOOKS at a unified diff's added and removed
 * lines (`+…` / `-…`) and at its `diff --git` headers; handed a markdown
 * document as-is, it would silently skip every line that does not happen to
 * start with a dash — which is most of a recap, and all of its `## Summary`
 * section. Presenting the document as a one-file diff of pure additions is
 * what makes the scan cover EVERY line, and it changes nothing about which
 * patterns match: `detectDiffSecrets` tests the content after the leading
 * marker, i.e. the original line.
 *
 * Two collisions the shaping has to avoid, both of which would drop a line out
 * of the content scan:
 *   - a recap line starting with `++` would produce `+++…`, which the scanner
 *     reads as a file-marker line. Such a line gets an extra space instead, so
 *     it stays a content line — and a leading space changes no verdict, none
 *     of the patterns being anchored at the start of the line;
 *   - a recap line starting with `diff --git ` would open a new pseudo-file.
 *     The `+` prefix already neutralises that one for free.
 */
export function recapScanPayload(markdown: string): string {
  const lines = markdown.split('\n').map((line) => {
    const prefixed = `+${line}`
    return prefixed.startsWith('+++') ? `+ ${line}` : prefixed
  })
  // A header so a match names the recap rather than '(unknown file)'. `.md` is
  // not a sensitive extension, so the header itself never triggers a match.
  return ['diff --git a/recap.md b/recap.md', ...lines].join('\n')
}

/** Everything `detectDiffSecrets` finds in a rendered recap. Empty is the normal case. */
export function scanRecapSecrets(markdown: string): SecretMatch[] {
  return detectDiffSecrets(recapScanPayload(markdown))
}

/**
 * Journal/API wording of a blocked publication, in the shape every other event
 * payload uses: raw English, the UI translating from `data.name`. Names WHAT
 * matched and WHERE, never the secret itself.
 */
export function recapSecretsMessage(matches: SecretMatch[]): string {
  const shown = matches
    .slice(0, RECAP_SECRET_DETAIL_MAX)
    .map((match) => `${match.file}: ${match.detail}`)
    .join('; ')
  const hidden = matches.length - RECAP_SECRET_DETAIL_MAX
  const more = hidden > 0 ? `, and ${hidden} more` : ''
  return `recap held back: it looks like it carries a secret (${shown}${more}) — nothing was sent to the forge, the recap stays in .codesema`
}

// --- Outcome ------------------------------------------------------------------

/**
 * What became of the comment. Every member but `posted` is a case where
 * NOTHING was written to the forge, and each one is kept apart because they
 * call for different human action: `no_issue` is not a degradation at all,
 * `already_posted` is the idempotence guard doing its job, `no_recap` and
 * `blocked_secrets` are local refusals, `unreachable` is the forge.
 */
export type RecapCommentStatus =
  'posted' | 'already_posted' | 'no_issue' | 'no_recap' | 'blocked_secrets' | 'unreachable'

/**
 * What became of the closure. `not_merged` is the ordinary answer for a task
 * whose merge has not happened — an issue that stays open is the correct
 * outcome, never a degradation. `skipped` is the closure that was not even
 * attempted because the comment did not land: an issue closed without its
 * recap is a ticket closed without a trace (design decision 3).
 */
export type RecapCloseStatus = 'closed' | 'not_merged' | 'skipped' | 'unreachable'

export type PublishRecapResult = {
  comment: RecapCommentStatus
  close: RecapCloseStatus
  /**
   * The readable half of whatever degraded, raw English like every journal
   * payload. Null when nothing did — a posted recap, or a task with no ticket
   * to post it on.
   */
  note: string | null
  /**
   * The D2 half, ADDED to `note`, never a substitute for it. Only the forge
   * degradations carry one: `forge_unreachable` names an unreachable forge,
   * and nothing in D2's table names "this recap carries a secret" or "there is
   * no recap" — a wrong code is worse than none (the same call `createMr`
   * makes for a forge CLI that ran and failed).
   */
  reason: TaskReason | null
  /**
   * The journal lines this publication wrote, in order, so the caller
   * broadcasts exactly what landed on disk (invariant 2's API leg). Empty when
   * there was nothing to say.
   */
  events: TaskEvent[]
}

export type PublishRecapOptions = {
  /** MAIN repo root: the task store and the forge CLI are both read from here. */
  cwd: string
  task: TaskRecord
  /**
   * Whether the merge HAS HAPPENED — a fact, supplied by T3.6, never evaluated
   * here (design decision 3). False keeps the issue open.
   */
  merged: boolean
  /** Forge I/O seam (§ 0.4): no test ever runs a real gh/glab, it asserts on the argv. */
  execFn?: ForgeIssuesExecFn | undefined
  // --- Seams for everything else this function touches.
  readTaskRecapFn?: typeof readTaskRecap
  listIssueCommentsFn?: typeof listIssueComments
  commentIssueFn?: typeof commentIssue
  closeIssueFn?: typeof closeIssue
  appendTaskEventFn?: typeof appendTaskEvent
}

/** `data.name` of the 'issue' journal lines this module writes. The UI translates from these. */
type RecapEventName =
  | 'recap_posted'
  | 'recap_already_posted'
  | 'recap_missing'
  | 'recap_blocked_secrets'
  | 'recap_unreachable'
  | 'closed'
  | 'close_unreachable'

/**
 * The comment body: the marker, then the recap's markdown rendering consumed
 * VERBATIM. T3.4 split `renderRecapMarkdown` off the schema precisely so this
 * ticket would have no formatting decision left to make, and the only thing
 * added here is the marker line the idempotence guard reads back.
 *
 * No bound of its own: `commentIssue` already runs the body through
 * `sanitizeIssueBody` (`ISSUE_BODY_MAX`, the forges' own contract) and refuses
 * an argv the kernel would not take, with a readable reason either way. The
 * merge-request description is the surface that carries `MR_BODY_SUMMARY_MAX`,
 * because that is the bound this ticket was told to preserve there.
 */
export function buildRecapComment(recap: RecapRecord, taskId: string): string {
  return `${recapMarker(taskId)}\n\n${renderRecapMarkdown(recap)}`
}

type Journal = (name: RecapEventName, message: string, reason?: TaskReason) => void

function journalFor(opts: PublishRecapOptions, events: TaskEvent[]): Journal {
  const append = opts.appendTaskEventFn ?? appendTaskEvent
  return (name, message, reason) => {
    try {
      events.push(
        append(opts.cwd, opts.task.id, {
          type: 'issue',
          // `message` is the raw English detail; the UI reads `data.name` and
          // never this (`issueEventText`, useTaskBoard.ts), which is exactly why
          // every degradation here gets its OWN name rather than one shared name
          // plus a server-built sentence.
          data: { name, message },
          ...(reason ? { reason_code: reason.code } : {}),
        }),
      )
    } catch {
      // A journal line that could not be appended (a full disk, a read-only
      // store) costs a LINE, never the publication: `publishTaskRecap` is
      // documented as never throwing, and this runs after — sometimes long
      // after — a comment already landed on a forge where nothing can be
      // taken back. The returned `events` stay exactly what is on disk, which
      // is what invariant 2's API leg promises: the caller broadcasts what
      // landed, not what was attempted.
    }
  }
}

/** The readable half of an unavailability, in the CLI's own words. */
function unavailableDetail(result: ForgeUnavailable): string {
  return result.detail ? `${result.reason}: ${result.detail}` : result.reason
}

type CommentDone = { comment: RecapCommentStatus; note: string | null; events: TaskEvent[] }

/**
 * The closure, always AFTER the comment and only ever reached once the comment
 * is on the issue (posted now, or posted by an earlier run). Kept as its own
 * step rather than folded into its caller so a later ticket can slot the label
 * write (T3.7) between the two without reshaping either.
 */
async function closeStep(
  opts: PublishRecapOptions,
  journal: Journal,
  done: CommentDone,
): Promise<PublishRecapResult> {
  const issue = opts.task.issue
  if (!issue || !opts.merged) {
    // Not merged: the issue stays open, and that is the right answer, not a
    // degradation — nothing to journal, nothing to name.
    return { ...done, close: 'not_merged', reason: null }
  }
  const closed = await (opts.closeIssueFn ?? closeIssue)({
    cwd: opts.cwd,
    execFn: opts.execFn,
    number: issue.iid,
  })
  if (!closed.available) {
    const note = `issue #${issue.iid} carries the recap but could not be closed (${unavailableDetail(closed)})`
    const reason = forgeIssueReason(closed)
    journal('close_unreachable', note, reason ?? undefined)
    // The comment's own note, when it had one, is KEPT and this one added to
    // it: two degradations, two sentences, never one overwriting the other.
    return {
      ...done,
      note: done.note ? `${done.note}; ${note}` : note,
      close: 'unreachable',
      reason,
    }
  }
  journal('closed', `issue #${issue.iid} closed`)
  return { ...done, close: 'closed', reason: null }
}

type CommentCtx = { recap: RecapRecord; events: TaskEvent[]; iid: number }

/**
 * The write, and the read that has to answer for it first. Every exit but the
 * last two is a forge that could not be asked the question, so nothing is
 * written and the closure is not even attempted.
 */
async function commentStep(
  opts: PublishRecapOptions,
  journal: Journal,
  ctx: CommentCtx,
): Promise<PublishRecapResult> {
  const { events, iid } = ctx
  const forge = { cwd: opts.cwd, execFn: opts.execFn, number: iid }
  const existing = await (opts.listIssueCommentsFn ?? listIssueComments)(forge)
  if (!existing.available) {
    const note = `the recap could not be posted on issue #${iid}: its comments could not be read (${unavailableDetail(existing)})`
    const reason = forgeIssueReason(existing)
    journal('recap_unreachable', note, reason ?? undefined)
    return { comment: 'unreachable', close: 'skipped', note, reason, events }
  }
  if (existing.comments.some((comment) => hasRecapMarker(comment.body, opts.task.id))) {
    // Marker present: abstain. Never edit — a finished task's recap does not
    // change, and editing is out of this ticket's scope by decision.
    const note = `the recap is already on issue #${iid}: nothing was sent again`
    journal('recap_already_posted', note)
    return closeStep(opts, journal, { comment: 'already_posted', note, events })
  }
  if (existing.truncated) {
    // The read answered, but not the QUESTION it was asked: past the cap the
    // marker can only be reported "absent from what was read", and writing on
    // that is exactly the duplicate this whole path exists to prevent. Named
    // as the reachability degradation it is — the forge holds more than one
    // read can see — with the specific cause in the message.
    const note = `the recap could not be posted on issue #${iid}: it carries more comments than one read can hold, so an earlier recap comment cannot be ruled out`
    const reason = taskReason('forge_unreachable', note)
    journal('recap_unreachable', note, reason)
    return { comment: 'unreachable', close: 'skipped', note, reason, events }
  }
  const posted = await (opts.commentIssueFn ?? commentIssue)({
    ...forge,
    body: buildRecapComment(ctx.recap, opts.task.id),
  })
  if (!posted.available) {
    const note = `the recap could not be posted on issue #${iid} (${unavailableDetail(posted)}) — it stays in .codesema`
    const reason = forgeIssueReason(posted)
    journal('recap_unreachable', note, reason ?? undefined)
    return { comment: 'unreachable', close: 'skipped', note, reason, events }
  }
  journal('recap_posted', `recap posted on issue #${iid}`)
  return closeStep(opts, journal, { comment: 'posted', note: null, events })
}

/**
 * Posts the recap on the task's issue, then closes that issue when — and only
 * when — `merged` says the merge happened. NEVER throws, and never reports a
 * task failure: every unhappy path is a named degradation.
 *
 * Everything decided WITHOUT the forge lives here — no ticket, no recap, a
 * recap that must not leave the machine — so no round trip is ever spent on a
 * document already ruled out.
 */
export async function publishTaskRecap(opts: PublishRecapOptions): Promise<PublishRecapResult> {
  const events: TaskEvent[] = []
  const issue = opts.task.issue
  if (!issue) {
    // A task with no ticket has nothing to publish and nothing went wrong: no
    // forge call, no journal line, no reason. Any of the three would be a
    // false alarm on every single ticketless task.
    return { comment: 'no_issue', close: 'skipped', note: null, reason: null, events }
  }
  const journal = journalFor(opts, events)
  const recap = (opts.readTaskRecapFn ?? readTaskRecap)(opts.cwd, opts.task.id)
  if (!recap) {
    const note = 'no recap on disk for this task: nothing was posted on the ticket'
    journal('recap_missing', note)
    return { comment: 'no_recap', close: 'skipped', note, reason: null, events }
  }
  // BEFORE any forge call — before the marker search even, which is itself a
  // round trip about a document we have already decided not to send. The scan
  // runs on the rendering that would be published, which is exactly what
  // leaves the machine.
  const secrets = scanRecapSecrets(renderRecapMarkdown(recap))
  if (secrets.length > 0) {
    const note = recapSecretsMessage(secrets)
    journal('recap_blocked_secrets', note)
    // recap.json is NOT touched: nothing is lost, only the publication is held.
    return { comment: 'blocked_secrets', close: 'skipped', note, reason: null, events }
  }
  return commentStep(opts, journal, { recap, events, iid: issue.iid })
}
