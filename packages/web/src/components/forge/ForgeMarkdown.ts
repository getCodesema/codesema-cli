// Markdown renderer for a forge issue or MR body: untrusted content, since
// anyone can open an issue on a public repo. Sanitization runs on the
// syntax tree itself (rehype-sanitize, an explicit allowlist schema), never
// on an HTML string already produced by a separate pass: the schema below
// is the single point that decides what survives. No DOM is used anywhere
// in this pipeline, so it renders the same way under the SSR/no-document
// test harness the rest of the forge board runs under.
import type { Element, ElementContent, Root } from 'hast'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { type Options as SanitizeSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'

/**
 * Class applied to a linkified `#123` reference so it can be styled with a
 * dotted underline instead of a plain link's solid one. `markLinks` (below)
 * assigns it after sanitize runs, and only when BOTH the final href and the
 * link's own visible text match an entry `linkifyForgeReferences` computed
 * (ForgeReferenceLinks.ts): the schema never allows a `class` attribute at
 * all, so a raw HTML link cannot carry this class in, and matching the
 * label too closes the remaining gap where a hand-written link happens to
 * share a reference's href but carries different, misleading anchor text.
 */
export const REFERENCE_LINK_CLASS = 'fdp-md-ref'

/**
 * Length alone is not the danger: measured on this pipeline, 50,000
 * characters of ordinary prose render in ~1ms, and ~30,000 characters of
 * realistic mixed markdown (headings, lists, a code block, a little
 * emphasis) in ~45ms. What is expensive is *shape*: long runs of emphasis
 * markers and deeply nested blockquotes (see `hasPathologicalMarkdownShape`
 * below), which this length cap does not need to compensate for on its own.
 * Real content in this repo's own issues measured at a median of 1,464
 * characters and a maximum of 3,924; 20,000 is a wide margin above that
 * (including a longer, agent-authored MR description, the central use
 * case) while still bounding memory/DOM size against an accidental paste
 * of something far larger. The caller is responsible for truncating to
 * this length before calling `renderForgeMarkdown` (and telling the reader
 * it did), and `renderForgeMarkdown` also enforces it itself so its own
 * contract holds regardless of what the caller remembers to do.
 */
export const MAX_FORGE_MARKDOWN_LENGTH = 20000

/**
 * A run of 30+ consecutive `*`/`_` characters, or blockquote nesting 20+
 * levels deep on one line: no legitimate CommonMark construct needs
 * anywhere near either (three of the same marker is the deepest real
 * emphasis nesting; real quoting is a handful of levels at most), and both
 * thresholds sit orders of magnitude below where the underlying parser
 * actually struggles. Measured on this pipeline: two runs of `*` split by
 * one character cost quadratic time that reaches ~750ms at a mere 4,001
 * characters and overflows the stringifier's call stack somewhere between
 * 24,001 and 30,001 (a different crash than the blockquote one, in
 * `hast-util-to-html` rather than in parsing); blockquote nesting overflows
 * the parser's own call stack between roughly 15,600 and 16,000
 * characters. A body shaped like either is treated as hostile: rendered
 * as escaped raw text instead of being handed to the parser at all, in
 * linear time, so detecting the shape never costs more than parsing safe
 * content would have.
 */
export const EMPHASIS_RUN_LIMIT = 30
export const BLOCKQUOTE_DEPTH_LIMIT = 20

/** A run of `limit` or more consecutive `*`/`_` characters, anywhere in
 * `markdown`. Single pass, O(length). */
function hasExcessiveEmphasisRun(markdown: string, limit: number): boolean {
  let run = 0
  for (let i = 0; i < markdown.length; i++) {
    const ch = markdown[i]
    if (ch === '*' || ch === '_') {
      run++
      if (run >= limit) {
        return true
      }
    } else {
      run = 0
    }
  }
  return false
}

/** `limit` or more nested blockquote markers (`>`, optionally separated by
 * spaces or tabs) opening a single line, anywhere in `markdown`. Single
 * pass, O(length): no regex, so this scan carries no backtracking risk of
 * its own. */
function hasExcessiveBlockquoteDepth(markdown: string, limit: number): boolean {
  let depth = 0
  let atLineStart = true
  for (let i = 0; i < markdown.length; i++) {
    const ch = markdown[i]
    if (ch === '\n') {
      depth = 0
      atLineStart = true
      continue
    }
    if (!atLineStart) {
      continue
    }
    if (ch === '>') {
      depth++
      if (depth >= limit) {
        return true
      }
      continue
    }
    if (ch === ' ' || ch === '\t') {
      continue
    }
    atLineStart = false
  }
  return false
}

/**
 * True when `markdown` is shaped like one of the two constructs known to
 * make this pipeline expensive or crash regardless of overall length (see
 * `EMPHASIS_RUN_LIMIT` / `BLOCKQUOTE_DEPTH_LIMIT`). Checked before parsing,
 * in linear time, so a hostile body never reaches the parser at all.
 */
export function hasPathologicalMarkdownShape(markdown: string): boolean {
  return (
    hasExcessiveEmphasisRun(markdown, EMPHASIS_RUN_LIMIT) ||
    hasExcessiveBlockquoteDepth(markdown, BLOCKQUOTE_DEPTH_LIMIT)
  )
}

/**
 * Explicit allowlist for this one surface, written from scratch rather
 * than extending rehype-sanitize's `defaultSchema`: only the tags the
 * detail panel's typography actually styles, plus `img` (raw HTML in a
 * body can carry one, and it is part of the security test matrix below).
 * No tag gets any attribute beyond what is listed here, in particular no
 * `id`/`class`/`style` anywhere, which also means DOM-clobbering via `id`
 * is not reachable without needing rehype-sanitize's clobber handling.
 */
const FORGE_MARKDOWN_SCHEMA: SanitizeSchema = {
  tagNames: [
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'strong',
    'em',
    'br',
    'blockquote',
    'ul',
    'ol',
    'li',
    'code',
    'pre',
    'a',
    'img',
  ],
  attributes: {
    a: ['href'],
    img: ['src', 'alt'],
  },
  // `javascript:`/`data:`/`vbscript:` and friends never survive: only a
  // scheme in this list, or no scheme at all (a relative path), is kept.
  protocols: {
    href: ['http', 'https'],
    src: ['http', 'https'],
  },
  // Tags whose HTML5 parsing treats their content as opaque raw text
  // (RAWTEXT/RCDATA elements) plus the handful of embed-style tags the
  // security suite targets. `hast-util-sanitize` only *unwraps* a
  // disallowed tag by default, keeping its text content: for `<script>`,
  // `<style>`, `<iframe>`, `<object>`, `<embed>`, that would leak the
  // payload as visible page text even though none of it ever executes.
  // `strip` removes the content along with the tag.
  strip: [
    'script',
    'style',
    'title',
    'textarea',
    'xmp',
    'iframe',
    'noembed',
    'noframes',
    'noscript',
    'object',
    'embed',
    'template',
    'plaintext',
  ],
}

/** Concatenated text of an element's descendants, ignoring markup: `<a
 * href="…"><strong>#123</strong></a>` reads as `#123`, same as the plain
 * form `linkifyForgeReferences` actually produces. */
function textContent(node: Element): string {
  let text = ''
  for (const child of node.children as ElementContent[]) {
    if (child.type === 'text') {
      text += child.value
    } else if (child.type === 'element') {
      text += textContent(child)
    }
  }
  return text
}

/**
 * Every link opens in a new tab with the attributes that go with it,
 * overwriting whatever `target`/`rel` a raw-HTML link tried to set (the
 * schema above never allows those from input in the first place, so this
 * is the only place they are set at all). A link is additionally marked as
 * a reference only when both its final href and its own visible text match
 * an entry of `references` (href -> the `#123` label it was linkified
 * with): matching the href alone would let a hand-written link reuse a
 * reference's exact URL under different, misleading anchor text and still
 * pick up the "trusted internal reference" styling. Runs after
 * rehype-sanitize, on the already-sanitized tree.
 */
function markLinks(references: ReadonlyMap<string, string>) {
  return (tree: Root) => {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'a') {
        return
      }
      const href = node.properties.href
      if (typeof href !== 'string') {
        return
      }
      node.properties.target = '_blank'
      node.properties.rel = ['noopener', 'noreferrer']
      const expectedLabel = references.get(href)
      if (expectedLabel !== undefined && textContent(node) === expectedLabel) {
        node.properties.className = [REFERENCE_LINK_CLASS]
      }
    })
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Renders a forge issue or MR body to sanitized HTML. `references` is the
 * href-to-label map `linkifyForgeReferences` (ForgeReferenceLinks.ts)
 * computed for this same body's `#123` references, passed through
 * unchanged so those links can be styled distinctly from a plain one.
 * Synchronous: nothing in this pipeline is async.
 *
 * Never throws: a body shaped like `hasPathologicalMarkdownShape` never
 * reaches the parser at all, and a failure that slips past that check
 * anyway (an unenumerated pathological shape, a future parser edge case)
 * falls back the same way, rather than reaching the caller as an unhandled
 * error or blanking the panel: escaped raw text, in both cases.
 */
export function renderForgeMarkdown(
  markdown: string,
  references: ReadonlyMap<string, string> = new Map(),
): string {
  const bounded = markdown.slice(0, MAX_FORGE_MARKDOWN_LENGTH)
  if (hasPathologicalMarkdownShape(bounded)) {
    return `<p class="fdp-md-fallback">${escapeHtml(bounded)}</p>`
  }
  try {
    const file = unified()
      .use(remarkParse)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeRaw)
      .use(rehypeSanitize, FORGE_MARKDOWN_SCHEMA)
      .use(markLinks, references)
      .use(rehypeStringify)
      .processSync(bounded)
    return String(file)
  } catch {
    return `<p class="fdp-md-fallback">${escapeHtml(bounded)}</p>`
  }
}
