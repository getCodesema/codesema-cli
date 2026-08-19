import { describe, expect, test } from 'bun:test'
import {
  extractIssueUrl,
  isIssueNumber,
  ISSUE_LABEL_MAX,
  parseGhIssue,
  parseGhIssueList,
  parseGlabIssue,
  parseGlabIssueList,
  sanitizeIssueBody,
  sanitizeIssueLabels,
  sanitizeIssueTitle,
  type ForgeIssue,
} from './forge-issues-parse.js'

/** What a sanitized body must not contain any more; tab and newline survive. */
function hasStrayControlChar(value: string): boolean {
  return Array.from(value).some((ch) => {
    const code = ch.codePointAt(0) ?? 0
    return ch !== '\t' && ch !== '\n' && (code < 0x20 || code === 0x7f)
  })
}

const GH_ISSUE = {
  number: 42,
  title: 'Add sidebar',
  body: 'It needs a sidebar.',
  state: 'OPEN',
  labels: [{ id: 'l1', name: 'bug', color: 'd73a4a' }],
  author: { id: 'u1', is_bot: false, login: 'octocat', name: 'The Octocat' },
  createdAt: '2026-07-20T09:00:00Z',
  updatedAt: '2026-07-28T10:00:00Z',
  url: 'https://github.com/acme/repo/issues/42',
}

const GLAB_ISSUE = {
  iid: 7,
  title: 'Fix login',
  description: 'Login is broken.',
  state: 'opened',
  labels: ['bug', 'ui'],
  author: { id: 1, username: 'jdoe', name: 'Jane Doe' },
  created_at: '2026-07-20T09:30:00.123Z',
  updated_at: '2026-07-28T09:30:00.123Z',
  web_url: 'https://gitlab.com/acme/repo/-/issues/7',
}

const GH_ISSUE_PARSED: ForgeIssue = {
  number: 42,
  title: 'Add sidebar',
  body: 'It needs a sidebar.',
  state: 'open',
  labels: ['bug'],
  author: 'octocat',
  createdAt: '2026-07-20T09:00:00Z',
  updatedAt: '2026-07-28T10:00:00Z',
  url: 'https://github.com/acme/repo/issues/42',
}

const GLAB_ISSUE_PARSED: ForgeIssue = {
  number: 7,
  title: 'Fix login',
  body: 'Login is broken.',
  state: 'open',
  labels: ['bug', 'ui'],
  author: 'jdoe',
  createdAt: '2026-07-20T09:30:00.123Z',
  updatedAt: '2026-07-28T09:30:00.123Z',
  url: 'https://gitlab.com/acme/repo/-/issues/7',
}

describe('issue parsers', () => {
  test('parses a valid gh issue list payload field by field', () => {
    expect(parseGhIssueList(JSON.stringify([GH_ISSUE]))).toEqual([GH_ISSUE_PARSED])
  })

  test('parses a valid glab issue list payload field by field', () => {
    expect(parseGlabIssueList(JSON.stringify([GLAB_ISSUE]))).toEqual([GLAB_ISSUE_PARSED])
  })

  test('no open issues is an empty array, not an unavailability', () => {
    expect(parseGhIssueList('[]')).toEqual([])
    expect(parseGlabIssueList('[]')).toEqual([])
  })

  test('rejects a truncated payload without throwing', () => {
    expect(parseGhIssueList(JSON.stringify([GH_ISSUE]).slice(0, 60))).toBeNull()
    expect(parseGlabIssueList(JSON.stringify([GLAB_ISSUE]).slice(0, 60))).toBeNull()
  })

  test('rejects a non-array payload', () => {
    expect(parseGhIssueList(JSON.stringify(GH_ISSUE))).toBeNull()
    expect(parseGlabIssueList(JSON.stringify(GLAB_ISSUE))).toBeNull()
  })

  test('one badly typed entry rejects the WHOLE array, never the valid rest', () => {
    expect(parseGhIssueList(JSON.stringify([GH_ISSUE, { ...GH_ISSUE, number: '43' }]))).toBeNull()
    expect(
      parseGlabIssueList(JSON.stringify([GLAB_ISSUE, { ...GLAB_ISSUE, labels: [{ name: 'x' }] }])),
    ).toBeNull()
  })

  test('rejects a missing field, a bad timestamp, an unknown state and a bad author', () => {
    expect(parseGhIssueList(JSON.stringify([{ ...GH_ISSUE, title: undefined }]))).toBeNull()
    expect(parseGhIssueList(JSON.stringify([{ ...GH_ISSUE, updatedAt: 'not-a-date' }]))).toBeNull()
    expect(parseGhIssueList(JSON.stringify([{ ...GH_ISSUE, state: 'DRAFT' }]))).toBeNull()
    expect(parseGhIssueList(JSON.stringify([{ ...GH_ISSUE, author: { id: 'u1' } }]))).toBeNull()
    expect(parseGlabIssueList(JSON.stringify([{ ...GLAB_ISSUE, iid: 0 }]))).toBeNull()
    expect(parseGlabIssueList(JSON.stringify([{ ...GLAB_ISSUE, author: { id: 1 } }]))).toBeNull()
  })

  test('an absent or null description reads as an empty body, a mistyped one rejects', () => {
    expect(parseGhIssueList(JSON.stringify([{ ...GH_ISSUE, body: null }]))?.[0]?.body).toBe('')
    expect(parseGhIssueList(JSON.stringify([{ ...GH_ISSUE, body: undefined }]))?.[0]?.body).toBe('')
    expect(parseGhIssueList(JSON.stringify([{ ...GH_ISSUE, body: 12 }]))).toBeNull()
    expect(
      parseGlabIssueList(JSON.stringify([{ ...GLAB_ISSUE, description: null }]))?.[0]?.body,
    ).toBe('')
  })

  test('the two state vocabularies both land on open/closed', () => {
    expect(parseGhIssueList(JSON.stringify([{ ...GH_ISSUE, state: 'CLOSED' }]))?.[0]?.state).toBe(
      'closed',
    )
    expect(
      parseGlabIssueList(JSON.stringify([{ ...GLAB_ISSUE, state: 'closed' }]))?.[0]?.state,
    ).toBe('closed')
  })

  test('single-issue parsers accept an object and reject an array or a truncation', () => {
    expect(parseGhIssue(JSON.stringify(GH_ISSUE))).toEqual(GH_ISSUE_PARSED)
    expect(parseGlabIssue(JSON.stringify(GLAB_ISSUE))).toEqual(GLAB_ISSUE_PARSED)
    expect(parseGhIssue(JSON.stringify([GH_ISSUE]))).toBeNull()
    expect(parseGlabIssue('{ not json')).toBeNull()
  })

  test('a label containing a comma is READ back as-is: the read side never censors', () => {
    // The other face of this coin — the write side refusing it — is asserted in
    // forge-issues.test.ts ('a label no forge could WRITE …').
    expect(
      parseGlabIssueList(JSON.stringify([{ ...GLAB_ISSUE, labels: ['needs, triage'] }]))?.[0]
        ?.labels,
    ).toEqual(['needs, triage'])
    expect(
      parseGhIssueList(JSON.stringify([{ ...GH_ISSUE, labels: [{ name: 'needs, triage' }] }]))?.[0]
        ?.labels,
    ).toEqual(['needs, triage'])
  })
})

