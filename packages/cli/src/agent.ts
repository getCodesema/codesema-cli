import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReasonCode } from './contract.js'
import {
  createCostMeter,
  usdToTicks,
  type CostCounters,
  type CostDegradation,
  type PriceRow,
  type RunEnv,
  type SettledCost,
} from './cost.js'
import { t } from './i18n.js'

const CLAUDE_STREAM_JSON_FLAG = '--output-format stream-json'
const CLAUDE_STREAM_FLAGS = `${CLAUDE_STREAM_JSON_FLAG} --include-partial-messages --verbose`

const AGENT_BINS = ['claude', 'codex', 'gemini', 'grok', 'opencode'] as const
export type KnownAgent = (typeof AGENT_BINS)[number]

export function knownAgent(command: string): KnownAgent | null {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const bin = first.split('/').pop() ?? ''
  return (AGENT_BINS as readonly string[]).includes(bin) ? (bin as KnownAgent) : null
}

/** Claude and OpenCode can run inside the task container cage. */
export function cageableAgent(command: string): boolean {
  const agent = knownAgent(command)
  return agent === 'claude' || agent === 'opencode'
}

/** OpenCode on the host is unsafe: its tools stay open without a cage. */
export function hostPolicyUnsafe(command: string): boolean {
  return knownAgent(command) === 'opencode'
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
  // opencode: command unchanged. Review hardening is OPENCODE_CONFIG_CONTENT
  // (wildcard deny, including agent.build/plan so a repo opencode.json cannot
  // re-enable tools via agent rules).
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
  opencode: [
    'OPENCODE_',
    'OPENROUTER_',
    'ANTHROPIC_',
    'CLAUDE_',
    'OPENAI_',
    'CODEX_',
    'GEMINI_',
    'GOOGLE_',
    'XAI_',
    'GROK_',
  ],
}

/** Inline opencode.json: wildcard deny, including default agent rules so a
 *  repo `agent.build.permission` cannot re-enable tools. */
export const OPENCODE_REVIEW_CONFIG = JSON.stringify({
  permission: { '*': 'deny' },
  agent: {
    build: { permission: { '*': 'deny' } },
    plan: { permission: { '*': 'deny' } },
  },
})

/**
 * Known agents get a minimal environment: base shell vars, proxy settings and
 * the provider's own variables (auth included). Everything else in the user's
 * environment (cloud keys, tokens, DB URLs) stays out of the subprocess.
 * Custom commands inherit the full environment: their needs are unknowable
 * and the user chose them explicitly.
 */
function applyInject(
  env: NodeJS.ProcessEnv,
  inject: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  if (!inject) {
    return env
  }
  const next = { ...env }
  for (const [key, value] of Object.entries(inject)) {
    if (next[key] === undefined) {
      next[key] = value
    }
  }
  return next
}

