// Task workspace contract: types + sanitizers for agent task records and their
// append-only event journal. Same doctrine as the review contract (index.ts):
// whitelist and truncate, never throw. Everything read back from disk goes
// through here before being trusted.

import {
  sanitizeReasonCode,
  sanitizeTaskReason,
  type ReasonCode,
  type TaskReason,
} from './reasons.js'

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_you'
  | 'reviewing'
  | 'review_ok'
  | 'review_ko'
  | 'shipped'
  | 'failed'
  | 'interrupted'

/**
 * Ticks in one US dollar: the cost unit of `cost_ticks` is 1 tick = 1e-10 USD.
 *
 * Money is carried as a NON-NEGATIVE INTEGER count of ticks, never as a float:
 * a float makes sums non-associative and comparisons unstable, which a running
 * total of turns cannot survive. 1e-10 USD is fine enough that the shortest
 * billable turn still rounds to something other than zero.
 */
export const TICKS_PER_USD = 10_000_000_000

/**
 * WHERE a `cost_ticks` figure comes from. A cost is a claim, so it never
 * travels without saying who is making it.
 *
 * - 'harness': the agent harness's OWN estimate of what the turn cost, read
 *   from the figure it reports at the end of a run. It covers everything the
 *   run consumed — output tokens, cache, subagents — but it is still an
 *   ESTIMATE computed from a table bundled in that harness's build, not an
 *   invoice from the provider's billing system.
 * - 'lower_bound': computed here from the token counters the stream reported,
 *   at published first-party rates, over input and cache ONLY. Every line item
 *   left out is positive, so the real bill is this figure OR MORE, never less.
 *
 * The two are not interchangeable and a reader must be able to tell them
 * apart, which is the whole reason this field exists.
 */
export type CostBasis = 'harness' | 'lower_bound'

const COST_BASES: ReadonlySet<CostBasis> = new Set(['harness', 'lower_bound'])

export type TaskTurn = {
  prompt: string
  response: string | null
  question: string | null
  started_at: string
  ended_at: string | null
  /** Total LLM tokens (input+output) consumed by this turn, when the agent's stream reports usage. */
  tokens?: number
  /**
   * What this turn cost, as a non-negative INTEGER number of ticks
   * (1 tick = 1e-10 USD, see TICKS_PER_USD). Counted by the CLI from the
   * stream's own token counters — never a figure stated by the model.
   *
   * OPTIONAL, and its honest default is ABSENCE, which means UNKNOWN — it does
   * NOT mean 0. A turn written before this field existed, a turn whose model
   * the price table does not know, and a turn that ran on a partner-operated
   * platform whose price list this build does not carry, all carry no cost at
   * all rather than a zero no reader could tell from a free turn.
   */
  cost_ticks?: number
  /**
   * Provenance of `cost_ticks` (see CostBasis): whether the figure is the
   * harness's own estimate or this build's input-and-cache lower bound.
   *
   * OPTIONAL, and meaningless without a figure: a turn with no `cost_ticks`
   * never carries a basis — a provenance for a number that is not there
   * describes nothing.
   */
  cost_basis?: CostBasis
}

