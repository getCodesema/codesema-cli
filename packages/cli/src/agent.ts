import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReasonCode } from './contract.js'
import { t } from './i18n.js'

const CLAUDE_STREAM_JSON_FLAG = '--output-format stream-json'
const CLAUDE_STREAM_FLAGS = `${CLAUDE_STREAM_JSON_FLAG} --include-partial-messages --verbose`

const AGENT_BINS = ['claude', 'codex', 'gemini', 'grok'] as const
type KnownAgent = (typeof AGENT_BINS)[number]

export function knownAgent(command: string): KnownAgent | null {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const bin = first.split('/').pop() ?? ''
  return (AGENT_BINS as readonly string[]).includes(bin) ? (bin as KnownAgent) : null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A flag counts as present only as a standalone token outside quotes: the same
 * literal inside another argument (e.g. an --append-system-prompt text) must
 * not disable the hardening.
 */
export function flagPresent(command: string, flag: string): boolean {
  const unquoted = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, ' ')
  return new RegExp(`(^|\\s)${escapeRegExp(flag)}(=|\\s|$)`).test(unquoted)
}

/**
 * Placeholder a command puts where its CLI expects a PATH to the prompt.
 *
 * Node hands a spawned child a Unix SOCKET as stdin, not a pipe (libuv builds
 * stdio out of socketpair), and opening /dev/stdin on a socket fails with
 * ENXIO. So an agent that cannot read a stream cannot be bridged with
 * `--prompt-file /dev/stdin` either, and passing the prompt as an argument
 * caps it at one page short of 128 KiB (MAX_ARG_STRLEN) — a limit a real diff
 * reaches. Such a command names {promptFile} instead: the prompt is written to
 * a private temp file, the placeholder becomes its quoted path, and the file is
 * deleted when the run settles, whatever ended it.
 */
export const PROMPT_FILE_PLACEHOLDER = '{promptFile}'

export function usesPromptFile(command: string): boolean {
  return command.includes(PROMPT_FILE_PLACEHOLDER)
}

/** Substitutes the placeholder, quoted: a temp dir can carry spaces on Windows. */
export function promptFileCommand(command: string, path: string): string {
  return command.replaceAll(PROMPT_FILE_PLACEHOLDER, `"${path}"`)
}

/**
 * The review agent is a pure text transformer (prompt on stdin, review JSON on
 * stdout), so tools, MCP servers and repo-provided agent settings are switched
 * off at the CLI level for known agents; a hostile repo cannot reach the agent
 * through its own .claude/ or AGENTS.md. Flags the user already set win.
 * Gemini has no CLI flag for this (tools are settings.json-only); its headless
 * policy engine already denies shell/write tools. Grok is cut off by a permission
 * rule rather than a tool list: `--tools ""` and an unknown allowlist both leave
 * every tool reachable (verified on grok 1.0.5), while `--deny '*'` refuses the
 * shell AND the file tools. Grok still LOADS the repo's AGENTS.md/CLAUDE.md and
 * has no flag to stop it (codex's project_doc_max_bytes has no equivalent), so
 * what the deny rule buys is the absence of execution, not the absence of
 * injected instructions. Do NOT apply this to the fix runner: applying fixes
 * needs the edit tools.
 */
export function hardenedReviewCommand(command: string): string {
  const agent = knownAgent(command)
  if (agent === 'claude') {
    const flags: string[] = []
    if (!flagPresent(command, '--tools')) {
      flags.push('--tools ""')
    }
    if (!flagPresent(command, '--strict-mcp-config')) {
      flags.push('--strict-mcp-config')
    }
    if (!flagPresent(command, '--setting-sources')) {
      flags.push('--setting-sources user')
    }
    return flags.length > 0 ? `${command} ${flags.join(' ')}` : command
  }
  if (agent === 'codex') {
    if (
      flagPresent(command, '--dangerously-bypass-approvals-and-sandbox') ||
      flagPresent(command, '--yolo')
    ) {
      return command
    }
    const flags: string[] = []
    if (!flagPresent(command, '--sandbox') && !flagPresent(command, '-s')) {
      flags.push('--sandbox read-only')
    }
    if (!flagPresent(command, '--ask-for-approval') && !flagPresent(command, '-a')) {
      flags.push('--ask-for-approval never')
    }
    if (!flagPresent(command, 'project_doc_max_bytes')) {
      flags.push('-c project_doc_max_bytes=0')
    }
    if (flags.length === 0) {
      return command
    }
    const stdinMarker = /\s-$/.test(command)
    const base = stdinMarker ? command.slice(0, -2) : command
    return [base, ...flags, ...(stdinMarker ? ['-'] : [])].join(' ')
  }
  if (agent === 'grok') {
    // Any permission-shaping flag means the user made this call themselves:
    // a narrower --tools, a rule of their own, or a deliberate bypass
    // (--always-approve, --permission-mode bypassPermissions) all win.
    const owned = [
      '--deny',
      '--disallowedTools',
      '--allow',
      '--allowedTools',
      '--tools',
      '--disallowed-tools',
      '--permission-mode',
      '--always-approve',
    ]
    if (owned.some((flag) => flagPresent(command, flag))) {
      return command
    }
    return `${command} --deny '*'`
  }
  return command
}

