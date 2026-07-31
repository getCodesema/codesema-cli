import { spawn } from 'node:child_process'
import { t } from './i18n.js'

const CLAUDE_STREAM_FLAGS = '--output-format stream-json --include-partial-messages --verbose'

const AGENT_BINS = ['claude', 'codex', 'gemini'] as const
type KnownAgent = (typeof AGENT_BINS)[number]

function knownAgent(command: string): KnownAgent | null {
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
function flagPresent(command: string, flag: string): boolean {
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

type ClaudeStreamParser = {
  push: (chunk: string) => void
  finalText: () => string | null
}

/** Parses claude's JSONL stream: text_delta events while streaming, result at the end. */
export function createClaudeStreamParser(onText?: (text: string) => void): ClaudeStreamParser {
  let lineBuffer = ''
  let streamedText = ''
  let resultText: string | null = null

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
        streamedText += inner.delta.text
        onText?.(streamedText)
      }
      return
    }
    if (event.type === 'assistant') {
      const message = event.message as { content?: { type?: string; text?: string }[] } | undefined
      const text = (message?.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
      if (text) {
        streamedText = text
        onText?.(streamedText)
      }
      return
    }
    if (event.type === 'result' && typeof event.result === 'string') {
      resultText = event.result
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
      return resultText ?? (streamedText || null)
    },
  }
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
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (detached && child.pid) {
          process.kill(-child.pid, 'SIGTERM')
        } else {
          child.kill('SIGTERM')
        }
      } catch {
        // process group already gone
      }
    }, opts.timeoutMs)

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
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
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