export function agentEnv(
  command: string,
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  inject?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv | undefined {
  // cmd.exe needs SystemRoot/ComSpec and Windows env names are case-insensitive:
  // narrowing there can break the spawn itself, so Windows inherits the full env.
  if (platform === 'win32') {
    return inject ? applyInject({ ...source }, inject) : undefined
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
  return applyInject(env, inject)
}

export function reviewAgentEnv(
  command: string,
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv | undefined {
  const inject =
    knownAgent(command) === 'opencode' && source.OPENCODE_CONFIG_CONTENT === undefined
      ? { OPENCODE_CONFIG_CONTENT: OPENCODE_REVIEW_CONFIG }
      : undefined
  return agentEnv(command, source, platform, inject)
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

export function opencodeJsonCommand(command: string): string | null {
  if (knownAgent(command) !== 'opencode') {
    return null
  }
  if (flagPresent(command, '--format')) {
    return null
  }
  return `${command} --format json`
}

export function emitsOpencodeJson(command: string): boolean {
  if (knownAgent(command) !== 'opencode') {
    return false
  }
  const unquoted = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, ' ')
  return /(^|\s)--format[\s=]+json(\s|$)/.test(unquoted)
}

export function streamFlagsCommand(command: string): string | null {
  return claudeStreamCommand(command) ?? opencodeJsonCommand(command)
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
  /**
   * BEST cost known for the turn so far (ticks, 1 tick = 1e-10 USD, plus its
   * provenance), republished at every change and `null` when the figure it
   * last published stops being true. A turn cut short therefore leaves the
   * caller holding exactly what is still defensible, never a stale number.
   */
  onCost?: (cost: SettledCost | null) => void
  /**
   * Something the accounting could not do, named and explained. NEUTRAL: a
   * cost that could not be established is a gap, not an error.
   */
  onCostDegraded?: (degradation: CostDegradation) => void
}

export type ClaudeTaskParserOptions = {
  /**
   * When the TURN started, ISO — the instant the price table is read at. Never
   * "now": a turn is billed at the rate in force while it ran, and there is no
   * clock anywhere on this path to substitute one. Absent (or unreadable)
   * prices nothing and says so, which is exactly right for the callers that
   * ask for no cost at all (the review parser).
   */
  at?: string
  /** Environment the agent ran with, for partner-platform detection. */
  env?: RunEnv
  /** Test seam: the price table to use. */
  prices?: readonly PriceRow[]
}

/**
 * Extended claude JSONL parser for agent tasks: everything the review stream
 * parser does, plus session capture (system/init) and tool activity. Tool
 * events are read from the complete `assistant`/`user` messages only, never
 * from partial stream_events, so each tool call is reported exactly once.
 */
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

/**
 * True for a frame produced INSIDE a subagent: Claude Code stamps those with
 * the id of the tool call that spawned them. The main loop's own frames carry
 * no such field.
 */
function isSubagentFrame(event: Record<string, unknown>): boolean {
  const parent = event.parent_tool_use_id
  return typeof parent === 'string' && parent.length > 0
}

/**
 * One usage payload, read as the four things it actually reports: base input,
 * output, cache reads and cache writes split by TTL.
 *
 * `total` (input+output) is what the LLM token meter has always shown and
 * stays exactly that. `counters` is what the fallback price table can bill —
 * output is absent from it on purpose (per-frame `output_tokens` is a
 * documented placeholder, see cost.ts).
 *
 * Cache writes come from `cache_creation.ephemeral_5m_input_tokens` /
 * `ephemeral_1h_input_tokens`, which say WHICH rate applies. The flat
 * `cache_creation_input_tokens` total is deliberately NOT used as a
 * substitute: it does not name a TTL, and picking one would be guessing a
 * price.
 */
function usageSplit(
  usage: unknown,
): { input: number; output: number; total: number; counters: CostCounters } | null {
  if (!usage || typeof usage !== 'object') {
    return null
  }
  const u = usage as {
    input_tokens?: unknown
    output_tokens?: unknown
    cache_read_input_tokens?: unknown
    cache_creation?: unknown
  }
  const input = num(u.input_tokens)
  const output = num(u.output_tokens)
  const cacheRead = num(u.cache_read_input_tokens)
  const creation = (u.cache_creation ?? {}) as {
    ephemeral_5m_input_tokens?: unknown
    ephemeral_1h_input_tokens?: unknown
  }
  const cacheWrite5m = num(creation.ephemeral_5m_input_tokens)
  const cacheWrite1h = num(creation.ephemeral_1h_input_tokens)
  if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite5m <= 0 && cacheWrite1h <= 0) {
    return null
  }
  return {
    input,
    output,
    total: input + output,
    counters: { input, cacheRead, cacheWrite5m, cacheWrite1h },
  }
}

export function createClaudeTaskParser(
  handlers: ClaudeTaskParserHandlers,
  options: ClaudeTaskParserOptions = {},
): ClaudeStreamParser {
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
  /**
   * `message.id`s whose usage was already counted. Claude Code emits ONE
   * assistant frame per content block and every one of them repeats the same
   * usage for the same API response, so counting frames instead of responses
   * inflates the total several-fold. A frame with no id cannot be
   * deduplicated and is counted as it comes.
   */
  const countedResponses = new Set<string>()
  // Cost bookkeeping lives in cost.ts: this parser reports frames, it does not
  // decide what they are worth.
  const cost = createCostMeter(
    {
      ...(handlers.onCost ? { onCost: handlers.onCost } : {}),
      ...(handlers.onCostDegraded ? { onDegraded: handlers.onCostDegraded } : {}),
    },
    {
      at: options.at ?? '',
      env: options.env ?? {},
      ...(options.prices ? { rows: options.prices } : {}),
    },
  )

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
    const framed = event.message as { id?: unknown; usage?: unknown; model?: unknown } | undefined
    const usage = usageSplit(framed?.usage)
    const messageId = typeof framed?.id === 'string' && framed.id ? framed.id : null
    // One API RESPONSE is one charge and one token count, however many frames
    // carry it: the repeats of an already-counted id are dropped here, and the
    // cost meter applies the same rule on its own side.
    const fresh = messageId === null || !countedResponses.has(messageId)
    if (usage !== null && fresh) {
      if (messageId !== null) {
        countedResponses.add(messageId)
      }
      if (usage.total > 0) {
        // The TOKEN meter counts the whole tree, subagents included: those
        // tokens were consumed by this turn, and `turn.tokens` has always
        // meant "what this turn burned". Only the price of them is a separate
        // question, answered just below.
        tokensSettled += usage.total
        handlers.onTokens?.(tokensSettled)
      }
      // A frame carrying `parent_tool_use_id` is a SUBAGENT's, not the main
      // loop's — the official cost-tracking guide skips exactly these when
      // summing per-step usage. Skipping them is what makes "subagents are
      // excluded from the lower bound" true BY CONSTRUCTION rather than by
      // hope; the harness's own estimate does include them, so the bound stays
      // a bound either way.
      if (!isSubagentFrame(event)) {
        cost.response(
          messageId,
          typeof framed?.model === 'string' ? framed.model : '',
          usage.counters,
        )
      }
    }
    // A complete assistant message CLOSES the current one: whatever streams
    // next is a new message (typically after the tool calls this one asked
    // for). An empty message never produced text, so it only shifts the
    // index — it can never open an empty bubble downstream.
    messageSeq++
    messageText = ''
  }

  /** The closing frame: the turn's reply, and the usage as the provider billed it. */
  const handleResult = (event: Record<string, unknown>) => {
    if (typeof event.result === 'string') {
      resultText = event.result
    }
    // The harness's own cost estimate rides on this frame; it is the nominal
    // figure because it is the only one covering output and subagents. The
    // meter validates it (see CostMeter.result) — this parser just forwards.
    cost.result(event)
    const usage = usageSplit(event.usage)
    if (usage === null) {
      return
    }
    if (usage.total > tokensSettled) {
      tokensSettled = usage.total
      handlers.onTokens?.(tokensSettled)
    }
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
      handleResult(event)
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value) {
      return value
    }
  }
  return null
}