const BASE_ENV_VARS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
]

const AGENT_ENV_PREFIXES: Record<KnownAgent, string[]> = {
  claude: ['ANTHROPIC_', 'CLAUDE_'],
  codex: ['OPENAI_', 'CODEX_'],
  gemini: ['GEMINI_', 'GOOGLE_'],
  grok: ['XAI_', 'GROK_'],
}

/**
 * Known agents get a minimal environment: base shell vars, proxy settings and
 * the provider's own variables (auth included). Everything else in the user's
 * environment (cloud keys, tokens, DB URLs) stays out of the subprocess.
 * Custom commands inherit the full environment: their needs are unknowable
 * and the user chose them explicitly.
 */
export function agentEnv(
  command: string,
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv | undefined {
  // cmd.exe needs SystemRoot/ComSpec and Windows env names are case-insensitive:
  // narrowing there can break the spawn itself, so Windows inherits the full env.
  if (platform === 'win32') {
    return undefined
  }
  const agent = knownAgent(command)
  if (!agent) {
    return undefined
  }
  const prefixes = [...AGENT_ENV_PREFIXES[agent]]
  const names = new Set(BASE_ENV_VARS)
  // Claude Code on Bedrock/Vertex authenticates through the cloud SDK env,
  // not ANTHROPIC_*: widen only when those modes are switched on.
  if (agent === 'claude') {
    if (source.CLAUDE_CODE_USE_BEDROCK) {
      prefixes.push('AWS_')
    }
    if (source.CLAUDE_CODE_USE_VERTEX) {
      prefixes.push('GOOGLE_', 'GCP_')
      names.add('CLOUD_ML_REGION')
    }
  }
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue
    }
    if (names.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) {
      env[key] = value
    }
  }
  return env
}

export function claudeStreamCommand(command: string): string | null {
  if (!/^claude(\s|$)/.test(command)) {
    return null
  }
  if (!/(^|\s)(-p|--print)(\s|$)/.test(command)) {
    return null
  }
  if (command.includes('--output-format') || command.includes('--input-format')) {
    return null
  }
  return `${command} ${CLAUDE_STREAM_FLAGS}`
}

/**
 * Whether the command's stdout is claude's JSONL stream — either because this
 * module added the flags (claudeStreamCommand) or because the caller did it
 * itself (taskCommandFor). The DECODING owner differs between those two cases,
 * the stream does not: the watchdog reads its semantic signals from both.
 *
 * Read as a TOKEN, like flagPresent: `--output-format=stream-json` counts,
 * quoted prose mentioning the flag does not, and `--output-format json` never
 * passes for the stream form.
 */
export function emitsClaudeStreamJson(command: string): boolean {
  const unquoted = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, ' ')
  return /(^|\s)--output-format[\s=]+stream-json(\s|$)/.test(unquoted)
}

export type ClaudeStreamParser = {
  push: (chunk: string) => void
  finalText: () => string | null
}

/** Ceiling for tool_use/tool_result summaries in task events: enough to tell
 *  what the agent is doing, never a full file body in the journal. */
export const TASK_TOOL_SUMMARY_MAX = 400

/**
 * Coarse window scanned before counting code points. A tool that writes a 5 MB
 * file must not cost a 5-million-element array to produce a 400-character
 * summary, and the stream is decoded once per consumer. Two UTF-16 units per
 * code point is the worst case, so this window always holds strictly more than
 * TASK_TOOL_SUMMARY_MAX code points and the truncation below is unchanged by
 * it (a surrogate split at the edge falls outside the kept prefix).
 */
const SUMMARY_SCAN_MAX = TASK_TOOL_SUMMARY_MAX * 4

/** One-line summary of an arbitrary tool payload, truncated by code points. */
function summarizePayload(value: unknown): string {
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value) ?? ''
    } catch {
      text = String(value)
    }
  }
  if (text.length <= SUMMARY_SCAN_MAX) {
    const all = Array.from(text)
    return all.length > TASK_TOOL_SUMMARY_MAX
      ? `${all.slice(0, TASK_TOOL_SUMMARY_MAX - 1).join('')}…`
      : text
  }
  return `${Array.from(text.slice(0, SUMMARY_SCAN_MAX))
    .slice(0, TASK_TOOL_SUMMARY_MAX - 1)
    .join('')}…`
}

type ClaudeContentBlock = {
  type?: string
  text?: string
  name?: string
  input?: unknown
  content?: unknown
}