export type TaskEventType =
  | 'turn_started'
  | 'tool_use'
  | 'tool_result'
  | 'message'
  | 'question'
  | 'commit'
  | 'review_started'
  | 'review_done'
  | 'checks'
  | 'shipped'
  | 'error'
  | 'interrupted'
  /** Isolation decided for the task at creation, with the reason behind it. */
  | 'isolation'
  /**
   * Something worth stating about what a turn COST: which figure was used,
   * or why none could be. A NEUTRAL line, never an error — a cost that cannot
   * be established is a gap in the accounting, not a failure of the work, and
   * painting it red would cry wolf on every turn run against an unpriced
   * model. The distinct cause is named in `data.name`.
   */
  | 'cost'
  /**
   * A fact about a task's BRANCH that is worth stating but stops nothing and
   * qualifies no D2 code (T1.6, decision DP14): a branch rename declined (the
   * task keeps its slug), a branch abandon() kept because it carries a commit
   * of its own, or the anchor `abandon()` had to fall back to because the
   * record predates `baseline_sha`. NEUTRAL by type, never 'message' (that
   * type is the agent's own words, rendered as a chat bubble and backed by
   * the turn's full text — routing a branch fact through it would either
   * duplicate the agent's last reply or never be seen) and never 'error' (none
   * of the three stops anything). The distinct cause is named in `data.name`,
   * same doctrine as `cost`.
   */
  | 'branch'
  /**
   * A local resource of the task — its HOME volume, its worktree — was
   * released, or could not be. A NEUTRAL domain line, never `error`: a
   * `volume rm` that fails on a task that just shipped takes nothing and
   * refuses nothing, and the boot sweep is the backstop, so painting it red
   * would be the exact cry-wolf DP8(b) already refused for `cost`. The
   * precise incident is named in `data.name` (e.g. `home_volume_released`,
   * `home_volume_not_released`, `container_runtime_absent`), never in the
   * type itself — `resource` names the DOMAIN, not the incident.
   */
  | 'resource'
  /**
   * A task just started waiting on a resource it does not hold yet (T1.3,
   * D4/D2): `data.name` is `'machine_busy'` (the machine-wide load cap has no
   * free slot) or `'project_busy'` (another task of the same project is
   * active). A NEUTRAL line like 'cost', never 'error': an ordinary wait is
   * not a degradation to paint red (DP8(b)/DP9), it is stated once per
   * TRANSITION into that wait — never re-journaled on every retry that still
   * finds the resource busy. `reason_code` is always 'resource_busy'.
   *
   * Kept on its own single line at the end of this union on purpose:
   * concurrent tickets each append their own member here, and a line nobody
   * else touches is a rebase conflict that resolves itself.
   */
  | 'queue'

/**
 * How a task's agent turns are contained.
 *
 * - 'container': the WHOLE turn runs inside a per-task container (worktree
 *   mounted, egress through an allowlist proxy). The cage is the guarantee, so
 *   the agent gets full Bash inside it.
 * - 'policy': the turn runs on the HOST, contained by CLI flags only (edit
 *   tools opened, user settings only, strict MCP config).
 *
 * Fixed AT CREATION and immutable: a record must never promise an isolation
 * its turns did not actually run under.
 */
export type TaskIsolation = 'container' | 'policy'

/** Flat, bounded payload: summaries only, never a full file body. */
export type TaskEventData = Record<string, string | number | boolean | null>

export type TaskEvent = {
  seq: number
  at: string
  type: TaskEventType
  data: TaskEventData
  /**
   * Machine-readable name of the degradation — or a qualifiable WAIT, per DP14
   * — this event reports, when it reports one. A DEDICATED field, never a key
   * inside `data`: the code is ADDED to the payload, so the readable message
   * every producer already puts in `data` stays exactly where — and what — it
   * was.
   *
   * "Degradation" alone would contradict this union's own 'queue' entry
   * (T1.3, D4): a NEUTRAL line, never an error, that STILL always carries
   * `reason_code: 'resource_busy'` (adversarial review round 3, MINEUR — the
   * two docstrings used to disagree). DP14's actual test is whether the code
   * qualifies an arrest/refusal a "terminal or retryable" question makes sense
   * for, not whether the line itself is bad news.
   *
   * OPTIONAL, and its honest default is absence: a journal line written before
   * this field existed claims no code, and so does any event that is neither a
   * degradation nor a qualifiable wait.
   */
  reason_code?: ReasonCode
}

/**
 * Statuses that count as ACTIVE for the one-active-conversation-per-branch
 * rule: everything non-terminal. Terminal tasks (shipped, failed) never block
 * a new conversation on their branch.
 */
export function isActiveTaskStatus(status: TaskStatus): boolean {
  return status !== 'shipped' && status !== 'failed'
}

