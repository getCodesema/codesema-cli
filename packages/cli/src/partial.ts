export type PartialFinding = {
  file: string
  message: string
  title?: string
  severity?: string
  kind?: string
  line?: number
}

export type PartialReview = {
  verdict?: 'approve' | 'request_changes' | 'comment' | undefined
  summary?: string | undefined
  intent?: string | undefined
  findings: PartialFinding[]
  stepTitles: string[]
}

const LITERAL_TAIL = /^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/
const CLOSED_STRING_TAIL = /^"(?:[^"\\]|\\.)*"$/

function lastNonWhitespace(s: string, before: number): string {
  for (let i = before - 1; i >= 0; i--) {
    const ch = s.charAt(i)
    if (ch !== ' ' && ch !== '\n' && ch !== '\r' && ch !== '\t') {
      return ch
    }
  }
  return ''
}

function stringStartBackwards(s: string): number {
  for (let i = s.length - 2; i >= 0; i--) {
    if (s[i] !== '"') {
      continue
    }
    let backslashes = 0
    for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) {
      backslashes++
    }
    if (backslashes % 2 === 0) {
      return i
    }
  }
  return -1
}

/**
 * Makes an in-progress JSON write parsable: closes the open string, trims the
 * incomplete token at the end of the buffer, drops a dangling key or comma,
 * and closes the object/array stack. Returns null if no object has started.
 */
export function repairTruncatedJson(raw: string): string | null {
  const start = raw.indexOf('{')
  if (start < 0) {
    return null
  }
  let s = raw.slice(start)

  const stack: string[] = []
  let inString = false
  let escaped = false
  let stringStart = -1
  let lastStructural = -1

  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i)
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      stringStart = i
      continue
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch)
      lastStructural = i
      continue
    }
    if (ch === ',' || ch === ':') {
      lastStructural = i
      continue
    }
    if (ch === '}' || ch === ']') {
      stack.pop()
      if (stack.length === 0) {
        return s.slice(0, i + 1)
      }
    }
  }

  if (inString) {
    if (escaped) {
      s = s.slice(0, -1)
    }
    s = s.replace(/\\u[0-9a-fA-F]{0,3}$/, '')
    s += '"'
    const prev = lastNonWhitespace(s, stringStart)
    const isKey = stack[stack.length - 1] === '{' && (prev === '{' || prev === ',')
    if (isKey) {
      s = s.slice(0, stringStart)
    }
  } else {
    const tail = s.slice(lastStructural + 1).trim()
    if (tail && !LITERAL_TAIL.test(tail)) {
      if (CLOSED_STRING_TAIL.test(tail)) {
        const before = s[lastStructural] ?? ''
        const isKey = stack[stack.length - 1] === '{' && (before === '{' || before === ',')
        if (isKey) {
          s = s.slice(0, lastStructural + 1)
        }
      } else {
        s = s.slice(0, lastStructural + 1)
      }
    }
  }

  for (;;) {
    s = s.trimEnd()
    if (s.endsWith(',')) {
      s = s.slice(0, -1)
      continue
    }
    if (s.endsWith(':')) {
      s = s.slice(0, -1).trimEnd()
      const keyStart = stringStartBackwards(s)
      if (keyStart >= 0) {
        s = s.slice(0, keyStart)
        continue
      }
    }
    break
  }

  for (let i = stack.length - 1; i >= 0; i--) {
    s += stack[i] === '{' ? '}' : ']'
  }
  return s
}

/** Tolerant extraction of the fields already readable from the review in progress. */
export function parsePartialReview(raw: string): PartialReview | null {
  const repaired = repairTruncatedJson(raw)
  if (!repaired) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(repaired)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const r = parsed as Record<string, unknown>

  const verdict =
    r.verdict === 'approve' || r.verdict === 'request_changes' || r.verdict === 'comment'
      ? r.verdict
      : undefined
  const summary = typeof r.summary === 'string' && r.summary.trim() ? r.summary.trim() : undefined

  const findings: PartialFinding[] = []
  if (Array.isArray(r.findings)) {
    for (const item of r.findings.slice(0, 200)) {
      if (!item || typeof item !== 'object') {
        continue
      }
      const f = item as Record<string, unknown>
      if (typeof f.file !== 'string' || !f.file || typeof f.message !== 'string' || !f.message) {
        continue
      }
      findings.push({
        file: f.file,
        message: f.message,
        ...(typeof f.title === 'string' && f.title ? { title: f.title } : {}),
        ...(typeof f.severity === 'string' ? { severity: f.severity } : {}),
        ...(typeof f.kind === 'string' ? { kind: f.kind } : {}),
        ...(Number.isInteger(f.line) && (f.line as number) > 0 ? { line: f.line as number } : {}),
      })
    }
  }

  const narrative =
    r.narrative && typeof r.narrative === 'object'
      ? (r.narrative as Record<string, unknown>)
      : undefined
  // Streams from pre-rename agent prompts used "chapters".
  const rawSteps = narrative?.steps ?? narrative?.chapters
  const stepTitles = Array.isArray(rawSteps)
    ? rawSteps
        .map((c) =>
          c && typeof c === 'object' && typeof (c as { title?: unknown }).title === 'string'
            ? (c as { title: string }).title
            : null,
        )
        .filter((t): t is string => Boolean(t))
    : []
  const intent =
    typeof narrative?.intent === 'string' && narrative.intent.trim()
      ? narrative.intent.trim()
      : undefined

  if (!verdict && !summary && !intent && findings.length === 0 && stepTitles.length === 0) {
    return null
  }
  return { verdict, summary, intent, findings, stepTitles }
}
