// Minimal, dependency-free markdown renderer for agent messages. The agent
// writes prose with headings, emphasis, lists, code — showing the raw sigils
// (##, **) in a bubble reads as a bug. Scope is deliberately small: headings,
// bold/italic, inline code, fenced code blocks, unordered/ordered lists,
// http(s) links, paragraphs. Everything is HTML-escaped BEFORE any transform,
// so the output is safe to v-html by construction.

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
  | { kind: 'p' | 'h2' | 'h3'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }

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
      if (
        !l.trim() ||
        l.startsWith('```') ||
        /^#{1,6}\s/.test(l) ||
        /^\s*([-*]|\d+[.)])\s+/.test(l)
      ) {
        break
      }
      body.push(l)
      i++
    }
    blocks.push({ kind: 'p', text: body.join('\n') })
  }
  return blocks
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
        default:
          return `<p>${renderInline(block.text).replaceAll('\n', '<br>')}</p>`
      }
    })
    .join('')
}