export type TaskRecord = {
  version: 1
  /** 12 lowercase hex chars, doubles as the on-disk directory name. */
  id: string
  title: string
  status: TaskStatus
  /** Fork mode: base ref the task branched from (e.g. "main"). Work-on mode: the MR target branch. */
  base: string
  /** Task branch: a generated "codesema/task-<slug>" (fork mode) or the pre-existing branch the conversation works on directly (work-on mode). */
  branch: string
  /** Absolute path of the task's git worktree. */
  worktree: string
  /**
   * Commit the agent's work is measured FROM: the resolved sha of the point
   * the conversation started at — the base it forked, or the tip of the branch
   * it works on — so `baseline_sha..HEAD` is exactly what the agent produced.
   * NOTHING is captured or committed to obtain it: the main repository's
   * uncommitted work never travels into the task's worktree, and no synthetic
   * commit is created anywhere. The baseline is a fact about where the work
   * began, not an artifact.
   *
   * OPTIONAL, and absence is the honest default: a record written before the
   * baseline existed (0.12) has no anchor to name, so its consumers fall back
   * on `base...HEAD` — the range they always used — and SAY SO rather than
   * pretending to a precision they don't have.
   *
   * WRITE-ONCE PER LINEAGE: it belongs to the conversation, not to one
   * materialization. A worktree rebuilt on the same branch keeps it; a fork
   * rebuilt as a NEW branch off a base that moved on re-anchors, because the
   * old anchor would otherwise credit the agent with the base's own commits.
   */
  baseline_sha?: string
  /**
   * True when this conversation brought its branch head into existence (every
   * fork, and a work-on conversation on a branch that only existed on origin).
   *
   * OPTIONAL, and absence is the honest default: a record written before this
   * field existed cannot say, and neither can one whose branch was already
   * there. Absence therefore means "not ours to delete" — the safe reading,
   * since the alternative is deleting someone's branch on a guess.
   */
  created_branch?: boolean
  /**
   * The tip this conversation last left on its branch: written at every
   * materialization and after every turn that commits. Its ONLY job is to make
   * a rebuild able to tell "the branch is where I left it" from "somebody else
   * wrote on it while my worktree was gone" — the anchor cannot answer that,
   * since a third party's commits sit AFTER the baseline and keep it a
   * perfectly valid ancestor.
   *
   * OPTIONAL, and absence is the honest default: a record written before this
   * field existed never knew where it left its branch, so a rebuild says
   * nothing rather than inventing a comparison it cannot make.
   */
  head_sha?: string
  /** Provider session id (claude --resume), null before the first turn ran. */
  agent_session_id: string | null
  turns: TaskTurn[]
  /** Path of the archived review record produced for this task, if any. */
  review_ref: string | null
  /** Time spent working; waiting_for_you time never counts as work. */
  work_ms: number
  wait_ms: number
  auto_ship: boolean
  /**
   * True for a work-on task (POST /api/tasks `branch`): the conversation works
   * DIRECTLY on the pre-existing `branch` — the worktree is a plain checkout
   * of it, and abandoning the task must never delete the branch.
   */
  work_on: boolean
  /**
   * Containment of this task's agent turns, decided at creation from the
   * workspace configuration and the container-runtime probe. Immutable: the
   * runner reads it, never writes it.
   */
  isolation: TaskIsolation
  /**
   * Why the task is where it is, when where it is is a degradation: the code
   * plus, in `detail`, the producer's own readable message verbatim. OPTIONAL,
   * and absence is the honest default — a record written by 0.12 has no reason
   * to state, and neither has a task nothing went wrong with. Cleared as soon
   * as the task moves on (a turn restarting, a review coming back OK), because
   * a stale reason is a lie about the present.
   */
  reason?: TaskReason
  /**
   * Last liveness beat of this task's agent (ISO-8601), written by the
   * semantic watchdog's heartbeat. It is what lets a reader tell a task that
   * is LONG from a task that is DEAD: `updated_at` only moves when something
   * happens, so a working agent deep inside a forty-minute tool call looks
   * exactly like a crashed one without it. Only meaningful while the task is
   * `running` — a starting turn CLEARS it, so a stale stamp can never be read
   * as a live one, and on a stopped task it is simply the last beat there was.
   *
   * OPTIONAL, and absence is the honest default: a record written before this
   * field existed claims no beat, and so does a task that is not running. It
   * is deliberately NOT a journal line — a beat every 30 s would grow
   * events.jsonl without ever saying anything new.
   */
  heartbeat_at?: string
  /**
   * Running total of what this task cost: the SUM of the `cost_ticks` its
   * turns carry, same unit (1 tick = 1e-10 USD) and same integer discipline.
   *
   * OPTIONAL with the same honest default as the turn's: ABSENT means
   * UNKNOWN, not 0. A task written by 0.12, and a task not one of whose turns
   * could be priced, carry nothing — never a `0` that would read as "free".
   */
  cost_ticks?: number
  /**
   * HOW MANY turns that total covers. A partial total is honest only if its
   * coverage is legible: `cost_turns` 2 on a task with 5 turns says plainly
   * that three turns are missing from the figure. Absent whenever
   * `cost_ticks` is, for the same reason.
   */
  cost_turns?: number
  /**
   * Provenance of the total (see CostBasis), DERIVED from the turns it sums:
   * 'harness' only when every covered turn is itself 'harness'. A single turn
   * on the fallback table drags the whole total down to 'lower_bound' — a sum
   * is never more authoritative than its weakest term.
   */
  cost_basis?: CostBasis
  /**
   * 1-based place of the task in its project's queue, when it is waiting for
   * its turn (one active task per project). DERIVED and TRANSIENT: the server
   * computes it from `<repo>/.codesema/queue.json` when it serves a listing,
   * and it is never written to task.json — a position stored on disk would be
   * a lie the moment the head of the queue starts.
   *
   * OPTIONAL, and absence is the honest default: a task that is not queued has
   * no position, and neither has a record read straight off disk (which is why
   * sanitizeTaskRecord deliberately drops any value found there).
   */
  queue_position?: number
  created_at: string
  updated_at: string
}

