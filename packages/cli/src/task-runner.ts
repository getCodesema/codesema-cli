// Task runner: drives agent turns inside each task's git worktree, caps
// concurrency (FIFO queue past the limit) and owns every status transition.
// The agent never commits — the runner commits the whole worktree at the end
// of a successful turn, so the result is deterministic across providers.
// A turn ends either in a result or in a question (no realtime channel into a
// running agent): the task lands on 'waiting_for_you' and the human's reply
// starts the next turn, resuming the provider session when it can.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  agentEnv,
  claudeStreamCommand,
  createClaudeTaskParser,
  flagPresent,
  runAgent,
  type AgentRunOptions,
} from './agent.js'
import type { TaskEvent, TaskRecord, TaskStatus } from './contract.js'
import { fixCommandFor } from './fix.js'
import { git, tryGit } from './git.js'
import { reviewLanguage } from './i18n.js'
import type { ChecksConfig } from './repo-config.js'
import {
  containerTaskCommandFor,
  runContainerTurn,
  type RunContainerTurnOptions,
} from './task-isolation.js'
import { createTaskWorktree, removeTaskWorktree, renameTaskBranch } from './task-worktree.js'
import { appendTaskEvent, loadTask, saveTask, type AppendTaskEventInput } from './tasks-store.js'

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

