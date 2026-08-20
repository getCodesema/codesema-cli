// Task runner: drives agent turns inside each task's git worktree, admits ONE
// task at a time per project (everything else waits in that project's
// persisted FIFO queue, task-queue.ts) and owns every status transition.
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
  createAgentStreamParser,
  effectiveAbsoluteCapMs,
  emitsClaudeStreamJson,
  emitsOpencodeJson,
  flagPresent,
  knownAgent,
  runAgent,
  type AgentHeartbeat,
  type AgentRunOptions,
  type WatchdogBudgets,
} from './agent.js'
import {
  isTerminalReason,
  reasonCodeOf,
  type ReasonCode,
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
import { git, refExists, revListCount, tryGit } from './git.js'
import { reviewLanguage, t } from './i18n.js'
import {
  createLoadCap,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  type LoadCap,
  type LoadCapSnapshot,
} from './load-cap.js'
import { projectIdFor } from './projects.js'
import type { ChecksConfig } from './repo-config.js'
import {
  agentHomeVolume,
  CAGE_FORWARDED_ENV,
  containerTaskCommandFor,
  releaseAgentHome,
  runContainerTurn,
  type ReleaseAgentHomeResult,
  type RunContainerTurnOptions,
} from './task-isolation.js'
import { createTaskQueue, type EnqueueResult, type TaskQueueIo } from './task-queue.js'
import {
  branchHasOwnCommits,
  BranchInUseError,
  createTaskWorktree,
  removeTaskWorktree,
  renameTaskBranch,
  resolveBranchRef,
  shortBranchName,
  type RenameRefusalReason,
  type TaskWorktree,
  type WorktreeLockFn,
  type WorktreeRemoval,
} from './task-worktree.js'
import {
  appendTaskEvent,
  loadTask,
  saveTask,
  taskReason,
  taskRecordExists,
  type AppendTaskEventInput,
} from './tasks-store.js'

/**
 * Historical default of the `maxParallelTasks` config key.
 *
 * INERT since T1.2, and STILL inert after T1.3: admission is decided by the
 * project's persisted queue and its one-active-task-per-project guard
 * (task-queue.ts), never by a slot budget. `maxParallelTasks` itself did not
 * retire — T1.3 turned it into a DEPRECATED alias of `maxConcurrentAgents`
 * (config.ts, workspace.ts), which feeds `load-cap.ts`'s real semaphore
 * instead. This constant, `TaskSlotPool` and `TaskRunnerOptions.maxParallel`
 * /`.slots` stay exactly as inert as T1.2 left them, kept only so the
 * deprecated key still parses into a shape nothing reads for admission.
 */
export const DEFAULT_MAX_PARALLEL_TASKS = 3

/** Bound for prompt/response previews embedded in journal events. */
const EVENT_PREVIEW_MAX = 400

function preview(text: string): string {
  const codePoints = Array.from(text)
  return codePoints.length > EVENT_PREVIEW_MAX
    ? `${codePoints.slice(0, EVENT_PREVIEW_MAX - 1).join('')}…`
    : text
}

/** Claude in print mode, and OpenCode, can pin and resume a session; other providers run one-shot turns. */
export function supportsSessionResume(command: string): boolean {
  if (knownAgent(command) === 'opencode') {
    return true
  }
  return /^claude(\s|$)/.test(command) && /(^|\s)(-p|--print)(\s|$)/.test(command)
}

export type TaskSession = { kind: 'new' | 'resume'; id: string }

/**
 * Per-turn agent command. The provider's edit tools are opened with the same
 * flags as the fix runner (tasks always run in write mode: the agent works in
 * its own worktree). Claude additionally gets the stream-json flags (tool
 * events + text deltas feed the live conversation) and a stable session:
 * --session-id on the first turn, --resume afterwards (flags verified against
 * claude 2.1.231 with -p). OpenCode gets `--format json` and `-s` on resume;
 * the first turn carries no session flag (the stream's sessionID is captured
 * instead).
 */
export function taskCommandFor(command: string, opts: { session: TaskSession | null }): string {
  let cmd = fixCommandFor(command)
  if (knownAgent(command) === 'opencode') {
    if (!flagPresent(cmd, '--format')) {
      cmd += ' --format json'
    }
    if (opts.session?.kind === 'resume') {
      cmd += ` -s ${opts.session.id}`
    }
    return cmd
  }
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
  /**
   * Re-read the checks config at the moment of the turn (T1.4). When the
   * getter is provided it always wins — including a `null` meaning "this repo
   * has no checks block anymore". The snapshot is only for callers that have
   * no file to re-read (tests).
   */
  getChecksConfig?: () => ChecksConfig | null | undefined
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
  const parser =
    emitsClaudeStreamJson(command) || emitsOpencodeJson(command)
      ? createAgentStreamParser(
          command,
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
  const checksConfig = opts.getChecksConfig ? opts.getChecksConfig() : opts.checksConfig
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
        ...(checksConfig !== undefined ? { checksConfig } : {}),
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

export type TaskActionResult =
  | {
      ok: true
      /**
       * Set when the gesture left the task WAITING: its 1-based place in its
       * project's queue, so the caller renders the right thing without a
       * round-trip. Absent means it started (or that there is no queue to be
       * in) — same doctrine as the field on TaskRecord.
       */
      queue_position?: number
      /**
       * Set when abandon() kept the task's branch instead of deleting it,
       * because it carries a commit of its own (T1.6): the name of the branch
       * that survives the worktree. Absent is the honest default for every
       * other gesture, and for an abandon that DID delete the branch — "no
       * branch was preserved by this call", not "unknown".
       */
      preserved_branch?: string
    }
  | {
      ok: false
      code: number
      error: string
      /**
       * Names the refusal for a machine, next to (never instead of) the
       * readable `error`. Optional: a refusal the D2 vocabulary has no word
       * for carries its message alone.
       */
      reason_code?: ReasonCode
    }

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

/** What `resolveAbandonAnchor` found, and whether it had to fall back to find it. */
type AbandonAnchor = {
  /**
   * The commit `abandon()` compares the branch's tip against, resolved to its
   * full OBJECT id (`^{commit}`) — never the stored string taken on trust.
   * Null: nothing resolved to a real commit in THIS repo, whichever source
   * was tried.
   */
  sha: string | null
  /** True when `baseline_sha` was absent and `record.base` had to stand in for it. */
  usedFallback: boolean
}

/**
 * The repère `abandon()` decides a branch's fate against (T1.6, design.md
 * D-A): `baseline_sha` (T1.5) when the record carries one — the exact commit
 * this conversation started from. A record written before it existed (0.12,
 * or a conversation that had already materialized when T1.5 shipped) has
 * none, and falls back to `record.base` resolved — the SAME degradation
 * T1.5 already applies to the review when no anchor was recorded — which the
 * caller must journal rather than let decide in silence.
 *
 * EITHER SOURCE is resolved as an OBJECT before it is trusted: the contract's
 * `sanitizeBaselineSha` only checks the SHAPE of a stored `baseline_sha` (7 to
 * 64 hex characters), never that the object it names still exists in this
 * repo — a `git filter-repo`, a re-clone into the same directory, a
 * `.codesema/` restored from another clone's backup, a shallow fetch, or a
 * hand-edited record can all leave a shape-valid sha that resolves to
 * nothing. The caller tells "resolved via baseline_sha" from "resolved via
 * the base fallback" from "resolved to nothing at all" by reading `sha` and
 * `usedFallback` together — never by trusting `baseline_sha`'s mere presence.
 */
function resolveAbandonAnchor(cwd: string, record: TaskRecord): AbandonAnchor {
  if (record.baseline_sha !== undefined) {
    return {
      sha: tryGit(['rev-parse', `${record.baseline_sha}^{commit}`], cwd),
      usedFallback: false,
    }
  }
  const ref = resolveBranchRef(cwd, shortBranchName(record.base))
  return {
    sha: ref ? tryGit(['rev-parse', `${ref}^{commit}`], cwd) : null,
    usedFallback: true,
  }
}

/** What `decideBranchFate` decided, for `abandon()` to act on and announce. */
type BranchFateDecision = {
  /** Passed to `removeTaskWorktree`: whether the BRANCH (not the worktree, always removed) goes too. */
  deleteBranch: boolean
  /** Whether the branch's tip differs from its anchor (or nothing could prove otherwise — the safe reading). */
  hasOwnCommits: boolean
  /** Commits ahead of the anchor, only when POSITIVE and countable — see decideBranchFate's doc. */
  ownCommitsCount: number | null
  /** Whether `record.branch` still names a real local ref, checked AFTER the commit decision, BEFORE removal. */
  branchStillExists: boolean
  /** Whether this task's branch was ever a candidate for deletion at all (false only for work-on). */
  createdOrAdopted: boolean
}

/**
 * Decides what `abandon()` does to a task's branch, and journals every
 * degradation the decision runs into along the way (T1.6) — this is the
 * doctrine at the top of task-worktree.ts, applied. Touches no worktree and
 * no branch itself: only the DECISION is made here, under no lock, so it can
 * run before `removeTaskWorktree` takes the repo lock and act on stale
 * information about nothing (the branch cannot change shape while nobody
 * holds that lock, this call included).
 */
function decideBranchFate(
  cwd: string,
  taskId: string,
  record: TaskRecord,
  emit: (id: string, input: AppendTaskEventInput) => void,
): BranchFateDecision {
  // work-on branches are NEVER deletable by abandon(), full stop — see the
  // CRITIQUE note at the call site for why. Every other task (a fork) always
  // brought its own branch into existence by construction (`worktree add -b`),
  // so it is always "ours" to consider deleting. `record.created_branch` is
  // deliberately NOT consulted: `sanitizeTaskRecord` (contract/src/tasks.ts)
  // only ever writes that key when it is `true`, never `false` — so on any
  // record actually read back from disk the field is `true | undefined`, and
  // testing it here would describe a shape no record can occupy.
  const createdOrAdopted = !record.work_on
  let hasOwnCommits = false
  // Purely descriptive, for the journal/API message below: how many commits,
  // when that can be counted and is POSITIVE. Stays null when it cannot be
  // counted, or resolves to 0 (a branch reset BACKWARD past its anchor still
  // answers `hasOwnCommits: true` — tip differs from anchor — but
  // `anchor..tip` counts zero commits ahead of it): "0 commits" is the one
  // claim `hasOwnCommits: true` must never make.
  let ownCommitsCount: number | null = null
  if (record.branch !== '') {
    const anchor = resolveAbandonAnchor(cwd, record)
    if (anchor.sha === null) {
      // The MAXIMAL degradation: nothing resolved to a real commit at all —
      // whether `baseline_sha` named an object gone from this repo, or there
      // was none and `record.base` resolves to nothing either. Journaled
      // exactly like the milder fallback below: silence here would be the
      // same silence T1.6 closed on the sibling path, and this one is worse.
      emit(taskId, {
        type: 'branch',
        data: {
          text: anchor.usedFallback
            ? `this task's record has no baseline_sha, and ${record.base || '(no base recorded)'} does not resolve either: ${record.branch}'s commit history cannot be measured, so it is treated as carrying a commit of its own`
            : `this task's baseline_sha does not name a commit that exists in this repo: ${record.branch}'s commit history cannot be measured against it, so it is treated as carrying a commit of its own`,
          name: 'baseline_sha_unresolved',
        },
      })
    } else if (anchor.usedFallback) {
      // A precision loss, not a stop (DP14): no reason_code — the same
      // family as T3.2's own `base...HEAD` fallback when no anchor was
      // recorded. The cause is named in `data.name`, never inferred.
      emit(taskId, {
        type: 'branch',
        data: {
          text: `this task's record has no baseline_sha (a pre-baseline record): falling back to ${record.base} resolved (${anchor.sha.slice(0, 12)}) to decide whether ${record.branch} carries a commit of its own`,
          name: 'baseline_sha_fallback',
        },
      })
    }
    hasOwnCommits = branchHasOwnCommits(cwd, record.branch, anchor.sha)
    if (hasOwnCommits && anchor.sha !== null) {
      const ahead = revListCount(`${anchor.sha}..refs/heads/${record.branch}`, cwd)
      ownCommitsCount = ahead !== null && ahead > 0 ? ahead : null
    }
  }
  // Checked AFTER the commit decision (which only needs the branch's NAME)
  // and BEFORE removal: a branch already gone before this abandon ran (a
  // stale checkout cleaned up out of band, an earlier partial abandon) must
  // never be announced as "kept" just because nothing could prove it empty.
  const branchStillExists = record.branch !== '' && refExists(`refs/heads/${record.branch}`, cwd)
  return {
    deleteBranch: createdOrAdopted && !hasOwnCommits,
    hasOwnCommits,
    ownCommitsCount,
    branchStillExists,
    createdOrAdopted,
  }
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
  /**
   * Aborted when the workspace is shutting down. The review holds the
   * project's admission claim for its whole run, and `shutdown()` waits for
   * that claim: without a way to CUT the review, a Ctrl-C during one waited
   * for the review agent's own timeout (up to 15 minutes by default) with
   * nothing on screen explaining why. The hook must pass this down to
   * whatever it runs (the agent subprocess takes an AbortSignal) and settle
   * the task quickly once it fires.
   */
  signal: AbortSignal
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
 * Shared concurrency budget of the pre-T1.2 workspace: one pool backed every
 * runner and `max` capped the number of 'running' tasks across every repo.
 *
 * INERT since T1.2, and STILL inert after T1.3: the number of active tasks
 * follows from "one active task per project" (task-queue.ts), so a pool
 * neither caps two projects against each other nor lets two tasks of the SAME
 * project run. The REAL machine-wide budget T1.3 adds is `load-cap.ts`'s
 * semaphore, a separate module — this type and its factory survive only as
 * the shape `maxParallelTasks` (now a deprecated alias, see
 * DEFAULT_MAX_PARALLEL_TASKS) still parses into; nothing reads `.running` or
 * `.pumps` for admission any more.
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
  /** Main repo root: the store, the queue and the worktrees live under its .codesema/. */
  cwd: string
  /**
   * Identity of the project this runner drives, for the one-active-task
   * guard. Defaults to the id `projects.ts` derives from `cwd`, which is the
   * same thing — the option exists so the manager passes the id it already
   * holds instead of re-hashing the path.
   */
  projectId?: string
  /** Raw configured agent command. */
  command: string
  /** Last-resort absolute ceiling of a turn; the watchdog is what detects a dead one. */
  timeoutMs: number
  /**
   * Watchdog budgets (D3) handed to every turn, host and caged alike; the D3
   * defaults apply when absent.
   *
   * Resolved per project (T1.4) from that repo's config; the manager passes
   * the project's budgets, not the launch repo's.
   */
  watchdog?: WatchdogBudgets | undefined
  /** INERT since T1.2 (see DEFAULT_MAX_PARALLEL_TASKS): admission is per project. */
  maxParallel?: number
  /** INERT since T1.2 (see TaskSlotPool): a pool no longer governs admission. */
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
  /** Re-read the checks config per turn (T1.4); wins over `checksConfig`. */
  getChecksConfig?: () => ChecksConfig | null | undefined
  /** Test seam for the caged path; the default drives real containers. */
  runContainerTurnFn?: (options: RunContainerTurnOptions) => Promise<string>
  /** Test seam for the repo's worktree lock; the default takes the real one. */
  worktreeLockFn?: WorktreeLockFn | undefined
  /**
   * The project's queue changed shape (a task joined it, left it, or started).
   * Everyone still waiting may have moved up a rank, and nothing else would
   * tell them: the manager re-broadcasts their records with a fresh
   * queue_position. Called AFTER the queue file was written.
   */
  onQueueChanged?: () => void
  /**
   * Automatic end-of-turn review (T4). When set, a successful 'done' turn
   * parks the task on 'reviewing' (post-commit) and hands it to this hook,
   * which owns the 'review_ok'/'review_ko' transition; when absent, the turn
   * lands directly on 'waiting_for_you'. Question turns never trigger it.
   */
  onTurnDone?: TaskTurnReviewFn
  /**
   * The drain is taking a moment: called ONCE, with the ids still settling, so
   * the terminal can say what a Ctrl-C is waiting for instead of looking
   * frozen. Never called when everything settles inside the grace.
   */
  onDrainWait?: (taskIds: readonly string[]) => void
  /** Test seam for that grace; production uses DRAIN_NOTICE_MS. */
  drainNoticeMs?: number
  /**
   * The drain gave up waiting, with the ids still unsettled. The process is
   * about to exit regardless: this exists so it never does so in silence.
   */
  onDrainTimeout?: (taskIds: readonly string[]) => void
  /** Test seam for the hard ceiling; production uses DRAIN_TIMEOUT_MS. */
  drainTimeoutMs?: number
  /**
   * queue.json went unusable while the workspace was RUNNING (not at boot),
   * with the ids the REBUILT queue holds. Reporting only: the queue rebuilds
   * itself on the read and the next write persists it, so a handler that
   * wrote here would be undone by the very operation that called it.
   */
  onQueueDegraded?: (reason: string, ids: readonly string[]) => void
  /** Filesystem seam of the persisted queue (§ 0.4); the default drives node:fs. */
  queueIo?: TaskQueueIo
  /**
   * Test seam for the task's HOME volume release at abandon (T1.9); the
   * default drives the real IsolationExecFn seam (task-isolation.ts). Never
   * called for a task whose isolation is not 'container' — nothing was ever
   * created for it to release.
   */
  releaseAgentHomeFn?: (opts: { taskId: string }) => Promise<ReleaseAgentHomeResult>
  /**
   * Machine-wide load cap (T1.3, D4): the REAL budget now, unlike `slots`
   * above. Injectable (§ 0.4) so tests can share ONE instance across several
   * runners (the machine cap is cross-project by nature) or set a tiny
   * plafond without touching real config; defaults to a FRESH
   * `createLoadCap(DEFAULT_MAX_CONCURRENT_AGENTS)` per runner when absent, so
   * every existing single-runner test keeps its previous (uncapped in
   * practice, since 4 comfortably covers them) behavior.
   */
  loadCap?: LoadCap
  /**
   * A task's turn just entered — or left — a wait on the machine load cap.
   * Called with the cap's occupation at that instant, so the caller (the
   * manager) can turn it into a `task_meta` frame the UI reads as "waiting
   * for a machine slot" instead of an undifferentiated "waiting". `waiting`
   * discriminates the two calls this can be — true on the way IN (no slot),
   * false on the way OUT (slot obtained) — since the snapshot alone can be
   * byte-identical between them (adversarial review fix).
   */
  onLoadCapWait?: (taskId: string, snapshot: LoadCapSnapshot, waiting: boolean) => void
}

export type TaskRunner = {
  /** Enqueues a 'queued' task; runs it now when the project has no active task. */
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
   * with an event {reason:'shutdown'} for the turns that were IN FLIGHT, keeps
   * the worktrees, and resolves once every one of them AND every in-flight
   * abandon has settled on disk.
   *
   * Queued tasks stay 'queued' (T1.2): the queue is persisted in
   * <repo>/.codesema/queue.json, so the next boot re-hydrates it and starts
   * the head. Sacrificing them to 'interrupted' was only ever right while the
   * queue died with the process.
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

/**
 * Reason a task carries while it waits behind another one of the same
 * project. The state is normal, not a failure — but a record that just sits on
 * 'queued' says nothing about WHY, so the D2 vocabulary names it: the resource
 * it waits for (its project's single active slot) is busy, and waiting is
 * exactly what fixes that. Dropped the moment the task launches.
 */
const QUEUED_BEHIND_DETAIL = 'another task of this project is already active'

/**
 * Reason a task carries while it waits for a slot of the MACHINE-wide load
 * cap (T1.3, D4) rather than for its own project's admission guard. Distinct
 * wording from QUEUED_BEHIND_DETAIL on purpose — AC3 of machine-load-cap asks
 * for the two motifs to be tellable apart on `resource_busy`, and a shared
 * sentence would make them the same fact to anyone reading the record.
 *
 * HAND-MIRRORED in the web bundle as `MACHINE_LOAD_WAIT_DETAIL`
 * (packages/web/src/composables/useTaskBoard.ts), which compares against it
 * to tell the two `resource_busy` motifs apart on a record that carries no
 * events. Changing a single character here without changing it THERE makes
 * the queue's #N pill silently fall back to the project-busy wording, and no
 * test in this package would notice (round 4, mineur: the cross-reference
 * used to point only one way, so a change starting on THIS side had nothing
 * to warn it). Round 5 (mineur F) replaced that comment-only cross-reference
 * with an actual lock: `packages/web/src/components/WorkQueue.test.ts` reads
 * THIS literal out of this file and renders the pill with it, so changing it
 * on one side alone is red on both sides. The two task-runner tests that
 * mention the sentence are copies of it and were never that lock.
 */
const MACHINE_LOAD_DETAIL =
  'the machine-wide load cap (maxConcurrentAgents) has no free slot for a turn, a review or a checks run'

/**
 * Detail carried by a task whose end-of-turn review a shutdown cut short.
 * The SINGLE source: the reviewer settles that case itself and the runner
 * covers the reviewer that does not, so the same sentence lands in the same
 * field from two files — it must not be written twice.
 */
export const REVIEW_CUT_DETAIL = 'the end-of-turn review was stopped by the shutdown'

/**
 * How long a drain stays silent before it says what it is waiting for. Short
 * enough that a Ctrl-C never looks frozen, long enough that the ordinary case
 * — everything settles at once — says nothing at all.
 */
export const DRAIN_NOTICE_MS = 1_000

/**
 * Hard ceiling on a graceful shutdown. Generous enough for an agent to die on
 * its SIGTERM and its turn to be persisted (well under a second in practice),
 * and short enough that a Ctrl-C is always over before a human reaches for the
 * second one. What it protects against is the part of the chain that takes no
 * signal — an auto-ship pushing to a remote that is not answering.
 */
export const DRAIN_TIMEOUT_MS = 30_000

/**
 * Broadcast hooks are OBSERVERS: they are given what happened, they never get
 * to decide what happens. A subscriber that throws (an SSE listener, a bug
 * downstream) used to travel back up into persist() — and therefore into the
 * window where the runner holds the project's admission claim, which it would
 * then leak for good. Every hook call goes through here instead.
 */
function notify(fn: (() => void) | undefined): void {
  try {
    fn?.()
  } catch (err) {
    // Contained, never hidden. The runner's own state must not depend on who
    // is listening — but a subscriber crashing means frames are being lost,
    // and a lost frame that nobody ever hears about is exactly the silent
    // degradation invariant 2 forbids.
    console.warn(`codesema: a task listener threw and was skipped: ${preview(errorMessage(err))}`)
  }
}

export function createTaskRunner(opts: TaskRunnerOptions): TaskRunner {
  const active = new Map<string, AbortController>()
  /**
   * End-of-turn reviews in flight. Separate from `active` on purpose: the
   * task is no longer interruptible as a running TURN (interrupt() must keep
   * 409-ing on 'reviewing'), but a shutdown still has to be able to cut the
   * review agent short — it holds the project's claim, and shutdown() waits.
   */
  const reviews = new Map<string, AbortController>()
  /** Turn promises of active tasks: shutdown() awaits them so every abort is persisted. */
  const inflight = new Map<string, Promise<void>>()
  /** Once shutting down: aborts get the {reason:'shutdown'} event, pump() stops launching. */
  let draining = false
  /**
   * The project's queue, PERSISTED in <cwd>/.codesema/queue.json, and the
   * guard that admits one task at a time for it. What waits here survives the
   * process (T1.2/D1); the in-memory `string[]` it replaces did not.
   */
  const queue = createTaskQueue({
    cwd: opts.cwd,
    projectId: opts.projectId ?? projectIdFor(opts.cwd),
    ...(opts.onQueueDegraded ? { onDegraded: opts.onQueueDegraded } : {}),
    ...(opts.queueIo ? { io: opts.queueIo } : {}),
  })
  /** Entry time into waiting_for_you; updated_at is the cross-restart fallback. */
  const waitingSince = new Map<string, number>()
  /**
   * Machine-wide load cap (T1.3, D4). A fresh, private instance when the
   * caller does not share one — see TaskRunnerOptions.loadCap.
   */
  const loadCap = opts.loadCap ?? createLoadCap(DEFAULT_MAX_CONCURRENT_AGENTS)
  /**
   * Ids whose CURRENT `reason` is the machine-cap wait (MACHINE_LOAD_DETAIL),
   * so schedule()'s generic "nothing named this wait, clear the reason"
   * cleanup does not blindly erase what launch() just wrote. Unlike `blocked`
   * below, membership here never removes an id from nextRunnable()'s
   * candidates: the whole point of the machine cap is that the SAME id is
   * retried — via onSlotFreed — once a slot frees anywhere on the machine.
   */
  const machineWaiting = new Set<string>()

  const persist = (record: TaskRecord): void => {
    // saveTask writes verbatim: bumping updated_at here keeps the listTasks
    // activity sort honest on every transition.
    record.updated_at = new Date().toISOString()
    saveTask(opts.cwd, record)
    // A queued record is broadcast WITH its rank: queue_position is derived at
    // read time and never persisted (saveTask above never sees it), so this is
    // the only place a live subscriber can learn it.
    const position = record.status === 'queued' ? queue.position(record.id) : null
    const shown = position === null ? record : { ...record, queue_position: position }
    notify(() => opts.onTask?.(shown))
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
    notify(() => opts.onEvent?.(id, event))
  }

  /**
   * T1.9: releases a task's HOME volume at termination, through the same
   * IsolationExecFn seam as the rest of isolation (never a runtime binary
   * named here — Décision 2) and reports the outcome as a NEUTRAL 'resource'
   * journal line (DP9, DP10): no reason_code, because a `volume rm` that
   * fails takes nothing and refuses nothing, and the boot sweep is the
   * backstop for whatever it leaves behind. Never blocks the caller: the
   * release itself never throws (releaseAgentHome's contract), so this is
   * plain sequential await, not a try/catch.
   */
  const releaseTaskHome = async (taskId: string): Promise<void> => {
    const release = opts.releaseAgentHomeFn ?? releaseAgentHome
    const outcome = await release({ taskId })
    const volume = agentHomeVolume(taskId)
    if (outcome.released) {
      emit(taskId, {
        type: 'resource',
        data: { name: 'home_volume_released', message: `HOME volume ${volume} released` },
      })
      return
    }
    if (outcome.reason === 'no-runtime') {
      emit(taskId, {
        type: 'resource',
        data: {
          name: 'container_runtime_absent',
          message: `no container runtime detected — HOME volume ${volume} could not be released`,
        },
      })
      return
    }
    emit(taskId, {
      type: 'resource',
      data: {
        name: 'home_volume_not_released',
        message: `HOME volume ${volume} could not be released: ${outcome.detail}`,
      },
    })
  }

  /**
   * The queue changed shape: everyone still waiting may have moved up. The
   * manager re-broadcasts their records with a fresh rank — nothing else would
   * ever tell a card in second place that it is now first.
   */
  const queueChanged = (): void => {
    notify(() => opts.onQueueChanged?.())
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
      // T1.6: the message alone used to leave nobody knowing WHERE that work
      // sits — the path and branch are ADDED, the original message untouched.
      emit(record.id, {
        type: 'error',
        data: {
          message: preview(errorMessage(err)),
          worktree: record.worktree,
          branch: record.branch,
        },
      })
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

  /** T1.6: readable clause for each RenameRefusalReason, next to the kept name. */
  const RENAME_REFUSAL_TEXT: Record<RenameRefusalReason, string> = {
    not_a_fork: 'the branch is not a task fork',
    unusable_proposal: 'the proposal yields no usable name',
    already_named: 'the branch already has that name',
    already_pushed: 'the branch is already published',
    git_refused: 'git refused the rename',
  }

  /**
   * Turn 1 only: adopt the branch name the agent proposed for itself, BEFORE
   * the commit, the review and the checks — everything downstream then sees a
   * single name. Never for a work-on task (that branch is the user's, the
   * prompt never even asks) and never past a push (renameTaskBranch refuses a
   * published branch). A refusal never fails the turn — the task simply keeps
   * the slug of its title — but T1.6 forbids the SILENCE that used to come
   * with it: the reason and the kept name are always journaled.
   *
   * No `reason_code` (DP14): a cosmetic rename declining stops nothing, the
   * turn goes on exactly as if it had never been proposed — none of D2's ten
   * codes describes a non-event. The cause travels in `data.name` instead,
   * the same doctrine as the neutral `cost` events (see `costEvent`).
   */
  const adoptBranchProposal = (record: TaskRecord, outcome: TaskTurnOutcome): void => {
    if (!outcome.branchProposal || record.work_on || record.turns.length > 1) {
      return
    }
    const result = renameTaskBranch(opts.cwd, record.id, record.branch, outcome.branchProposal)
    if (!result.renamed) {
      emit(record.id, {
        type: 'branch',
        data: {
          text: `branch rename to "${preview(outcome.branchProposal)}" declined (${RENAME_REFUSAL_TEXT[result.reason]}): keeping ${result.current}`,
          name: `branch_rename_${result.reason}`,
          kept_branch: result.current,
        },
      })
      return
    }
    record.branch = result.branch
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

  /**
   * Settles a finished turn. ASYNC on purpose: when an end-of-turn review
   * follows, this only resolves once that review (and the auto-ship it may
   * chain) has settled — the project's admission claim is released on THIS
   * promise, so "one active task per project" covers the whole active window
   * (isActiveTaskStatus counts 'reviewing' as active too) and not just the
   * agent turn. Without it the next task of the same repo started while the
   * previous one still had a review agent in its worktree.
   *
   * The containerized checks stay fire-and-forget on purpose: they run beside
   * the review, touch no task state, and — since T1.3 — acquire their OWN
   * 'checks' slot of the machine load cap at their own call site
   * (task-server.ts's startChecks), independently of this claim: a checks run
   * that outlives the review must not hold up the project's next task, and it
   * never did.
   */
  const finishTurn = async (
    record: TaskRecord,
    outcome: TaskTurnOutcome,
    startedAt: number,
    attempt?: TurnAttempt,
  ): Promise<void> => {
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
        // T4: the automatic review owns the final transition.
        record.status = 'reviewing'
        persist(record)
        // The review is abortable like the agent turn was. It holds the
        // project's claim, and shutdown() waits on that claim: a review with
        // no cut-off turns a Ctrl-C into a 15-minute silence.
        const controller = new AbortController()
        if (draining) {
          // The shutdown's abort loop has already run: a controller created
          // after it would never be aborted by anyone, and the task would sit
          // on 'reviewing' — a status with no way out inside this session.
          controller.abort()
        }
        reviews.set(record.id, controller)
        const io: TaskTurnIo = {
          emit: (input) => emit(record.id, input),
          persist: () => persist(record),
          text: (text) => notify(() => opts.onText?.(record.id, text)),
          signal: controller.signal,
        }
        try {
          await opts.onTurnDone(record, io)
        } catch (err) {
          // The reviewer never rejects by contract; a bug there must not
          // strand the task on 'reviewing' (unreplyable, uninterruptible).
          emit(record.id, { type: 'error', data: { message: preview(errorMessage(err)) } })
          record.status = 'review_ko'
          persist(record)
        } finally {
          reviews.delete(record.id)
        }
        // A review the shutdown cut short leaves the task where the shutdown
        // leaves every interrupted turn: 'interrupted', replyable, its work
        // committed and its worktree kept. Belt and braces — the reviewer
        // settles this itself — for the case where it returned on some other
        // path while the signal was already up.
        if (controller.signal.aborted && record.status === 'reviewing') {
          // Journaled like every other interruption: a status that changes
          // without a line in events.jsonl is exactly the silence invariant 2
          // forbids, and this was the only transition missing one.
          emit(record.id, {
            type: 'interrupted',
            data: { reason: 'shutdown' },
            reason_code: 'interrupted_by_user',
          })
          record.status = 'interrupted'
          record.reason = taskReason('interrupted_by_user', REVIEW_CUT_DETAIL)
          persist(record)
        }
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

  /**
   * What one admission attempt did.
   * - 'started': the turn is in flight and owns the claim.
   * - 'busy': the project already has an active task; nothing moved.
   * - 'machine_busy': the project was free, but the machine-wide load cap
   *   (T1.3, D4) had no slot. The project claim was given straight back — see
   *   launch() — so `queue.activeTask()` reads null again, exactly as before
   *   the attempt; the task keeps its place in the queue, its 'queued'
   *   status and a `resource_busy`/MACHINE_LOAD_DETAIL reason, and
   *   `onSlotFreed` retries it once a slot frees anywhere.
   * - 'blocked': the turn could NOT be started (a worktree that will not
   *   materialize). The task keeps its place in the queue and its 'queued'
   *   status — a turn that never started is not a failed turn — and the reason
   *   is in its journal. It stops being a CANDIDATE for this session (see
   *   `blocked`) so it never holds the line up, and a human gesture or the
   *   next boot puts it back in the running.
   */
  type LaunchOutcome = 'started' | 'busy' | 'machine_busy' | 'blocked'

  /**
   * Ids whose worktree refused to materialize in THIS session, mapped to the
   * readable failure. They keep their place in queue.json — the human may
   * still fix the branch and retry — but `pump` STEPS OVER them: a head that
   * cannot start must never starve the tasks behind it. Nothing in this
   * process retries a blocked id on its own (no timer, and every pump is a
   * gesture), so retrying it on every pump would only re-journal the same
   * error forever.
   *
   * An id leaves this set on exactly three things, and it is worth being
   * precise because the human-facing gestures are NOT interchangeable here:
   *  - `start()` on it again — the one retry gesture that reaches a task still
   *    sitting in the queue, and the reason `start` lets a blocked id through
   *    its "already started" guard;
   *  - it leaving the line at all (Stop, Abandon — dropFromQueue), after which
   *    Resume goes through schedule() like any other fresh scheduling;
   *  - the process restarting.
   * `reply()` and `resume()` do NOT reach it: both refuse a task that is still
   * queued, which is the pre-existing rule and stays one.
   */
  const blocked = new Map<string, string>()

  /** A human gesture (or a departure) puts an id back in the running. */
  const unblock = (taskId: string): void => {
    blocked.delete(taskId)
  }

  /**
   * Re-entrance guard. `releaseSlot` pumps, and a launch that fails releases
   * the claim, so a naive pump would re-enter itself through its own error
   * path. One pump at a time; the nested call is a no-op and the outer loop
   * stays in charge.
   */
  let pumping = false

  /**
   * A queue write that is allowed to fail without taking the gesture down with
   * it. The queue refuses to write in one specific case on purpose — an
   * unusable file whose bytes it could not copy aside — and `remove` is called
   * from Stop, Abandon and the sweep, none of which should turn a degraded
   * queue file into a 500. The refusal is reported, not swallowed.
   */
  const tryQueueWrite = <T>(what: () => T, fallback: T): T => {
    try {
      return what()
    } catch (err) {
      notify(() => opts.onQueueDegraded?.(preview(errorMessage(err)), []))
      return fallback
    }
  }

  /**
   * The first entry of the line this session can actually try: stale entries
   * are swept out on the way, and ids already known not to materialize are
   * STEPPED OVER rather than retried — they keep their rank, they just stop
   * being the reason nobody else runs.
   */
  const nextRunnable = (): TaskRecord | null => {
    // Swept in ONE batch at the end: dropping ids one by one re-read and
    // rewrote the whole file per id, synchronously, on the loop that also
    // serves HTTP — and fired a queue-changed broadcast each time, so the
    // server re-read records and re-sent frames per removal.
    const stale: string[] = []
    let runnable: TaskRecord | null = null
    for (const entry of queue.list()) {
      if (blocked.has(entry.id)) {
        continue
      }
      const record = loadTask(opts.cwd, entry.id)
      if (!record) {
        // null means BOTH "no such task" and "could not read it just now"
        // (a burst of open descriptors, an EACCES, a half-written file). Only
        // the first justifies taking an id out of the line; the second is
        // transient, and evicting on it silently costs a valid task its rank.
        if (!taskRecordExists(opts.cwd, entry.id)) {
          stale.push(entry.id)
        }
        continue
      }
      if (record.status !== 'queued') {
        // No longer waiting: it has no business making anyone queue behind it
        // (boot reconciliation does the same on a cold start).
        stale.push(entry.id)
        continue
      }
      runnable = record
      break
    }
    // Whatever put these ids here left the line for a reason OTHER than the
    // machine cap: gone from the store, or no longer 'queued' (adversarial
    // review round 3, MINEUR — corrected comment: `machineWaiting` is
    // per-runner, IN-MEMORY state, empty at every boot, so this is never
    // "a stale entry from a crashed process" or boot reconciliation — it is
    // THIS session observing, on a LATER pump(), that a record it once marked
    // machine-waiting moved on some other way (a reply, an abandon) within
    // the very session that set the flag). Nothing else prunes it on THIS
    // path — only dropFromQueue() does, for the human-gesture departures — so
    // without this an id swept out here would keep claiming (in memory only;
    // nothing re-persists it) that the machine is full for it long after it
    // stopped being a candidate at all.
    for (const id of stale) {
      machineWaiting.delete(id)
    }
    if (tryQueueWrite(() => queue.removeMany(stale), 0) > 0) {
      queueChanged()
    }
    return runnable
  }

  /**
   * Starts the best candidate of the queue while the project has no active
   * task. Ends on the first of: a drain, a queue with nothing runnable left,
   * or a claim already taken. A candidate that cannot start is recorded as
   * blocked and the loop moves on to the next one, so one unmaterializable
   * task costs the project one attempt — never its whole line.
   */
  const pump = (): void => {
    // Nothing new launches during a drain (draining cannot flip mid-loop:
    // the whole pump is synchronous).
    if (draining || pumping) {
      return
    }
    pumping = true
    try {
      while (queue.activeTask() === null) {
        const record = nextRunnable()
        if (!record) {
          return
        }
        // 'busy' means somebody else took the claim in between: stop. So does
        // 'machine_busy' — the project claim was given straight back, so
        // looping again would just pick the SAME head and hit the SAME full
        // cap, forever, on this very tick. 'blocked' put this id in `blocked`,
        // so the next lap picks a different one and the loop always makes
        // progress.
        const outcome = launch(record)
        if (outcome === 'busy' || outcome === 'machine_busy') {
          return
        }
      }
    } finally {
      pumping = false
    }
  }

  /** The project's single active slot frees: the head of the queue may start. */
  const releaseSlot = (id: string): void => {
    queue.releaseActive(id)
    pump()
  }

  /**
   * A human gesture takes a task out of the line for good (Stop, Abandon). It
   * leaves the queue AND, if it happened to be the one holding the project's
   * admission claim, it gives that back: a claim outliving the task it was
   * taken for would freeze the project until the next boot. Frees whoever is
   * next, in the same breath.
   */
  const dropFromQueue = (taskId: string): void => {
    // It is leaving the line: nothing left to step over, and a task id created
    // again later must not inherit this session's verdict.
    unblock(taskId)
    machineWaiting.delete(taskId)
    const wasQueued = tryQueueWrite(() => queue.remove(taskId), false)
    const wasActive = queue.activeTask() === taskId
    if (wasActive) {
      queue.releaseActive(taskId)
    }
    if (wasQueued || wasActive) {
      queueChanged()
      // Either the slot just came back, or the head of the line did: both mean
      // somebody behind may go now. (A no-op when the project is still busy —
      // pump checks the claim first.)
      pump()
    }
  }

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

  /**
   * The turn itself, on a worktree that already exists. Settles its own
   * outcome.
   *
   * `releaseLoadSlot` frees the machine-cap slot (T1.3) the instant the
   * agent's OWN process settles — success or failure — and BEFORE finishTurn
   * can call `onTurnDone`. That ordering is what keeps a cap of 1 from
   * dead-locking itself: `onTurnDone` may acquire a 'review' slot from the
   * SAME budget, and a turn still holding its 'turn' slot while awaiting a
   * review that awaits that very slot would never resolve either side.
   */
  const runTurn = (
    record: TaskRecord,
    controller: AbortController,
    releaseLoadSlot: () => void,
  ): Promise<void> => {
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
    const checksConfig = opts.getChecksConfig ? opts.getChecksConfig() : opts.checksConfig
    return (
      runTaskTurn({
        cwd: record.worktree,
        task: record,
        prompt: composeTurnPrompt(record, opts.command),
        command: opts.command,
        timeoutMs: opts.timeoutMs,
        ...(opts.watchdog ? { watchdog: opts.watchdog } : {}),
        onHeartbeat: () => beat(record),
        signal: controller.signal,
        onEvent: (event) => emit(record.id, event),
        onText: (text, seq) => notify(() => opts.onText?.(record.id, text, seq)),
        onTokens: (total) => notify(() => opts.onTokens?.(record.id, total)),
        onCost: (cost) => {
          attempt.cost = cost
        },
        ...(opts.runAgentFn ? { runAgentFn: opts.runAgentFn } : {}),
        ...(opts.allowedDomains ? { allowedDomains: opts.allowedDomains } : {}),
        ...(checksConfig !== undefined ? { checksConfig } : {}),
        ...(opts.runContainerTurnFn ? { runContainerTurnFn: opts.runContainerTurnFn } : {}),
      })
        .then((outcome) => {
          // The agent process is done: the task stops being interruptible as a
          // running turn here, even though the review that follows still holds
          // the project's claim. The machine-cap 'turn' slot goes with it —
          // BEFORE finishTurn, which is what may acquire 'review' next.
          active.delete(record.id)
          releaseLoadSlot()
          return finishTurn(record, outcome, startedAt, attempt)
        })
        // CHAINED, not the two-argument form: the turn's own rejection lands
        // here AND so does a finishTurn that folded the attempt's cost and then
        // threw on its way out (a commit, an emit, a persist). That second case
        // is exactly why the fold carries a marker — the same attempt would
        // otherwise be counted twice.
        .catch((err: unknown) => {
          const aborted = controller.signal.aborted
          active.delete(record.id)
          releaseLoadSlot()
          failTurn(record, err, startedAt, { aborted, attempt })
        })
        .catch((err: unknown) => {
          // failTurn never rejects by contract; a bug in it must not strand the
          // claim, so it lands here and the finally of the launch chain frees it
          // anyway.
          emit(record.id, { type: 'error', data: { message: preview(errorMessage(err)) } })
        })
    )
  }

  const launch = (record: TaskRecord): LaunchOutcome => {
    // Claimed BEFORE any await — the very property the slot reservation
    // carried: two concurrent admissions on this project must not interleave.
    // A refusal means another task of the project is already active; the head
    // stays where it is and waits for that one to release.
    if (!queue.claimActive(record.id)) {
      return 'busy'
    }
    // T1.3 (D4): the machine-wide load cap, tried SYNCHRONOUSLY right here —
    // still before any `await` — the exact property the project claim above
    // just demonstrated. `tryAcquire` never blocks and never queues (see
    // load-cap.ts), so this is a plain test-and-set: on a miss the project
    // claim is handed straight back and the entry stays IN queue.json (the
    // dequeue is further down, past this point) — 'waiting for the project'
    // and 'waiting for the machine' stay tellable apart on the record.
    const loadRelease = loadCap.tryAcquire('turn')
    const snapshot = loadCap.snapshot()
    if (!loadRelease) {
      queue.releaseActive(record.id)
      // A TRANSITION, not a re-statement: `machineWaiting` already holding
      // this id means a PREVIOUS attempt (retried by onSlotFreed after some
      // OTHER consumer's release, which does not imply a slot is free for
      // THIS one) already journaled and broadcast the exact same fact. A
      // free-for-all cap shared by every project can retry the same head
      // many times over before it ever gets in — persisting and emitting on
      // every miss would journal (and write, and push an SSE frame for)
      // nothing NEW each time (adversarial review, MINEUR).
      const enteringWait = !machineWaiting.has(record.id)
      machineWaiting.add(record.id)
      record.reason = taskReason('resource_busy', MACHINE_LOAD_DETAIL)
      if (enteringWait) {
        // D2 vocabulary, applied per the spec's letter: the wait is visible
        // in BOTH the journal and the API, not the API alone (adversarial
        // review, MAJEUR 1). `queue` is its own event type, never `error` —
        // an ordinary wait is not a degradation to paint red (DP8(b)/DP9).
        //
        // try/catch (adversarial review round 3, MINEUR): these are disk
        // writes (appendTaskEvent, saveTask) that CAN throw (ENOSPC, EACCES).
        // Unguarded, a throw here would surface as an unrelated 500 on the
        // direct start()/schedule() path, and be swallowed WITHOUT A TRACE on
        // the onSlotFreed path — notifyFreed's per-listener catch (load-cap.ts)
        // has no logging at all, unlike this runner's own `notify()`.
        try {
          emit(record.id, {
            type: 'queue',
            data: { name: 'machine_busy', message: MACHINE_LOAD_DETAIL },
            reason_code: 'resource_busy',
          })
          persist(record)
        } catch (err) {
          console.warn(
            `codesema: failed to record a machine-cap wait: ${preview(errorMessage(err))}`,
          )
        }
        notify(() => opts.onLoadCapWait?.(record.id, snapshot, true))
      }
      return 'machine_busy'
    }
    machineWaiting.delete(record.id)
    notify(() => opts.onLoadCapWait?.(record.id, snapshot, false))
    /** Idempotent: `runTurn` releases it right when the agent settles (before
     * `finishTurn` can acquire a 'review' slot from the SAME budget — see its
     * doc comment); this is the backstop for every OTHER exit of this
     * function (materialization failure, an abort before the turn ever ran,
     * a synchronous throw between here and the promise chain below). */
    let loadReleased = false
    const releaseLoadSlot = (): void => {
      if (loadReleased) {
        return
      }
      loadReleased = true
      loadRelease()
    }
    // Set only once the turn actually owns the claim through its promise chain;
    // until then the finally below frees it, whatever went wrong in between.
    let handedOver = false
    const controller = new AbortController()
    try {
      active.set(record.id, controller)
      // Materialization waits for the repo's worktree lock, so it is async; the
      // whole launch is therefore a promise, tracked in `inflight` from its
      // first tick so shutdown() cannot resolve while a task is still being set
      // up. It is also why this function answers 'started' as soon as the chain
      // owns the claim: whether the worktree can be had is no longer knowable
      // synchronously, so a materialization that fails releases the claim and
      // re-pumps instead of reporting 'blocked' to the caller.
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
      const promise = ensureWorktree(record, controller.signal)
        .then(() => {
          // Out of the line BEFORE the record says 'running'. The other order
          // left a window where a failing queue write (read-only .codesema,
          // ENOSPC) stranded a record on 'running' with no turn in flight:
          // neither interruptible nor resumable, and a lie on the board.
          // Failing here costs nothing — the record is untouched, the entry is
          // still in the file, and the catch below is honest when it says the
          // turn never started.
          queue.remove(record.id)
          if (controller.signal.aborted) {
            // Interrupted while the worktree was still materializing: the turn
            // never starts, and the task settles exactly as an aborted one.
            queueChanged()
            failTurn(record, new Error(t('agent.interrupted')), Date.now(), { aborted: true })
            return
          }
          const turn = record.turns.at(-1)
          if (turn) {
            // The turn STARTS now, not when the record was created or the reply
            // typed: a task that waited two days in the queue must not render
            // as "running for two days" the second it gets its slot.
            turn.started_at = new Date().toISOString()
          }
          // It started: whatever went wrong last time is not a fact about it
          // any more (this also covers the id a human retried through
          // schedule()).
          unblock(record.id)
          const running = runTurn(record, controller, releaseLoadSlot)
          queueChanged()
          return running
        })
        .catch((err: unknown) => {
          // Only reachable from the materialization — runTurn settles its own
          // failures. Two outcomes, and what tells them apart is whether the
          // failure NAMES itself:
          //  - an abort, or a degradation carrying a D2 code (the repo's
          //    worktree lock giving up says `resource_busy`), settles the turn
          //    through failTurn, which puts the task on the status that code's
          //    terminality calls for — that is what makes a lock timeout
          //    'interrupted' and resumable instead of a dead end;
          //  - anything else (a base branch that no longer exists) means the
          //    turn NEVER started: the task keeps its place in the line and its
          //    'queued' status, stops being a candidate for this session so it
          //    never starves the tasks behind it, and a human gesture (reply,
          //    resume, Stop, Abandon) or the next boot revives it.
          const aborted = controller.signal.aborted
          if (aborted || reasonCodeOf(err) !== null) {
            failTurn(record, err, Date.now(), { aborted })
            return
          }
          const message = preview(errorMessage(err))
          // Journaled ONCE per id: every pump used to re-append the same line,
          // so a permanently blocked task grew events.jsonl without bound.
          if (!blocked.has(record.id)) {
            emit(record.id, { type: 'error', data: { message }, reason_code: 'agent_error' })
          }
          blocked.set(record.id, message)
          // The verdict has to reach the RECORD, not just the journal and a Map
          // in memory. The boot pump comes through here WITHOUT going through
          // schedule(), so a task blocked at boot used to keep whatever reason
          // it was carrying from the previous session — typically "another task
          // of this project is already active", said while nothing at all was
          // running, which then also armed the UI's "N conversations ahead"
          // hint.
          record.reason = taskReason('agent_error', message)
          persist(record)
        })
        .finally(() => {
          // Backstop: the ONLY path that reaches here without having already
          // released via runTurn is "materialization failed / aborted before
          // the turn ever ran" — releaseLoadSlot's own guard makes the second
          // call (after runTurn already released) a no-op.
          releaseLoadSlot()
          active.delete(record.id)
          inflight.delete(record.id)
          releaseSlot(record.id)
        })
      // Tracked so shutdown() awaits the persistence of every aborted turn AND
      // of the review that follows a finished one.
      inflight.set(record.id, promise)
      handedOver = true
      return 'started'
    } finally {
      if (!handedOver) {
        // Hermetic: the claim is released on EVERY path that did not hand it
        // to a turn promise. Leaking it would freeze the project for good —
        // nothing else in the process would ever free it again.
        releaseLoadSlot()
        active.delete(record.id)
        queue.releaseActive(record.id)
      }
    }
  }

  /**
   * Everything that wants a turn goes through the persisted queue — start,
   * reply and resume alike. The pump right after either launches it (the
   * project was idle) or leaves it waiting, in which case the record says
   * WHY it waits rather than sitting on a mute 'queued'.
   *
   * Refuses, named, when the queue will not take the task: a queue that cannot
   * remember it is a task nothing would ever start.
   */
  const schedule = (record: TaskRecord): TaskActionResult => {
    // A human asked for this turn: whatever this id failed at earlier in the
    // session, it gets a fresh attempt (and its journal a fresh line).
    unblock(record.id)
    // A fresh attempt starts unwitnessed by the machine cap too — the pump()
    // call below re-adds it (and re-persists the reason) the moment launch()
    // actually sees the cap full. MEASURED (round 4): over the whole CLI
    // suite this line never actually removes anything — `launch()`'s own
    // success-path delete has always cleared the id first (11 effective
    // removals there, 0 here). It is the belt to that brace, kept for a
    // future call path that reaches `schedule()` without having gone through
    // a successful `launch()`; the test 'journaled BOTH times' only goes red
    // when BOTH deletes are gone, so nothing here is proven in isolation.
    machineWaiting.delete(record.id)
    let enqueued: EnqueueResult
    try {
      enqueued = queue.enqueue(record.id)
    } catch (err) {
      enqueued = { ok: false, reason: errorMessage(err) }
    }
    if (!enqueued.ok) {
      emit(record.id, {
        type: 'error',
        data: { message: preview(enqueued.reason) },
        reason_code: 'resource_busy',
      })
      record.reason = taskReason('resource_busy', enqueued.reason)
      persist(record)
      return { ok: false, code: 503, error: enqueued.reason, reason_code: 'resource_busy' }
    }
    queueChanged()
    pump()
    // Admission is read off the CLAIM, never off the queue file. Materializing
    // a worktree waits for the repo's worktree lock, so it is async and the
    // entry only leaves queue.json once that worktree is there: a task holding
    // the claim HAS started, whatever its entry still says for another tick.
    if (queue.activeTask() === record.id) {
      return { ok: true }
    }
    const position = queue.position(record.id)
    if (position === null) {
      return { ok: true }
    }
    // Still waiting — but `reason` is the machine-readable surface T1.1 built,
    // and it must say the TRUE cause. Writing "another task is already active"
    // whenever the position was 1 was a lie precisely in the case that hurts:
    // nothing running, the task simply could not materialize.
    if (queue.activeTask() !== null) {
      // Same transition discipline as the machine-cap wait right below: only
      // journal (and only once) the FIRST time this record is stated to be
      // waiting on ITS PROJECT's own slot, not every schedule() call that
      // finds it still there (adversarial review, MAJEUR 1 — the spec asks
      // for the wait in the journal AND the API, twice over, not a re-quoted
      // line per retry).
      const alreadyStated =
        record.reason?.code === 'resource_busy' && record.reason.detail === QUEUED_BEHIND_DETAIL
      record.reason = taskReason('resource_busy', QUEUED_BEHIND_DETAIL)
      if (!alreadyStated) {
        emit(record.id, {
          type: 'queue',
          data: { name: 'project_busy', message: QUEUED_BEHIND_DETAIL },
          reason_code: 'resource_busy',
        })
      }
      persist(record)
    } else if (machineWaiting.has(record.id)) {
      // launch() (called by the pump() above) already settled the record
      // with the machine-cap reason on this very attempt — nothing to add,
      // and nothing to clear: doing either here would race whatever
      // onSlotFreed's next retry does to the SAME record.
    } else if (!blocked.has(record.id)) {
      // Waiting for something this runner has no name for (a drain in
      // progress, a task ahead of it that a gesture will revive). Saying
      // nothing beats guessing. When it IS blocked, launch() has already
      // settled the record with the real failure — on every path, boot
      // included — so there is nothing to add here.
      delete record.reason
      persist(record)
    }
    return { ok: true, queue_position: position }
  }

  // T1.3 (D4): a slot freeing ANYWHERE on the machine — another project's
  // turn, a review, a checks run — may be exactly what this project's head is
  // waiting for. The machine cap has no queue of its own for `launch()`
  // (tryAcquire never blocks, never queues — see load-cap.ts), so this is the
  // only thing that ever retries a 'machine_busy' head; without it, a task
  // parked on the machine cap would sit there until some UNRELATED gesture on
  // THIS project's own queue (a reply, a Stop) happened to call pump() again.
  // The unsubscribe is KEPT and called by shutdown() (adversarial review
  // round 3, MINEUR): thrown away, this runner would keep getting pumped by
  // every machine-wide slot release for the rest of the process's life —
  // T1.3 is what turns "a slot freed anywhere" into a reason to poke EVERY
  // runner, a coupling `TaskSlotPool` never created (it was inert before).
  const unsubscribeSlotFreed = loadCap.onSlotFreed(() => pump())

  // A queue this project's previous session left behind starts as soon as a
  // runner exists for that project — nothing else would ever pick it up, and
  // its tasks never got a turn to begin with. WHEN that runner is built is the
  // manager's call, and deliberately not at boot: `TaskManager.startPending()`
  // is an explicit step the workspace triggers only once the HTTP server
  // listens and the shutdown handlers are installed. An 'interrupted' task is
  // a different story and still never restarts on its own (T8) — it is not in
  // this file.
  pump()

  return {
    start(task) {
      if (draining) {
        return { ok: false, code: 409, error: 'shutting down' }
      }
      // A task this session set ASIDE (its worktree would not materialize) is
      // still in the line and still 'queued', so the plain "already started"
      // refusal would have been the only answer a human ever got — and there
      // would be no gesture at all to try it again. Starting it once more IS
      // that gesture: the enqueue is idempotent (same rank), schedule() clears
      // the session's verdict, and the pump gives it a real second chance.
      if (active.has(task.id) || (queue.position(task.id) !== null && !blocked.has(task.id))) {
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
      return schedule(record)
    },

    reply(taskId, message) {
      if (draining) {
        return { ok: false, code: 409, error: 'shutting down' }
      }
      const text = typeof message === 'string' ? message.trim() : ''
      if (!text) {
        return { ok: false, code: 400, error: 'empty message' }
      }
      if (active.has(taskId)) {
        return { ok: false, code: 409, error: 'task is running' }
      }
      // Its worktree is being deleted right now: starting a turn on it would
      // run a real agent against a directory about to vanish, and the abandon
      // would then overwrite whatever that turn recorded.
      if (abandoning.has(taskId)) {
        return { ok: false, code: 409, error: 'task is being abandoned' }
      }
      if (queue.position(taskId) !== null) {
        // Waiting its turn is not running: a task that never started must not
        // be refused with a sentence claiming it did.
        return { ok: false, code: 409, error: 'task is queued' }
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
      return schedule(record)
    },

    resume(taskId) {
      if (draining) {
        return { ok: false, code: 409, error: 'shutting down' }
      }
      if (active.has(taskId)) {
        return { ok: false, code: 409, error: 'task is running' }
      }
      if (abandoning.has(taskId)) {
        return { ok: false, code: 409, error: 'task is being abandoned' }
      }
      if (queue.position(taskId) !== null) {
        // Waiting its turn is not running: a task that never started must not
        // be refused with a sentence claiming it did.
        return { ok: false, code: 409, error: 'task is queued' }
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
      return schedule(record)
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
      dropFromQueue(taskId)
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
      // Out of the queue before the await: pump() launches straight from the
      // queue and does not consult the guards, so a slot freeing up mid-removal
      // would start a turn on the worktree being deleted. dropFromQueue hands the
      // project's admission claim back too, if this task happened to hold it.
      const queued = queue.position(taskId) !== null
      dropFromQueue(taskId)
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
        // EXCEPT a branch this conversation never brought into existence, OR a
        // work-on conversation full stop — a work-on branch is the USER's,
        // whether this conversation materialized its local head from origin or
        // adopted one that already existed locally, and deleting the ONLY copy
        // of it (origin/<branch> can vanish between two turns — merged, renamed,
        // cleaned up on the forge) is a loss this ticket exists to rule out.
        //
        // T1.6 adds a SECOND, narrower gate on top: even a branch this
        // conversation created is kept when it carries a commit of its own —
        // the doctrine at the top of task-worktree.ts. This can only WIDEN
        // preservation, never narrow it. `decideBranchFate` runs the whole
        // decision (and journals every degradation it meets) BEFORE
        // removeTaskWorktree runs — the worktree lock does not protect a
        // decision already made, and nothing about the branch's shape can
        // change while no lock is held, this call included.
        const fate = decideBranchFate(opts.cwd, taskId, record, emit)
        let removal: WorktreeRemoval
        try {
          removal = await removeTaskWorktree(opts.cwd, taskId, record.branch, {
            deleteBranch: fate.deleteBranch,
            ...(opts.worktreeLockFn ? { lockFn: opts.worktreeLockFn } : {}),
          })
        } catch (err) {
          // TOTAL, like ship one layer up: this result is dispatched by an
          // HTTP handler that does not catch, and an unhandled rejection kills
          // the server. A cleanup that could not happen is REPORTED — the task
          // keeps its worktree and its status, both still true.
          if (queued) {
            // Nothing was removed, so nothing about this task changed — except
            // that it is no longer in the line. A 'queued' record outside the queue
            // is unstartable (start() 409s on the status, pump() never sees it):
            // put it back and wake the pump. It goes to the TAIL — the persisted
            // queue has no insert-at-rank — and a startable task at the back beats
            // an unstartable one at its old place.
            tryQueueWrite<EnqueueResult>(() => queue.enqueue(taskId), {
              ok: false,
              reason: 'requeue refused',
            })
            queueChanged()
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
        // T1.6: signalled on its OWN 'branch' event, never folded into the
        // 'worktree removed, task abandoned' line below — that message stays
        // BYTE FOR BYTE what it always was, existing readers included, and
        // the new fact gets a journal line of its own instead of growing the
        // old one's payload. No `reason_code` (DP14): none of the three cases
        // below is a degradation — a preserved branch is the doctrine working
        // as intended, an already-gone branch is a fact stated once it is
        // known, and an untouched work-on branch is the ordinary outcome.
        //
        // Emitted (and the API result built) from the PRE-await `record` and
        // `fate`, not from `current` below: the branch was already decided
        // and the worktree already removed accordingly BEFORE the repo-lock
        // wait, so this is true regardless of whether the task record still
        // exists to be re-read.
        //
        // `preserved_branch` NAMES a branch — it must never name one that is
        // not there. `hasOwnCommits` alone answers "was it right not to
        // delete it", never "does it exist to be pointed at": a branch
        // cleaned up out of band before this abandon ran (a stale checkout,
        // an earlier partial abandon) reads `hasOwnCommits: true` for the
        // same reason a real survivor does — nothing could prove it empty —
        // but there is no ref left to announce, so the API field and the
        // 'branch_preserved' event are gated on `fate.branchStillExists` too.
        let preservedBranchResult: { preserved_branch?: string } = {}
        if (fate.hasOwnCommits && fate.branchStillExists) {
          preservedBranchResult = { preserved_branch: record.branch }
          emit(taskId, {
            type: 'branch',
            data: {
              // A work-on branch is kept UNCONDITIONALLY (fate.createdOrAdopted
              // is false): stating the commit as the REASON it was kept would
              // claim a causality that does not hold for it, even though the
              // commit itself is real and worth saying.
              text: fate.createdOrAdopted
                ? `worktree removed, task abandoned; ${record.branch} was KEPT: it carries a commit of its own`
                : `worktree removed, task abandoned; ${record.branch} was never ours to delete (work-on) and carries a commit of its own`,
              name: 'branch_preserved',
              preserved_branch: record.branch,
              ...(fate.ownCommitsCount !== null
                ? { preserved_branch_commits: fate.ownCommitsCount }
                : {}),
            },
          })
        } else if (fate.hasOwnCommits && !fate.branchStillExists) {
          emit(taskId, {
            type: 'branch',
            data: {
              text: `${record.branch} could not be proven empty, but it was already gone before this abandon ran: nothing was deleted here, and nothing survives to point at`,
              name: 'branch_gone',
            },
          })
        } else if (!fate.hasOwnCommits && !fate.createdOrAdopted && fate.branchStillExists) {
          // A work-on branch this abandon never had the right to touch, which
          // also happens to carry nothing of its own: still worth a line,
          // since 'worktree removed, task abandoned' alone would otherwise be
          // the ONLY thing said about a branch this doctrine promises to
          // always mention when it survives an abandon.
          emit(taskId, {
            type: 'branch',
            data: {
              text: `worktree removed, task abandoned; ${record.branch} was never ours to delete (work-on) and stays exactly where it was`,
              name: 'branch_untouched',
            },
          })
        }
        // NEVER persist a snapshot that crossed an await. `record` was read
        // before a wait on the repo lock that can last a minute; a ship settling
        // in that window has already written the record, and writing the old
        // copy back would erase the mr_url and resurrect the pre-ship status.
        // The removal is done either way — the worktree is gone — so a record
        // that disappeared meanwhile is a success with nothing left to write,
        // except the branch verdict above, which is already written.
        const current = loadTask(opts.cwd, taskId)
        if (!current) {
          return { ok: true, ...preservedBranchResult }
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
        // T1.9 review round 3, Mineur 3: the terminal status is written to
        // disk BEFORE the (possibly slow, up to the release seam's own
        // timeout) HOME volume release below — not after. A daemon that
        // hangs on `volume rm` must never keep a task's record sitting on a
        // non-terminal status for the whole wait: if the process dies in
        // that window, the record on disk is already 'failed'/'shipped'
        // rather than whatever it was before this abandon started.
        persist(current)
        emit(taskId, { type: 'error', data: { message: 'worktree removed, task abandoned' } })
        // T1.9: the HOME volume is a resource of ITS OWN isolation, not of
        // the worktree just removed above — nothing was ever created for a
        // 'policy' task, so nothing is attempted for one either.
        if (current.isolation === 'container') {
          await releaseTaskHome(taskId)
        }
        return { ok: true, ...preservedBranchResult }
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
      // Stops this runner from being pumped by every OTHER project's slot
      // releases once it is going down itself (adversarial review round 3,
      // MINEUR): the listener otherwise outlives the runner it was built for.
      unsubscribeSlotFreed()
      // The queued tasks are LEFT ALONE, on purpose (T1.2). They stay 'queued'
      // in queue.json, which outlives this process: the next boot re-hydrates
      // the file, reconciles it with the records and starts the head. Marking
      // them 'interrupted' was the honest answer only while nothing
      // re-enqueued them — it cost a human gesture per task for a turn that
      // had never even started.
      for (const controller of active.values()) {
        // SIGTERM to the agent's process group; failTurn persists 'interrupted'
        // with {reason:'shutdown'} because draining is set.
        controller.abort()
      }
      // The reviews too: they hold the claim this shutdown waits on, and the
      // review agent is just another subprocess with a signal.
      for (const controller of reviews.values()) {
        controller.abort()
      }
      // A wait is never mute. Aborting is not instantaneous (a SIGTERM'd agent
      // still has to die and its turn still has to be persisted), and a
      // terminal that says nothing for several seconds after a Ctrl-C reads as
      // a hang. Past a short grace, say what is still settling.
      const pending = [...inflight.keys()]
      const timer = setTimeout(() => {
        notify(() => opts.onDrainWait?.(pending))
      }, opts.drainNoticeMs ?? DRAIN_NOTICE_MS)
      // Never the reason a process lingers: this timer only ever talks.
      timer.unref?.()
      // And a HARD ceiling on the whole wait. What the drain awaits grew with
      // T1.2: the turn promise now carries the end-of-turn review AND the
      // auto-ship chained behind it, and ship() takes no signal — a push to a
      // slow remote could hold a Ctrl-C for minutes. Past this, the shutdown
      // stops waiting and SAYS it stopped, rather than looking wedged.
      // (The containerized checks are fire-and-forget and were never awaited;
      // the container runtime's own cleanup budget is T3.1's subject, not
      // this one's.)
      let capTimer: ReturnType<typeof setTimeout> | undefined
      const cap = new Promise<'timeout'>((resolve) => {
        capTimer = setTimeout(() => resolve('timeout'), opts.drainTimeoutMs ?? DRAIN_TIMEOUT_MS)
        capTimer.unref?.()
      })
      try {
        const outcome = await Promise.race([
          // Abandons alongside the turns: both end in a record write that must
          // land before the process is allowed to go.
          Promise.allSettled([...inflight.values(), ...abandonsInFlight]).then(
            () => 'settled' as const,
          ),
          cap,
        ])
        if (outcome === 'timeout') {
          notify(() => opts.onDrainTimeout?.([...inflight.keys()]))
        }
      } finally {
        clearTimeout(timer)
        clearTimeout(capTimer)
      }
    },

    runningCount: () => active.size,
  }
}