/** A tool_result's content is either a plain string or text blocks: flatten to one string. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return (content as ClaudeContentBlock[])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
  }
  return ''
}

export type ClaudeTaskParserHandlers = {
  /**
   * ANY frame the stream decoded, whatever its type — the single signal that
   * says "this agent is still alive". Fired before the type-specific handler
   * and for unknown frame types too; an illegible line is not a frame and
   * fires nothing, so a provider spewing garbage never passes for activity.
   */
  onActivity?: () => void
  /**
   * Skip the tool payload summaries entirely. A consumer that only COUNTS
   * tools — the watchdog — must not pay a JSON.stringify of every tool input
   * for text it will never read; `inputSummary`/`summary` are then ''.
   */
  countOnly?: boolean
  /** Provider session id from the system/init event, needed for --resume on later turns. */
  onInit?: (sessionId: string) => void
  /** A complete assistant tool call: name + summarized input (bounded). */
  onToolUse?: (name: string, inputSummary: string) => void
  /** Summarized tool output (bounded). */
  onToolResult?: (summary: string) => void
  /**
   * Text of ONE assistant message, cumulative WITHIN that message only.
   * `seq` is that message's index in the turn: a turn is a conversation, not
   * one paragraph — claude splits its reply around every tool call, and each
   * of those messages is a separate thing the agent SAID. Successive messages
   * therefore never concatenate, and a consumer tells "more text on the
   * current message" (same seq) from "a new message" (bigger seq).
   */
  onText?: (text: string, seq: number) => void
  /**
   * Cumulative LLM tokens (input+output) of the turn so far. Fired on every
   * usage-bearing frame: completed assistant messages accumulate, the final
   * result event is authoritative when it carries usage.
   */
  onTokens?: (total: number) => void
}

/**
 * Extended claude JSONL parser for agent tasks: everything the review stream
 * parser does, plus session capture (system/init) and tool activity. Tool
 * events are read from the complete `assistant`/`user` messages only, never
 * from partial stream_events, so each tool call is reported exactly once.
 */
/** input+output of one usage payload; cache reads are billed input too but negligible for a live counter. */
function usageTotal(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') {
    return null
  }
  const u = usage as { input_tokens?: unknown; output_tokens?: unknown }
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0
  return input > 0 || output > 0 ? input + output : null
}

export function createClaudeTaskParser(handlers: ClaudeTaskParserHandlers): ClaudeStreamParser {
  const { onText } = handlers
  const summarize = (value: unknown): string => (handlers.countOnly ? '' : summarizePayload(value))
  let lineBuffer = ''
  /** Index of the message currently being streamed (its bubble, client-side). */
  let messageSeq = 0
  /** Cumulative text of THAT message; reset at every message boundary. */
  let messageText = ''
  /** Last non-empty message text: the turn's reply when no result frame comes. */
  let lastText = ''
  let resultText: string | null = null
  let tokensSettled = 0

  const handleAssistant = (event: Record<string, unknown>) => {
    const message = event.message as { content?: ClaudeContentBlock[] } | undefined
    const blocks = Array.isArray(message?.content) ? message.content : []
    const text = blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    if (text) {
      // Authoritative version of what the partial deltas were building.
      messageText = text
      lastText = text
      onText?.(messageText, messageSeq)
    }
    for (const block of blocks) {
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        handlers.onToolUse?.(block.name, summarize(block.input ?? {}))
      }
    }
    const usage = usageTotal((event.message as { usage?: unknown } | undefined)?.usage)
    if (usage !== null) {
      tokensSettled += usage
      handlers.onTokens?.(tokensSettled)
    }
    // A complete assistant message CLOSES the current one: whatever streams
    // next is a new message (typically after the tool calls this one asked
    // for). An empty message never produced text, so it only shifts the
    // index — it can never open an empty bubble downstream.
    messageSeq++
    messageText = ''
  }

  const handleLine = (line: string) => {
    if (!line.trim()) {
      return
    }
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    handlers.onActivity?.()
    if (event.type === 'system') {
      if (event.subtype === 'init' && typeof event.session_id === 'string' && event.session_id) {
        handlers.onInit?.(event.session_id)
      }
      return
    }
    if (event.type === 'stream_event') {
      const inner = (event.event ?? {}) as {
        type?: string
        delta?: { type?: string; text?: string }
      }
      if (
        inner.type === 'content_block_delta' &&
        inner.delta?.type === 'text_delta' &&
        inner.delta.text
      ) {
        messageText += inner.delta.text
        lastText = messageText
        onText?.(messageText, messageSeq)
      }
      return
    }
    if (event.type === 'assistant') {
      handleAssistant(event)
      return
    }
    if (event.type === 'user') {
      const message = event.message as { content?: ClaudeContentBlock[] } | undefined
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        if (block.type === 'tool_result') {
          handlers.onToolResult?.(
            handlers.countOnly ? '' : summarizePayload(toolResultText(block.content)),
          )
        }
      }
      return
    }
    if (event.type === 'result') {
      if (typeof event.result === 'string') {
        resultText = event.result
      }
      // The result frame's usage is the whole turn as the provider billed it.
      const usage = usageTotal(event.usage)
      if (usage !== null && usage > tokensSettled) {
        tokensSettled = usage
        handlers.onTokens?.(tokensSettled)
      }
    }
  }

  return {
    push(chunk: string) {
      lineBuffer += chunk
      for (;;) {
        const nl = lineBuffer.indexOf('\n')
        if (nl < 0) {
          break
        }
        handleLine(lineBuffer.slice(0, nl))
        lineBuffer = lineBuffer.slice(nl + 1)
      }
    },
    finalText() {
      if (lineBuffer.trim()) {
        handleLine(lineBuffer)
        lineBuffer = ''
      }
      // Fallback for a stream cut before its result frame: the LAST message
      // is the reply (the earlier ones were steps on the way there).
      return resultText ?? (lastText || null)
    },
  }
}

