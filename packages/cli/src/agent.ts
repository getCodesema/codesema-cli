import { spawn } from 'node:child_process'
import { t } from './i18n.js'

const CLAUDE_STREAM_FLAGS = '--output-format stream-json --include-partial-messages --verbose'

const AGENT_BINS = ['claude', 'codex', 'gemini'] as const
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
 * The review agent is a pure text transformer (prompt on stdin, review JSON on
 * stdout), so tools, MCP servers and repo-provided agent settings are switched
 * off at the CLI level for known agents; a hostile repo cannot reach the agent
 * through its own .claude/ or AGENTS.md. Flags the user already set win.
 * Gemini has no CLI flag for this (tools are settings.json-only); its headless
 * policy engine already denies shell/write tools. Do NOT apply this to the fix
 * runner: applying fixes needs the edit tools.
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

export type ClaudeStreamParser = {
  push: (chunk: string) => void
  finalText: () => string | null
}

/** Ceiling for tool_use/tool_result summaries in task events: enough to tell
 *  what the agent is doing, never a full file body in the journal. */
export const TASK_TOOL_SUMMARY_MAX = 400

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
  const codePoints = Array.from(text)
  return codePoints.length > TASK_TOOL_SUMMARY_MAX
    ? `${codePoints.slice(0, TASK_TOOL_SUMMARY_MAX - 1).join('')}…`
    : text
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
        handlers.onToolUse?.(block.name, summarizePayload(block.input ?? {}))
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
          handlers.onToolResult?.(summarizePayload(toolResultText(block.content)))
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
 * spans two messages.
 */
export function createClaudeStreamParser(onText?: (text: string) => void): ClaudeStreamParser {
  return createClaudeTaskParser(onText ? { onText } : {})
}

export type AgentRunOptions = {
  command: string
  prompt: string
  cwd: string
  timeoutMs: number
  /** Environment for the subprocess; undefined inherits the full process env. */
  env?: NodeJS.ProcessEnv | undefined
  /** Cumulative review text so far, called on every update from the agent. */
  onText?: (text: string) => void
  /** Aborting interrupts the run: SIGTERM to the whole process group, the promise rejects. */
  signal?: AbortSignal | undefined
}

export function runAgent(opts: AgentRunOptions): Promise<string> {
  const streamCommand = claudeStreamCommand(opts.command)
  const command = streamCommand ?? opts.command
  const parser = streamCommand ? createClaudeStreamParser(opts.onText) : null

  return new Promise((resolve, reject) => {
    // detached (non-Windows): the agent runs in its own process group, so the
    // timeout can kill the shell AND its children with a single kill(-pid).
    const detached = process.platform !== 'win32'
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
      detached,
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    })
    let out = ''
    let timedOut = false
    let aborted = false
    const killGroup = () => {
      try {
        if (detached && child.pid) {
          process.kill(-child.pid, 'SIGTERM')
        } else {
          child.kill('SIGTERM')
        }
      } catch {
        // process group already gone
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, opts.timeoutMs)
    // Same kill-the-group path as the timeout, driven by the caller (task interrupt).
    const onAbort = () => {
      aborted = true
      killGroup()
    }
    if (opts.signal?.aborted) {
      onAbort()
    } else {
      opts.signal?.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (d: Buffer) => {
      const chunk = d.toString()
      out += chunk
      if (parser) {
        parser.push(chunk)
      } else {
        opts.onText?.(out)
      }
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (aborted) {
        reject(new Error(t('agent.interrupted')))
      } else if (timedOut) {
        reject(new Error(t('agent.timeout', { s: Math.round(opts.timeoutMs / 1000) })))
      } else if (code === 0) {
        resolve(parser ? (parser.finalText() ?? out) : out)
      } else {
        reject(new Error(t('agent.exitCode', { code })))
      }
    })
    // an agent that crashes closes stdin early: without a handler, the EPIPE would kill the whole process
    child.stdin.on('error', () => {})
    child.stdin.write(opts.prompt)
    child.stdin.end()
  })
}
