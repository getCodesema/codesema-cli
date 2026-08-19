// Task runner: drives agent turns inside each task's git worktree, caps
// concurrency (FIFO queue past the limit) and owns every status transition.
// The agent never commits — the runner commits the whole worktree at the end
// of a successful turn, so the result is deterministic across providers.
// A turn ends either in a result or in a question (no realtime channel into a
// running agent): the task lands on 'waiting_for_you' and the human's reply
// starts the next turn, resuming the provider session when it can. A turn cut
// short instead (crash, shutdown, Stop) leaves the task 'interrupted', and
// resume() re-runs that very turn in place — never on its own, always on a
// human gesture.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  AGENT_WATCHDOG_DEFAULTS,
  agentEnv,
  agentReasonCode,
  claudeStreamCommand,
  createClaudeTaskParser,
  effectiveAbsoluteCapMs,
  emitsClaudeStreamJson,
  flagPresent,
  runAgent,
  type AgentHeartbeat,
  type AgentRunOptions,
  type WatchdogBudgets,
} from './agent.js'
import {
  isTerminalReason,
  reasonCodeOf,
  type TaskEvent,
  type TaskRecord,
  type TaskStatus,
  type TaskTurn,
} from './contract.js'
import {
  foldTurnCost,
  totalCost,
  turnCostOf,
  type CostDegradation,
  type SettledCost,
} from './cost.js'
import { fixCommandFor } from './fix.js'
import { git, refExists, tryGit } from './git.js'
import { reviewLanguage, t } from './i18n.js'
import type { ChecksConfig } from './repo-config.js'
import {
  CAGE_FORWARDED_ENV,
  containerTaskCommandFor,
  runContainerTurn,
  type RunContainerTurnOptions,
} from './task-isolation.js'
import {
  BranchInUseError,
  createTaskWorktree,
  removeTaskWorktree,
  renameTaskBranch,
  type TaskWorktree,
  type WorktreeLockFn,
  type WorktreeRemoval,
} from './task-worktree.js'
import {
  appendTaskEvent,
  loadTask,
  saveTask,
  taskReason,
  type AppendTaskEventInput,
} from './tasks-store.js'

/** Concurrent 'running' tasks by default; overridable via the maxParallelTasks config. */
export const DEFAULT_MAX_PARALLEL_TASKS = 3

/** Bound for prompt/response previews embedded in journal events. */
const EVENT_PREVIEW_MAX = 400

function preview(text: string): string {
  const codePoints = Array.from(text)
  return codePoints.length > EVENT_PREVIEW_MAX
    ? `${codePoints.slice(0, EVENT_PREVIEW_MAX - 1).join('')}…`
    : text
}

/** Claude in print mode can pin and resume a session; other providers run one-shot turns. */
export function supportsSessionResume(command: string): boolean {
  return /^claude(\s|$)/.test(command) && /(^|\s)(-p|--print)(\s|$)/.test(command)
}

export type TaskSession = { kind: 'new' | 'resume'; id: string }

/**
 * Per-turn agent command. The provider's edit tools are opened with the same
 * flags as the fix runner (tasks always run in write mode: the agent works in
 * its own worktree). Claude additionally gets the stream-json flags (tool
 * events + text deltas feed the live conversation) and a stable session:
 * --session-id on the first turn, --resume afterwards (flags verified against
 * claude 2.1.231 with -p).
 */
export function taskCommandFor(command: string, opts: { session: TaskSession | null }): string {
  let cmd = fixCommandFor(command)
  if (!/^claude(\s|$)/.test(command)) {
    return cmd
  }
  // CVE-2026-25725 lesson: a turn could write .claude/settings.json or
  // .mcp.json INTO the worktree, and the next resumed turn would load them —
  // hooks and MCP servers running with host privileges. Task agents therefore
  // load user-level settings only and ignore repo-provided MCP config, like
  // the review harness. User-set flags win (flagPresent, quote-aware).
  if (!flagPresent(cmd, '--strict-mcp-config')) {
    cmd += ' --strict-mcp-config'
  }
  if (!flagPresent(cmd, '--setting-sources')) {
    cmd += ' --setting-sources user'
  }
  cmd = claudeStreamCommand(cmd) ?? cmd
  if (opts.session) {
    cmd +=
      opts.session.kind === 'new'
        ? ` --session-id ${opts.session.id}`
        : ` --resume ${opts.session.id}`
  }
  return cmd
}

/**
 * Task-turn language instruction, driven by the same `language` config as
 * review.ts's languageRule(): explicit config wins, otherwise the agent
 * mirrors whatever language the user's own messages are in. Unlike a
 * review's structured fields (summary, messages, narrative), a task turn is
 * a conversation, so this is scoped in buildTaskPrompt to the summary and
 * the QUESTION line only — never code identifiers, paths, or commit
 * messages.
 */
function taskLanguageRule(): string {
  const language = reviewLanguage()
  return language
    ? `write every reply to the user in ${language}`
    : "reply in the language of the user's messages"
}

/**
 * Standing instructions sent with the first turn (and replayed for providers
 * without session resume). The QUESTION protocol is the whole question
 * mechanism: a turn ends either in a summary or in that final line.
 *
 * `askBranchName` adds the one-line BRANCH protocol, asked on the FIRST turn
 * of a forked task only (see parseTaskBranchProposal): once the branch has the
 * agent's name, re-asking would only invite a rename mid-conversation.
 */
export function buildTaskPrompt(task: TaskRecord, opts: { askBranchName?: boolean } = {}): string {
  const lines = [
    'You are an autonomous coding agent working on a task in a dedicated git worktree of this repository (your current directory).',
    '',
    `Task: ${task.title}`,
    '',
    'Rules:',
    '- Work only inside this worktree. Never touch files outside it.',
    '- Do NOT commit, stage, push, or run destructive git commands: the runner commits your work at the end of the turn.',
    // The cage mounts the worktree and NOTHING else — the .git directory it
    // points at lives on the other side, so git simply cannot work in there.
    // Saying it up front beats letting the agent discover it by failing.
    ...(task.isolation === 'container'
      ? [
          '- You are running inside a container: the working tree is here, but its git directory is not, so git commands will fail. Read and edit files directly; the runner commits from outside.',
        ]
      : []),
    '- Follow the existing code style and conventions of the repository.',
    '- If the repo has cheap checks (typecheck, unit tests, lint), run them and fix what YOUR changes broke before finishing.',
    `- Language: ${taskLanguageRule()}. This covers your summary and any 'QUESTION: <text>' line; code identifiers, file paths and commit messages stay as they are.`,
    "- If you cannot proceed without a human decision, end your reply with a single final line of the exact form 'QUESTION: <your question>' (nothing after that line). Ask only when truly blocked.",
    '- Otherwise end your reply with a short plain-text summary of what you did and how you verified it (no code fences).',
    // FIRST line, because the QUESTION protocol already owns the last one.
    ...(opts.askBranchName
      ? [
          "- Start this reply with a single first line of the exact form 'BRANCH: <name>', where <name> is a 2-5 word kebab-case English branch name for this task (e.g. 'fix-preview-rename') — always in English, regardless of the language rule above. Then continue with your reply as usual.",
        ]
      : []),
  ]
  return lines.join('\n')
}

/** Bound for the raw name the agent proposes; longer is prose, not a branch name. */
const BRANCH_PROPOSAL_MAX = 60

/** A branch name, possibly still spaced/uppercased: slug() finishes the job. */
const BRANCH_PROPOSAL_RE = /^[a-z0-9][a-z0-9 ._/-]*$/i

export type TaskBranchProposal = {
  /** Usable proposal, still to be slugged; null when the line carried garbage. */
  name: string | null
  /** The reply with the protocol line removed. */
  rest: string
}

/**
 * The first-turn prompt asks the agent to OPEN its reply with
 * 'BRANCH: <kebab-name>' (the last line is already taken by the QUESTION
 * protocol). Null when there is no such line — the overwhelmingly common case
 * for a provider that ignored the instruction, and the reason the field is
 * optional. A present but unusable line still gets stripped (it is protocol,
 * not prose) with a null name: the branch just keeps its generated slug.
 */
export function parseTaskBranchProposal(response: string): TaskBranchProposal | null {
  const trimmed = response.trimStart()
  const breakAt = trimmed.indexOf('\n')
  const first = (breakAt === -1 ? trimmed : trimmed.slice(0, breakAt)).trim()
  const match = /^BRANCH:\s*(.+)$/i.exec(first)
  if (!match) {
    return null
  }
  const rest = (breakAt === -1 ? '' : trimmed.slice(breakAt + 1)).trim()
  // Agents love quoting and backticking identifiers; that is not garbage.
  const raw = (match[1] ?? '')
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .trim()
  const usable =
    raw.length >= 3 && raw.length <= BRANCH_PROPOSAL_MAX && BRANCH_PROPOSAL_RE.test(raw)
  return { name: usable ? raw : null, rest }
}

/**
 * The task prompt asks the agent to END its reply with 'QUESTION: <text>'
 * when it needs a human decision: only the last non-empty line counts, a
 * QUESTION mention mid-prose is not a question.
 */
export function parseTaskQuestion(response: string): string | null {
  const last = response.trimEnd().split('\n').at(-1)?.trim() ?? ''
  const match = /^QUESTION:\s*(.+)$/.exec(last)
  return match?.[1]?.trim() || null
}

