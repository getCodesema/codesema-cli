import { describe, expect, test } from 'bun:test'
import { REFERENCE_LINK_CLASS, renderForgeMarkdown } from './ForgeMarkdown'

// The security suite below is the actual point of this module: a forge body
// is untrusted content (anyone can open an issue on a public repo), and for
// each vector the assertion is on what survives, not just that nothing
// throws.
describe('security: nothing dangerous survives sanitize', () => {
  test('a script tag: removed, its content never appears as text either', () => {
    const html = renderForgeMarkdown('before <script>alert(1)</script> after')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  test('an inline event handler attribute: stripped, the element and its text survive', () => {
    const html = renderForgeMarkdown('<p onclick="alert(1)">hello</p>')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('alert(1)')
    expect(html).toContain('hello')
  })

  test('a javascript: URL on a markdown link: the href is dropped, the label survives', () => {
    const html = renderForgeMarkdown('[click me](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('href')
    expect(html).toContain('click me')
  })

  test('a javascript: URL on a raw HTML link: the href is dropped', () => {
    const html = renderForgeMarkdown('<a href="javascript:alert(1)">click</a>')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('href')
  })

  test('an iframe: removed entirely, including its inner text', () => {
    const html = renderForgeMarkdown('<iframe src="https://evil.example">inner text</iframe>')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('inner text')
  })

  test('an object tag: removed entirely, including its fallback content', () => {
    const html = renderForgeMarkdown('<object data="evil.swf">fallback</object>')
    expect(html).not.toContain('<object')
    expect(html).not.toContain('fallback')
  })

  test('an embed tag: removed entirely', () => {
    const html = renderForgeMarkdown('<embed src="evil.swf">')
    expect(html).not.toContain('<embed')
  })

  test('an image with an onerror handler: the handler is stripped, a safe src stays', () => {
    const html = renderForgeMarkdown('<img src="https://example.test/x.png" onerror="alert(1)">')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('alert(1)')
    expect(html).toContain('src="https://example.test/x.png"')
  })

  test("a link with a target and no safety attributes: normalized, never the attacker's target", () => {
    const html = renderForgeMarkdown('<a href="https://example.com" target="_self">ext</a>')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).not.toContain('target="_self"')
  })

  test('malformed HTML that could escape its context: the parser closes it safely, no tag leaks out', () => {
    const html = renderForgeMarkdown('<div><span>unclosed <b>bold')
    expect(html).not.toContain('<div')
    expect(html).not.toContain('<span')
    expect(html).not.toContain('<b>')
    expect(html).toContain('unclosed')
    expect(html).toContain('bold')
  })

  test('a doubly encoded entity: stays inert text, never decodes into a live tag', () => {
    const html = renderForgeMarkdown('&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('</script>')
    // A single decode pass turns `&amp;` into `&`, which stringify then
    // re-encodes on the way out: the text still reads as escaped markup,
    // never as something a second decode pass could turn into a live tag.
    expect(html).toContain('&#x26;lt;script&#x26;gt;alert(1)&#x26;lt;/script&#x26;gt;')
  })

  test('a style attribute carrying an expression: the whole attribute is dropped', () => {
    const html = renderForgeMarkdown('<p style="background:url(javascript:alert(1))">x</p>')
    expect(html).not.toContain('style=')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('x')
  })

  test('a style tag: removed entirely, its CSS text never leaks as visible content', () => {
    const html = renderForgeMarkdown('before <style>body{display:none}</style> after')
    expect(html).not.toContain('<style')
    expect(html).not.toContain('display:none')
  })
})

describe('typography: every element the detail panel styles', () => {
  test('all six heading levels', () => {
    const html = renderForgeMarkdown('# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6')
    expect(html).toContain('<h1>H1</h1>')
    expect(html).toContain('<h2>H2</h2>')
    expect(html).toContain('<h3>H3</h3>')
    expect(html).toContain('<h4>H4</h4>')
    expect(html).toContain('<h5>H5</h5>')
    expect(html).toContain('<h6>H6</h6>')
  })

  test('inline code', () => {
    const html = renderForgeMarkdown('some `code` here')
    expect(html).toContain('<code>code</code>')
  })

  test('a fenced code block renders as a pre > code pair, its own scroll container', () => {
    const html = renderForgeMarkdown('```\nconst x = 1\n```')
    expect(html).toContain('<pre><code>')
    expect(html).toContain('const x = 1')
  })

  test('a blockquote', () => {
    const html = renderForgeMarkdown('> quoted text')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('quoted text')
  })

  test('an unordered list', () => {
    const html = renderForgeMarkdown('- a\n- b')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>a</li>')
    expect(html).toContain('<li>b</li>')
  })

  test('an ordered list', () => {
    const html = renderForgeMarkdown('1. one\n2. two')
    expect(html).toContain('<ol>')
    expect(html).toContain('<li>one</li>')
  })

  test('a link to an allowed protocol keeps its href', () => {
    const html = renderForgeMarkdown('[text](https://example.com)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('>text<')
  })

  test('bold and italic emphasis', () => {
    const html = renderForgeMarkdown('**bold** and *italic*')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
  })
})

describe('reference link styling', () => {
  test('a link whose href is in referenceUrls gets the reference class', () => {
    const html = renderForgeMarkdown(
      '[#123](https://github.com/acme/repo/issues/123)',
      new Set(['https://github.com/acme/repo/issues/123']),
    )
    expect(html).toContain(`class="${REFERENCE_LINK_CLASS}"`)
  })

  test('a plain link not in referenceUrls never gets the reference class', () => {
    const html = renderForgeMarkdown(
      '[text](https://example.com)',
      new Set(['https://github.com/acme/repo/issues/123']),
    )
    expect(html).not.toContain(REFERENCE_LINK_CLASS)
  })

  test('a raw HTML link forging the reference class attribute: the class is dropped like any other, never granted the reference style', () => {
    const html = renderForgeMarkdown(
      '<a href="https://evil.example" class="fdp-md-ref">fake</a>',
      new Set(['https://github.com/acme/repo/issues/123']),
    )
    expect(html).not.toContain(REFERENCE_LINK_CLASS)
  })

  test('every link, reference or not, opens in a new tab with safe attributes', () => {
    const html = renderForgeMarkdown('[text](https://example.com)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})

describe('no content', () => {
  test('an empty body renders to no visible markup', () => {
    expect(renderForgeMarkdown('')).toBe('')
  })
})
