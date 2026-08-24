import { describe, expect, test } from 'bun:test'
import { linkifyForgeReferences } from './ForgeReferenceLinks'

const GH_ISSUE_URL = 'https://github.com/acme/repo/issues/42'
const GH_PR_URL = 'https://github.com/acme/repo/pull/42'
const GLAB_ISSUE_URL = 'https://gitlab.com/acme/repo/-/issues/7'
const GLAB_MR_URL = 'https://gitlab.com/acme/repo/-/merge_requests/7'

describe('a simple reference', () => {
  test('is rewritten into a markdown link, and the URL it points to is reported', () => {
    const { markdown, referenceUrls } = linkifyForgeReferences('see #123 for details', GH_ISSUE_URL)
    expect(markdown).toBe('see [#123](https://github.com/acme/repo/issues/123) for details')
    expect(referenceUrls).toEqual(new Set(['https://github.com/acme/repo/issues/123']))
  })

  test('the base is derived from the current item, same URL family: a PR stays a pull URL', () => {
    const { markdown } = linkifyForgeReferences('#7', GH_PR_URL)
    expect(markdown).toBe('[#7](https://github.com/acme/repo/pull/7)')
  })

  test('a GitLab issue URL derives a GitLab-shaped base', () => {
    const { markdown } = linkifyForgeReferences('#5', GLAB_ISSUE_URL)
    expect(markdown).toBe('[#5](https://gitlab.com/acme/repo/-/issues/5)')
  })

  test('a GitLab MR URL derives a merge_requests-shaped base', () => {
    const { markdown } = linkifyForgeReferences('#5', GLAB_MR_URL)
    expect(markdown).toBe('[#5](https://gitlab.com/acme/repo/-/merge_requests/5)')
  })

  test('every reference in the body is rewritten, and every URL reported', () => {
    const { markdown, referenceUrls } = linkifyForgeReferences('see #1 and #2', GH_ISSUE_URL)
    expect(markdown).toBe(
      'see [#1](https://github.com/acme/repo/issues/1) and [#2](https://github.com/acme/repo/issues/2)',
    )
    expect(referenceUrls).toEqual(
      new Set(['https://github.com/acme/repo/issues/1', 'https://github.com/acme/repo/issues/2']),
    )
  })
})

describe('masking: zones where # never means a reference', () => {
  test('a reference inside a fenced code block is left untouched', () => {
    const markdown = 'see #1\n```\ncode #123 unchanged\n```\nend'
    const { markdown: result, referenceUrls } = linkifyForgeReferences(markdown, GH_ISSUE_URL)
    expect(result).toContain('code #123 unchanged')
    expect(result).not.toContain('](https://github.com/acme/repo/issues/123)')
    expect(referenceUrls).toEqual(new Set(['https://github.com/acme/repo/issues/1']))
  })

  test('a reference inside inline code is left untouched', () => {
    const { markdown, referenceUrls } = linkifyForgeReferences('inline `#123` code', GH_ISSUE_URL)
    expect(markdown).toBe('inline `#123` code')
    expect(referenceUrls.size).toBe(0)
  })

  test('a reference inside an existing link is left untouched, no nested link is produced', () => {
    const { markdown, referenceUrls } = linkifyForgeReferences(
      '[see #123 here](https://example.com)',
      GH_ISSUE_URL,
    )
    expect(markdown).toBe('[see #123 here](https://example.com)')
    expect(referenceUrls.size).toBe(0)
  })

  test('a hex color is never mistaken for a reference', () => {
    const { markdown, referenceUrls } = linkifyForgeReferences('the color is #1a2b3c', GH_ISSUE_URL)
    expect(markdown).toBe('the color is #1a2b3c')
    expect(referenceUrls.size).toBe(0)
  })

  test('an issue comment anchor in a bare URL is never mistaken for a reference', () => {
    const markdown = 'see https://github.com/acme/repo/issues/12#issuecomment-9 for context'
    const { markdown: result, referenceUrls } = linkifyForgeReferences(markdown, GH_ISSUE_URL)
    expect(result).toBe(markdown)
    expect(referenceUrls.size).toBe(0)
  })

  test('code and links compose: a reference outside them is still linkified', () => {
    const markdown = '`#1` then #2 then [#3](https://example.com)'
    const { markdown: result, referenceUrls } = linkifyForgeReferences(markdown, GH_ISSUE_URL)
    expect(result).toBe(
      '`#1` then [#2](https://github.com/acme/repo/issues/2) then [#3](https://example.com)',
    )
    expect(referenceUrls).toEqual(new Set(['https://github.com/acme/repo/issues/2']))
  })
})

describe('an unreliable base', () => {
  test('an item URL not ending in /<number>: every reference is left as plain text', () => {
    const markdown = 'see #123 for details'
    const { markdown: result, referenceUrls } = linkifyForgeReferences(
      markdown,
      'https://example.com/not-numbered',
    )
    expect(result).toBe(markdown)
    expect(referenceUrls.size).toBe(0)
  })

  test('an empty item URL: every reference is left as plain text', () => {
    const markdown = 'see #123 for details'
    const { markdown: result, referenceUrls } = linkifyForgeReferences(markdown, '')
    expect(result).toBe(markdown)
    expect(referenceUrls.size).toBe(0)
  })
})

describe('no references', () => {
  test('a body with no # at all is returned unchanged', () => {
    const { markdown, referenceUrls } = linkifyForgeReferences('nothing to see here', GH_ISSUE_URL)
    expect(markdown).toBe('nothing to see here')
    expect(referenceUrls.size).toBe(0)
  })

  test('an empty body is returned unchanged', () => {
    const { markdown, referenceUrls } = linkifyForgeReferences('', GH_ISSUE_URL)
    expect(markdown).toBe('')
    expect(referenceUrls.size).toBe(0)
  })
})