/**
 * Parses claude's JSONL stream: text_delta events while streaming, result at
 * the end. onText carries the current MESSAGE's text (see the task parser),
 * which is exactly what a partial-JSON reader wants — the review's JSON never
 * spans two messages. `handlers` carries whatever else wants to read the same
 * stream without decoding it a second time (runAgent's watchdog signals).
 */
export function createClaudeStreamParser(
  onText?: (text: string) => void,
  handlers?: Omit<ClaudeTaskParserHandlers, 'onText'>,
): ClaudeStreamParser {
  return createClaudeTaskParser({ ...handlers, ...(onText ? { onText } : {}) })
}

// --- semantic watchdog (D3) -------------------------------------------------

/**
 * What a watchdog cut ran out of. Both are the SAME reason code
 * (`inactivity_timeout`): from the outside, the run died of silence — the
 * cause only says which silence, an agent saying nothing or a tool never
 * coming back.
 */
export type AgentWatchdogCause = 'inactivity' | 'tool_budget'

/** The three budgets of D3, in milliseconds. */
export type WatchdogBudgets = {
  /** Silence, TOOLS ASIDE, past which the run is considered dead. */
  inactivityMs: number
  /** How long a tool may stay in flight before the run is considered stuck. */
  toolBudgetMs: number
  /** Period of the liveness frame that lets the UI tell "long" from "dead". */
  heartbeatMs: number
}

/**
 * D3's defaults. A wall-clock timeout answers "how long has this run lasted?",
 * which says nothing about whether the agent is alive; these answer "when did
 * it last do anything?" and "has a tool been out there forever?", which does.
 */
export const AGENT_WATCHDOG_DEFAULTS: WatchdogBudgets = {
  inactivityMs: 30 * 60 * 1000,
  toolBudgetMs: 2 * 60 * 60 * 1000,
  heartbeatMs: 30 * 1000,
}

/** One liveness frame: what the run has been doing since the previous beat. */
export type AgentHeartbeat = {
  /** Clock instant of the beat (injected clock: never assumed to be Date.now). */
  at: number
  /** Milliseconds since the last decoded frame. */
  idleMs: number
  /** Tools open right now; > 0 means the silence is a WAIT, not a death. */
  inFlightTools: number
}

export type SemanticWatchdog = {
  /** A frame was decoded (or bytes arrived): the run is alive at this instant. */
  markActivity: () => void
  /** A `tool_use` of a COMPLETE assistant frame opened a tool. */
  openTool: () => void
  /**
   * A `tool_result` of a COMPLETE user frame closed a tool.
   * @returns false when no tool was open — an orphan result, ignored.
   */
  closeTool: () => boolean
  inFlightTools: () => number
  /** Evaluates the budgets at the clock's current instant; fires at most one expiry. */
  tick: () => void
  /** Disarms for good: a stopped watchdog neither beats nor expires. */
  stop: () => void
}

/**
 * The liveness state machine, clock-injected and timer-free: it decides, the
 * caller drives it (see runAgent). No test ever waits out a budget counted in
 * tens of minutes — it moves the clock and calls `tick`.
 *
 * The tool budget bounds an UNINTERRUPTED in-flight window, not one identified
 * tool: the counter carries no tool ids, by design (the ticket asks to lean on
 * the parser's existing granularity rather than add id correlation). The
 * window opens when the count leaves 0 and closes when it returns to 0, so a
 * hundred tools called back to back each get a fresh window, while a count
 * that never returns to 0 — including an ORPHAN `tool_use` whose result never
 * comes — holds the inactivity watchdog suspended for at most `toolBudgetMs`,
 * after which the tool budget cuts the run. That upper bound is the whole
 * point: a suspended watchdog is always temporary, never permanent.
 */