export const TASK_TITLE_MAX = 200
/** Bound for a caller-supplied base branch name (POST /api/tasks `base`). */
export const TASK_BASE_MAX = 200
export const TASK_PATH_MAX = 500
export const TASK_SESSION_ID_MAX = 200
/** Bound for a timestamp read back from disk: an ISO-8601 instant, nothing longer. */
export const TASK_TIMESTAMP_MAX = 40
/** Applies to a turn's prompt, response and question alike. */
export const TASK_TURN_TEXT_MAX = 20_000
export const TASK_TURNS_MAX = 500
export const TASK_EVENT_DATA_KEYS_MAX = 16
export const TASK_EVENT_DATA_KEY_MAX = 64
export const TASK_EVENT_DATA_STRING_MAX = 2_000

const TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'queued',
  'running',
  'waiting_for_you',
  'reviewing',
  'review_ok',
  'review_ko',
  'shipped',
  'failed',
  'interrupted',
])

const TASK_EVENT_TYPES: ReadonlySet<TaskEventType> = new Set([
  'turn_started',
  'tool_use',
  'tool_result',
  'message',
  'question',
  'commit',
  'review_started',
  'review_done',
  'checks',
  'shipped',
  'error',
  'interrupted',
  'isolation',
  'cost',
  'branch',
  'resource',
  'queue',
])

const TASK_ISOLATIONS: ReadonlySet<TaskIsolation> = new Set(['container', 'policy'])

/**
 * A baseline (and the remembered branch tip beside it) is a git object name and
 * nothing else: hex only, from an abbreviated 7 up to a sha256 repo's 64.
 * Whitelisted rather than truncated — half a sha is not a shorter sha, it is a
 * different (or missing) commit, and the whole point of these fields is that
 * the range they anchor, and the comparison they allow, can be trusted.
 */
const BASELINE_SHA_RE = /^[0-9a-f]{7,64}$/

/** Hex sha or nothing: an unusable value drops the key, never throws, never invents one. */
function sanitizeBaselineSha(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const sha = raw.trim().toLowerCase()
  return BASELINE_SHA_RE.test(sha) ? sha : null
}

/** The id names a directory under .codesema/tasks/: nothing else is usable. */
const TASK_ID_RE = /^[0-9a-f]{12}$/