/**
 * The journal line for something the cost accounting could not do.
 *
 * NEUTRAL by type ('cost', not 'error'): a figure that cannot be established
 * is a gap in the accounting, not a failure of the work — painting it red
 * would cry wolf on every turn run against a model this build cannot price.
 *
 * Each cause is reported AS ITSELF: the message says what actually happened,
 * never a catch-all. `data.name` carries the machine-readable cause and the
 * readable message stays where every producer puts it — the name is ADDED, it
 * does not replace. No `reason_code`: the shared vocabulary (D2) qualifies why
 * a TASK stopped, and none of these stops anything.
 */
export function costEvent(degradation: CostDegradation): AppendTaskEventInput {
  switch (degradation.cause) {
    case 'partner_platform':
      return {
        type: 'cost',
        data: {
          name: 'cost_partner_platform_unpriced',
          signal: degradation.signal,
          message: `cost not recorded: this run bills through a partner-operated platform (${degradation.signal}), whose price list this build does not carry — a first-party figure would be the wrong invoice, so none is written`,
        },
      }
    case 'model_unpriced':
      return {
        type: 'cost',
        data: {
          name: 'cost_model_unpriced',
          model: degradation.model,
          message: `cost unknown: model ${degradation.model} has no row in the fallback price table — the turn is left without a cost rather than counted as free`,
        },
      }
    case 'price_expired':
      return {
        type: 'cost',
        data: {
          name: 'cost_price_expired',
          model: degradation.model,
          at: degradation.at,
          message: `cost unknown: no price on record for ${degradation.model} applies on ${degradation.at} — its known rate windows do not cover this turn, and an out-of-window rate is a wrong rate, so none is applied`,
        },
      }
    case 'turn_undated':
      return {
        type: 'cost',
        data: {
          name: 'cost_turn_undated',
          model: degradation.model,
          at: degradation.at || '(none)',
          message: `cost unknown: this turn carries no readable start date (${degradation.at || 'empty'}), and a price is only ever read at the date the turn ran — ${degradation.model} is in the table, but no rate can be selected without a date, and "now" is not an answer`,
        },
      }
    case 'counters_unusable':
      return {
        type: 'cost',
        data: {
          name: 'cost_counters_unusable',
          model: degradation.model,
          message: `cost unknown: the usage counters reported for ${degradation.model} are not usable token counts (negative, fractional or out of exact range) — no figure is derived from them`,
        },
      }
    case 'harness_amount_unusable':
      return {
        type: 'cost',
        data: {
          name: 'cost_harness_amount_unusable',
          subtype: degradation.subtype,
          message: `cost estimate discarded: the ${degradation.subtype} result frame reports a cost that is not a usable amount (not finite, negative, or beyond the per-turn ceiling) — the turn falls back to the input-and-cache lower bound rather than record a broken figure`,
        },
      }
    case 'turn_unrepresentable':
      return {
        type: 'cost',
        data: {
          name: 'cost_turn_unrepresentable',
          kept_ticks: degradation.keptTicks,
          dropped_ticks: degradation.droppedTicks,
          message: `cost not added: this turn already carried ${degradation.keptTicks} ticks and a further attempt measured ${degradation.droppedTicks}, whose sum leaves the exact integer range — the turn keeps the figure it had rather than take a wrong one, so it now UNDERSTATES what the turn cost`,
        },
      }
    case 'total_unrepresentable':
      return {
        type: 'cost',
        data: {
          name: 'cost_total_unrepresentable',
          turns: degradation.turns,
          message: `task total not recorded: the ${degradation.turns} priced turns of this task sum past the exact integer range, so the total is stated nowhere rather than stated wrong — the per-turn figures are untouched. This is NOT an unpriced task`,
        },
      }
    case 'drift':
      return {
        type: 'cost',
        data: {
          name: 'cost_drift',
          lower_bound_ticks: degradation.lowerBoundTicks,
          harness_ticks: degradation.harnessTicks,
          message: `cost cross-check: the input-and-cache lower bound (${degradation.lowerBoundTicks} ticks) exceeds the harness estimate kept for this turn (${degradation.harnessTicks} ticks), which it structurally cannot — one of the two price tables is out of date. The harness figure stands; this line is informative`,
        },
      }
  }
}

/** A turn's cost with its provenance; the two never travel apart. */
export type TurnCost = SettledCost

/**
 * One ATTEMPT at a turn: what its meter last published, and whether that
 * measurement has already been folded onto the turn.
 *
 * The marker exists because an attempt has two exit paths and BOTH can run for
 * the same attempt: `finishTurn` folds the cost and then goes on to commit,
 * emit and persist — any of which can throw (a full disk on the journal, a
 * host broadcast blowing up) — and the promise chain's `.catch` then runs
 * `failTurn` with the very same figure. Folding is ADDITIVE since a resumed
 * attempt's cost is disjoint from the killed one's, so without this marker the
 * same attempt would be counted twice, on the turn and therefore on the
 * record's derived total.
 *
 * INVARIANT: one attempt's measurement is folded AT MOST ONCE, whichever way
 * the attempt leaves.
 */
export type TurnAttempt = { cost: TurnCost | null; folded: boolean }

/**
 * The environment the cost meter is allowed to read for its partner-platform
 * detection: the one the process that ACTUALLY RUNS the agent will see, and
 * nothing else.
 *
 * On the host that is `agentEnv`'s narrowed environment (or ours when the
 * command is a custom one that inherits everything).
 *
 * IN THE CAGE it is `CAGE_FORWARDED_ENV` and only that: the container gets
 * those variables by name and nothing more. Reading the host's environment
 * there would be reading variables the agent never sees — an operator with
 * `CLAUDE_CODE_USE_BEDROCK` exported for some other tool would have every
 * caged turn declared "partner platform" and stripped of its cost, while the
 * agent inside was in fact billing first-party. The model-SHAPE signal
 * (`PARTNER_SHAPES`) stays active on both paths and is what actually catches a
 * real Bedrock or Vertex run, because the ids come back on the stream itself.
 *
 * Deriving the cage's set from `CAGE_FORWARDED_ENV` rather than hard-coding an
 * exclusion keeps this honest: the day those variables are genuinely forwarded,
 * detection resumes by itself.
 */
export function costRunEnv(
  caged: boolean,
  command: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!caged) {
    return agentEnv(command, source) ?? source
  }
  const env: NodeJS.ProcessEnv = {}
  for (const name of CAGE_FORWARDED_ENV) {
    const value = source[name]
    if (value !== undefined) {
      env[name] = value
    }
  }
  return env
}

export type TaskTurnOutcome =
  | {
      kind: 'done'
      response: string
      sessionId: string | null
      tokens: number
      /**
       * What the turn cost and WHERE the figure comes from, or null when
       * UNKNOWN — which is never 0.
       */
      cost: TurnCost | null
      /** First turn only: the branch name the agent proposed for the task. */
      branchProposal?: string
    }
  | {
      kind: 'question'
      response: string
      question: string
      sessionId: string | null
      tokens: number
      /**
       * What the turn cost and WHERE the figure comes from, or null when
       * UNKNOWN — which is never 0.
       */
      cost: TurnCost | null
      /** First turn only: the branch name the agent proposed for the task. */
      branchProposal?: string
    }

export type RunTaskTurnOptions = {
  /** The task's worktree, not the main repo. */
  cwd: string
  task: TaskRecord
  /** Full prompt for this turn, already composed (preamble + user message). */
  prompt: string
  /** Raw configured agent command; per-turn flags are added here. */
  command: string
  /** Last-resort absolute ceiling of the turn; the watchdog is what detects a dead one. */
  timeoutMs: number
  /** Watchdog budgets (D3), applied to the host path AND to the caged one; D3 defaults when absent. */
  watchdog?: WatchdogBudgets | undefined
  /** Liveness beat of the running agent, one per heartbeat period. */
  onHeartbeat?: ((beat: AgentHeartbeat) => void) | undefined
  signal?: AbortSignal
  /** Journal sink: the caller appends to the store and broadcasts. */
  onEvent: (event: AppendTaskEventInput) => void
  /**
   * One streamed agent message (SSE only, never persisted): `text` is
   * cumulative WITHIN the message, `seq` is its index in the turn. Providers
   * without a message-aware stream deliver everything as message 0.
   */
  onText?: (text: string, seq: number) => void
  /** Cumulative token count of the turn (SSE live meter; final value persisted on the turn). */
  onTokens?: (total: number) => void
  /**
   * Best cost known for the turn SO FAR, with its provenance, republished at
   * every change (`null` when nothing is claimable any more). Published as it
   * accrues rather than only at the end, so a caller can persist what a turn
   * had already spent when it was killed — an interrupted turn's cost is not
   * lost, it is simply a lower bound.
   */
  onCost?: (cost: TurnCost | null) => void
  runAgentFn?: (options: AgentRunOptions) => Promise<string>
  /** Egress allowlist of the cage (container isolation only). */
  allowedDomains?: readonly string[] | undefined
  /** Repo checks config: the base image of the cage falls back to it. */
  checksConfig?: ChecksConfig | null | undefined
  /** Test seam for the caged path; the default drives real containers. */
  runContainerTurnFn?: (options: RunContainerTurnOptions) => Promise<string>
  /** Test seam for the repo's worktree lock; the default takes the real one. */
  worktreeLockFn?: WorktreeLockFn | undefined
}

