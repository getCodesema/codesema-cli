import { describe, expect, test } from 'bun:test'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  test('plain text becomes a paragraph, untouched', () => {
    expect(renderMarkdown('Done. I ran the checks.')).toBe('<p>Done. I ran the checks.</p>')
  })

  test('HTML is escaped BEFORE any transform: never injectable', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    )
    expect(renderMarkdown('a **<b>** b')).toBe('<p>a <strong>&lt;b&gt;</strong> b</p>')
  })

  test('headings map to two visual ranks', () => {
    expect(renderMarkdown('## Ce qui reste à faire')).toBe('<h2>Ce qui reste à faire</h2>')
    expect(renderMarkdown('### Détail')).toBe('<h3>Détail</h3>')
    expect(renderMarkdown('# Top')).toBe('<h2>Top</h2>')
  })

  test('bold, italic, inline code — code wins over emphasis', () => {
    expect(renderMarkdown('**Où on en est** : la tranche 1')).toBe(
      '<p><strong>Où on en est</strong> : la tranche 1</p>',
    )
    expect(renderMarkdown('run `npm **test**` now')).toBe(
      '<p>run <code>npm **test**</code> now</p>',
    )
    expect(renderMarkdown('a *souligné* mot')).toBe('<p>a <em>souligné</em> mot</p>')
  })

  test('lists, ordered and not', () => {
    expect(renderMarkdown('- un\n- deux')).toBe('<ul><li>un</li><li>deux</li></ul>')
    expect(renderMarkdown('1. un\n2. deux')).toBe('<ol><li>un</li><li>deux</li></ol>')
  })

  test('fenced code keeps its body literal', () => {
    expect(renderMarkdown('```\nconst a = 1 && 2\n```')).toBe(
      '<pre><code>const a = 1 &amp;&amp; 2</code></pre>',
    )
  })

  test('links: http(s) only, label rendered', () => {
    expect(renderMarkdown('[doc](https://ex.com/a)')).toBe(
      '<p><a href="https://ex.com/a" target="_blank" rel="noopener noreferrer">doc</a></p>',
    )
    // Non-http protocol never becomes a link.
    expect(renderMarkdown('[x](javascript:alert(1))')).toContain('[x](javascript:alert(1))')
  })

  test('inline images: http(s) and /api evidence paths only', () => {
    expect(renderMarkdown('![shot](https://ex.com/a.png)')).toBe(
      '<p><img src="https://ex.com/a.png" alt="shot" loading="lazy" /></p>',
    )
    expect(renderMarkdown('![](/api/tasks/t1/evidence/screenshots%2Fa.png?project=p)')).toBe(
      '<p><img src="/api/tasks/t1/evidence/screenshots%2Fa.png?project=p" alt="" loading="lazy" /></p>',
    )
    // javascript: and bare relative paths stay literal.
    expect(renderMarkdown('![x](javascript:alert(1))')).toContain('![x](javascript:alert(1))')
    expect(renderMarkdown('![x](../evil.png)')).toContain('![x](../evil.png)')
  })

  test('mixed document: headings + bold + list + paragraphs', () => {
    const out = renderMarkdown('## Reste à faire\n\n**Où on en est** : ok.\n\n- a\n- b')
    expect(out).toBe(
      '<h2>Reste à faire</h2><p><strong>Où on en est</strong> : ok.</p><ul><li>a</li><li>b</li></ul>',
    )
  })

  test('hard-wrapped paragraph lines join with <br>', () => {
    expect(renderMarkdown('ligne 1\nligne 2')).toBe('<p>ligne 1<br>ligne 2</p>')
  })

  test('blockquotes keep their lines, rules become <hr>', () => {
    expect(renderMarkdown('> one\n> two\n\n---\n\nafter')).toBe(
      '<blockquote>one<br>two</blockquote><hr><p>after</p>',
    )
  })

  test('pipe tables render head and rows, cells inline-formatted', () => {
    expect(renderMarkdown('| a | b |\n|---|:--:|\n| `x` | **y** |')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td><code>x</code></td><td><strong>y</strong></td></tr></tbody></table>',
    )
  })

  test('a lone pipe line without a separator row stays a paragraph', () => {
    expect(renderMarkdown('| not | a table |')).toBe('<p>| not | a table |</p>')
  })
})
