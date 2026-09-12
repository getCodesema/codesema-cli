// Minimal, dependency-free markdown renderer for agent messages. The agent
// writes prose with headings, emphasis, lists, code — showing the raw sigils
// (##, **) in a bubble reads as a bug. Scope is deliberately small: headings,
// bold/italic, inline code, fenced code blocks, unordered/ordered lists,
// blockquotes, pipe tables, rules, http(s) links, inline images, paragraphs.
// Everything is HTML-escaped BEFORE any transform, so the output is safe to
// v-html by construction.

const escapeHtml = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

/** Inline transforms on an ALREADY-ESCAPED string: code first (its content
 * stays literal), then links, bold, italic. */
function renderInline(escaped: string): string {
  const parts: string[] = []
  // Split on `code` spans so emphasis never rewrites inside them.
  const pieces = escaped.split(/(`[^`]+`)/)
  for (const piece of pieces) {
    if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 2) {
      parts.push(`<code>${piece.slice(1, -1)}</code>`)
      continue
    }
    let text = piece
    // ![alt](url) before links so the [alt](url) half is not eaten as an <a>.
    // http(s) or same-origin /api/… (evidence screenshots); never javascript:.
    text = text.replace(
      /!\[([^\]]*)\]\(((?:https?:\/\/|\/api\/)[^\s)]+)\)/g,
      '<img src="$2" alt="$1" loading="lazy" />',
    )
    // [label](https://…) — http(s) only, never javascript: (input is escaped,
    // but the protocol allowlist keeps the guarantee explicit).
    text = text.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    )
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    text = text.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    parts.push(text)
  }
  return parts.join('')
}

type Block =
  | { kind: 'p' | 'h2' | 'h3' | 'blockquote'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'hr' }
  | { kind: 'table'; head: string[]; rows: string[][] }

const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEPARATOR = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/
const BLOCK_START = /^\s*(&gt;|[-*]|\d+[.)])\s+|^\s*\|/

const splitCells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())

function readTable(lines: string[], start: number): { block: Block; next: number } | null {
  const head = lines[start] ?? ''
  const separator = lines[start + 1] ?? ''
  if (!TABLE_ROW.test(head) || !TABLE_SEPARATOR.test(separator)) {
    return null
  }
  const rows: string[][] = []
  let i = start + 2
  while (i < lines.length && TABLE_ROW.test(lines[i] ?? '')) {
    rows.push(splitCells(lines[i] ?? ''))
    i++
  }
  return { block: { kind: 'table', head: splitCells(head), rows }, next: i }
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.trim()) {
      i++
      continue
    }
    if (line.startsWith('```')) {
      const body: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        body.push(lines[i] ?? '')
        i++
      }
      i++ // closing fence (or EOF)
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'hr' })
      i++
      continue
    }
    const table = readTable(lines, i)
    if (table) {
      blocks.push(table.block)
      i = table.next
      continue
    }
    const quote = /^\s*&gt;\s?(.*)$/.exec(line)
    if (quote) {
      const body: string[] = []
      while (i < lines.length) {
        const m = /^\s*&gt;\s?(.*)$/.exec(lines[i] ?? '')
        if (!m) {
          break
        }
        body.push(m[1] ?? '')
        i++
      }
      blocks.push({ kind: 'blockquote', text: body.join('\n') })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      // Every level maps to two visual ranks: a chat bubble is not a document.
      blocks.push({ kind: (heading[1]?.length ?? 2) <= 2 ? 'h2' : 'h3', text: heading[2] ?? '' })
      i++
      continue
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      const items: string[] = []
      while (i < lines.length) {
        const m = /^\s*[-*]\s+(.*)$/.exec(lines[i] ?? '')
        if (!m) {
          break
        }
        items.push(m[1] ?? '')
        i++
      }
      blocks.push({ kind: 'ul', items })
      continue
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      const items: string[] = []
      while (i < lines.length) {
        const m = /^\s*\d+[.)]\s+(.*)$/.exec(lines[i] ?? '')
        if (!m) {
          break
        }
        items.push(m[1] ?? '')
        i++
      }
      blocks.push({ kind: 'ol', items })
      continue
    }
    // Paragraph: consecutive plain lines join with <br> (agents hard-wrap).
    const body: string[] = []
    while (i < lines.length) {
      const l = lines[i] ?? ''
      const opensBlock = l.startsWith('```') || /^#{1,6}\s/.test(l) || BLOCK_START.test(l)
      if (!l.trim() || (opensBlock && body.length > 0)) {
        break
      }
      body.push(l)
      i++
    }
    blocks.push({ kind: 'p', text: body.join('\n') })
  }
  return blocks
}

function renderTable(head: string[], rows: string[][]): string {
  const cells = (row: string[], tag: 'th' | 'td'): string =>
    row.map((cell) => `<${tag}>${renderInline(cell)}</${tag}>`).join('')
  const body = rows.map((row) => `<tr>${cells(row, 'td')}</tr>`).join('')
  return `<table><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${body}</tbody></table>`
}

/** Safe HTML for one agent message. Plain text (no markdown sigils) comes out
 * as simple <p> paragraphs, so using this unconditionally costs nothing. */
export function renderMarkdown(text: string): string {
  const blocks = parseBlocks(escapeHtml(text))
  return blocks
    .map((block) => {
      switch (block.kind) {
        case 'code':
          return `<pre><code>${block.text}</code></pre>`
        case 'h2':
        case 'h3':
          return `<${block.kind}>${renderInline(block.text)}</${block.kind}>`
        case 'ul':
        case 'ol':
          return `<${block.kind}>${block.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${block.kind}>`
        case 'hr':
          return '<hr>'
        case 'blockquote':
          return `<blockquote>${renderInline(block.text).replaceAll('\n', '<br>')}</blockquote>`
        case 'table':
          return renderTable(block.head, block.rows)
        default:
          return `<p>${renderInline(block.text).replaceAll('\n', '<br>')}</p>`
      }
    })
    .join('')
}