/**
 * Runs one agent turn and reports what happened through events. The command
 * carries the stream-json flags itself, so runAgent's own claude parsing
 * stays off (it bails on an explicit --output-format) and onText delivers the
 * raw cumulative JSONL: the task parser is fed the delta of each update.
 */
export async function runTaskTurn(opts: RunTaskTurnOptions): Promise<TaskTurnOutcome> {
  const run = opts.runAgentFn ?? runAgent
  const session: TaskSession | null = supportsSessionResume(opts.command)
    ? opts.task.agent_session_id
      ? { kind: 'resume', id: opts.task.agent_session_id }
      : { kind: 'new', id: randomUUID() }
    : null
  // The isolation is fixed on the record at creation: 'container' turns run
  // inside the task's own box (full agent tools, the cage is the guarantee),
  // everything else keeps the host path with its policy hardening.
  const caged = opts.task.isolation === 'container'
  const command = caged
    ? containerTaskCommandFor(opts.command, { session })
    : taskCommandFor(opts.command, { session })

  opts.onEvent({
    type: 'turn_started',
    data: { turn: opts.task.turns.length, prompt: preview(opts.prompt) },
  })

  let sessionId: string | null = null
  if (session) {
    sessionId = session.id
  }
  let tokens = 0
  // Absence is the honest default: a turn whose cost was never established
  // carries none, and no reader may read that as "it was free".
  let cost: TurnCost | null = null
  // The price table is read at the instant the TURN started, never at "now":
  // a turn is billed at the rate that was in force while it ran. The turn was
  // appended by the caller before this runs, so its stamp is already on the
  // record — and when it is not, the answer is an EMPTY stamp that prices
  // nothing and says so, never a clock reading that would quietly bill the
  // turn at today's rate.
  const startedAt = opts.task.turns.at(-1)?.started_at ?? ''
  const parser = emitsClaudeStreamJson(command)
    ? createClaudeTaskParser(
        {
          onInit: (id) => {
            sessionId = id
          },
          onToolUse: (name, input) => opts.onEvent({ type: 'tool_use', data: { name, input } }),
          onToolResult: (summary) => opts.onEvent({ type: 'tool_result', data: { summary } }),
          ...(opts.onText ? { onText: opts.onText } : {}),
          onTokens: (total) => {
            tokens = total
            opts.onTokens?.(total)
          },
          // The meter republishes at every change, `null` included: the last
          // thing it said is what this turn can honestly claim.
          onCost: (settled) => {
            cost = settled
            opts.onCost?.(settled)
          },
          onCostDegraded: (degradation) => opts.onEvent(costEvent(degradation)),
        },
        { at: startedAt, env: costRunEnv(caged, command) },
      )
    : null
  let fed = 0
  // Both paths deliver the SAME cumulative stdout, so the stream-json parser
  // is fed identically whether the agent ran on the host or in its box.
  const onText = (text: string): void => {
    if (parser) {
      parser.push(text.slice(fed))
      fed = text.length
    } else {
      // No stream-json: the raw stdout is one growing blob with no message
      // boundary to read — it is message 0, forever.
      opts.onText?.(text, 0)
    }
  }
  const budgets = opts.watchdog ?? AGENT_WATCHDOG_DEFAULTS
  // A ceiling BELOW the watchdog budgets would cancel the watchdog outright —
  // the shipped default was a 900 s ceiling under a 1 800 s inactivity budget,
  // so a live task still died of the wall clock at 15 min and a dead one still
  // never named itself. The turn's ceiling is therefore raised, never lowered,
  // to sit above the largest budget plus the whole kill escalation.
  const absoluteCapMs = effectiveAbsoluteCapMs(opts.timeoutMs, budgets)
  const raw = caged
    ? await (opts.runContainerTurnFn ?? runContainerTurn)({
        taskId: opts.task.id,
        worktree: opts.cwd,
        command,
        prompt: opts.prompt,
        timeoutMs: absoluteCapMs,
        watchdog: budgets,
        ...(opts.onHeartbeat ? { onHeartbeat: opts.onHeartbeat } : {}),
        ...(opts.allowedDomains ? { allowedDomains: opts.allowedDomains } : {}),
        ...(opts.checksConfig !== undefined ? { checksConfig: opts.checksConfig } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        onText,
      })
    : await run({
        command,
        prompt: opts.prompt,
        cwd: opts.cwd,
        absoluteCapMs,
        env: agentEnv(command),
        watchdog: budgets,
        ...(opts.onHeartbeat ? { onHeartbeat: opts.onHeartbeat } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        onText,
      })
  // The resolved value is the full stdout: replay whatever onText never saw
  // (an injected runAgentFn may resolve without streaming at all).
  if (parser && raw.length > fed) {
    parser.push(raw.slice(fed))
  }
  const full = (parser ? (parser.finalText() ?? raw) : raw).trim()
  // Parsed exactly where the prompt asked for it: the FIRST turn of a forked
  // task. Anywhere else (later turns, work-on conversations) a reply opening
  // with 'BRANCH:' was never protocol and stays plain prose in the response.
  const asked = opts.task.turns.length <= 1 && !opts.task.work_on
  const proposal = asked ? parseTaskBranchProposal(full) : null
  const response = proposal ? proposal.rest : full
  const branch = proposal?.name ? { branchProposal: proposal.name } : {}

  const question = parseTaskQuestion(response)
  if (question) {
    opts.onEvent({ type: 'question', data: { question: preview(question) } })
    return { kind: 'question', response, question, sessionId, tokens, cost, ...branch }
  }
  opts.onEvent({ type: 'message', data: { text: preview(response) } })
  return { kind: 'done', response, sessionId, tokens, cost, ...branch }
}

export type TaskActionResult = { ok: true } | { ok: false; code: number; error: string }

/**
 * The turn a RESUME would re-run (T8), or null when there is none. A task is
 * only resumable when it is 'interrupted' AND its last turn never delivered a
 * reply: that turn's agent process died mid-flight (crash, shutdown) or never
 * started (queued at drain time), so re-running the very same instruction is
 * exactly what picks the work back up.
 *
 * A last turn that DID answer means the opposite: the agent finished and the
 * human interrupted from 'waiting_for_you'. There is nothing to redo — only a
 * new instruction moves that conversation, so the UI offers the composer
 * instead of a Resume button that would silently repeat a finished turn.
 *
 * The CONTEXT of the re-run always exists: the instruction is on the turn, and
 * composeTurnPrompt either resumes the provider session (agent_session_id) or
 * replays the transcript from the record's own turns.
 */
export function pendingResumeTurn(record: TaskRecord): TaskTurn | null {
  if (record.status !== 'interrupted') {
    return null
  }
  const turn = record.turns.at(-1)
  return turn && turn.response === null ? turn : null
}

/** Store/broadcast toolkit handed to the end-of-turn review hook. */
export type TaskTurnIo = {
  /** Appends to the journal and broadcasts (store write first). */
  emit: (input: AppendTaskEventInput) => void
  /** Persists the (mutated) record with a fresh updated_at, then broadcasts it. */
  persist: () => void
  /**
   * SSE-only progress line on the task_text channel; never persisted. Sent
   * WITHOUT a message index on purpose: this is a status line that replaces
   * the previous one, not a message added to a conversation.
   */
  text: (text: string) => void
}

/**
 * End-of-turn review hook (T4). Called after a successful 'done' turn, once
 * the runner committed the worktree and persisted the task as 'reviewing'.
 * The hook owns the final transition (it must leave the task on
 * 'review_ok'/'review_ko' via io.persist) and never rejects by contract; the
 * runner still guards against a bug with a review_ko fallback.
 */
export type TaskTurnReviewFn = (record: TaskRecord, io: TaskTurnIo) => Promise<void>

/**
 * Shared concurrency budget. One pool can back several runners (the
 * multi-project workspace: one runner per repo, ONE global cap): `running`
 * holds the task ids currently occupying a slot across all of them, and
 * freeing a slot wakes every registered pump so any runner's queue may win
 * the slot.
 */
export type TaskSlotPool = {
  max: number
  running: Set<string>
  pumps: Set<() => void>
}

export function createTaskSlotPool(max: number): TaskSlotPool {
  return { max, running: new Set(), pumps: new Set() }
}

export type TaskRunnerOptions = {
  /** Main repo root: the store and the worktrees live under its .codesema/. */
  cwd: string
  /** Raw configured agent command. */
  command: string
  /** Last-resort absolute ceiling of a turn; the watchdog is what detects a dead one. */
  timeoutMs: number
  /**
   * Watchdog budgets (D3) handed to every turn, host and caged alike; the D3
   * defaults apply when absent.
   *
   * TODO(T1.4): resolved ONCE at boot from the launch repo and shared by every
   * project — per-project config resolution is T1.4's job.
   */
  watchdog?: WatchdogBudgets | undefined
  /** Cap of this runner's own pool; ignored when `slots` is provided. */
  maxParallel?: number
  /** Shared slot pool (global cap across runners); defaults to a private pool of maxParallel. */
  slots?: TaskSlotPool
  /** Broadcast hooks, called AFTER the corresponding store write. */
  onTask?: (record: TaskRecord) => void
  onEvent?: (taskId: string, event: TaskEvent) => void
  /**
   * Live text of the task. `seq` present: the agent's message of that index in
   * the running turn (bubbles that ACCUMULATE client-side). `seq` absent: a
   * bare progress line of whatever else streams on that channel — the
   * end-of-turn review (TaskTurnIo.text) — which replaces the previous one.
   */
  onText?: (taskId: string, text: string, seq?: number) => void
  /** Live token meter of the in-flight turn (SSE only; the final count lands on the turn). */
  onTokens?: (taskId: string, total: number) => void
  runAgentFn?: (options: AgentRunOptions) => Promise<string>
  /** Egress allowlist handed to every caged turn of this repo. */
  allowedDomains?: readonly string[] | undefined
  /** Repo checks config (base image fallback of the cage). */
  checksConfig?: ChecksConfig | null | undefined
  /** Test seam for the caged path; the default drives real containers. */
  runContainerTurnFn?: (options: RunContainerTurnOptions) => Promise<string>
  /** Test seam for the repo's worktree lock; the default takes the real one. */
  worktreeLockFn?: WorktreeLockFn | undefined
  /**
   * Automatic end-of-turn review (T4). When set, a successful 'done' turn
   * parks the task on 'reviewing' (post-commit) and hands it to this hook,
   * which owns the 'review_ok'/'review_ko' transition; when absent, the turn
   * lands directly on 'waiting_for_you'. Question turns never trigger it.
   */
  onTurnDone?: TaskTurnReviewFn
}

export type TaskRunner = {
  /** Enqueues a 'queued' task; runs it now if a slot is free. */
  start: (task: TaskRecord) => TaskActionResult
  /** Answers a 'waiting_for_you' task: appends a turn and schedules it. */
  reply: (taskId: string, message: string) => TaskActionResult
  /**
   * T8. Picks an 'interrupted' task back up WITHOUT a new instruction: the
   * turn that never finished is re-scheduled as it stands (same prompt, same
   * turn index), so the conversation continues instead of branching. Refused
   * (409) on any other status and on a task with no unfinished turn to re-run.
   * A worktree that vanished is rebuilt, not refused: reply() rebuilds it too,
   * and an affordance the UI offers must not be one that can only 409.
   */
  resume: (taskId: string) => TaskActionResult
  /** SIGTERM to the agent's process group (running) or drops the task from the queue. */
  interrupt: (taskId: string) => TaskActionResult
  /**
   * Deletes the worktree AND the branch, marks the task 'failed'. Refused
   * while running, and while another abandon of the same task is in flight.
   * NEVER rejects: a cleanup that could not happen comes back as a result,
   * because the HTTP layer that dispatches it does not catch.
   */
  abandon: (taskId: string) => Promise<TaskActionResult>
  /**
   * True while an abandon of this task is between its worktree removal and its
   * record write. Published because that window belongs to the layer above too:
   * ship() must refuse during it exactly as abandon() refuses during a ship
   * (task-server.ts) — otherwise the two settle in either order and the loser
   * writes the record last.
   */
  isAbandoning: (taskId: string) => boolean
  /**
   * Graceful process exit: aborts every running agent, persists 'interrupted'
   * with an event {reason:'shutdown'} (queued tasks included — a 'queued'
   * record with no live process would be unstartable at next boot), keeps the
   * worktrees, and resolves once every in-flight turn AND every in-flight
   * abandon has settled on disk.
   */
  shutdown: () => Promise<void>
  runningCount: () => number
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Folds ONE attempt's measurement into the turn, then RECOMPUTES the record's
 * total from the turns it actually carries. The total is derived, never
 * incremented, so it can only ever equal the sum of its terms — and it comes
 * with its coverage (`cost_turns`) and its provenance (`cost_basis`), because
 * a total whose reader cannot tell how complete or how authoritative it is
 * says nothing useful.
 *
 * The SAME rule applies whether the attempt finished or died (see
 * `foldTurnCost`): a `resume()` re-runs the very turn a Ctrl-C cut short, so
 * an attempt that measured nothing must never erase what an earlier one
 * recorded, and an attempt that measured something adds to it.
 *
 * A task not one of whose turns could be priced keeps no total at all —
 * unknown, not zero.
 */
function accrueCost(
  record: TaskRecord,
  turn: TaskTurn | undefined,
  cost: TurnCost | null,
  onDegraded?: (degradation: CostDegradation) => void,
): void {
  if (turn) {
    const folded = foldTurnCost(turnCostOf(turn), cost)
    if (folded.kind === 'set') {
      turn.cost_ticks = folded.cost.ticks
      turn.cost_basis = folded.cost.basis
    } else if (folded.kind === 'unrepresentable') {
      // The turn keeps what it had — replacing it with a wrong number would be
      // worse — but nothing downstream can notice on its own (the turn still
      // carries a usable figure, so the record total stays an ordinary total).
      // Saying it here is the only place it gets said.
      onDegraded?.({
        cause: 'turn_unrepresentable',
        keptTicks: folded.kept.ticks,
        droppedTicks: folded.dropped.ticks,
      })
    }
  }
  const total = totalCost(record.turns)
  if (total.kind === 'total') {
    record.cost_ticks = total.ticks
    record.cost_turns = total.turns
    record.cost_basis = total.basis
    return
  }
  // Nothing to state: the fields go rather than carry a stale total.
  delete record.cost_ticks
  delete record.cost_turns
  delete record.cost_basis
  if (total.kind === 'unrepresentable') {
    // NOT the same thing as an unpriced task, and it must not look like one:
    // there ARE figures, their sum simply does not fit an exact integer.
    onDegraded?.({ cause: 'total_unrepresentable', turns: total.turns })
  }
}

/**
 * The branch a rebuild had to leave behind, and why. Only ever set when the
 * conversation could NOT go back to its own branch: `in_use` means git refused
 * (checked out elsewhere) and `commits` counts what stays there, `gone` means
 * the branch was deleted and there is nothing left to point at.
 */
type StrandedBranch = { branch: string; reason: 'in_use' | 'gone'; commits: number }

/** Transcript replay for providers without session resume (one-shot turns). */
function transcript(record: TaskRecord): string {
  const parts = ['Previous turns of this task:']
  for (const [i, turn] of record.turns.slice(0, -1).entries()) {
    parts.push(`[turn ${i + 1}] instruction: ${turn.prompt}`)
    if (turn.response) {
      parts.push(`[turn ${i + 1}] your reply: ${turn.response}`)
    }
  }
  return parts.join('\n')
}

/**
 * First turn: standing instructions + the task prompt. Later turns: claude
 * resumes its session so the reply alone is enough; other providers get a
 * one-shot run with the transcript replayed.
 */
function composeTurnPrompt(record: TaskRecord, command: string): string {
  const message = record.turns.at(-1)?.prompt ?? ''
  if (record.turns.length <= 1) {
    // A work-on conversation is not asked to name anything: it works on the
    // user's own pre-existing branch, which is never renamed.
    return `${buildTaskPrompt(record, { askBranchName: !record.work_on })}\n\n${message}`
  }
  if (supportsSessionResume(command) && record.agent_session_id) {
    return message
  }
  return [buildTaskPrompt(record), '', transcript(record), '', `New instruction: ${message}`].join(
    '\n',
  )
}

export function createTaskRunner(opts: TaskRunnerOptions): TaskRunner {
  const pool = opts.slots ?? createTaskSlotPool(opts.maxParallel ?? DEFAULT_MAX_PARALLEL_TASKS)
  const active = new Map<string, AbortController>()
  /** Turn promises of active tasks: shutdown() awaits them so every abort is persisted. */
  const inflight = new Map<string, Promise<void>>()
  /** Once shutting down: aborts get the {reason:'shutdown'} event, pump() stops launching. */
  let draining = false
  /** Task ids waiting for a slot, FIFO. Their records stay 'queued' on disk. */
  const queue: string[] = []
  /** Entry time into waiting_for_you; updated_at is the cross-restart fallback. */
  const waitingSince = new Map<string, number>()

  const persist = (record: TaskRecord): void => {
    // saveTask writes verbatim: bumping updated_at here keeps the listTasks
    // activity sort honest on every transition.
    record.updated_at = new Date().toISOString()
    saveTask(opts.cwd, record)
    opts.onTask?.(record)
  }

  /**
   * Liveness beat of a RUNNING turn: `heartbeat_at` only, deliberately not
   * `updated_at` — a beat says the agent is alive, not that anything happened,
   * and the activity sort must not be reordered by a task that is merely
   * breathing. One small atomic write per period per running task, and one SSE
   * frame, which is what lets the UI tell a LONG task from a DEAD one; a
   * journal line every 30 s would grow events.jsonl without ever saying
   * anything new.
   */
  const beat = (record: TaskRecord): void => {
    record.heartbeat_at = new Date().toISOString()
    saveTask(opts.cwd, record)
    opts.onTask?.(record)
  }

  const emit = (id: string, input: AppendTaskEventInput): void => {
    const event = appendTaskEvent(opts.cwd, id, input)
    opts.onEvent?.(id, event)
  }

  const accrueWait = (record: TaskRecord): void => {
    const since = waitingSince.get(record.id) ?? Date.parse(record.updated_at)
    if (Number.isFinite(since)) {
      record.wait_ms += Math.max(0, Date.now() - since)
    }
    waitingSince.delete(record.id)
  }

  /** The runner, not the agent, commits the turn: deterministic and provider-agnostic. */
  const commitTurn = (record: TaskRecord): void => {
    const dirty = tryGit(['status', '--porcelain'], record.worktree)
    if (!dirty || !dirty.trim()) {
      return
    }
    const filesChanged = dirty.trim().split('\n').length
    try {
      git(['add', '-A'], record.worktree)
      git(
        ['commit', '-m', `task(${record.id}): ${record.title} — turn ${record.turns.length}`],
        record.worktree,
      )
    } catch (err) {
      // A failed commit (missing git identity, hook failure) degrades to an
      // error event: the work is still in the worktree, the turn succeeded.
      emit(record.id, { type: 'error', data: { message: preview(errorMessage(err)) } })
      return
    }
    const sha = tryGit(['rev-parse', 'HEAD'], record.worktree)
    if (sha) {
      // Where the conversation leaves its branch. A rebuild compares the tip it
      // finds against this one: equal means "as I left it", different means
      // somebody else wrote on the branch while the worktree was gone — the
      // anchor cannot tell those apart, since foreign commits land AFTER it and
      // leave it a perfectly valid ancestor.
      record.head_sha = sha
    }
    emit(record.id, {
      type: 'commit',
      data: { sha: sha ?? '', files_changed: filesChanged, turn: record.turns.length },
    })
  }

  /**
   * Turn 1 only: adopt the branch name the agent proposed for itself, BEFORE
   * the commit, the review and the checks — everything downstream then sees a
   * single name. Never for a work-on task (that branch is the user's, the
   * prompt never even asks) and never past a push (renameTaskBranch refuses a
   * published branch). Any refusal is a silent no-op: the task keeps the slug
   * of its title, which is exactly the behaviour that existed before.
   */
  const adoptBranchProposal = (record: TaskRecord, outcome: TaskTurnOutcome): void => {
    if (!outcome.branchProposal || record.work_on || record.turns.length > 1) {
      return
    }
    const renamed = renameTaskBranch(opts.cwd, record.id, record.branch, outcome.branchProposal)
    if (!renamed) {
      return
    }
    record.branch = renamed
    // Broadcast right away: the UI reads record.branch for the Diff tab and
    // for the ship, and the rest of the turn already runs on the new name.
    persist(record)
  }

  /**
   * Folds an attempt's cost onto the turn, exactly once (see TurnAttempt).
   * Both exit paths go through here and no other place writes a turn's cost.
   */
  const foldAttemptCost = (
    record: TaskRecord,
    turn: TaskTurn | undefined,
    attempt: TurnAttempt | undefined,
  ): void => {
    if (attempt?.folded) {
      return
    }
    if (attempt) {
      attempt.folded = true
    }
    accrueCost(record, turn, attempt?.cost ?? null, (d) => emit(record.id, costEvent(d)))
  }

  const finishTurn = (
    record: TaskRecord,
    outcome: TaskTurnOutcome,
    startedAt: number,
    attempt?: TurnAttempt,
  ): void => {
    record.work_ms += Date.now() - startedAt
    adoptBranchProposal(record, outcome)
    record.agent_session_id = outcome.sessionId ?? record.agent_session_id
    const turn = record.turns.at(-1)
    if (turn) {
      turn.response = outcome.response || null
      turn.question = outcome.kind === 'question' ? outcome.question : null
      turn.ended_at = new Date().toISOString()
      if (outcome.tokens > 0) {
        turn.tokens = outcome.tokens
      }
    }
    // `attempt.cost` and `outcome.cost` are the same last publication of the
    // same meter; the attempt carries it so the failure path can fold the same
    // figure — or, having seen it folded here, decline to fold it again.
    foldAttemptCost(record, turn, attempt ?? { cost: outcome.cost, folded: false })
    if (outcome.kind === 'done') {
      commitTurn(record)
      if (opts.onTurnDone) {
        // T4: the automatic review owns the final transition. The runner slot
        // frees when this function returns (the review agent runs outside the
        // maxParallel cap — only 'running' tasks count against it).
        record.status = 'reviewing'
        persist(record)
        const io: TaskTurnIo = {
          emit: (input) => emit(record.id, input),
          persist: () => persist(record),
          text: (text) => opts.onText?.(record.id, text),
        }
        void opts.onTurnDone(record, io).catch((err: unknown) => {
          // The reviewer never rejects by contract; a bug there must not
          // strand the task on 'reviewing' (unreplyable, uninterruptible).
          emit(record.id, { type: 'error', data: { message: preview(errorMessage(err)) } })
          record.status = 'review_ko'
          persist(record)
        })
        return
      }
    }
    // Both outcomes wait for the human (answer the question, or decide what's
    // next: reply, ship).
    record.status = 'waiting_for_you'
    waitingSince.set(record.id, Date.now())
    persist(record)
  }

  const failTurn = (
    record: TaskRecord,
    err: unknown,
    startedAt: number,
    /** How the turn died, and the attempt that died. */
    death: { aborted: boolean; attempt?: TurnAttempt },
  ): void => {
    const { aborted } = death
    record.work_ms += Date.now() - startedAt
    const turn = record.turns.at(-1)
    if (turn && !turn.ended_at) {
      turn.ended_at = new Date().toISOString()
    }
    // A turn that was killed still SPENT what it had spent. The meter's last
    // published figure is folded onto the turn with its own basis: dropping it
    // would report a cut turn as free, which is the one reading this field
    // must never allow. Same fold as the success path — an attempt that
    // measured nothing erases nothing — and at most once per attempt, since a
    // finishTurn that folded and THEN threw lands right here. It happens
    // BEFORE any branching, so the watchdog's exit folds exactly like the
    // others: no exit path of this function may leave a turn's spend unwritten.
    foldAttemptCost(record, turn, death.attempt)
    // A run the semantic watchdog cut is NOT a dead end: `inactivity_timeout`
    // is RETRYABLE in D2 — what has to change is the run or its environment,
    // never the work on the branch — so the task lands on 'interrupted', which
    // both reply() and resume() accept, with its worktree and its commits
    // intact. 'failed' is terminal and would cost the user the whole turn. The
    // code is read BEFORE `aborted` on purpose: a human hitting Stop during the
    // kill escalation is reacting to the cut, not causing it.
    const watchdogCode = agentReasonCode(err)
    if (watchdogCode) {
      record.status = 'interrupted'
      const message = preview(errorMessage(err))
      emit(record.id, { type: 'interrupted', data: { message }, reason_code: watchdogCode })
      record.reason = taskReason(watchdogCode, message)
    } else if (aborted) {
      record.status = 'interrupted'
      // An abort is always a human stopping this task: Ctrl-C on the workspace
      // (draining) or the interrupt button. The payload stays EXACTLY what it
      // has always been — the code rides in its own field next to it — and the
      // record restates the same thing, the readable message in `detail`.
      const message = draining ? 'shutdown' : preview(errorMessage(err))
      emit(record.id, {
        type: 'interrupted',
        data: draining ? { reason: 'shutdown' } : { message },
        reason_code: 'interrupted_by_user',
      })
      record.reason = taskReason('interrupted_by_user', message)
    } else {
      const message = preview(errorMessage(err))
      // Some failures name their own degradation (the repo's worktree lock
      // giving up says `resource_busy`). The code rides in its own field, the
      // payload stays exactly what it always was, and the record restates the
      // pair — an unnamed failure still lands as a plain error, as before.
      const code = reasonCodeOf(err)
      // A RETRYABLE degradation must never land on a status nothing can pick
      // back up: 'failed' is terminal and offers no resume, while the whole
      // point of `terminal: false` is that the same operation, attempted
      // later, can genuinely succeed. Same argument as the abort path above.
      const retryable = code !== null && !isTerminalReason(code)
      record.status = retryable ? 'interrupted' : 'failed'
      emit(record.id, {
        // The event names the same outcome as the status. A task parked on
        // 'interrupted' — with a resume affordance — announced by an 'error'
        // event would make the timeline and the badge disagree, and the web
        // mirror renders the two from the same stream.
        type: retryable ? 'interrupted' : 'error',
        data: { message },
        ...(code ? { reason_code: code } : {}),
      })
      if (code) {
        record.reason = taskReason(code, message)
      }
    }
    // The worktree is deliberately left alone on every one of these paths
    // (T1.6): the branch and whatever the agent had written before it stopped
    // are the only account of what happened.
    persist(record)
  }

  /**
   * Where this conversation's work is measured FROM, decided at materialization
   * and stated whenever it moves.
   *
   * The discriminant for "first materialization" is `record.worktree === ''`,
   * and it is the only honest one available: an empty worktree PROVES no work
   * can be on the branch, because the branch does not exist yet. The turn list
   * cannot answer that question — `ended_at` is stamped on the open turn of a
   * task that never ran at all (a graceful shutdown while it was still
   * `queued`, an interrupt during materialization), and `reply()` is the
   * documented way to pick exactly those back up.
   *
   * The anchor is write-once PER LINEAGE. Within one lineage — the same branch,
   * rebuilt — it never moves: the tip already carries the turns that ran, and a
   * fresh anchor would quietly drop them out of every diff measured from it.
   * A rebuild NORMALLY stays in its lineage, because ensureWorktree takes the
   * conversation's own branch back. Only when that is impossible (the branch is
   * checked out elsewhere, or was deleted) does a fresh branch get forged: that
   * one IS a new lineage — keeping the old anchor would attribute to the agent
   * every commit the base gained meanwhile — so the anchor moves with it, and
   * the change of branch is announced whether or not the anchor moved.
   *
   * A record that arrives with NO anchor and a worktree it already had (a 0.12
   * conversation resumed) gets none: anchoring on a branch that already carries
   * work would put that work behind the baseline and out of the review. It
   * keeps falling back on `base...HEAD`, out loud.
   *
   * The uncommitted files of the MAIN repo never travel into the worktree —
   * a task must not publish the human's private work in progress — and that is
   * said ONCE, on the turn that materializes, not on every turn.
   */
  const anchorConversation = (
    record: TaskRecord,
    wt: TaskWorktree,
    lineage: { first: boolean; fresh: StrandedBranch | null },
  ): void => {
    if (wt.created_branch) {
      // Once true, always true: the conversation created this head, whatever a
      // later re-materialization happens to find.
      record.created_branch = true
    }
    // Where this materialization leaves the branch. Written on every path, so
    // the NEXT rebuild can compare instead of guessing (see head_sha).
    record.head_sha = wt.baseline
    if (lineage.fresh) {
      // UNCONDITIONAL: a conversation that changes branch has to say so even
      // when the base has not moved an inch — the branch under it changed,
      // which is the part the human cannot see and cannot guess. Saying it only
      // when the baseline moved was silence on the common case.
      const moved =
        record.baseline_sha !== undefined && record.baseline_sha !== wt.baseline
          ? ` the baseline moved with it (${record.baseline_sha.slice(0, 12)} → ${wt.baseline.slice(0, 12)});`
          : ''
      const left =
        lineage.fresh.reason === 'gone'
          ? `the branch ${lineage.fresh.branch} that carried the earlier turns no longer exists, so their commits are not in this worktree`
          : `the branch ${lineage.fresh.branch} that carried the earlier turns is checked out elsewhere and could not be taken back, so ${lineage.fresh.commits} commit(s) stay there — nothing deletes that branch, but this worktree does not carry them`
      emit(record.id, {
        type: 'message',
        data: {
          text: `worktree rebuilt on a FRESH fork of ${record.base} (branch ${wt.branch}):${moved} ${left}`,
          ...(lineage.fresh.reason === 'in_use'
            ? { stranded_branch: lineage.fresh.branch, stranded_commits: lineage.fresh.commits }
            : {}),
        },
      })
    }
    if (record.baseline_sha !== undefined) {
      if (lineage.fresh && record.baseline_sha !== wt.baseline) {
        record.baseline_sha = wt.baseline
      }
      return
    }
    if (!lineage.first) {
      emit(record.id, {
        type: 'message',
        data: {
          // Deliberately does NOT name a branch: on a rebuilt fork the record
          // already carries the FRESHLY forged name, not the one that carried
          // the earlier turns. What is true in every case is that this
          // conversation had materialized before.
          text: `no baseline was recorded for this conversation and it had already materialized before: anchoring one now could hide the work its earlier turns left behind, so the review keeps measuring ${record.base}...HEAD`,
        },
      })
      return
    }
    record.baseline_sha = wt.baseline
    if (wt.uncommitted_files > 0) {
      // In work-on mode `base` is the MR target, NOT what the sha belongs to:
      // labelling the branch tip with the target's name would name the wrong
      // thing entirely.
      const startedFrom = record.work_on ? record.branch : record.base
      emit(record.id, {
        type: 'message',
        data: {
          text: `${wt.uncommitted_files} uncommitted file(s) in the main repository are NOT carried into the task worktree: the agent starts from ${startedFrom}@${wt.baseline.slice(0, 12)}`,
          uncommitted_files: wt.uncommitted_files,
        },
      })
    }
  }

  /**
   * The repo lock was taken from a holder whose pid was still alive (the
   * pid-recycling valve of worktree-lock.ts). Rare, and never inferred later
   * from a mangled index: it is named where the human reads the task, with the
   * retryable code that says another process was involved.
   */
  const reportLockSteal = (taskId: string, stolen: { pid: number; age_ms: number }): void => {
    emit(taskId, {
      type: 'error',
      data: {
        message: `repo worktree lock taken from pid ${stolen.pid}, which had held it for ${Math.round(stolen.age_ms / 1000)}s (assumed a recycled pid, not a live holder)`,
      },
      reason_code: 'resource_busy',
    })
  }

  /**
   * The branch came back with commits this conversation never made. Silence
   * here is the exact mirror of the silence that losing them would be: the
   * anchor cannot catch it (a third party's commits land AFTER the baseline and
   * leave it a valid ancestor), so `baseline..HEAD` would present someone
   * else's work as the agent's — measured by the review, published by the ship.
   * The conversation keeps the branch, because that is where its own work is,
   * and says what it found.
   */
  const reportForeignCommits = (record: TaskRecord, wt: TaskWorktree): void => {
    const left = record.head_sha
    if (!left || left === wt.baseline) {
      return
    }
    const ahead = Number.parseInt(
      tryGit(['rev-list', '--count', `${left}..${wt.baseline}`], opts.cwd) ?? '',
      10,
    )
    const text =
      ahead > 0
        ? `${ahead} commit(s) landed on ${record.branch} from outside this conversation while its worktree was gone (${left.slice(0, 12)} → ${wt.baseline.slice(0, 12)}): they sit after the baseline, so the review measures them as part of this task`
        : `${record.branch} was rewritten while this conversation's worktree was gone (${left.slice(0, 12)} → ${wt.baseline.slice(0, 12)}): the commits its earlier turns made may no longer be on it`
    emit(record.id, {
      type: 'message',
      data: { text, foreign_head: wt.baseline, foreign_commits: ahead > 0 ? ahead : 0 },
    })
  }

  const ensureWorktree = async (record: TaskRecord, signal: AbortSignal): Promise<void> => {
    if (record.worktree && existsSync(record.worktree)) {
      return
    }
    // No worktree ever named on this record = nothing can be on its branch yet.
    const first = record.worktree === ''
    if (record.work_on) {
      // Work-on task (POST /api/tasks branch=…): the conversation identifies
      // with its pre-existing branch — check the branch itself out, first
      // materialization and re-materialization alike. record.base already
      // holds the MR target (set by the server at creation): never overwrite
      // it, and a branch deleted or checked out elsewhere in the meantime
      // fails the turn with a readable error instead of forking a substitute.
      const wt = await createTaskWorktree(opts.cwd, record.id, record.title, {
        branch: record.branch,
        signal,
        ...(opts.worktreeLockFn ? { lockFn: opts.worktreeLockFn } : {}),
      })
      record.worktree = wt.worktree
      if (wt.lock_stolen) {
        reportLockSteal(record.id, wt.lock_stolen)
      }
      // A work-on branch is the USER's: teammates pushing to it between two
      // turns is ordinary, and all the more reason to name what came back.
      reportForeignCommits(record, wt)
      // Same branch, same history: the lineage is never fresh here.
      anchorConversation(record, wt, { first, fresh: null })
      return
    }
    // A base set BEFORE the first materialization (worktree still empty) is an
    // explicit request (POST /api/tasks base=…): honor it — a deleted branch
    // fails the turn rather than silently branching from somewhere else. Once
    // a worktree existed, base may hold a DETECTED ref (possibly remote, e.g.
    // 'origin/main'), so re-materialization keeps the auto-detection path.
    // REBUILD of a fork: the conversation goes back to its OWN branch, exactly
    // the way a work-on conversation does. That branch is where every commit
    // its earlier turns made still lives; forking a fresh one beside it would
    // leave that work referenced by nothing — out of `baseline..HEAD`, out of
    // the review, out of the ship, and not even deleted by an abandon (which
    // only knows the record's current branch). Adopting keeps the lineage, the
    // anchor and the work in one piece.
    let stranded: StrandedBranch | null = null
    if (!first && record.branch) {
      // `^{commit}` is not decoration: `rev-parse --verify` answers for a REF,
      // not for the object it points at, so a ref left dangling by a partial
      // clone or an interrupted fetch would pass this gate, fail the
      // `worktree add` underneath it with a raw (and locale-dependent) git
      // error, and drop the whole conversation into terminal 'failed'. Peeling
      // to a commit is what actually asks "is the work there?" — and when it is
      // not, this falls into the 'gone' branch below, which survives out loud.
      if (refExists(`refs/heads/${record.branch}^{commit}`, opts.cwd)) {
        try {
          const kept = await createTaskWorktree(opts.cwd, record.id, record.title, {
            branch: record.branch,
            signal,
            ...(opts.worktreeLockFn ? { lockFn: opts.worktreeLockFn } : {}),
          })
          record.worktree = kept.worktree
          if (kept.lock_stolen) {
            reportLockSteal(record.id, kept.lock_stolen)
          }
          // Taking the branch back is not the same as taking back what we left
          // on it: anything a third party pushed meanwhile is now inside the
          // measured range, and says so.
          reportForeignCommits(record, kept)
          // Same branch, same history, same anchor: not a new lineage. `base`
          // is NOT overwritten — the work-on path leaves it empty, and this
          // conversation's base is a fork base it must keep.
          anchorConversation(record, kept, { first, fresh: null })
          return
        } catch (err) {
          if (!(err instanceof BranchInUseError)) {
            throw err
          }
          // Someone checked the branch out elsewhere: git will not hand it over,
          // so a fresh fork is the only way to keep the conversation alive —
          // and the work left behind is named below, always.
          stranded = { branch: record.branch, reason: 'in_use', commits: 0 }
        }
      } else {
        stranded = { branch: record.branch, reason: 'gone', commits: 0 }
      }
    }
    const explicitBase = !record.worktree && record.base ? { base: record.base } : {}
    const wt = await createTaskWorktree(opts.cwd, record.id, record.title, {
      ...explicitBase,
      signal,
      ...(opts.worktreeLockFn ? { lockFn: opts.worktreeLockFn } : {}),
    })
    record.base = wt.base
    record.branch = wt.branch
    record.worktree = wt.worktree
    if (wt.lock_stolen) {
      reportLockSteal(record.id, wt.lock_stolen)
    }
    if (stranded?.reason === 'in_use') {
      // What the human loses sight of, counted rather than hinted at.
      const behind = tryGit(['rev-list', '--count', `${wt.branch}..${stranded.branch}`], opts.cwd)
      stranded.commits = Number.parseInt(behind ?? '', 10) || 0
    }
    // A re-forged fork IS a new branch off the base's current tip: fresh lineage.
    anchorConversation(record, wt, { first, fresh: stranded })
  }

  const pump = (): void => {
    // Nothing new launches during a drain (draining cannot flip mid-loop:
    // the whole pump is synchronous).
    if (draining) {
      return
    }
    while (pool.running.size < pool.max && queue.length > 0) {
      const id = queue.shift()
      const record = id ? loadTask(opts.cwd, id) : null
      if (record && record.status === 'queued') {
        launch(record)
      }
    }
  }
  pool.pumps.add(pump)

  /**
   * Tasks whose abandon is in flight. It has to exist because abandon() now
   * AWAITS the repo's worktree lock: its guards (`active.has`, the queue, the
   * status) and its `loadTask` run before that await, and its `persist` after.
   * Without a token, a reply() landing in that window sees nothing holding the
   * task, starts a real agent turn on a worktree that is about to be deleted,
   * and has its record overwritten by the abandon's stale snapshot. Same
   * idiom as the `shipping` guard one layer up (task-server.ts).
   */
  const abandoning = new Set<string>()
  /**
   * The same abandons, as promises, so shutdown() can wait for them. An abandon
   * is a git worktree removal followed by a record write: draining while one is
   * mid-flight would leave the process to exit between the two, with the
   * worktree gone and the record still claiming it.
   */
  const abandonsInFlight = new Set<Promise<void>>()

  /** Slot released: wake every runner sharing the pool, any queue may win it. */
  const releaseSlot = (id: string): void => {
    pool.running.delete(id)
    for (const wake of pool.pumps) {
      wake()
    }
  }

  /** The turn itself, on a worktree that already exists. Settles its own outcome. */
  const runTurn = (record: TaskRecord, controller: AbortController): Promise<void> => {
    record.status = 'running'
    // The task is moving again: whatever reason it last stopped for is history,
    // and a record that kept claiming it would be lying about the present. The
    // previous turn's last beat goes with it — absence reads as "nothing known
    // yet", which is true, where a stale stamp would read as "long dead".
    delete record.reason
    delete record.heartbeat_at
    persist(record)
    const startedAt = Date.now()
    // This attempt at the turn: the meter's last published figure — what it
    // had already spent if it dies — and the marker that keeps that figure
    // from being folded twice when both exit paths run.
    const attempt: TurnAttempt = { cost: null, folded: false }
    return runTaskTurn({
      cwd: record.worktree,
      task: record,
      prompt: composeTurnPrompt(record, opts.command),
      command: opts.command,
      timeoutMs: opts.timeoutMs,
      ...(opts.watchdog ? { watchdog: opts.watchdog } : {}),
      onHeartbeat: () => beat(record),
      signal: controller.signal,
      onEvent: (event) => emit(record.id, event),
      onText: (text, seq) => opts.onText?.(record.id, text, seq),
      onTokens: (total) => opts.onTokens?.(record.id, total),
      onCost: (cost) => {
        attempt.cost = cost
      },
      ...(opts.runAgentFn ? { runAgentFn: opts.runAgentFn } : {}),
      ...(opts.allowedDomains ? { allowedDomains: opts.allowedDomains } : {}),
      ...(opts.checksConfig !== undefined ? { checksConfig: opts.checksConfig } : {}),
      ...(opts.runContainerTurnFn ? { runContainerTurnFn: opts.runContainerTurnFn } : {}),
    })
      .then((outcome) => finishTurn(record, outcome, startedAt, attempt))
      .catch((err: unknown) =>
        failTurn(record, err, startedAt, { aborted: controller.signal.aborted, attempt }),
      )
  }

  const launch = (record: TaskRecord): void => {
    const controller = new AbortController()
    // Reserved before any await: a concurrent start()/pump() — on this runner
    // or on another one sharing the pool — must see the slot taken.
    active.set(record.id, controller)
    pool.running.add(record.id)
    // Materialization waits for the repo's worktree lock, so it is async; the
    // whole launch is therefore a promise, tracked in `inflight` from its first
    // tick so shutdown() cannot resolve while a task is still being set up.
    //
    // FOUR places in this codebase hold a task record across an await before
    // writing it back. Each needs an argument, and here is the whole list so
    // the next one added can be checked against it:
    //
    // 1. abandon() — re-READS after the await. It is the only one that must,
    //    because a ship can legitimately settle inside its window.
    // 2. launch(), this chain — valid by EXCLUSION: `active` holds this id
    //    from before the first await (set above, deleted only after the turn
    //    has settled on disk), so start/reply/resume/interrupt/abandon all
    //    409, and ship one layer up only accepts 'review_ok'/'review_ko' —
    //    statuses a task in `active` cannot be in.
    // 3. ship() in task-server.ts — valid by exclusion too: `ctx.shipping`
    //    holds the id across the push, and reply/resume/abandon consult it.
    // 4. The reviewer's captured record (task-review.ts) — valid by exclusion:
    //    the task sits on 'reviewing' for the whole flow, a status every
    //    action refuses.
    //
    // Exclusion is a real argument, but only while the guard that provides it
    // exists: whoever weakens one of those guards owns this comment too.
    const turn = ensureWorktree(record, controller.signal)
      .then(() => {
        if (controller.signal.aborted) {
          // Interrupted while the worktree was still materializing: the turn
          // never starts, and the task settles exactly as an aborted one.
          failTurn(record, new Error(t('agent.interrupted')), Date.now(), { aborted: true })
          return
        }
        return runTurn(record, controller)
      })
      // Only reachable from ensureWorktree — runTurn settles its own failures.
      // The signal matters as much here as it does inside a turn: a human who
      // interrupts while the worktree is still queueing for the repo lock has
      // interrupted the task, not broken it — and 'failed' has no resume path.
      .catch((err: unknown) =>
        failTurn(record, err, Date.now(), { aborted: controller.signal.aborted }),
      )
      .finally(() => {
        active.delete(record.id)
        inflight.delete(record.id)
        releaseSlot(record.id)
      })
    // Tracked so shutdown() can await the persistence of every aborted turn.
    inflight.set(record.id, turn)
  }

  const schedule = (record: TaskRecord): void => {
    if (!draining && pool.running.size < pool.max) {
      launch(record)
    } else {
      queue.push(record.id)
    }
  }

  return {
    start(task) {
      if (draining) {
        return { ok: false, code: 409, error: 'shutting down' }
      }
      if (active.has(task.id) || queue.includes(task.id)) {
        return { ok: false, code: 409, error: 'task already started' }
      }
      // Fresh copy from disk: never run on a possibly stale caller record.
      const record = loadTask(opts.cwd, task.id)
      if (!record) {
        return { ok: false, code: 404, error: 'task not found' }
      }
      if (record.status !== 'queued') {
        return { ok: false, code: 409, error: `task is ${record.status}` }
      }
      if (abandoning.has(task.id)) {
        return { ok: false, code: 409, error: 'task is being abandoned' }
      }
      schedule(record)
      return { ok: true }
    },

    reply(taskId, message) {
      if (draining) {
        return { ok: false, code: 409, error: 'shutting down' }
      }
      const text = typeof message === 'string' ? message.trim() : ''
      if (!text) {
        return { ok: false, code: 400, error: 'empty message' }
      }
      if (active.has(taskId) || queue.includes(taskId)) {
        return { ok: false, code: 409, error: 'task is running' }
      }
      // Its worktree is being deleted right now: starting a turn on it would
      // run a real agent against a directory about to vanish, and the abandon
      // would then overwrite whatever that turn recorded.
      if (abandoning.has(taskId)) {
        return { ok: false, code: 409, error: 'task is being abandoned' }
      }
      const record = loadTask(opts.cwd, taskId)
      if (!record) {
        return { ok: false, code: 404, error: 'task not found' }
      }
      // 'interrupted' is replyable too: that IS the resume path after a crash
      // or a graceful shutdown (a stored claude session resumes via --resume,
      // other providers get the transcript replay — composeTurnPrompt decides).
      // 'review_ok'/'review_ko' are replyable as well: "fix the findings" (or
      // any follow-up) is just the next turn after the automatic review.
      const replyable: readonly TaskStatus[] = [
        'waiting_for_you',
        'interrupted',
        'review_ok',
        'review_ko',
      ]
      if (!replyable.includes(record.status)) {
        return { ok: false, code: 409, error: 'task is not waiting for a reply' }
      }
      if (record.status !== 'interrupted') {
        // waiting_for_you and review_ok/review_ko time is human wait (the task
        // sits in the "waiting for you" zone; accrueWait falls back to
        // updated_at = end of review). Time spent interrupted (process down)
        // is neither work nor wait.
        accrueWait(record)
      }
      record.turns.push({
        prompt: text,
        response: null,
        question: null,
        started_at: new Date().toISOString(),
        ended_at: null,
      })
      // Persisted as 'queued' first: if all slots are busy the task correctly
      // shows up as queued; launch() flips it to 'running' when its turn comes.
      record.status = 'queued'
      persist(record)
      schedule(record)
      return { ok: true }
    },

    resume(taskId) {
      if (draining) {
        return { ok: false, code: 409, error: 'shutting down' }
      }
      if (active.has(taskId) || queue.includes(taskId)) {
        return { ok: false, code: 409, error: 'task is running' }
      }
      if (abandoning.has(taskId)) {
        return { ok: false, code: 409, error: 'task is being abandoned' }
      }
      const record = loadTask(opts.cwd, taskId)
      if (!record) {
        return { ok: false, code: 404, error: 'task not found' }
      }
      if (record.status !== 'interrupted') {
        return { ok: false, code: 409, error: `task is ${record.status}` }
      }
      const turn = pendingResumeTurn(record)
      if (!turn) {
        // The last turn answered: only a new instruction moves this on.
        return { ok: false, code: 409, error: 'task has no interrupted turn to resume' }
      }
      // A worktree that vanished is NOT refused here any more: reply() — the
      // button sitting next to Resume, on the same 'interrupted' task — already
      // rebuilds it, so the refusal protected nothing and left the UI with a
      // Resume that could only ever 409. ensureWorktree rebuilds, and says out
      // loud that the baseline moved with the fresh fork.
      // The very same turn runs again, in place: no new turn is appended, so
      // the conversation keeps one instruction per turn and the transcript
      // replay (or the resumed provider session) stays exact.
      turn.ended_at = null
      record.status = 'queued'
      persist(record)
      schedule(record)
      return { ok: true }
    },

    interrupt(taskId) {
      const controller = active.get(taskId)
      if (controller) {
        // The abort rejects the agent promise; failTurn persists 'interrupted'.
        controller.abort()
        return { ok: true }
      }
      if (abandoning.has(taskId)) {
        return { ok: false, code: 409, error: 'task is being abandoned' }
      }
      const record = loadTask(opts.cwd, taskId)
      if (!record) {
        return { ok: false, code: 404, error: 'task not found' }
      }
      if (record.status !== 'queued' && record.status !== 'waiting_for_you') {
        return { ok: false, code: 409, error: `task is ${record.status}` }
      }
      const queued = queue.indexOf(taskId)
      if (queued >= 0) {
        queue.splice(queued, 1)
      }
      if (record.status === 'waiting_for_you') {
        accrueWait(record)
      }
      const turn = record.turns.at(-1)
      if (turn && !turn.ended_at) {
        turn.ended_at = new Date().toISOString()
      }
      record.status = 'interrupted'
      // Same degradation as the shutdown path above, so the same code: a
      // vocabulary that read differently depending on which producer emitted
      // it would be unusable by the web mirror and by the post-mortem.
      emit(taskId, { type: 'interrupted', data: {}, reason_code: 'interrupted_by_user' })
      record.reason = taskReason('interrupted_by_user')
      persist(record)
      return { ok: true }
    },

    async abandon(taskId) {
      if (active.has(taskId)) {
        return { ok: false, code: 409, error: 'task is running' }
      }
      if (abandoning.has(taskId)) {
        return { ok: false, code: 409, error: 'task is being abandoned' }
      }
      const record = loadTask(opts.cwd, taskId)
      if (!record) {
        return { ok: false, code: 404, error: 'task not found' }
      }
      // 'reviewing' means an agent (T4's review) still works in the worktree:
      // deleting it mid-run is as unsafe as on 'running'. Interrupt first.
      if (record.status === 'running' || record.status === 'reviewing') {
        return { ok: false, code: 409, error: `task is ${record.status}` }
      }
      const queued = queue.indexOf(taskId)
      if (queued >= 0) {
        // Out of the queue before the await: pump() launches straight from the
        // queue and does not consult the guards, so a slot freeing up mid-removal
        // would start a turn on the worktree being deleted.
        queue.splice(queued, 1)
      }
      // Claimed BEFORE the first await, released only once the record has been
      // written: everything the guards above just established stays true for
      // the whole removal, which now waits for the repo's worktree lock.
      abandoning.add(taskId)
      let settle = (): void => {}
      const inFlight = new Promise<void>((resolve) => {
        settle = resolve
      })
      abandonsInFlight.add(inFlight)
      try {
        // Abandon is the one place the branch dies with the worktree: the task's
        // work is explicitly discarded, unlike interrupt/shutdown which keep both.
        // EXCEPT for a branch the conversation did not bring into existence —
        // it pre-existed and belongs to the user, so only the checkout goes.
        // `created_branch` is the precise answer to that question (a work-on
        // conversation on a branch that only existed on origin DID create the
        // local head, and cleaning it up leaves origin untouched); a record
        // written before that field existed falls back on the coarse rule it
        // was decided under, which is the honest default for a missing field.
        let removal: WorktreeRemoval
        try {
          removal = await removeTaskWorktree(opts.cwd, taskId, record.branch, {
            deleteBranch: record.created_branch ?? !record.work_on,
            ...(opts.worktreeLockFn ? { lockFn: opts.worktreeLockFn } : {}),
          })
        } catch (err) {
          // TOTAL, like ship one layer up: this result is dispatched by an
          // HTTP handler that does not catch, and an unhandled rejection kills
          // the server. A cleanup that could not happen is REPORTED — the task
          // keeps its worktree and its status, both still true.
          if (queued >= 0) {
            // Nothing was removed, so nothing about this task changed — except
            // that it is no longer in any queue. A 'queued' record outside every
            // queue is unstartable (start() 409s on the status, pump() never
            // sees it): put it back where it was and wake the pool.
            queue.splice(Math.min(queued, queue.length), 0, taskId)
            pump()
          }
          return { ok: false, code: 500, error: preview(errorMessage(err)) }
        }
        if (removal.lock_stolen) {
          reportLockSteal(taskId, removal.lock_stolen)
        }
        if (!removal.serialized) {
          // The cleanup went ahead without the repo lock rather than strand a
          // worktree forever. That is a degradation, so it is named and readable
          // — never inferred later from a corrupted index.
          emit(taskId, {
            type: 'error',
            data: {
              message: `worktree removal proceeded WITHOUT the repo lock (held by pid ${removal.holder_pid ?? 0} for ${Math.round((removal.holder_age_ms ?? 0) / 1000)}s)`,
            },
            reason_code: 'resource_busy',
          })
        }
        // NEVER persist a snapshot that crossed an await. `record` was read
        // before a wait on the repo lock that can last a minute; a ship settling
        // in that window has already written the record, and writing the old
        // copy back would erase the mr_url and resurrect the pre-ship status.
        // The removal is done either way — the worktree is gone — so a record
        // that disappeared meanwhile is a success with nothing left to write.
        const current = loadTask(opts.cwd, taskId)
        if (!current) {
          return { ok: true }
        }
        if (current.status === 'waiting_for_you') {
          accrueWait(current)
        }
        const turn = current.turns.at(-1)
        if (turn && !turn.ended_at) {
          turn.ended_at = new Date().toISOString()
        }
        // Cleaning up a SHIPPED task is housekeeping, not a discard: its work
        // lives on in the pushed branch/MR, the status must keep saying so.
        // Everything else abandoned mid-cycle is discarded work: failed.
        if (current.status !== 'shipped') {
          current.status = 'failed'
        }
        emit(taskId, { type: 'error', data: { message: 'worktree removed, task abandoned' } })
        persist(current)
        return { ok: true }
      } finally {
        abandoning.delete(taskId)
        abandonsInFlight.delete(inFlight)
        settle()
      }
    },

    isAbandoning(taskId) {
      return abandoning.has(taskId)
    },

    async shutdown() {
      draining = true
      // A 'queued' record with no live process would be unstartable at the
      // next boot (nothing re-enqueues it): 'interrupted' is the honest state
      // and reply() is its documented resume path.
      for (const id of queue.splice(0)) {
        const record = loadTask(opts.cwd, id)
        if (!record || record.status !== 'queued') {
          continue
        }
        const turn = record.turns.at(-1)
        if (turn && !turn.ended_at) {
          turn.ended_at = new Date().toISOString()
        }
        record.status = 'interrupted'
        emit(id, {
          type: 'interrupted',
          data: { reason: 'shutdown' },
          reason_code: 'interrupted_by_user',
        })
        record.reason = taskReason('interrupted_by_user', 'shutdown')
        persist(record)
      }
      for (const controller of active.values()) {
        // SIGTERM to the agent's process group; failTurn persists 'interrupted'
        // with {reason:'shutdown'} because draining is set.
        controller.abort()
      }
      // Abandons alongside the turns: both end in a record write that must land
      // before the process is allowed to go.
      await Promise.allSettled([...inflight.values(), ...abandonsInFlight])
    },

    runningCount: () => active.size,
  }
}