/** Guards every id joined into a filesystem path (store, HTTP routes). */
export function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID_RE.test(value)
}

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : ''

const nullableStr = (v: unknown, max: number): string | null => {
  const s = str(v, max)
  return s ? s : null
}

const isoOrNow = (v: unknown): string => (typeof v === 'string' && v ? v : new Date().toISOString())

const nonNegativeInt = (v: unknown): number =>
  Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0

/**
 * `nonNegativeInt`'s OPTIONAL twin, for `cost_ticks`: same predicate, but the
 * fallback is absence instead of `0`.
 *
 * A required counter (work_ms, tokens read as a total) can degrade to 0 and
 * still be honest — "no time measured" and "no time spent" are close enough.
 * A cost cannot: on this field, `0` means "this turn was free", which is a
 * claim, and the whole point of `cost_ticks` is that absence means UNKNOWN. So
 * anything the predicate rejects — a float, a negative, a string, a value too
 * large to be an exact integer — drops the key rather than inventing a zero.
 * Whitelist and truncate doctrine, never throws.
 *
 * `-0` is rejected explicitly: it passes both `Number.isSafeInteger` and
 * `>= 0`, and a negative zero on a money field is a value nobody meant to
 * write. It costs one expression to refuse and leaves no doubt in memory.
 */
const optionalCostTicks = (v: unknown): number | null =>
  Number.isSafeInteger(v) && (v as number) >= 0 && !Object.is(v, -0) ? (v as number) : null

/**
 * Coverage of a record's total: how many turns the figure sums.
 *
 * Bounded to `[1, kept]`, where `kept` is the number of turns this record
 * actually keeps after sanitizing. A coverage of `0` describes a total that
 * covers nothing (so there is no total), and a coverage larger than the record
 * has turns claims a completeness the file cannot back — both are the kind of
 * hand-edited or future-written value this layer exists to refuse.
 */
const optionalCostTurns = (v: unknown, kept: number): number | null => {
  const n = optionalCostTicks(v)
  return n !== null && n >= 1 && n <= Math.min(kept, TASK_TURNS_MAX) ? n : null
}

/**
 * Whitelist for `cost_basis`: a provenance nobody can name is worse than none,
 * so an unknown value drops the key instead of guessing which of the two it
 * meant. Callers additionally drop it when there is no `cost_ticks` to
 * describe.
 */
const optionalCostBasis = (v: unknown): CostBasis | null =>
  COST_BASES.has(v as CostBasis) ? (v as CostBasis) : null

/**
 * `cost_ticks` and `cost_basis` are ONE FACT in two keys, so they survive or
 * fall TOGETHER — in both directions.
 *
 * A provenance with no figure describes nothing; a figure whose provenance
 * nobody can name cannot be interpreted either (is it the harness's estimate
 * of the whole run, or a floor over input and cache only?), and worse, a
 * half-kept pair makes two readers disagree about whether the turn carries a
 * cost at all — which is how a re-run silently REPLACES a figure it should
 * have added to. Anything that breaks the pair therefore drops both keys.
 */
const costPair = (
  rawTicks: unknown,
  rawBasis: unknown,
): { cost_ticks: number; cost_basis: CostBasis } | null => {
  const ticks = optionalCostTicks(rawTicks)
  const basis = optionalCostBasis(rawBasis)
  return ticks === null || basis === null ? null : { cost_ticks: ticks, cost_basis: basis }
}

function sanitizeTaskTurn(raw: unknown): TaskTurn | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const t = raw as Record<string, unknown>
  // A turn without a prompt carries no information: skip it entirely.
  const prompt = typeof t.prompt === 'string' ? t.prompt.slice(0, TASK_TURN_TEXT_MAX) : ''
  if (!prompt.trim()) {
    return null
  }
  const cost = costPair(t.cost_ticks, t.cost_basis)
  return {
    prompt,
    response:
      typeof t.response === 'string' ? t.response.slice(0, TASK_TURN_TEXT_MAX) || null : null,
    question:
      typeof t.question === 'string' ? t.question.slice(0, TASK_TURN_TEXT_MAX) || null : null,
    started_at: isoOrNow(t.started_at),
    ended_at: typeof t.ended_at === 'string' && t.ended_at ? t.ended_at : null,
    ...(typeof t.tokens === 'number' && Number.isFinite(t.tokens) && t.tokens >= 0
      ? { tokens: Math.min(Math.round(t.tokens), 1_000_000_000) }
      : {}),
    // Absence is PRESERVED as absence, exactly like `tokens`: a turn with no
    // cost on disk comes back with no cost in memory. Figure and provenance
    // are one fact and travel as one (see costPair) — never one without the
    // other, in either direction.
    ...cost,
  }
}