describe('sanitizers', () => {
  test('a title is single-line and bounded, whatever was handed in', () => {
    expect(sanitizeIssueTitle('a\nb\u0007 c')).toBe('a b c')
    expect(sanitizeIssueTitle('  --flag  spaced  ')).toBe('--flag spaced')
    expect(Array.from(sanitizeIssueTitle('x'.repeat(400)))).toHaveLength(255)
    expect(sanitizeIssueTitle('x'.repeat(400)).endsWith('…')).toBe(true)
  })

  test('a body keeps its lines and tabs, drops the rest, and never throws', () => {
    expect(sanitizeIssueBody('a\r\nb\tc\u0000')).toBe('a\nb\tc')
    expect(sanitizeIssueBody('')).toBe('')
    expect(hasStrayControlChar(sanitizeIssueBody('a\u0000\u001B[31mb'))).toBe(false)
  })

  test('a caller that lost its types gets a degradation, not a throw', () => {
    // Patron of sanitizeTaskRecord: `unknown` in, honest value out, never a
    // crash — the exported sanitizers used to be typed `string` and blew up on
    // the null a JS caller (or a JSON body) can always hand over.
    for (const raw of [null, undefined, 42, {}, ['x'], Symbol('s')]) {
      expect(sanitizeIssueTitle(raw)).toBe('')
      expect(sanitizeIssueBody(raw)).toBe('')
    }
  })

  test('labels: absent is an empty set, a non-list is a refusal, not a throw', () => {
    expect(sanitizeIssueLabels(undefined)).toEqual({ ok: true, labels: [] })
    expect(sanitizeIssueLabels(null)).toEqual({ ok: true, labels: [] })
    expect(sanitizeIssueLabels(['bug', ' ui '])).toEqual({ ok: true, labels: ['bug', 'ui'] })
    expect(sanitizeIssueLabels('bug').ok).toBe(false)
    expect(sanitizeIssueLabels([null]).ok).toBe(false)
  })

  test('a refused label says which one and why, comma included', () => {
    const comma = sanitizeIssueLabels(['ok', 'needs, triage'])
    expect(comma.ok).toBe(false)
    expect(comma.ok === false && comma.detail).toContain('needs, triage')
    expect(comma.ok === false && comma.detail).toContain('comma-separated')
    const long = sanitizeIssueLabels(['x'.repeat(ISSUE_LABEL_MAX + 1)])
    expect(long.ok === false && long.detail).toContain(String(ISSUE_LABEL_MAX))
  })

  test('an issue number is a positive integer or nothing at all', () => {
    expect(isIssueNumber(1)).toBe(true)
    for (const bad of [0, -1, 1.5, '1', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isIssueNumber(bad)).toBe(false)
    }
  })
})

describe('extractIssueUrl', () => {
  test('recovers the created issue URL and trims trailing punctuation', () => {
    expect(extractIssueUrl('Created https://gitlab.com/a/b/-/issues/7.')).toBe(
      'https://gitlab.com/a/b/-/issues/7',
    )
    expect(extractIssueUrl('nothing here')).toBeNull()
  })

  test('a self-hosted forge on plain http keeps its link', () => {
    expect(extractIssueUrl('http://gitlab.internal/a/b/-/issues/12\n')).toBe(
      'http://gitlab.internal/a/b/-/issues/12',
    )
  })
})
