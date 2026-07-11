import { spawn } from 'node:child_process'
import { t } from './i18n.js'

const CLAUDE_STREAM_FLAGS = '--output-format stream-json --include-partial-messages --verbose'

export function claudeStreamCommand(command: string): string | null {
  if (!/^claude(\s|$)/.test(command)) return null
  if (!/(^|\s)(-p|--print)(\s|$)/.test(command)) return null
  if (command.includes('--output-format') || command.includes('--input-format')) return null
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
    if (!line.trim()) return
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (event.type === 'stream_event') {
      const inner = (event.event ?? {}) as { type?: string; delta?: { type?: string; text?: string } }
      if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && inner.delta.text) {
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
        if (nl < 0) break
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
    const child = spawn(command, { shell: true, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'inherit'], detached })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (detached && child.pid) process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch {
        // process group already gone
      }
    }, opts.timeoutMs)

    child.stdout.on('data', (d: Buffer) => {
      const chunk = d.toString()
      out += chunk
      if (parser) parser.push(chunk)
      else opts.onText?.(out)
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