/**
 * Revalidates a TaskRecord read back from disk. Returns null when the input
 * has no usable identity (missing or malformed id); every other field is
 * normalized to a safe default. An unknown status degrades to 'failed': a
 * record written by a newer schema is shown as broken, never as runnable.
 */
export function sanitizeTaskRecord(raw: unknown): TaskRecord | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim().toLowerCase() : ''
  if (!TASK_ID_RE.test(id)) {
    return null
  }
  const turns: TaskTurn[] = []
  if (Array.isArray(r.turns)) {
    for (const item of r.turns) {
      if (turns.length >= TASK_TURNS_MAX) {
        break
      }
      const turn = sanitizeTaskTurn(item)
      if (turn) {
        turns.push(turn)
      }
    }
  }
  const created_at = isoOrNow(r.created_at)
  const reason = sanitizeTaskReason(r.reason)
  // The record's total is a TRIO — figure, coverage, provenance — written
  // together by the runner and only meaningful together: a total whose reader
  // cannot tell how complete or how authoritative it is says nothing useful.
  // Any one of the three missing or unusable drops all three.
  const totalPair = costPair(r.cost_ticks, r.cost_basis)
  const costTurns = optionalCostTurns(r.cost_turns, turns.length)
  const total =
    totalPair === null || costTurns === null ? null : { ...totalPair, cost_turns: costTurns }
  const baselineSha = sanitizeBaselineSha(r.baseline_sha)
  const headSha = sanitizeBaselineSha(r.head_sha)
  return {
    version: 1,
    id,
    title: str(r.title, TASK_TITLE_MAX),
    status: TASK_STATUSES.has(r.status as TaskStatus) ? (r.status as TaskStatus) : 'failed',
    base: str(r.base, TASK_PATH_MAX),
    branch: str(r.branch, TASK_PATH_MAX),
    worktree: str(r.worktree, TASK_PATH_MAX),
    // Optional and whitelisted, same doctrine as `reason` below: a record
    // written before the baseline existed keeps none, and one whose value is
    // not a git object name drops the key rather than anchoring a range on a
    // sha nobody can resolve.
    ...(baselineSha ? { baseline_sha: baselineSha } : {}),
    // Present only when TRUE: absence is the honest "we did not create this
    // branch, or we cannot say", which is also the only safe answer for a
    // reader deciding whether the branch may be deleted.
    ...(r.created_branch === true ? { created_branch: true } : {}),
    // Same whitelist as the baseline: a tip that is not a git object name is
    // worse than no tip at all, since the comparison it feeds decides whether
    // the conversation announces a stranger's commits or stays silent.
    ...(headSha ? { head_sha: headSha } : {}),
    agent_session_id: nullableStr(r.agent_session_id, TASK_SESSION_ID_MAX),
    turns,
    review_ref: nullableStr(r.review_ref, TASK_PATH_MAX),
    work_ms: nonNegativeInt(r.work_ms),
    wait_ms: nonNegativeInt(r.wait_ms),
    auto_ship: r.auto_ship === true,
    // Absent on records written before work-on mode existed: those are all
    // fork tasks, so false is the honest default.
    work_on: r.work_on === true,
    // Absent on records written before the container cage existed — those all
    // ran on the host under the policy hardening, so 'policy' is the honest
    // default. An unknown value degrades the same way: a record must never
    // claim a stronger containment than the one it can prove.
    isolation: TASK_ISOLATIONS.has(r.isolation as TaskIsolation)
      ? (r.isolation as TaskIsolation)
      : 'policy',
    // Optional and whitelisted, exactly like `source` on TaskChecks: a record
    // without a reason keeps none, and one whose code is unknown (older or
    // newer vocabulary, tampered file) drops the key entirely rather than
    // claiming a reason no reader can name. Never throws.
    ...(reason ? { reason } : {}),
    // Same doctrine: optional, whitelisted to a plain bounded string, dropped
    // entirely when it is not one. A missing beat means "we know nothing",
    // never "the agent is dead".
    ...(typeof r.heartbeat_at === 'string' && r.heartbeat_at
      ? { heartbeat_at: r.heartbeat_at.slice(0, TASK_TIMESTAMP_MAX) }
      : {}),
    // Same optional-with-absence rule as on the turn: a record written by 0.12
    // has no total to state, and one whose value is unusable states none
    // either — a `0` here would claim the task was free.
    ...total,
    // queue_position is deliberately ABSENT here: it is derived from the
    // project's queue at read time, never persisted, so a value sitting in a
    // task.json can only be stale (or hand-written) and is dropped rather
    // than trusted.
    created_at,
    updated_at: typeof r.updated_at === 'string' && r.updated_at ? r.updated_at : created_at,
  }
}