export function createSemanticWatchdog(opts: {
  budgets: WatchdogBudgets
  now: () => number
  onHeartbeat?: ((beat: AgentHeartbeat) => void) | undefined
  /** Fired ONCE, with the elapsed time that blew the budget. */
  onExpire: (cause: AgentWatchdogCause, elapsedMs: number) => void
}): SemanticWatchdog {
  const { budgets, now } = opts
  let lastActivityAt = now()
  let lastBeatAt = lastActivityAt
  let inFlight = 0
  /** When the CURRENT uninterrupted in-flight window opened; null when no tool is out. */
  let toolsSince: number | null = null
  let expired = false
  let stopped = false

  return {
    markActivity() {
      lastActivityAt = now()
    },
    openTool() {
      inFlight++
      if (inFlight === 1) {
        toolsSince = now()
      }
    },
    closeTool() {
      // An orphan tool_result (truncated stream, replayed turn, a provider
      // that pairs badly) is IGNORED rather than counted: a negative counter
      // would suspend the inactivity watchdog forever, i.e. disarm it in
      // silence — the single costliest way this module can fail.
      if (inFlight === 0) {
        return false
      }
      inFlight--
      if (inFlight === 0) {
        toolsSince = null
      }
      return true
    },
    inFlightTools: () => inFlight,
    tick() {
      if (stopped) {
        return
      }
      const at = now()
      // The beat comes first and keeps coming while a tool is out: a run that
      // is long has to look different from a run that is dead, and that is
      // exactly the moment the two are hardest to tell apart.
      if (at - lastBeatAt >= budgets.heartbeatMs) {
        lastBeatAt = at
        opts.onHeartbeat?.({ at, idleMs: at - lastActivityAt, inFlightTools: inFlight })
      }
      if (expired) {
        return
      }
      if (toolsSince !== null) {
        // Inactivity is SUSPENDED here on purpose: an agent waiting on a
        // twenty-minute test suite is not dead, it is waiting. Only the tool
        // budget can cut this window.
        const elapsed = at - toolsSince
        if (elapsed >= budgets.toolBudgetMs) {
          expired = true
          opts.onExpire('tool_budget', elapsed)
        }
        return
      }
      const idle = at - lastActivityAt
      if (idle >= budgets.inactivityMs) {
        expired = true
        opts.onExpire('inactivity', idle)
      }
    },
    stop() {
      stopped = true
    },
  }
}

/** Coarsest polling period: 30 s is invisible against budgets counted in tens of minutes. */
const WATCHDOG_TICK_MAX_MS = 30_000
/** Finest: a test may set millisecond budgets, a real run must never spin. */
const WATCHDOG_TICK_MIN_MS = 10

/** How often a run evaluates the budgets: fine enough for the smallest of them, never faster. */
export function watchdogTickMs(budgets: WatchdogBudgets): number {
  const smallest = Math.min(budgets.inactivityMs, budgets.toolBudgetMs, budgets.heartbeatMs)
  return Math.max(WATCHDOG_TICK_MIN_MS, Math.min(WATCHDOG_TICK_MAX_MS, smallest))
}

/**
 * A run the semantic watchdog cut short. It carries D2's name for what
 * happened BESIDE the readable message, which stays exactly what it says —
 * invariant 2: the code is ADDED to the message, never a replacement for it.
 */
export class AgentWatchdogError extends Error {
  /** Retryable in D2: what has to change is the RUN or its environment, not the work on the branch. */
  readonly reasonCode: ReasonCode = 'inactivity_timeout'
  constructor(
    readonly watchdogCause: AgentWatchdogCause,
    message: string,
  ) {
    super(message)
    this.name = 'AgentWatchdogError'
  }
}

/** The reason code an agent failure names, or null when it names none (tolerant, never throws). */
export function agentReasonCode(err: unknown): ReasonCode | null {
  return err instanceof AgentWatchdogError ? err.reasonCode : null
}

/** The readable message a watchdog cut states, in the UI language. */
export function watchdogMessage(cause: AgentWatchdogCause, elapsedMs: number): string {
  const m = Math.max(1, Math.round(elapsedMs / 60_000))
  return cause === 'inactivity' ? t('agent.inactivity', { m }) : t('agent.toolBudget', { m })
}

// --- clocks, spawning, and the shape of a kill ------------------------------

/** Time source and timers of a run; injected so no test ever waits out a budget. */
export type AgentClock = {
  /** Milliseconds; the watchdog only ever reads differences. */
  now: () => number
  /** One-shot timer, returning its canceller. */
  setTimer: (fn: () => void, ms: number) => () => void
}

/**
 * Longest delay `setTimeout` accepts: a signed 32-bit count of milliseconds,
 * about 24.8 days. Node and bun both CLAMP anything larger to **1 ms** (with a
 * TimeoutOverflowWarning), which turns a ceiling of "in a month" into "right
 * now" — every turn would die at birth with `agent.timeout`. Clamping to the
 * ceiling instead makes an absurdly large budget mean "never fires in this
 * process's life", which is the honest reading of it: a delay that never comes
 * beats a delay that comes immediately.
 *
 * The clamp lives in the CLOCK so every consumer inherits it at once — the
 * absolute ceiling, the three watchdog budgets, the kill escalation and the
 * caged path all schedule through here.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1

export const systemClock: AgentClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, Math.min(ms, MAX_TIMER_MS))
    return () => clearTimeout(handle)
  },
}

/** Spawn seam: the default is node's `spawn`; tests hand back a recording double. */
export type AgentSpawnFn = (command: string, options: SpawnOptions) => ChildProcess