export type TaskTurnOutcome =
  | {
      kind: 'done'
      response: string
      sessionId: string | null
      tokens: number
      /** First turn only: the branch name the agent proposed for the task. */
      branchProposal?: string
    }
  | {
      kind: 'question'
      response: string
      question: string
      sessionId: string | null
      tokens: number
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
  timeoutMs: number
  signal?: AbortSignal
  /** Journal sink: the caller appends to the store and broadcasts. */
  onEvent: (event: AppendTaskEventInput) => void
  /** Cumulative streamed text (SSE only, never persisted). */
  onText?: (text: string) => void
  /** Cumulative token count of the turn (SSE live meter; final value persisted on the turn). */
  onTokens?: (total: number) => void
  runAgentFn?: (options: AgentRunOptions) => Promise<string>
  /** Egress allowlist of the cage (container isolation only). */
  allowedDomains?: readonly string[] | undefined
  /** Repo checks config: the base image of the cage falls back to it. */
  checksConfig?: ChecksConfig | null | undefined
  /** Test seam for the caged path; the default drives real containers. */
  runContainerTurnFn?: (options: RunContainerTurnOptions) => Promise<string>
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
  const parser = command.includes('--output-format stream-json')
    ? createClaudeTaskParser({
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
      })
    : null
  let fed = 0
  // Both paths deliver the SAME cumulative stdout, so the stream-json parser
  // is fed identically whether the agent ran on the host or in its box.
  const onText = (text: string): void => {
    if (parser) {
      parser.push(text.slice(fed))
      fed = text.length
    } else {
      opts.onText?.(text)
    }
  }
  const raw = caged
    ? await (opts.runContainerTurnFn ?? runContainerTurn)({
        taskId: opts.task.id,
        worktree: opts.cwd,
        command,
        prompt: opts.prompt,
        timeoutMs: opts.timeoutMs,
        ...(opts.allowedDomains ? { allowedDomains: opts.allowedDomains } : {}),
        ...(opts.checksConfig !== undefined ? { checksConfig: opts.checksConfig } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        onText,
      })
    : await run({
        command,
        prompt: opts.prompt,
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        env: agentEnv(command),
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
    return { kind: 'question', response, question, sessionId, tokens, ...branch }
  }
  opts.onEvent({ type: 'message', data: { text: preview(response) } })
  return { kind: 'done', response, sessionId, tokens, ...branch }
}

export type TaskActionResult = { ok: true } | { ok: false; code: number; error: string }

/** Store/broadcast toolkit handed to the end-of-turn review hook. */
export type TaskTurnIo = {
  /** Appends to the journal and broadcasts (store write first). */
  emit: (input: AppendTaskEventInput) => void
  /** Persists the (mutated) record with a fresh updated_at, then broadcasts it. */
  persist: () => void
  /** SSE-only progress line on the task_text channel; never persisted. */
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
  timeoutMs: number
  /** Cap of this runner's own pool; ignored when `slots` is provided. */
  maxParallel?: number
  /** Shared slot pool (global cap across runners); defaults to a private pool of maxParallel. */
  slots?: TaskSlotPool
  /** Broadcast hooks, called AFTER the corresponding store write. */
  onTask?: (record: TaskRecord) => void
  onEvent?: (taskId: string, event: TaskEvent) => void
  onText?: (taskId: string, text: string) => void
  /** Live token meter of the in-flight turn (SSE only; the final count lands on the turn). */
  onTokens?: (taskId: string, total: number) => void
  runAgentFn?: (options: AgentRunOptions) => Promise<string>
  /** Egress allowlist handed to every caged turn of this repo. */
  allowedDomains?: readonly string[] | undefined
  /** Repo checks config (base image fallback of the cage). */
  checksConfig?: ChecksConfig | null | undefined
  /** Test seam for the caged path; the default drives real containers. */
  runContainerTurnFn?: (options: RunContainerTurnOptions) => Promise<string>
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
  /** SIGTERM to the agent's process group (running) or drops the task from the queue. */
  interrupt: (taskId: string) => TaskActionResult
  /** Deletes the worktree AND the branch, marks the task 'failed'. Refused while running. */
  abandon: (taskId: string) => TaskActionResult
  /**
   * Graceful process exit: aborts every running agent, persists 'interrupted'
   * with an event {reason:'shutdown'} (queued tasks included — a 'queued'
   * record with no live process would be unstartable at next boot), keeps the
   * worktrees, and resolves once every in-flight turn has settled on disk.
   */
  shutdown: () => Promise<void>
  runningCount: () => number
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

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

  const finishTurn = (record: TaskRecord, outcome: TaskTurnOutcome, startedAt: number): void => {
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
    aborted: boolean,
  ): void => {
    record.work_ms += Date.now() - startedAt
    const turn = record.turns.at(-1)
    if (turn && !turn.ended_at) {
      turn.ended_at = new Date().toISOString()
    }
    if (aborted) {
      record.status = 'interrupted'
      emit(record.id, {
        type: 'interrupted',
        data: draining ? { reason: 'shutdown' } : { message: preview(errorMessage(err)) },
      })
    } else {
      record.status = 'failed'
      emit(record.id, { type: 'error', data: { message: preview(errorMessage(err)) } })
    }
    persist(record)
  }

  const ensureWorktree = (record: TaskRecord): void => {
    if (record.worktree && existsSync(record.worktree)) {
      return
    }
    if (record.work_on) {
      // Work-on task (POST /api/tasks branch=…): the conversation identifies
      // with its pre-existing branch — check the branch itself out, first
      // materialization and re-materialization alike. record.base already
      // holds the MR target (set by the server at creation): never overwrite
      // it, and a branch deleted or checked out elsewhere in the meantime
      // fails the turn with a readable error instead of forking a substitute.
      const wt = createTaskWorktree(opts.cwd, record.id, record.title, { branch: record.branch })
      record.worktree = wt.worktree
      return
    }
    // A base set BEFORE the first materialization (worktree still empty) is an
    // explicit request (POST /api/tasks base=…): honor it — a deleted branch
    // fails the turn rather than silently branching from somewhere else. Once
    // a worktree existed, base may hold a DETECTED ref (possibly remote, e.g.
    // 'origin/main'), so re-materialization keeps the auto-detection path.
    const explicitBase = !record.worktree && record.base ? { base: record.base } : {}
    const wt = createTaskWorktree(opts.cwd, record.id, record.title, explicitBase)
    record.base = wt.base
    record.branch = wt.branch
    record.worktree = wt.worktree
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

  /** Slot released: wake every runner sharing the pool, any queue may win it. */
  const releaseSlot = (id: string): void => {
    pool.running.delete(id)
    for (const wake of pool.pumps) {
      wake()
    }
  }

  const launch = (record: TaskRecord): void => {
    const controller = new AbortController()
    // Reserved before any await: a concurrent start()/pump() — on this runner
    // or on another one sharing the pool — must see the slot taken.
    active.set(record.id, controller)
    pool.running.add(record.id)
    try {
      ensureWorktree(record)
    } catch (err) {
      active.delete(record.id)
      failTurn(record, err, Date.now(), false)
      releaseSlot(record.id)
      return
    }
    record.status = 'running'
    persist(record)
    const startedAt = Date.now()
    const turn = runTaskTurn({
      cwd: record.worktree,
      task: record,
      prompt: composeTurnPrompt(record, opts.command),
      command: opts.command,
      timeoutMs: opts.timeoutMs,
      signal: controller.signal,
      onEvent: (event) => emit(record.id, event),
      onText: (text) => opts.onText?.(record.id, text),
      onTokens: (total) => opts.onTokens?.(record.id, total),
      ...(opts.runAgentFn ? { runAgentFn: opts.runAgentFn } : {}),
      ...(opts.allowedDomains ? { allowedDomains: opts.allowedDomains } : {}),
      ...(opts.checksConfig !== undefined ? { checksConfig: opts.checksConfig } : {}),
      ...(opts.runContainerTurnFn ? { runContainerTurnFn: opts.runContainerTurnFn } : {}),
    })
      .then((outcome) => finishTurn(record, outcome, startedAt))
      .catch((err: unknown) => failTurn(record, err, startedAt, controller.signal.aborted))
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

    interrupt(taskId) {
      const controller = active.get(taskId)
      if (controller) {
        // The abort rejects the agent promise; failTurn persists 'interrupted'.
        controller.abort()
        return { ok: true }
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
      emit(taskId, { type: 'interrupted', data: {} })
      persist(record)
      return { ok: true }
    },

    abandon(taskId) {
      if (active.has(taskId)) {
        return { ok: false, code: 409, error: 'task is running' }
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
        queue.splice(queued, 1)
      }
      if (record.status === 'waiting_for_you') {
        accrueWait(record)
      }
      // Abandon is the one place the branch dies with the worktree: the task's
      // work is explicitly discarded, unlike interrupt/shutdown which keep both.
      // EXCEPT for work-on tasks — their branch pre-existed the conversation
      // and belongs to the user, so only the worktree checkout is discarded.
      removeTaskWorktree(opts.cwd, taskId, record.branch, { deleteBranch: !record.work_on })
      const turn = record.turns.at(-1)
      if (turn && !turn.ended_at) {
        turn.ended_at = new Date().toISOString()
      }
      // Cleaning up a SHIPPED task is housekeeping, not a discard: its work
      // lives on in the pushed branch/MR, the status must keep saying so.
      // Everything else abandoned mid-cycle is discarded work: failed.
      if (record.status !== 'shipped') {
        record.status = 'failed'
      }
      emit(taskId, { type: 'error', data: { message: 'worktree removed, task abandoned' } })
      persist(record)
      return { ok: true }
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
        emit(id, { type: 'interrupted', data: { reason: 'shutdown' } })
        persist(record)
      }
      for (const controller of active.values()) {
        // SIGTERM to the agent's process group; failTurn persists 'interrupted'
        // with {reason:'shutdown'} because draining is set.
        controller.abort()
      }
      await Promise.allSettled(inflight.values())
    },

    runningCount: () => active.size,
  }
}