function sanitizeTaskEventData(raw: unknown): TaskEventData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }
  const out: TaskEventData = {}
  let kept = 0
  for (const [key, value] of Object.entries(raw)) {
    if (kept >= TASK_EVENT_DATA_KEYS_MAX) {
      break
    }
    const k = key.slice(0, TASK_EVENT_DATA_KEY_MAX)
    if (!k) {
      continue
    }
    if (typeof value === 'string') {
      out[k] = value.slice(0, TASK_EVENT_DATA_STRING_MAX)
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[k] = value
    } else if (typeof value === 'boolean' || value === null) {
      out[k] = value
    } else {
      // Nested objects/arrays are dropped: the journal stays flat and bounded.
      continue
    }
    kept++
  }
  return out
}

// --- Task checks (container-run typecheck/tests/lint on the task worktree) --

/** Per-command outcome. 'skipped' = never ran (an earlier install/step failed). */
export type TaskCheckStatus = 'passed' | 'failed' | 'timeout' | 'skipped'

/**
 * Whole-run status. 'error' means the run itself could not happen (no
 * container runtime, engine bug) as opposed to a check failing;
 * 'unconfigured' means nothing to run was detected or configured.
 */
export type TaskChecksStatus = 'running' | 'passed' | 'failed' | 'error' | 'unconfigured'

/**
 * WHERE the executed plan came from, in the engine's own precedence order:
 * the repo's explicit .codesema config, the commands the repo declares for
 * itself (lefthook hooks, then CI workflow jobs), else the lockfile/scripts
 * heuristic. Optional on the wire: a checks.json written before this field
 * existed simply carries no provenance.
 */
export type TaskChecksSource = 'config' | 'lefthook' | 'ci' | 'scripts'

export type TaskCheckResult = {
  command: string
  status: TaskCheckStatus
  /** Container exit code; null when it never exited on its own (timeout, skip). */
  exit_code: number | null
  duration_ms: number
  /** LAST ~4000 chars of the check's stdout+stderr (the end carries the verdict). */
  tail: string
}

/** The persisted checks.json of one task: latest run only, overwritten each run. */
export type TaskChecks = {
  /** Worktree HEAD the checks ran against. */
  head_sha: string
  started_at: string
  finished_at: string | null
  status: TaskChecksStatus
  checks: TaskCheckResult[]
  /** Readable failure when status is 'error' (e.g. no container runtime). */
  error: string | null
  /**
   * Provenance of the plan that ran. ABSENT (never null) when unknown: files
   * written by an older engine, and runs that never resolved a plan
   * ('unconfigured'), carry nothing — readers show nothing then.
   */
  source?: TaskChecksSource
}

export const TASK_CHECK_COMMAND_MAX = 500
export const TASK_CHECK_TAIL_MAX = 4_000
export const TASK_CHECKS_LIST_MAX = 32
export const TASK_CHECKS_ERROR_MAX = 2_000
/** A git sha is 40 (64 for sha256 repos) chars; anything longer is garbage. */
const TASK_CHECKS_SHA_MAX = 64