/**
 * Signal seam. Receives the NEGATIVE pid when the agent runs in its own
 * process group, which is the whole point of `detached`: one signal reaches
 * the shell AND everything it started.
 */
export type AgentKillFn = (pid: number, signal: NodeJS.Signals) => void

/**
 * Bounded wait between SIGTERM and SIGKILL: long enough for an agent to flush
 * its last words and exit on its own, short enough that a kill actually kills.
 */
export const AGENT_KILL_GRACE_MS = 5_000

/**
 * Bounded wait between SIGKILL and settling the promise anyway. SIGKILL is not
 * a guarantee the process disappears (uninterruptible I/O, a zombie holding an
 * inherited pipe open) and the promise is what a graceful shutdown awaits: a
 * run that can never settle turns Ctrl-C into a hang. Past this, the run
 * REPORTS what killed it and lets go of the streams.
 */
export const AGENT_SETTLE_GRACE_MS = 10_000

/**
 * Slack added on top of the largest watchdog budget when deriving a run's
 * effective ceiling: room for the full kill escalation plus a comfortable
 * margin, so the ceiling can never fire first by a hair.
 */
export const WATCHDOG_CAP_MARGIN_MS = 60_000

/**
 * The absolute ceiling a run actually gets. A ceiling BELOW the watchdog
 * budgets silently cancels the watchdog — the run always dies of the wall
 * clock first, with `agent.timeout` and no reason code, which is exactly the
 * bug the semantic watchdog exists to remove (the shipped default was a 900 s
 * ceiling under a 1 800 s inactivity budget: the watchdog could never fire
 * once). So the ceiling is raised, never lowered, to sit above the largest
 * budget plus the whole kill escalation.
 *
 * Only long-lived AGENT TURNS use this; the review and fix runners keep their
 * historical `--timeout` verbatim, which is the contract their users know.
 */
export function effectiveAbsoluteCapMs(configuredMs: number, budgets: WatchdogBudgets): number {
  const floor =
    Math.max(budgets.inactivityMs, budgets.toolBudgetMs) +
    AGENT_KILL_GRACE_MS +
    AGENT_SETTLE_GRACE_MS +
    WATCHDOG_CAP_MARGIN_MS
  return Math.max(configuredMs, floor)
}

/**
 * The semantic watchdog, armed over one run's stdout and ticking on the
 * injected clock. Two ways to feed it, never both:
 *
 * - the caller already decodes the stream → it grafts `handlers` onto its own
 *   parser and never calls `push`, so nothing is decoded twice;
 * - the caller does not → it calls `push` with the raw stdout, which decodes
 *   the frames when the command emits claude JSONL and otherwise falls back to
 *   counting BYTES as life (all a provider we cannot read can offer: no tool
 *   budget there, only the inactivity guard).
 */
export type StreamWatchdog = {
  /** Graft onto a parser the caller already owns. */
  handlers: ClaudeTaskParserHandlers
  /** Feed raw stdout here when the caller owns no parser. */
  push: (chunk: string) => void
  /** Whether this stream is decodable at all (false = bytes-only fallback). */
  decodable: boolean
  stop: () => void
}

export function armStreamWatchdog(opts: {
  /** The agent command line whose stdout this is: says whether it can be decoded. */
  command: string
  /** True when the caller pushes the stream through its own parser carrying `handlers`. */
  callerDecodes: boolean
  budgets: WatchdogBudgets
  clock: AgentClock
  onHeartbeat?: ((beat: AgentHeartbeat) => void) | undefined
  onExpire: (cause: AgentWatchdogCause, elapsedMs: number) => void
}): StreamWatchdog {
  const watchdog = createSemanticWatchdog({
    budgets: opts.budgets,
    now: opts.clock.now,
    ...(opts.onHeartbeat ? { onHeartbeat: opts.onHeartbeat } : {}),
    onExpire: (cause, elapsedMs) => {
      stop()
      opts.onExpire(cause, elapsedMs)
    },
  })
  const handlers: ClaudeTaskParserHandlers = {
    // Activity is a DECODED FRAME wherever one can be decoded: raw bytes on a
    // readable stream would let a provider dribbling garbage pass for alive.
    onActivity: () => watchdog.markActivity(),
    onToolUse: () => watchdog.openTool(),
    onToolResult: () => {
      watchdog.closeTool()
    },
    countOnly: true,
  }
  const decodable = emitsClaudeStreamJson(opts.command)
  const ownParser = !opts.callerDecodes && decodable ? createClaudeTaskParser(handlers) : null

  let tickCancel: (() => void) | null = null
  let stopped = false
  const stop = (): void => {
    stopped = true
    watchdog.stop()
    tickCancel?.()
    tickCancel = null
  }
  const tickMs = watchdogTickMs(opts.budgets)
  const armTick = (): void => {
    if (stopped) {
      return
    }
    tickCancel = opts.clock.setTimer(() => {
      tickCancel = null
      watchdog.tick()
      armTick()
    }, tickMs)
  }
  armTick()

  return {
    handlers,
    decodable,
    push(chunk) {
      if (opts.callerDecodes) {
        return
      }
      if (ownParser) {
        ownParser.push(chunk)
        return
      }
      // Nothing here can be decoded: bytes flowing are the only life signal
      // this provider offers, and a tool it runs in silence counts as silence.
      watchdog.markActivity()
    },
    stop,
  }
}

