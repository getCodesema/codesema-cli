import { describe, expect, test } from 'bun:test'
import {
  extractIssueUrl,
  ghIssueDatabaseId,
  ghIssueNumberFromRest,
  ghRestIssueFrom,
  GLAB_HIERARCHY_CHILDREN_QUERY,
  GLAB_HIERARCHY_HAS_CHILDREN_QUERY,
  GLAB_HIERARCHY_PARENT_QUERY,
  glabIssueDatabaseId,
  glabIssueRestRef,
  isIssueNumber,
  parseGhIssue,
  parseGhIssueComments,
  parseGhIssueList,
  parseGhSubIssueList,
  parseGlabHierarchyChildren,
  parseGlabHierarchyHasChildren,
  parseGlabHierarchyMutation,
  parseGlabHierarchyParent,
  parseGlabIssue,
  parseGlabIssueList,
  parseGlabIssueNotes,
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
    expect(comma.ok === false && comma.detail).toBe(
      'label "needs, triage" refused: it contains a comma, and GitLab\'s API takes the label set as ONE comma-separated string — a comma can be read back from a forge, never written to one',
    )
  })

  test('a label at exactly 255 characters is accepted, 256 is refused — the boundary is > not >= (MIN-4)', () => {
    // 255/256/60/59 are hard-coded here on purpose, NOT read off
    // ISSUE_LABEL_MAX/LABEL_QUOTE_MAX: a test that builds both the fixture
    // AND the assertion from the same exported constant proves nothing —
    // moving ISSUE_LABEL_MAX from 255 to 3 would move both together and
    // leave the test green. Pinning both ends to the SPEC value (GitLab's
    // 255-character label cap) catches that drift.
    const atCap = 'x'.repeat(255)
    expect(sanitizeIssueLabels([atCap])).toEqual({ ok: true, labels: [atCap] })

    const overCap = 'x'.repeat(256)
    const result = sanitizeIssueLabels([overCap])
    expect(result.ok).toBe(false)
    // The refusal quotes the label TRUNCATED to LABEL_QUOTE_MAX (60) code
    // points — 59 kept plus an ellipsis — otherwise asserted nowhere despite
    // this being exactly the fixture that exercises it.
    const quoted = JSON.stringify(`${'x'.repeat(59)}…`)
    expect(result.ok === false && result.detail).toBe(
      `label ${quoted} refused: it is longer than 255 characters`,
    )
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

// --- T2.2: hierarchy parsers, direct (not through forge-issues.ts's ladder) ---

const GH_REST_ISSUE = {
  number: 20,
  title: 'Fix login',
  body: 'Login is broken.',
  state: 'open',
  labels: [{ name: 'bug' }],
  user: { login: 'jdoe' },
  created_at: '2026-07-20T09:30:00.123Z',
  updated_at: '2026-07-28T09:30:00.123Z',
  html_url: 'https://github.com/acme/repo/issues/20',
}

describe('ghRestIssueFrom / parseGhSubIssueList (T2.2)', () => {
  test('parses a valid REST sub-issue entry field by field', () => {
    expect(ghRestIssueFrom(GH_REST_ISSUE)).toEqual({
      number: 20,
      title: 'Fix login',
      body: 'Login is broken.',
      state: 'open',
      labels: ['bug'],
      author: 'jdoe',
      createdAt: '2026-07-20T09:30:00.123Z',
      updatedAt: '2026-07-28T09:30:00.123Z',
      url: 'https://github.com/acme/repo/issues/20',
    })
  })

  test('one badly typed entry rejects the WHOLE sub-issues array', () => {
    expect(
      parseGhSubIssueList(JSON.stringify([GH_REST_ISSUE, { ...GH_REST_ISSUE, number: '21' }])),
    ).toBeNull()
  })

  test('a truncated sub-issues payload is rejected, never partially parsed', () => {
    expect(parseGhSubIssueList(JSON.stringify([GH_REST_ISSUE]).slice(0, 30))).toBeNull()
  })

  test('null/non-object input never throws', () => {
    expect(ghRestIssueFrom(null)).toBeNull()
    expect(ghRestIssueFrom('a string')).toBeNull()
    expect(ghRestIssueFrom(42)).toBeNull()
  })
})

describe('ghIssueDatabaseId / glabIssueDatabaseId (T2.2)', () => {
  test('a positive integer id parses; anything else does not', () => {
    for (const parse of [ghIssueDatabaseId, glabIssueDatabaseId]) {
      expect(parse(JSON.stringify({ id: 4200 }))).toBe(4200)
      expect(parse(JSON.stringify({ id: 0 }))).toBeNull()
      expect(parse(JSON.stringify({ id: -1 }))).toBeNull()
      expect(parse(JSON.stringify({ id: 1.5 }))).toBeNull()
      expect(parse(JSON.stringify({ id: '4200' }))).toBeNull()
      expect(parse(JSON.stringify({}))).toBeNull()
      expect(parse('not json')).toBeNull()
      expect(parse(JSON.stringify([1, 2, 3]))).toBeNull()
    }
  })
})

describe('glabIssueRestRef (T2.2)', () => {
  test('a valid REST answer yields the database id and the URL origin', () => {
    expect(
      glabIssueRestRef(
        JSON.stringify({ id: 700, web_url: 'https://gitlab.com/acme/repo/-/issues/7' }),
      ),
    ).toEqual({ id: 700, origin: 'https://gitlab.com' })
  })

  test('a self-hosted origin (different scheme/port) is read as-is, never assumed to be gitlab.com', () => {
    expect(
      glabIssueRestRef(
        JSON.stringify({ id: 1, web_url: 'http://gitlab.internal:8080/a/b/-/issues/1' }),
      ),
    ).toEqual({ id: 1, origin: 'http://gitlab.internal:8080' })
  })

  test('a malformed web_url degrades to null rather than throwing on `new URL`', () => {
    expect(glabIssueRestRef(JSON.stringify({ id: 1, web_url: 'not a url' }))).toBeNull()
    expect(glabIssueRestRef(JSON.stringify({ id: 1, web_url: 42 }))).toBeNull()
    expect(glabIssueRestRef(JSON.stringify({ id: 1 }))).toBeNull()
  })

  test('a non-positive-integer id is rejected', () => {
    expect(
      glabIssueRestRef(JSON.stringify({ id: 0, web_url: 'https://gitlab.com/a/b/-/issues/1' })),
    ).toBeNull()
  })
})

describe('ghIssueNumberFromRest (T2.2)', () => {
  test('reads the repo-scoped number off a parent (or resolve) REST answer', () => {
    expect(ghIssueNumberFromRest(JSON.stringify({ number: 10 }))).toBe(10)
  })

  test('rejects anything that is not a positive integer number, never throws', () => {
    for (const bad of [
      JSON.stringify({ number: 0 }),
      JSON.stringify({ number: '10' }),
      JSON.stringify({}),
      'not json',
      JSON.stringify(null),
    ]) {
      expect(ghIssueNumberFromRest(bad)).toBeNull()
    }
  })
})

describe('parseGlabHierarchyMutation (T2.2)', () => {
  test('an empty errors array is a plain success', () => {
    expect(
      parseGlabHierarchyMutation(JSON.stringify({ data: { workItemUpdate: { errors: [] } } })),
    ).toEqual({ kind: 'ok', value: true })
  })

  test('a RECOGNIZED schema-gap top-level error answers "unsupported" (MAJEUR C, real graphql-ruby shape)', () => {
    const result = parseGlabHierarchyMutation(
      JSON.stringify({
        errors: [
          {
            message: "InputObject 'WorkItemUpdateInput' doesn't accept argument 'hierarchyWidget'",
          },
        ],
      }),
    )
    // The message is asserted verbatim (MIN-4), not just `.kind`: an
    // `unsupported` outcome still carries the forge's own words through to
    // the caller (invariant 2), and nothing else in this file pinned that.
    expect(result).toEqual({
      kind: 'unsupported',
      message: "InputObject 'WorkItemUpdateInput' doesn't accept argument 'hierarchyWidget'",
    })
  })

  test('an UNRECOGNIZED top-level error — our own typo on a widget leaf field — stays "error" (MAJEUR C)', () => {
    // Same SHAPE as a genuine gap ("Field 'x' doesn't exist on type 'Y'"),
    // but Y is one of our own widget types, not Query/Mutation: this can
    // only be this module's own mistake, never a real capability gap.
    const result = parseGlabHierarchyMutation(
      JSON.stringify({
        errors: [{ message: "Field 'childrn' doesn't exist on type 'WorkItemWidgetHierarchy'" }],
      }),
    )
    expect(result).toEqual({
      kind: 'error',
      message: "Field 'childrn' doesn't exist on type 'WorkItemWidgetHierarchy'",
    })
  })

  test('an authorization refusal (no recognized name) stays "error"', () => {
    const result = parseGlabHierarchyMutation(
      JSON.stringify({ errors: [{ message: 'You are not authorized to perform this action' }] }),
    )
    expect(result.kind).toBe('error')
  })

  test('a business rejection nested under data.workItemUpdate.errors stays "error", never "unsupported"', () => {
    const result = parseGlabHierarchyMutation(
      JSON.stringify({
        data: {
          workItemUpdate: { errors: ["You don't have permission to update this work item"] },
        },
      }),
    )
    expect(result).toEqual({
      kind: 'error',
      message: "You don't have permission to update this work item",
    })
  })

  test('an entry point genuinely missing from the schema (an edition without work items) answers "unsupported"', () => {
    const result = parseGlabHierarchyMutation(
      JSON.stringify({
        errors: [{ message: "Field 'workItemUpdate' doesn't exist on type 'Mutation'" }],
      }),
    )
    expect(result.kind).toBe('unsupported')
  })

  test('the SAME entry-point field name, but typo\'d on one of OUR OWN widget types, stays "error" (M20)', () => {
    // "workItem" is one of the two entry points GLAB_MISSING_ENTRY_POINTS
    // recognizes, but ONLY when the message says it is missing from
    // Query/Mutation. Here it is reported missing from
    // WorkItemWidgetHierarchy instead — a leaf-field typo this module made
    // on its OWN widget type, never a real capability gap. A mutant that
    // shortens the match down to "field 'workitem'" alone (dropping "doesn't
    // exist on type 'query'") would wrongly call this "unsupported".
    const result = parseGlabHierarchyMutation(
      JSON.stringify({
        errors: [{ message: "Field 'workItem' doesn't exist on type 'WorkItemWidgetHierarchy'" }],
      }),
    )
    expect(result.kind).toBe('error')
  })

  test('fragment-type gap needs BOTH halves of the conjunction, not either alone (M17)', () => {
    // Only "no such type" without "can't be a fragment condition": not the
    // recognized graphql-ruby shape, must stay "error". A mutant turning the
    // `&&` into `||` would call this "unsupported" on this half alone.
    const onlyNoSuchType = parseGlabHierarchyMutation(
      JSON.stringify({ errors: [{ message: 'No such type WorkItemWidgetHierarchy here' }] }),
    )
    expect(onlyNoSuchType.kind).toBe('error')
    // Only "can't be a fragment condition" without "no such type": same
    // posture, must also stay "error".
    const onlyFragmentCondition = parseGlabHierarchyMutation(
      JSON.stringify({ errors: [{ message: "X can't be a fragment condition here" }] }),
    )
    expect(onlyFragmentCondition.kind).toBe('error')
  })

  test('the input-argument gap needs BOTH halves of the conjunction, not either alone (M18)', () => {
    // Only the InputObject name, no "doesn't accept argument": stays "error".
    const onlyInputObject = parseGlabHierarchyMutation(
      JSON.stringify({ errors: [{ message: "InputObject 'WorkItemUpdateInput' is odd here" }] }),
    )
    expect(onlyInputObject.kind).toBe('error')
    // Only the "doesn't accept argument" half, no InputObject name: stays
    // "error" too.
    const onlyArgument = parseGlabHierarchyMutation(
      JSON.stringify({
        errors: [{ message: "Something doesn't accept argument 'hierarchyWidget'" }],
      }),
    )
    expect(onlyArgument.kind).toBe('error')
  })

  test('messages.some: ONE genuine gap among several top-level errors is enough (M24)', () => {
    // GitLab's own validate_max_errors allows up to 5 top-level errors on
    // one response. A mutant turning `.some` into `.every` would require
    // ALL of them to look like a gap, which a real mixed payload (one
    // genuine schema gap plus one unrelated validation error) never
    // satisfies.
    const result = parseGlabHierarchyMutation(
      JSON.stringify({
        errors: [
          { message: 'this query is too complex' },
          { message: "Field 'workItemUpdate' doesn't exist on type 'Mutation'" },
        ],
      }),
    )
    expect(result.kind).toBe('unsupported')
  })

  test('a top-level "errors": [] is a legitimate answer, never read as a refusal (M26)', () => {
    // Some GraphQL responses always carry an `errors` key, empty on success.
    // A mutant dropping the `errors.length === 0` half of the top-level
    // guard would treat this empty array as "the schema refused the query".
    const result = parseGlabHierarchyMutation(
      JSON.stringify({ errors: [], data: { workItemUpdate: { errors: [] } } }),
    )
    expect(result).toEqual({ kind: 'ok', value: true })
  })

  test('unreadable JSON never throws', () => {
    expect(parseGlabHierarchyMutation('not json')).toEqual({
      kind: 'error',
      message: 'unreadable output',
    })
    expect(parseGlabHierarchyMutation(JSON.stringify({ data: {} }))).toEqual({
      kind: 'error',
      message: 'unreadable output',
    })
  })
})

const GLAB_ORIGIN = 'https://gitlab.com'

function glabChild(iid: number, extra: Record<string, unknown> = {}) {
  return {
    iid,
    title: 'Fix login',
    state: 'OPEN',
    webPath: `/acme/repo/-/issues/${iid}`,
    author: { username: 'jdoe' },
    createdAt: '2026-07-20T09:30:00.123Z',
    updatedAt: '2026-07-28T09:30:00.123Z',
    widgets: [{ description: 'Login is broken.' }, { labels: { nodes: [{ title: 'bug' }] } }],
    ...extra,
  }
}

function childrenPage(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return JSON.stringify({
    data: {
      workItem: {
        widgets: [{ children: { pageInfo: { hasNextPage, endCursor }, nodes } }],
      },
    },
  })
}

describe('parseGlabHierarchyChildren (T2.2)', () => {
  test('parses a valid page field by field, including nested description/labels widgets', () => {
    const result = parseGlabHierarchyChildren(childrenPage([glabChild(20)]), GLAB_ORIGIN)
    expect(result).toEqual({
      kind: 'ok',
      value: {
        issues: [
          {
            number: 20,
            title: 'Fix login',
            body: 'Login is broken.',
            state: 'open',
            labels: ['bug'],
            author: 'jdoe',
            createdAt: '2026-07-20T09:30:00.123Z',
            updatedAt: '2026-07-28T09:30:00.123Z',
            url: 'https://gitlab.com/acme/repo/-/issues/20',
          },
        ],
        hasNextPage: false,
        endCursor: null,
      },
    })
  })

  test('propagates hasNextPage and endCursor from pageInfo verbatim', () => {
    const result = parseGlabHierarchyChildren(
      childrenPage([glabChild(20)], true, 'cursor1'),
      GLAB_ORIGIN,
    )
    expect(result.kind === 'ok' && result.value.hasNextPage).toBe(true)
    expect(result.kind === 'ok' && result.value.endCursor).toBe('cursor1')
  })

  test('a null webPath REJECTS the entry rather than fabricating a URL from the origin alone (MINEUR)', () => {
    // buildIssue requires a non-empty url string; a null webPath must turn
    // into `undefined`, not `origin + null`/`origin` — either of which
    // would be a URL this module invented, not one the forge gave it.
    const result = parseGlabHierarchyChildren(
      childrenPage([glabChild(20, { webPath: null })]),
      GLAB_ORIGIN,
    )
    expect(result).toEqual({ kind: 'error', message: 'unreadable output' })
  })

  test('a malformed (present but broken) labels widget REJECTS the whole entry, never falls back to [] (MINEUR)', () => {
    // Distinct from an ABSENT labels widget (tested below, a legitimate
    // "no labels"): here the widget IS present but its shape is broken —
    // "Never a partial array" means this must reject, not silently drop
    // the labels and keep the rest of the entry.
    const broken = glabChild(20, { widgets: [{ description: 'x' }, { labels: { nodes: 'nope' } }] })
    expect(parseGlabHierarchyChildren(childrenPage([broken]), GLAB_ORIGIN)).toEqual({
      kind: 'error',
      message: 'unreadable output',
    })
    const badTitle = glabChild(20, {
      widgets: [{ description: 'x' }, { labels: { nodes: [{ title: 42 }] } }],
    })
    expect(parseGlabHierarchyChildren(childrenPage([badTitle]), GLAB_ORIGIN)).toEqual({
      kind: 'error',
      message: 'unreadable output',
    })
  })

  test('an ABSENT labels widget reads as no labels — legitimate, not a rejection', () => {
    const noLabelsWidget = glabChild(20, { widgets: [{ description: 'x' }] })
    const result = parseGlabHierarchyChildren(childrenPage([noLabelsWidget]), GLAB_ORIGIN)
    expect(result.kind === 'ok' && result.value.issues[0]?.labels).toEqual([])
  })

  test('an ABSENT description widget reads as an empty body — legitimate, not a rejection', () => {
    const noDescWidget = glabChild(20, { widgets: [{ labels: { nodes: [{ title: 'bug' }] } }] })
    const result = parseGlabHierarchyChildren(childrenPage([noDescWidget]), GLAB_ORIGIN)
    expect(result.kind === 'ok' && result.value.issues[0]?.body).toBe('')
  })

  test('the children widget is found by its KEY, not its position in the widgets array', () => {
    const reordered = JSON.stringify({
      data: {
        workItem: {
          widgets: [
            { description: 'unrelated widget first' },
            { labels: { nodes: [] } },
            {
              children: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [glabChild(20)],
              },
            },
          ],
        },
      },
    })
    const result = parseGlabHierarchyChildren(reordered, GLAB_ORIGIN)
    expect(result.kind === 'ok' && result.value.issues).toHaveLength(1)
  })

  test('no hierarchy widget in the answer reads as no children, not a refusal', () => {
    const noWidget = JSON.stringify({ data: { workItem: { widgets: [{ description: 'x' }] } } })
    expect(parseGlabHierarchyChildren(noWidget, GLAB_ORIGIN)).toEqual({
      kind: 'ok',
      value: { issues: [], hasNextPage: false, endCursor: null },
    })
  })

  test('workItem: null (a bad id) degrades to unreadable, never throws', () => {
    expect(
      parseGlabHierarchyChildren(JSON.stringify({ data: { workItem: null } }), GLAB_ORIGIN),
    ).toEqual({ kind: 'error', message: 'unreadable output' })
  })

  test('a top-level RECOGNIZED schema gap answers "unsupported"', () => {
    const result = parseGlabHierarchyChildren(
      JSON.stringify({ errors: [{ message: "Field 'workItem' doesn't exist on type 'Query'" }] }),
      GLAB_ORIGIN,
    )
    expect(result.kind).toBe('unsupported')
  })

  test('a top-level UNRECOGNIZED error stays "error", never defaults to "unsupported" (M46)', () => {
    // The ternary that maps schemaGap -> 'unsupported' else 'error' must
    // actually branch: an authorization refusal (no recognized gap name)
    // must not be silently reported as "this edition can't do it" — that
    // would be the exact silent-guard failure CRITIQUE 2 already fixed once,
    // reappearing on this parser if the ternary collapsed to an
    // unconditional 'unsupported'.
    const result = parseGlabHierarchyChildren(
      JSON.stringify({ errors: [{ message: 'You are not authorized to perform this action' }] }),
      GLAB_ORIGIN,
    )
    expect(result).toEqual({
      kind: 'error',
      message: 'You are not authorized to perform this action',
    })
  })

  test('a fragment-type gap on WorkItemWidgetDescription is recognized (M14)', () => {
    const result = parseGlabHierarchyChildren(
      JSON.stringify({
        errors: [
          {
            message: "No such type WorkItemWidgetDescription, so it can't be a fragment condition",
          },
        ],
      }),
      GLAB_ORIGIN,
    )
    expect(result.kind).toBe('unsupported')
  })

  test('a fragment-type gap on WorkItemWidgetLabels is recognized (M15)', () => {
    const result = parseGlabHierarchyChildren(
      JSON.stringify({
        errors: [
          { message: "No such type WorkItemWidgetLabels, so it can't be a fragment condition" },
        ],
      }),
      GLAB_ORIGIN,
    )
    expect(result.kind).toBe('unsupported')
  })

  test('hasNextPage is read strictly: only the literal boolean true counts (M10)', () => {
    // A mutant turning `hasNextPage === true` into `hasNextPage !== false`
    // would treat any truthy-ish non-boolean (here: the string "true", and
    // null) as "there is more" — GraphQL never sends either for a Boolean
    // field, but a defensive strict check must reject them as false anyway.
    const stringTrue = parseGlabHierarchyChildren(
      childrenPage([glabChild(20)], 'true' as unknown as boolean, null),
      GLAB_ORIGIN,
    )
    expect(stringTrue.kind === 'ok' && stringTrue.value.hasNextPage).toBe(false)
    const nullValue = parseGlabHierarchyChildren(
      childrenPage([glabChild(20)], null as unknown as boolean, null),
      GLAB_ORIGIN,
    )
    expect(nullValue.kind === 'ok' && nullValue.value.hasNextPage).toBe(false)
  })

  test('an empty-string endCursor is treated as no cursor, never accepted as one (M11)', () => {
    // isNonEmptyString('') is false: an empty string must degrade to null,
    // not be walked as a real (empty) cursor value.
    const result = parseGlabHierarchyChildren(childrenPage([glabChild(20)], true, ''), GLAB_ORIGIN)
    expect(result.kind === 'ok' && result.value.endCursor).toBeNull()
  })

  test('one bad child entry rejects the WHOLE page, never a partial list', () => {
    const good = glabChild(20)
    const bad = { ...glabChild(21), iid: 'not-a-number' }
    expect(parseGlabHierarchyChildren(childrenPage([good, bad]), GLAB_ORIGIN)).toEqual({
      kind: 'error',
      message: 'unreadable output',
    })
  })
})

describe('parseGlabHierarchyParent (T2.2)', () => {
  test('a real parent is read off widgets[].parent.iid', () => {
    const payload = JSON.stringify({
      data: { workItem: { widgets: [{ parent: { iid: 10 } }] } },
    })
    expect(parseGlabHierarchyParent(payload)).toEqual({ kind: 'ok', value: 10 })
  })

  test('parent: null is a legitimate "no parent", never an error', () => {
    const payload = JSON.stringify({ data: { workItem: { widgets: [{ parent: null }] } } })
    expect(parseGlabHierarchyParent(payload)).toEqual({ kind: 'ok', value: null })
  })

  test('no hierarchy widget at all is also read as "no parent"', () => {
    const payload = JSON.stringify({ data: { workItem: { widgets: [{ description: 'x' }] } } })
    expect(parseGlabHierarchyParent(payload)).toEqual({ kind: 'ok', value: null })
  })

  test('a malformed parent.iid is rejected, never throws', () => {
    const payload = JSON.stringify({
      data: { workItem: { widgets: [{ parent: { iid: 'not-a-number' } }] } },
    })
    expect(parseGlabHierarchyParent(payload)).toEqual({
      kind: 'error',
      message: 'unreadable output',
    })
  })

  test('a recognized schema gap answers "unsupported"', () => {
    const payload = JSON.stringify({
      errors: [{ message: "Field 'workItem' doesn't exist on type 'Query'" }],
    })
    expect(parseGlabHierarchyParent(payload).kind).toBe('unsupported')
  })

  test('a top-level UNRECOGNIZED error stays "error", never defaults to "unsupported" (M46)', () => {
    // Same guard as parseGlabHierarchyChildren: an authorization refusal
    // during the one-level guard must be classified "error" (retryable,
    // journaled) — never "unsupported" (edition can't do it), which would
    // silently swallow a permission refusal as a capability gap.
    const payload = JSON.stringify({
      errors: [{ message: 'You are not authorized to perform this action' }],
    })
    expect(parseGlabHierarchyParent(payload)).toEqual({
      kind: 'error',
      message: 'You are not authorized to perform this action',
    })
  })
})

describe('parseGlabHierarchyHasChildren (T2.2)', () => {
  test('at least one child node is true', () => {
    const payload = JSON.stringify({
      data: { workItem: { widgets: [{ children: { nodes: [{ iid: 99 }] } }] } },
    })
    expect(parseGlabHierarchyHasChildren(payload)).toEqual({ kind: 'ok', value: true })
  })

  test('an empty nodes array is false', () => {
    const payload = JSON.stringify({
      data: { workItem: { widgets: [{ children: { nodes: [] } }] } },
    })
    expect(parseGlabHierarchyHasChildren(payload)).toEqual({ kind: 'ok', value: false })
  })

  test('no hierarchy widget at all is also false, not a refusal', () => {
    const payload = JSON.stringify({ data: { workItem: { widgets: [{ description: 'x' }] } } })
    expect(parseGlabHierarchyHasChildren(payload)).toEqual({ kind: 'ok', value: false })
  })

  test('a top-level UNRECOGNIZED error stays "error", never defaults to "unsupported" (M46)', () => {
    // The fourth (and, until this round, only untested) copy of the
    // `schemaGap ? unsupported : error` ternary. It matters MORE here than
    // on its three siblings, not less: this parser answers the cheap
    // `first: 1` probe the one-level guard runs, so a refusal reclassified
    // as `unsupported` would leave `forgeIssueReason` returning null — no
    // D2 code, no journal line, exactly the silent degradation invariant 2
    // forbids.
    const payload = JSON.stringify({
      errors: [{ message: 'You are not authorized to perform this action' }],
    })
    expect(parseGlabHierarchyHasChildren(payload)).toEqual({
      kind: 'error',
      message: 'You are not authorized to perform this action',
    })
  })

  test('a top-level RECOGNIZED schema gap answers "unsupported", carrying the forge message', () => {
    // The other direction of the same ternary: an edition whose schema has
    // no WorkItemWidgetHierarchy type at all fails the fragment condition,
    // and THAT is a genuine capability gap, not an outage.
    const payload = JSON.stringify({
      errors: [
        { message: "No such type WorkItemWidgetHierarchy, so it can't be a fragment condition" },
      ],
    })
    expect(parseGlabHierarchyHasChildren(payload)).toEqual({
      kind: 'unsupported',
      message: "No such type WorkItemWidgetHierarchy, so it can't be a fragment condition",
    })
  })
})

describe('hierarchy query constants (T2.2)', () => {
  test('the children query enters through Query.workItem, never Query.issue, and asks for a real cursor', () => {
    expect(GLAB_HIERARCHY_CHILDREN_QUERY).toContain('workItem(id: $id)')
    expect(GLAB_HIERARCHY_CHILDREN_QUERY).not.toMatch(/\bissue\(id:/)
    expect(GLAB_HIERARCHY_CHILDREN_QUERY).toContain('children(first: 100, after: $after)')
    expect(GLAB_HIERARCHY_CHILDREN_QUERY).toContain('pageInfo { hasNextPage endCursor }')
    expect(GLAB_HIERARCHY_CHILDREN_QUERY).toContain('webPath')
    expect(GLAB_HIERARCHY_CHILDREN_QUERY).not.toContain('webUrl')
  })

  test('the parent and has-children queries both enter through Query.workItem too', () => {
    expect(GLAB_HIERARCHY_PARENT_QUERY).toContain('workItem(id: $id)')
    expect(GLAB_HIERARCHY_PARENT_QUERY).toContain('parent { iid }')
    expect(GLAB_HIERARCHY_HAS_CHILDREN_QUERY).toContain('workItem(id: $id)')
    expect(GLAB_HIERARCHY_HAS_CHILDREN_QUERY).toContain('children(first: 1)')
  })
})

// T3.5: the marker search reads these, and a marker missed is a duplicate
// comment on someone's ticket — so `body` is the one field that rejects.
describe('comment payloads (T3.5)', () => {
  test('gh reads author.login and createdAt off the comments field', () => {
    const raw = JSON.stringify({
      comments: [
        { id: 'IC_1', author: { login: 'octocat' }, body: 'hi', createdAt: '2026-07-21T09:00:00Z' },
      ],
    })
    expect(parseGhIssueComments(raw)).toEqual([
      { body: 'hi', author: 'octocat', createdAt: '2026-07-21T09:00:00Z', system: false },
    ])
  })

  test('glab reads author.username and created_at off the capitalised Notes array', () => {
    const raw = JSON.stringify({
      iid: 7,
      Notes: [
        { id: 1, author: { username: 'jdoe' }, body: 'hi', created_at: '2026-07-21T09:30:00Z' },
      ],
    })
    expect(parseGlabIssueNotes(raw)).toEqual([
      { body: 'hi', author: 'jdoe', createdAt: '2026-07-21T09:30:00Z', system: false },
    ])
  })

  test("glab's system notes are kept and flagged, never silently dropped", () => {
    const raw = JSON.stringify({
      Notes: [
        { body: 'a real comment', author: { username: 'jdoe' }, system: false },
        { body: 'changed the description', author: { username: 'jdoe' }, system: true },
      ],
    })
    expect(parseGlabIssueNotes(raw)?.map((c) => c.system)).toEqual([false, true])
  })

  test('an issue with no Notes key at all is an empty list, not an unreadable answer', () => {
    expect(parseGlabIssueNotes(JSON.stringify({ iid: 7, title: 'x' }))).toEqual([])
    expect(parseGlabIssueNotes(JSON.stringify({ iid: 7, Notes: null }))).toEqual([])
  })

  test('an entry without a readable body rejects the WHOLE array', () => {
    const gh = JSON.stringify({ comments: [{ body: 'ok' }, { author: { login: 'x' } }] })
    expect(parseGhIssueComments(gh)).toBeNull()
    const glab = JSON.stringify({ Notes: [{ body: 'ok' }, { body: 42 }] })
    expect(parseGlabIssueNotes(glab)).toBeNull()
  })

  test('an empty body is a comment, and the author/date degrade to empty rather than reject', () => {
    expect(parseGhIssueComments(JSON.stringify({ comments: [{ body: '' }] }))).toEqual([
      { body: '', author: '', createdAt: '', system: false },
    ])
  })

  test('a truncated or non-object payload is null, never a throw', () => {
    expect(parseGhIssueComments('{"comments":[')).toBeNull()
    expect(parseGhIssueComments('[]')).toBeNull()
    expect(parseGhIssueComments('null')).toBeNull()
    expect(parseGlabIssueNotes('not json')).toBeNull()
    expect(parseGhIssueComments(JSON.stringify({ comments: 'nope' }))).toBeNull()
  })
})
