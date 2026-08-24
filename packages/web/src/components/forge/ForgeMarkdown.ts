// Markdown renderer for a forge issue or MR body: untrusted content, since
// anyone can open an issue on a public repo. Sanitization runs on the
// syntax tree itself (rehype-sanitize, an explicit allowlist schema), never
// on an HTML string already produced by a separate pass: the schema below
// is the single point that decides what survives. No DOM is used anywhere
// in this pipeline, so it renders the same way under the SSR/no-document
// test harness the rest of the forge board runs under.
import type { Root } from 'hast'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { type Options as SanitizeSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'

/**
 * Class applied to a linkified `#123` reference so it can be styled with a
 * dotted underline instead of a plain link's solid one. Never reachable
 * from raw markdown input: `markLinks` (below) assigns it after sanitize
 * runs, by matching the final href against a set of URLs this module's
 * caller computed itself (see ForgeReferenceLinks.ts). A schema entry
 * allowing this class as a literal attribute value would instead let a
 * crafted `<a class="fdp-md-ref">` in a body claim the reference style for
 * an arbitrary link.
 */
export const REFERENCE_LINK_CLASS = 'fdp-md-ref'

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
  ],
}

/**
 * Every link opens in a new tab with the attributes that go with it,
 * overwriting whatever `target`/`rel` a raw-HTML link tried to set (the
 * schema above never allows those from input in the first place, so this
 * is the only place they are set at all). A link whose final href is in
 * `referenceUrls` is additionally marked as a reference. Runs after
 * rehype-sanitize, on the already-sanitized tree: see REFERENCE_LINK_CLASS.
 */
function markLinks(referenceUrls: ReadonlySet<string>) {
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
      if (referenceUrls.has(href)) {
        node.properties.className = [REFERENCE_LINK_CLASS]
      }
    })
  }
}

/**
 * Renders a forge issue or MR body to sanitized HTML. `referenceUrls` is
 * the set of URLs `linkifyForgeReferences` (ForgeReferenceLinks.ts)
 * generated for this same body's `#123` references, passed through
 * unchanged so those links can be styled distinctly from a plain one.
 * Synchronous: nothing in this pipeline is async.
 */
export function renderForgeMarkdown(
  markdown: string,
  referenceUrls: ReadonlySet<string> = new Set(),
): string {
  const file = unified()
    .use(remarkParse)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, FORGE_MARKDOWN_SCHEMA)
    .use(markLinks, referenceUrls)
    .use(rehypeStringify)
    .processSync(markdown)
  return String(file)
}