// --- running an agent -------------------------------------------------------

export type AgentRunOptions = {
  command: string
  prompt: string
  cwd: string
  /**
   * LAST-RESORT ceiling on the whole run, in milliseconds. This is a wall
   * clock: it measures the one thing that says nothing about whether the agent
   * is alive, so it is NEVER the mechanism that detects a dead run — the
   * semantic watchdog below is. It stays as the net under the net, for the
   * case where the watchdog itself is blind (a stream that lies, a chatty
   * infinite tool loop), and it rejects with its own distinct `agent.timeout`.
   *
   * A caller running long agent TURNS must pass it through
   * `effectiveAbsoluteCapMs`, or a ceiling below the budgets cancels the
   * watchdog outright.
   */
  absoluteCapMs: number
  /** Environment for the subprocess; undefined inherits the full process env. */
  env?: NodeJS.ProcessEnv | undefined
  /** Cumulative review text so far, called on every update from the agent. */
  onText?: (text: string) => void
  /** Aborting interrupts the run: the kill escalation runs, the promise rejects. */
  signal?: AbortSignal | undefined
  /** Watchdog budgets (D3 defaults when absent); resolveWatchdogBudgets reads them from the config. */
  watchdog?: WatchdogBudgets | undefined
  /** Liveness frame, one per heartbeat period. */
  onHeartbeat?: ((beat: AgentHeartbeat) => void) | undefined
  /** Test seams: injected clock, spawn and signal delivery (no real process, no real wait). */
  clock?: AgentClock | undefined
  spawnFn?: AgentSpawnFn | undefined
  killFn?: AgentKillFn | undefined
}