function opencodeSessionId(event: Record<string, unknown>): string | null {
  const part = asRecord(event.part)
  for (const obj of [event, part]) {
    const id = firstString(obj.sessionID, obj.sessionId, obj.session_id)
    if (id) {
      return id
    }
  }
  return null
}

/**
 * OpenCode `--format json` NDJSON (verified 1.18.19): step_start / text /
 * tool_use / tool_result / step_finish. sessionID is camelCase on events.
 */
export function createOpencodeTaskParser(
  handlers: ClaudeTaskParserHandlers,
  _options: ClaudeTaskParserOptions = {},
): ClaudeStreamParser {
  const { onText } = handlers
  const summarize = (value: unknown): string => (handlers.countOnly ? '' : summarizePayload(value))
  let lineBuffer = ''
  let messageSeq = 0
  let messageText = ''
  let lastText = ''
  let tokensSettled = 0
  let costTicks = 0
  let initSent = false

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
    if (!initSent) {
      const sessionId = opencodeSessionId(event)
      if (sessionId) {
        initSent = true
        handlers.onInit?.(sessionId)
      }
    }
    const part = asRecord(event.part)
    if (event.type === 'step_start') {
      if (messageText) {
        messageSeq++
        messageText = ''
      }
      return
    }
    if (event.type === 'text') {
      const piece = typeof part.text === 'string' ? part.text : ''
      if (piece) {
        messageText += piece
        lastText = messageText
        onText?.(messageText, messageSeq)
      }
      return
    }
    if (event.type === 'tool_use') {
      const state = asRecord(part.state)
      const name = firstString(event.name, part.name, part.tool)
      if (name) {
        handlers.onToolUse?.(name, summarize(part.input ?? state.input ?? event.input ?? {}))
      }
      // OpenCode emits tool_use when the tool finishes (status completed +
      // output on the same event). Closing here keeps the watchdog inFlight
      // from sticking after the first call. A tool_result line is fallback.
      if (state.status === 'completed' || state.output !== undefined) {
        const payload =
          state.output ?? part.output ?? part.content ?? event.output ?? event.content ?? ''
        handlers.onToolResult?.(handlers.countOnly ? '' : summarizePayload(payload))
      }
      return
    }
    if (event.type === 'tool_result') {
      const payload = part.output ?? part.content ?? event.output ?? event.content ?? part
      handlers.onToolResult?.(handlers.countOnly ? '' : summarizePayload(payload))
      return
    }
    if (event.type === 'step_finish') {
      const tokens = asRecord(part.tokens)
      const input = num(tokens.input)
      const output = num(tokens.output)
      const total = num(tokens.total)
      if (input > 0 || output > 0 || total > 0) {
        tokensSettled += input + output
        if (total > tokensSettled) {
          tokensSettled = total
        }
        handlers.onTokens?.(tokensSettled)
      }
      const ticks = usdToTicks(part.cost)
      if (ticks !== null) {
        costTicks += ticks
        handlers.onCost?.({ ticks: costTicks, basis: 'harness' })
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
      return lastText || null
    },
  }
}

export function createOpencodeStreamParser(
  onText?: (text: string) => void,
  handlers?: Omit<ClaudeTaskParserHandlers, 'onText'>,
): ClaudeStreamParser {
  return createOpencodeTaskParser({ ...handlers, ...(onText ? { onText } : {}) })
}

export function createAgentStreamParser(
  command: string,
  handlers: ClaudeTaskParserHandlers,
  options: ClaudeTaskParserOptions = {},
): ClaudeStreamParser {
  return emitsOpencodeJson(command)
    ? createOpencodeTaskParser(handlers, options)
    : createClaudeTaskParser(handlers, options)
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
  const decodable = emitsClaudeStreamJson(opts.command) || emitsOpencodeJson(opts.command)
  const ownParser =
    !opts.callerDecodes && decodable ? createAgentStreamParser(opts.command, handlers) : null

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
  const streamCommand = streamFlagsCommand(opts.command)
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
    const parser = streamCommand
      ? emitsOpencodeJson(streamCommand)
        ? createOpencodeStreamParser(opts.onText, armed.handlers)
        : createClaudeStreamParser(opts.onText, armed.handlers)
      : null

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
