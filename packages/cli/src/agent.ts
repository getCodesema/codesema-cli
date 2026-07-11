// Exécution de l'agent headless : prompt sur stdin, review JSON sur stdout.
// Claude Code bascule en stream-json (aperçu temps réel) ; les autres agents
// remontent leur stdout brut au fil de l'eau.

import { spawn } from 'node:child_process'

const CLAUDE_STREAM_FLAGS = '--output-format stream-json --include-partial-messages --verbose'

/** Variante streaming d'une commande claude -p, ou null si non applicable. */
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

/** Parse la sortie JSONL de claude : text_delta au fil de l'eau, result à la fin. */
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
  /** Texte cumulé de la review en cours, à chaque avancée de l'agent. */
  onText?: (text: string) => void
}

export function runAgent(opts: AgentRunOptions): Promise<string> {
  const streamCommand = claudeStreamCommand(opts.command)
  const command = streamCommand ?? opts.command
  const parser = streamCommand ? createClaudeStreamParser(opts.onText) : null

  return new Promise((resolve, reject) => {
    // detached (hors Windows) : l'agent tourne dans son propre groupe de process,
    // le timeout peut donc tuer le shell ET ses enfants d'un seul kill(-pid).
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
        // groupe déjà terminé
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
        reject(new Error(`agent timed out after ${Math.round(opts.timeoutMs / 1000)}s — raise it with --timeout <seconds>`))
      } else if (code === 0) {
        resolve(parser ? (parser.finalText() ?? out) : out)
      } else {
        reject(new Error(`agent command exited with code ${code}`))
      }
    })
    // un agent qui crashe ferme stdin tôt : sans handler, l'EPIPE tuerait tout le process
    child.stdin.on('error', () => {})
    child.stdin.write(opts.prompt)
    child.stdin.end()
  })
}