export function runAgent(opts: AgentRunOptions): Promise<string> {
  const streamCommand = claudeStreamCommand(opts.command)
  const baseCommand = streamCommand ?? opts.command
  // 0o700 on the directory: the prompt carries the whole diff, so it is never
  // readable by another user of the machine while the agent works on it.
  const promptDir = usesPromptFile(baseCommand)
    ? mkdtempSync(join(tmpdir(), 'codesema-prompt-'))
    : null
  const promptPath = promptDir === null ? null : join(promptDir, 'prompt.txt')
  if (promptPath !== null) {
    writeFileSync(promptPath, opts.prompt, { mode: 0o600 })
  }
  const command = promptPath === null ? baseCommand : promptFileCommand(baseCommand, promptPath)
  const clock = opts.clock ?? systemClock
  const budgets = opts.watchdog ?? AGENT_WATCHDOG_DEFAULTS
  const spawnFn = opts.spawnFn ?? spawn
  const killFn: AgentKillFn =
    opts.killFn ??
    ((pid, signal) => {
      process.kill(pid, signal)
    })

  return new Promise((resolve, reject) => {
    // detached (non-Windows): the agent runs in its own process group, so a
    // single kill(-pid) reaches the shell AND its children.
    const detached = process.platform !== 'win32'
    const child = spawnFn(command, {
      shell: true,
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
      detached,
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    })
    const stdin = child.stdin
    const stdout = child.stdout
    // Registered BEFORE anything can close stdin: an agent that crashes closes
    // it early, and without this handler the EPIPE would kill the host process.
    stdin?.on('error', () => {})

    let out = ''
    let capped = false
    let aborted = false
    let killing = false
    let settled = false
    let cut: { cause: AgentWatchdogCause; elapsedMs: number } | null = null
    let capCancel: (() => void) | null = null
    let killCancel: (() => void) | null = null
    let settleCancel: (() => void) | null = null

    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (detached && child.pid) {
          killFn(-child.pid, signal)
        } else {
          child.kill(signal)
        }
      } catch {
        // process group already gone
      }
    }

    /** Settles once, whether the child ever reported its own death or not. */
    const finish = (outcome: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      stopTimers()
      opts.signal?.removeEventListener('abort', onAbort)
      // Removed by name, never recursively: this deletes exactly the two
      // things it created, and leaves anything else alone.
      if (promptPath !== null && promptDir !== null) {
        try {
          unlinkSync(promptPath)
          rmdirSync(promptDir)
        } catch {
          // a temp file the OS will collect anyway: never worth failing a run
        }
      }
      outcome()
    }

    /** What the run rejects/resolves with, given everything known about it. */
    const settleFromState = (code: number | null): void => {
      // A watchdog cut that already started the escalation OWNS the outcome: a
      // human hitting Stop during the grace period is reacting to the kill, not
      // causing it, and overwriting the cause would lose the reason code and
      // the resumable status that goes with it.
      if (cut) {
        reject(new AgentWatchdogError(cut.cause, watchdogMessage(cut.cause, cut.elapsedMs)))
      } else if (aborted) {
        reject(new Error(t('agent.interrupted')))
      } else if (capped) {
        reject(new Error(t('agent.timeout', { s: Math.round(opts.absoluteCapMs / 1000) })))
      } else if (code === 0) {
        resolve(parser ? (parser.finalText() ?? out) : out)
      } else {
        reject(new Error(t('agent.exitCode', { code })))
      }
    }

    /**
     * The kill, in the ONE order that both ends it and keeps what it produced:
     * stdin → SIGTERM → bounded wait → SIGKILL → stdout → bounded wait →
     * settle anyway. stdout comes after the SIGKILL on purpose — closing it
     * any earlier truncates the stream and throws away the agent's final
     * words, which are exactly what says why it died.
     */
    const escalateKill = (): void => {
      if (killing) {
        return
      }
      killing = true
      // Nothing left for the budgets to say, and a beat during the death
      // throes would only claim life where there is none.
      armed.stop()
      // 1. stdin. In today's flow it is ALREADY closed — runAgent writes the
      //    prompt and ends stdin as soon as the run starts — so this call is a
      //    guaranteed no-op here, kept as the first step because the order is
      //    the contract: the day a caller keeps stdin open (an interactive
      //    turn), EOF is the gentlest way to ask an agent to leave, and the
      //    error a redundant close raises is absorbed by the guard above.
      try {
        stdin?.end()
      } catch {
        // stdin already gone
      }
      // 2. SIGTERM to the whole group.
      signalGroup('SIGTERM')
      killCancel = clock.setTimer(() => {
        killCancel = null
        // 3. the wait is over: an agent that ignored SIGTERM gets 4. SIGKILL —
        //    without this, "kill" was only ever a polite request.
        signalGroup('SIGKILL')
        // 5. and only now stdout.
        try {
          stdout?.destroy()
        } catch {
          // stream already gone
        }
        // 6. SIGKILL is not a promise that the process disappears, and this
        //    promise is what shutdown() awaits. Report anyway rather than hang.
        settleCancel = clock.setTimer(() => {
          settleCancel = null
          finish(() => settleFromState(null))
        }, AGENT_SETTLE_GRACE_MS)
      }, AGENT_KILL_GRACE_MS)
    }

    const armed = armStreamWatchdog({
      command,
      callerDecodes: streamCommand !== null,
      budgets,
      clock,
      ...(opts.onHeartbeat ? { onHeartbeat: opts.onHeartbeat } : {}),
      onExpire: (cause, elapsedMs) => {
        if (killing) {
          return
        }
        cut = { cause, elapsedMs }
        escalateKill()
      },
    })

    function stopTimers(): void {
      armed.stop()
      capCancel?.()
      killCancel?.()
      settleCancel?.()
      capCancel = null
      killCancel = null
      settleCancel = null
    }

    capCancel = clock.setTimer(() => {
      capCancel = null
      if (killing) {
        return
      }
      capped = true
      escalateKill()
    }, opts.absoluteCapMs)

    // Same escalation as the watchdog, driven by the caller (task interrupt).
    function onAbort(): void {
      aborted = true
      escalateKill()
    }
    if (opts.signal?.aborted) {
      onAbort()
    } else {
      opts.signal?.addEventListener('abort', onAbort, { once: true })
    }

    // Text parser: only when THIS module added the stream flags. A caller that
    // set them itself owns the decoding of the text (see runTaskTurn), and the
    // watchdog then keeps its own reader — otherwise a task turn's forty-minute
    // test run would look like forty silent minutes and get killed for being
    // alive.
    const parser = streamCommand ? createClaudeStreamParser(opts.onText, armed.handlers) : null

    stdout?.on('data', (d: Buffer) => {
      const chunk = d.toString()
      out += chunk
      if (parser) {
        // Activity comes from the frames this push decodes, not from the bytes.
        parser.push(chunk)
      } else {
        armed.push(chunk)
        opts.onText?.(out)
      }
    })
    child.on('error', (err) => {
      finish(() => reject(err))
    })
    child.on('close', (code: number | null) => {
      // The worktree is NOT touched here (T1.6): the branch and its uncommitted
      // work are what a killed task has to show for itself.
      finish(() => settleFromState(code))
    })
    // An agent reading a prompt FILE still gets an immediate EOF: it must never
    // be left waiting on a stdin that will stay empty.
    if (promptPath === null) {
      stdin?.write(opts.prompt)
    }
    stdin?.end()
  })
}