const TASK_CHECK_STATUSES: ReadonlySet<TaskCheckStatus> = new Set([
  'passed',
  'failed',
  'timeout',
  'skipped',
])

const TASK_CHECKS_STATUSES: ReadonlySet<TaskChecksStatus> = new Set([
  'running',
  'passed',
  'failed',
  'error',
  'unconfigured',
])

const TASK_CHECKS_SOURCES: ReadonlySet<TaskChecksSource> = new Set([
  'config',
  'lefthook',
  'ci',
  'scripts',
])

function sanitizeTaskCheckResult(raw: unknown): TaskCheckResult | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const c = raw as Record<string, unknown>
  // A result without a command or with an unknown status cannot be rendered
  // honestly: skip the entry rather than invent one.
  const command = str(c.command, TASK_CHECK_COMMAND_MAX)
  if (!command || !TASK_CHECK_STATUSES.has(c.status as TaskCheckStatus)) {
    return null
  }
  return {
    command,
    status: c.status as TaskCheckStatus,
    exit_code: Number.isInteger(c.exit_code) ? (c.exit_code as number) : null,
    duration_ms: nonNegativeInt(c.duration_ms),
    // The tail's END is the valuable part (final error, summary line): truncate
    // from the front, never the back.
    tail: typeof c.tail === 'string' ? c.tail.slice(-TASK_CHECK_TAIL_MAX) : '',
  }
}

/**
 * Revalidates a TaskChecks read back from disk (checks.json) or received over
 * SSE. Same doctrine as the other sanitizers: whitelist and truncate, never
 * throw. Null when the whole-run status is unusable — a file written by a
 * newer schema must not render as a verdict it does not carry.
 */
export function sanitizeTaskChecks(raw: unknown): TaskChecks | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  if (!TASK_CHECKS_STATUSES.has(r.status as TaskChecksStatus)) {
    return null
  }
  const checks: TaskCheckResult[] = []
  if (Array.isArray(r.checks)) {
    for (const item of r.checks) {
      if (checks.length >= TASK_CHECKS_LIST_MAX) {
        break
      }
      const check = sanitizeTaskCheckResult(item)
      if (check) {
        checks.push(check)
      }
    }
  }
  return {
    head_sha: str(r.head_sha, TASK_CHECKS_SHA_MAX),
    started_at: isoOrNow(r.started_at),
    finished_at: typeof r.finished_at === 'string' && r.finished_at ? r.finished_at : null,
    status: r.status as TaskChecksStatus,
    checks,
    error: nullableStr(r.error, TASK_CHECKS_ERROR_MAX),
    // Optional and whitelisted: an absent or unknown provenance drops the key
    // entirely rather than surfacing a token no reader can label.
    ...(TASK_CHECKS_SOURCES.has(r.source as TaskChecksSource)
      ? { source: r.source as TaskChecksSource }
      : {}),
  }
}

/**
 * Revalidates a TaskEvent (one JSONL journal line). Returns null when the
 * line cannot be placed in the journal (missing seq) or rendered (unknown
 * type): the reader skips it and moves on, a corrupt line never crashes.
 */
export function sanitizeTaskEvent(raw: unknown): TaskEvent | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const e = raw as Record<string, unknown>
  if (!Number.isInteger(e.seq) || (e.seq as number) < 0) {
    return null
  }
  if (!TASK_EVENT_TYPES.has(e.type as TaskEventType)) {
    return null
  }
  // Optional field, whitelisted on its own: an unknown code drops the key and
  // leaves the event otherwise intact — the readable message in `data` is what
  // the line was always about, the code only names it.
  const reasonCode = sanitizeReasonCode(e.reason_code)
  return {
    seq: e.seq as number,
    at: isoOrNow(e.at),
    type: e.type as TaskEventType,
    data: sanitizeTaskEventData(e.data),
    ...(reasonCode ? { reason_code: reasonCode } : {}),
  }
}
