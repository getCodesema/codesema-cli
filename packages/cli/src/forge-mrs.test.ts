import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  FORGE_MR_MAX_BUFFER_BYTES,
  listOpenMrs,
  MR_LIST_MAX,
  parseGhMrList,
  parseGlabMrDetail,
  parseGlabMrList,
  runForgeCli,
  type CliOutcome,
  type ForgeMr,
  type ForgeMrsExecFn,
} from './forge-mrs.js'

/** The 7 fields every ForgeMr carries regardless of forge or enrichment outcome. */
const BASE_FIELDS = {
  number: 1,
  title: 'x',
  author: 'a',
  sourceBranch: 'feat/x',
  targetBranch: 'main',
  updatedAt: '2026-07-28T10:00:00Z',
  url: 'https://example.test/1',
}

/** All the new contract fields as they read when the forge gave nothing to fill them with. */
const EMPTY_ENRICHMENT = {
  state: null,
  isDraft: null,
  labels: null,
  additions: null,
  deletions: null,
  changedFiles: null,
  checks: null,
  reviewers: null,
  assignees: null,
  milestone: null,
  mergeable: null,
  commits: null,
  body: null,
} satisfies Partial<ForgeMr>

describe('parseGhMrList', () => {
  test('parses a valid gh pr list --json payload with none of the new fields', () => {
    const raw = JSON.stringify([
      {
        number: 42,
        title: 'Add sidebar',
        author: { id: 'u1', is_bot: false, login: 'octocat', name: 'The Octocat' },
        baseRefName: 'main',
        headRefName: 'feat/sidebar',
        updatedAt: '2026-07-28T10:00:00Z',
        url: 'https://github.com/acme/repo/pull/42',
      },
    ])
    expect(parseGhMrList(raw)).toEqual([
      {
        number: 42,
        title: 'Add sidebar',
        author: 'octocat',
        sourceBranch: 'feat/sidebar',
        targetBranch: 'main',
        updatedAt: '2026-07-28T10:00:00Z',
        url: 'https://github.com/acme/repo/pull/42',
        ...EMPTY_ENRICHMENT,
      },
    ])
  })

  test('returns an empty array for no open PRs', () => {
    expect(parseGhMrList('[]')).toEqual([])
  })

  test('rejects invalid json', () => {
    expect(parseGhMrList('not json')).toBeNull()
  })

  test('rejects a non-array payload', () => {
    expect(parseGhMrList('{"number":1}')).toBeNull()
  })

  test('rejects an entry missing a required field', () => {
    const raw = JSON.stringify([
      {
        number: 1,
        title: 'x',
        author: { login: 'a' },
        baseRefName: 'main',
        // headRefName missing
        updatedAt: '2026-07-28T10:00:00Z',
        url: 'https://github.com/acme/repo/pull/1',
      },
    ])
    expect(parseGhMrList(raw)).toBeNull()
  })

  test('rejects an unparseable updatedAt', () => {
    const raw = JSON.stringify([
      {
        number: 1,
        title: 'x',
        author: { login: 'a' },
        baseRefName: 'main',
        headRefName: 'feat/x',
        updatedAt: 'not-a-date',
        url: 'https://github.com/acme/repo/pull/1',
      },
    ])
    expect(parseGhMrList(raw)).toBeNull()
  })

  test('parses every new field when gh supplies the full contract', () => {
    const raw = JSON.stringify([
      {
        number: 42,
        title: 'Add sidebar',
        author: { login: 'octocat' },
        baseRefName: 'main',
        headRefName: 'feat/sidebar',
        updatedAt: '2026-07-28T10:00:00Z',
        url: 'https://github.com/acme/repo/pull/42',
        state: 'OPEN',
        isDraft: true,
        labels: [{ id: 'L1', name: 'bug', description: '', color: 'D6393F' }],
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        statusCheckRollup: [
          {
            __typename: 'CheckRun',
            name: 'build',
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            startedAt: '2026-07-28T09:00:00Z',
            completedAt: '2026-07-28T09:05:00Z',
            detailsUrl: 'https://github.com/acme/repo/runs/1',
          },
        ],
        reviewRequests: [{ __typename: 'User', login: 'reviewer1' }],
        assignees: [{ id: 'u2', login: 'assignee1', name: 'Assignee One' }],
        milestone: { number: 1, title: 'v1.0', description: '', dueOn: null },
        mergeable: 'MERGEABLE',
        commits: [
          {
            oid: 'abc123',
            messageHeadline: 'feat: sidebar',
            messageBody: '',
            committedDate: '2026-07-28T09:00:00Z',
            authoredDate: '2026-07-28T09:00:00Z',
            authors: [{ name: 'octocat', email: 'o@example.test', id: 'u1', login: 'octocat' }],
          },
        ],
        body: 'PR description',
      },
    ])
    expect(parseGhMrList(raw)).toEqual([
      {
        number: 42,
        title: 'Add sidebar',
        author: 'octocat',
        sourceBranch: 'feat/sidebar',
        targetBranch: 'main',
        updatedAt: '2026-07-28T10:00:00Z',
        url: 'https://github.com/acme/repo/pull/42',
        state: 'open',
        isDraft: true,
        labels: ['bug'],
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        checks: { passed: 1, failed: 0, pending: 0, skipped: 0, truncated: false },
        reviewers: ['reviewer1'],
        assignees: ['assignee1'],
        milestone: 'v1.0',
        mergeable: 'mergeable',
        commits: 1,
        body: 'PR description',
      },
    ])
  })

  test('a field the forge did not supply is null, never 0, [], or ""', () => {
    const raw = JSON.stringify([
      {
        ...BASE_FIELDS,
        author: { login: 'a' },
        baseRefName: 'main',
        headRefName: 'feat/x',
        // No state, isDraft, labels, additions, deletions, changedFiles,
        // statusCheckRollup, reviewRequests, assignees, milestone, mergeable,
        // commits, body at all.
      },
    ])
    const parsed = parseGhMrList(raw)
    expect(parsed).not.toBeNull()
    const mr = parsed?.[0]
    expect(mr?.state).toBeNull()
    expect(mr?.isDraft).toBeNull()
    expect(mr?.labels).toBeNull()
    expect(mr?.additions).toBeNull()
    expect(mr?.deletions).toBeNull()
    expect(mr?.changedFiles).toBeNull()
    expect(mr?.checks).toBeNull()
    expect(mr?.reviewers).toBeNull()
    expect(mr?.assignees).toBeNull()
    expect(mr?.milestone).toBeNull()
    expect(mr?.mergeable).toBeNull()
    expect(mr?.commits).toBeNull()
    expect(mr?.body).toBeNull()
    // Explicitly not the falsy defaults a careless mapping would produce:
    expect(mr?.additions).not.toBe(0)
    expect(mr?.labels).not.toEqual([])
    expect(mr?.body).not.toBe('')
  })

  test('an unrecognised state or mergeable value degrades to null, not a guess', () => {
    const raw = JSON.stringify([
      {
        ...BASE_FIELDS,
        author: { login: 'a' },
        baseRefName: 'main',
        headRefName: 'feat/x',
        state: 'SOMETHING_NEW',
        mergeable: 'SOMETHING_ELSE',
      },
    ])
    const parsed = parseGhMrList(raw)
    expect(parsed?.[0]?.state).toBeNull()
    expect(parsed?.[0]?.mergeable).toBeNull()
  })

  test('milestone null (no milestone set) stays null, distinct from a missing field', () => {
    const raw = JSON.stringify([
      {
        ...BASE_FIELDS,
        author: { login: 'a' },
        baseRefName: 'main',
        headRefName: 'feat/x',
        milestone: null,
      },
    ])
    expect(parseGhMrList(raw)?.[0]?.milestone).toBeNull()
  })

  test('body "" (an empty but present description) is kept as "", not turned into null', () => {
    const raw = JSON.stringify([
      {
        ...BASE_FIELDS,
        author: { login: 'a' },
        baseRefName: 'main',
        headRefName: 'feat/x',
        body: '',
      },
    ])
    expect(parseGhMrList(raw)?.[0]?.body).toBe('')
  })

  test('reviewRequests folds Team entries (name, no login) alongside User entries (login)', () => {
    const raw = JSON.stringify([
      {
        ...BASE_FIELDS,
        author: { login: 'a' },
        baseRefName: 'main',
        headRefName: 'feat/x',
        reviewRequests: [
          { __typename: 'User', login: 'alice' },
          { __typename: 'Team', name: 'platform-team', slug: 'platform-team' },
        ],
      },
    ])
    expect(parseGhMrList(raw)?.[0]?.reviewers).toEqual(['alice', 'platform-team'])
  })

  test('a malformed optional field degrades that field to null without rejecting the whole entry', () => {
    const raw = JSON.stringify([
      {
        ...BASE_FIELDS,
        author: { login: 'a' },
        baseRefName: 'main',
        headRefName: 'feat/x',
        labels: [{ description: 'no name here' }],
        additions: 'twelve',
        milestone: { description: 'no title here' },
      },
    ])
    const parsed = parseGhMrList(raw)
    expect(parsed).not.toBeNull()
    expect(parsed?.[0]?.labels).toBeNull()
    expect(parsed?.[0]?.additions).toBeNull()
    expect(parsed?.[0]?.milestone).toBeNull()
    // Required fields are untouched, and the entry is still returned.
    expect(parsed?.[0]?.number).toBe(1)
  })

  describe('statusCheckRollup rollup', () => {
    function ghListWith(statusCheckRollup: unknown): string {
      return JSON.stringify([
        {
          ...BASE_FIELDS,
          author: { login: 'a' },
          baseRefName: 'main',
          headRefName: 'feat/x',
          statusCheckRollup,
        },
      ])
    }

    test('null statusCheckRollup (no resolvable head commit) yields checks: null, not an all-zero rollup', () => {
      expect(parseGhMrList(ghListWith(null))?.[0]?.checks).toBeNull()
    })

    test('an empty array (head commit exists, zero checks configured) yields a real all-zero rollup', () => {
      expect(parseGhMrList(ghListWith([]))?.[0]?.checks).toEqual({
        passed: 0,
        failed: 0,
        pending: 0,
        skipped: 0,
        truncated: false,
      })
    })

    test('buckets every CheckRun conclusion and StatusContext state correctly', () => {
      const checks = [
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEUTRAL' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'CANCELLED' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'STALE' },
        { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
        { __typename: 'CheckRun', status: 'QUEUED', conclusion: '' },
        { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' },
        { __typename: 'StatusContext', context: 'ci/legacy2', state: 'PENDING' },
        { __typename: 'StatusContext', context: 'ci/legacy3', state: 'EXPECTED' },
        { __typename: 'StatusContext', context: 'ci/legacy4', state: 'ERROR' },
        { __typename: 'StatusContext', context: 'ci/legacy5', state: 'FAILURE' },
      ]
      expect(parseGhMrList(ghListWith(checks))?.[0]?.checks).toEqual({
        passed: 3, // CheckRun (SUCCESS, NEUTRAL) + StatusContext (SUCCESS)
        failed: 6, // CheckRun (FAILURE, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE) + StatusContext (ERROR, FAILURE)
        pending: 4, // CheckRun (IN_PROGRESS, QUEUED) + StatusContext (PENDING, EXPECTED)
        skipped: 3, // CheckRun (SKIPPED, CANCELLED, STALE)
        truncated: false,
      })
    })

    test('a completed CheckRun with an unrecognised conclusion surfaces as failed, not silently dropped', () => {
      const checks = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SOMETHING_NEW' }]
      expect(parseGhMrList(ghListWith(checks))?.[0]?.checks).toEqual({
        passed: 0,
        failed: 1,
        pending: 0,
        skipped: 0,
        truncated: false,
      })
    })

    test('a StatusContext with an unrecognised state surfaces as failed', () => {
      const checks = [{ __typename: 'StatusContext', context: 'x', state: 'SOMETHING_NEW' }]
      expect(parseGhMrList(ghListWith(checks))?.[0]?.checks).toEqual({
        passed: 0,
        failed: 1,
        pending: 0,
        skipped: 0,
        truncated: false,
      })
    })

    test('truncated is true once the rollup hits gh own contexts(first:100) cap', () => {
      const hundred = Array.from({ length: 100 }, () => ({
        __typename: 'CheckRun',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
      }))
      const rollup = parseGhMrList(ghListWith(hundred))?.[0]?.checks
      expect(rollup?.truncated).toBe(true)
      expect(rollup?.passed).toBe(100)
    })

    test('truncated is false under the cap', () => {
      const ninetyNine = Array.from({ length: 99 }, () => ({
        __typename: 'CheckRun',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
      }))
      expect(parseGhMrList(ghListWith(ninetyNine))?.[0]?.checks?.truncated).toBe(false)
    })

    test('shape mismatch in a check entry degrades the whole checks field to null', () => {
      expect(parseGhMrList(ghListWith(['not an object']))?.[0]?.checks).toBeNull()
    })
  })
})

describe('parseGlabMrList', () => {
  test('parses a valid glab mr list --output json payload with none of the new fields', () => {
    const raw = JSON.stringify([
      {
        iid: 7,
        title: 'Fix login',
        author: { id: 1, username: 'jdoe', name: 'Jane Doe' },
        source_branch: 'fix/login',
        target_branch: 'develop',
        updated_at: '2026-07-28T09:30:00.123Z',
        web_url: 'https://gitlab.com/acme/repo/-/merge_requests/7',
      },
    ])
    expect(parseGlabMrList(raw)).toEqual([
      {
        number: 7,
        title: 'Fix login',
        author: 'jdoe',
        sourceBranch: 'fix/login',
        targetBranch: 'develop',
        updatedAt: '2026-07-28T09:30:00.123Z',
        url: 'https://gitlab.com/acme/repo/-/merge_requests/7',
        ...EMPTY_ENRICHMENT,
      },
    ])
  })

  test('returns an empty array for no open MRs', () => {
    expect(parseGlabMrList('[]')).toEqual([])
  })

  test('rejects invalid json', () => {
    expect(parseGlabMrList('{not json')).toBeNull()
  })

  test('rejects a non-array payload', () => {
    expect(parseGlabMrList('{"iid":1}')).toBeNull()
  })

  test('rejects an entry missing a required field', () => {
    const raw = JSON.stringify([
      {
        iid: 7,
        title: 'Fix login',
        author: { username: 'jdoe' },
        source_branch: 'fix/login',
        // target_branch missing
        updated_at: '2026-07-28T09:30:00.123Z',
        web_url: 'https://gitlab.com/acme/repo/-/merge_requests/7',
      },
    ])
    expect(parseGlabMrList(raw)).toBeNull()
  })

  test('rejects an entry whose author has no username', () => {
    const raw = JSON.stringify([
      {
        iid: 7,
        title: 'Fix login',
        author: { id: 1 },
        source_branch: 'fix/login',
        target_branch: 'develop',
        updated_at: '2026-07-28T09:30:00.123Z',
        web_url: 'https://gitlab.com/acme/repo/-/merge_requests/7',
      },
    ])
    expect(parseGlabMrList(raw)).toBeNull()
  })

  test('parses every field the list payload itself can supply', () => {
    const raw = JSON.stringify([
      {
        iid: 7,
        title: 'Fix login',
        description: 'MR body',
        author: { username: 'jdoe' },
        source_branch: 'fix/login',
        target_branch: 'develop',
        updated_at: '2026-07-28T09:30:00.123Z',
        web_url: 'https://gitlab.com/acme/repo/-/merge_requests/7',
        state: 'opened',
        draft: true,
        work_in_progress: false,
        labels: ['bug', 'needs-review'],
        assignees: [{ username: 'jdoe' }],
        reviewers: [{ username: 'reviewer1' }, { username: 'reviewer2' }],
        milestone: { title: 'v1.0' },
        merge_status: 'can_be_merged',
      },
    ])
    expect(parseGlabMrList(raw)).toEqual([
      {
        number: 7,
        title: 'Fix login',
        author: 'jdoe',
        sourceBranch: 'fix/login',
        targetBranch: 'develop',
        updatedAt: '2026-07-28T09:30:00.123Z',
        url: 'https://gitlab.com/acme/repo/-/merge_requests/7',
        state: 'open',
        isDraft: true,
        labels: ['bug', 'needs-review'],
        additions: null,
        deletions: null,
        changedFiles: null,
        checks: null,
        reviewers: ['reviewer1', 'reviewer2'],
        assignees: ['jdoe'],
        milestone: 'v1.0',
        mergeable: 'mergeable',
        commits: null,
        body: 'MR body',
      },
    ])
  })

  test('a field the list payload does not supply is null, never 0, [], or ""', () => {
    const raw = JSON.stringify([
      {
        iid: 7,
        title: 'x',
        author: { username: 'a' },
        source_branch: 'x',
        target_branch: 'main',
        updated_at: '2026-07-28T09:30:00.123Z',
        web_url: 'https://gitlab.com/a/b/-/merge_requests/7',
      },
    ])
    const parsed = parseGlabMrList(raw)
    const mr = parsed?.[0]
    expect(mr?.state).toBeNull()
    expect(mr?.isDraft).toBeNull()
    expect(mr?.labels).toBeNull()
    expect(mr?.reviewers).toBeNull()
    expect(mr?.assignees).toBeNull()
    expect(mr?.milestone).toBeNull()
    expect(mr?.mergeable).toBeNull()
    expect(mr?.body).toBeNull()
    // Never fetched at the list stage regardless of what the payload says:
    expect(mr?.additions).toBeNull()
    expect(mr?.deletions).toBeNull()
    expect(mr?.changedFiles).toBeNull()
    expect(mr?.checks).toBeNull()
    expect(mr?.commits).toBeNull()
  })

  test.each([
    ['opened', 'open'],
    ['merged', 'merged'],
    ['closed', 'closed'],
  ])('maps state %s to %s', (glabState, expected) => {
    const raw = JSON.stringify([
      {
        iid: 1,
        title: 'x',
        author: { username: 'a' },
        source_branch: 'x',
        target_branch: 'main',
        updated_at: '2026-07-28T09:30:00.123Z',
        web_url: 'https://gitlab.com/a/b/-/merge_requests/1',
        state: glabState,
      },
    ])
    expect(parseGlabMrList(raw)?.[0]?.state).toBe(expected as never)
  })

  test('an unrecognised state value degrades to null, not a guess', () => {
    const raw = JSON.stringify([
      {
        iid: 1,
        title: 'x',
        author: { username: 'a' },
        source_branch: 'x',
        target_branch: 'main',
        updated_at: '2026-07-28T09:30:00.123Z',
        web_url: 'https://gitlab.com/a/b/-/merge_requests/1',
        state: 'locked',
      },
    ])
    expect(parseGlabMrList(raw)?.[0]?.state).toBeNull()
  })

  test.each([
    ['can_be_merged', 'mergeable'],
    ['cannot_be_merged', 'conflicting'],
    ['cannot_be_merged_recheck', 'conflicting'],
    ['unchecked', 'unknown'],
    ['checking', 'unknown'],
  ])('maps merge_status %s to %s', (mergeStatus, expected) => {
    const raw = JSON.stringify([
      {
        iid: 1,
        title: 'x',
        author: { username: 'a' },
        source_branch: 'x',
        target_branch: 'main',
        updated_at: '2026-07-28T09:30:00.123Z',
        web_url: 'https://gitlab.com/a/b/-/merge_requests/1',
        merge_status: mergeStatus,
      },
    ])
    expect(parseGlabMrList(raw)?.[0]?.mergeable).toBe(expected as never)
  })

  test('an unrecognised merge_status value degrades to null, not a guess', () => {
    const raw = JSON.stringify([
      {
        iid: 1,
        title: 'x',
        author: { username: 'a' },
        source_branch: 'x',
        target_branch: 'main',
        updated_at: '2026-07-28T09:30:00.123Z',
        web_url: 'https://gitlab.com/a/b/-/merge_requests/1',
        merge_status: 'preparing',
      },
    ])
    expect(parseGlabMrList(raw)?.[0]?.mergeable).toBeNull()
  })

  test('work_in_progress is used only when draft is absent', () => {
    const withWip = JSON.stringify([
      {
        iid: 1,
        title: 'x',
        author: { username: 'a' },
        source_branch: 'x',
        target_branch: 'main',
        updated_at: '2026-07-28T09:30:00.123Z',
        web_url: 'https://gitlab.com/a/b/-/merge_requests/1',
        work_in_progress: true,
      },
    ])
    expect(parseGlabMrList(withWip)?.[0]?.isDraft).toBe(true)

    const withBoth = JSON.stringify([
      {
        iid: 1,
        title: 'x',
        author: { username: 'a' },
        source_branch: 'x',
        target_branch: 'main',
        updated_at: '2026-07-28T09:30:00.123Z',
        web_url: 'https://gitlab.com/a/b/-/merge_requests/1',
        draft: false,
        work_in_progress: true,
      },
    ])
    expect(parseGlabMrList(withBoth)?.[0]?.isDraft).toBe(false)
  })

  test('milestone null (no milestone set) stays null', () => {
    const raw = JSON.stringify([
      {
        iid: 1,
        title: 'x',
        author: { username: 'a' },
        source_branch: 'x',
        target_branch: 'main',
        updated_at: '2026-07-28T09:30:00.123Z',
        web_url: 'https://gitlab.com/a/b/-/merge_requests/1',
        milestone: null,
      },
    ])
    expect(parseGlabMrList(raw)?.[0]?.milestone).toBeNull()
  })

  test('description "" (an empty but present body) is kept as "", not turned into null', () => {
    const raw = JSON.stringify([
      {
        iid: 1,
        title: 'x',
        author: { username: 'a' },
        source_branch: 'x',
        target_branch: 'main',
        updated_at: '2026-07-28T09:30:00.123Z',
        web_url: 'https://gitlab.com/a/b/-/merge_requests/1',
        description: '',
      },
    ])
    expect(parseGlabMrList(raw)?.[0]?.body).toBe('')
  })

  test('a malformed optional field degrades that field to null without rejecting the whole entry', () => {
    const raw = JSON.stringify([
      {
        iid: 1,
        title: 'x',
        author: { username: 'a' },
        source_branch: 'x',
        target_branch: 'main',
        updated_at: '2026-07-28T09:30:00.123Z',
        web_url: 'https://gitlab.com/a/b/-/merge_requests/1',
        labels: ['ok', 42],
        assignees: [{ id: 1 }],
        milestone: { description: 'no title here' },
      },
    ])
    const parsed = parseGlabMrList(raw)
    expect(parsed).not.toBeNull()
    expect(parsed?.[0]?.labels).toBeNull()
    expect(parsed?.[0]?.assignees).toBeNull()
    expect(parsed?.[0]?.milestone).toBeNull()
    expect(parsed?.[0]?.number).toBe(1)
  })
})

describe('parseGlabMrDetail (per-MR enrichment payload)', () => {
  test('parses changes_count and a passed pipeline', () => {
    const raw = JSON.stringify({
      changes_count: '3',
      pipeline: { id: 1, status: 'success' },
    })
    expect(parseGlabMrDetail(raw)).toEqual({
      changedFiles: 3,
      checks: { passed: 1, failed: 0, pending: 0, skipped: 0, truncated: false },
    })
  })

  test('changes_count "1000+" (GitLab caps the field) degrades to null rather than a wrong number', () => {
    const raw = JSON.stringify({ changes_count: '1000+', pipeline: null })
    expect(parseGlabMrDetail(raw)?.changedFiles).toBeNull()
  })

  test('missing changes_count is null', () => {
    expect(parseGlabMrDetail(JSON.stringify({ pipeline: null }))?.changedFiles).toBeNull()
  })

  test('pipeline: null (no CI ever ran) yields checks: null, not an all-zero rollup', () => {
    expect(
      parseGlabMrDetail(JSON.stringify({ changes_count: '0', pipeline: null }))?.checks,
    ).toBeNull()
  })

  test.each([
    ['success', { passed: 1, failed: 0, pending: 0, skipped: 0, truncated: false }],
    ['failed', { passed: 0, failed: 1, pending: 0, skipped: 0, truncated: false }],
    ['skipped', { passed: 0, failed: 0, pending: 0, skipped: 1, truncated: false }],
    ['canceled', { passed: 0, failed: 0, pending: 0, skipped: 1, truncated: false }],
    ['canceling', { passed: 0, failed: 0, pending: 0, skipped: 1, truncated: false }],
    ['pending', { passed: 0, failed: 0, pending: 1, skipped: 0, truncated: false }],
    ['running', { passed: 0, failed: 0, pending: 1, skipped: 0, truncated: false }],
    ['created', { passed: 0, failed: 0, pending: 1, skipped: 0, truncated: false }],
    ['manual', { passed: 0, failed: 0, pending: 1, skipped: 0, truncated: false }],
    ['scheduled', { passed: 0, failed: 0, pending: 1, skipped: 0, truncated: false }],
    ['waiting_for_resource', { passed: 0, failed: 0, pending: 1, skipped: 0, truncated: false }],
    ['preparing', { passed: 0, failed: 0, pending: 1, skipped: 0, truncated: false }],
    ['waiting_for_callback', { passed: 0, failed: 0, pending: 1, skipped: 0, truncated: false }],
  ])('maps pipeline status %s to the expected rollup', (status, expected) => {
    const raw = JSON.stringify({ changes_count: '1', pipeline: { status } })
    expect(parseGlabMrDetail(raw)?.checks).toEqual(expected)
  })

  test('an unrecognised pipeline status surfaces as failed, not silently dropped', () => {
    const raw = JSON.stringify({ pipeline: { status: 'something_new' } })
    expect(parseGlabMrDetail(raw)?.checks).toEqual({
      passed: 0,
      failed: 1,
      pending: 0,
      skipped: 0,
      truncated: false,
    })
  })

  test('a pipeline object without a status string yields checks: null', () => {
    expect(parseGlabMrDetail(JSON.stringify({ pipeline: { id: 1 } }))?.checks).toBeNull()
  })

  test('rejects invalid json', () => {
    expect(parseGlabMrDetail('not json')).toBeNull()
  })

  test('rejects a non-object payload', () => {
    expect(parseGlabMrDetail('[1,2,3]')).toBeNull()
    expect(parseGlabMrDetail('null')).toBeNull()
  })
})

describe('runForgeCli', () => {
  test('argv is handed through verbatim, never joined into a shell command line', async () => {
    const outcome = await runForgeCli(
      'git',
      ['rev-parse', '--is-bare-repository'],
      process.cwd(),
      5000,
    )
    expect(outcome.kind).toBe('ok')
  })

  test('a binary that never gives back the hand times out and is reported as an error', async () => {
    // The budget is a parameter only so this test costs 50ms instead of 8s.
    const outcome = await runForgeCli('sleep', ['5'], process.cwd(), 50)
    expect(outcome.kind).toBe('error')
  })

  test('a missing binary is reported as missing, not as an error', async () => {
    const outcome = await runForgeCli(
      'codesema-forge-mrs-nonexistent-binary',
      [],
      process.cwd(),
      1000,
    )
    expect(outcome.kind).toBe('missing')
  })
})

describe('listOpenMrs', () => {
  const tempDirs: string[] = []

  function tempRepoWithRemote(): string {
    const repo = mkdtempSync(join(tmpdir(), 'codesema-forge-mrs-'))
    tempDirs.push(repo)
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://example.test/a/b.git'], {
      stdio: 'ignore',
    })
    return repo
  }

  function cleanup(): void {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('reports no-remote for a repo without an origin remote', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'codesema-forge-mrs-'))
    try {
      expect(await listOpenMrs(repo)).toEqual({ available: false, reason: 'no-remote' })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('reports no-cli when neither gh nor glab is installed', async () => {
    const repo = tempRepoWithRemote()
    try {
      const execFn: ForgeMrsExecFn = () => Promise.resolve({ kind: 'missing' })
      expect(await listOpenMrs(repo, { execFn })).toEqual({ available: false, reason: 'no-cli' })
    } finally {
      cleanup()
    }
  })

  test('reports cli-error when a CLI runs and fails (including a simulated timeout)', async () => {
    const repo = tempRepoWithRemote()
    try {
      const execFn: ForgeMrsExecFn = () => Promise.resolve({ kind: 'error' })
      expect(await listOpenMrs(repo, { execFn })).toEqual({ available: false, reason: 'cli-error' })
    } finally {
      cleanup()
    }
  })

  test('reports cli-error when the output cannot be parsed (shape mismatch)', async () => {
    const repo = tempRepoWithRemote()
    try {
      const execFn: ForgeMrsExecFn = () => Promise.resolve({ kind: 'ok', stdout: 'not json' })
      expect(await listOpenMrs(repo, { execFn })).toEqual({ available: false, reason: 'cli-error' })
    } finally {
      cleanup()
    }
  })

  test('falls back from gh (missing) to glab (ok) on an unrecognised remote', async () => {
    const repo = tempRepoWithRemote()
    try {
      const glabMr = {
        iid: 1,
        title: 'x',
        author: { username: 'a' },
        source_branch: 'x',
        target_branch: 'main',
        updated_at: '2026-07-28T09:30:00.123Z',
        web_url: 'https://gitlab.example.test/a/b/-/merge_requests/1',
      }
      const execFn: ForgeMrsExecFn = (cli): Promise<CliOutcome> => {
        if (cli === 'gh') {
          return Promise.resolve({ kind: 'missing' })
        }
        return Promise.resolve({ kind: 'ok', stdout: JSON.stringify([glabMr]) })
      }
      const result = await listOpenMrs(repo, {
        execFn,
        glabEnrichConcurrency: 2,
        glabEnrichBudgetMs: 1000,
      })
      expect(result.available).toBe(true)
      expect(result.available && result.mrs).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  describe('GitLab per-MR enrichment (changedFiles, checks)', () => {
    function glabListStdout(iids: number[]): string {
      return JSON.stringify(
        iids.map((iid) => ({
          iid,
          title: `mr ${iid}`,
          author: { username: 'a' },
          source_branch: `feat/${iid}`,
          target_branch: 'main',
          updated_at: '2026-07-28T09:30:00.123Z',
          web_url: `https://gitlab.example.test/a/b/-/merge_requests/${iid}`,
        })),
      )
    }

    test('enriches every MR when every per-MR call succeeds', async () => {
      const repo = tempRepoWithRemote()
      try {
        const execFn: ForgeMrsExecFn = (cli, args): Promise<CliOutcome> => {
          if (cli === 'gh') {
            return Promise.resolve({ kind: 'missing' })
          }
          if (args[0] === 'mr') {
            return Promise.resolve({ kind: 'ok', stdout: glabListStdout([1, 2]) })
          }
          // api projects/:fullpath/merge_requests/<iid>
          return Promise.resolve({
            kind: 'ok',
            stdout: JSON.stringify({ changes_count: '5', pipeline: { status: 'success' } }),
          })
        }
        const result = await listOpenMrs(repo, {
          execFn,
          glabEnrichConcurrency: 2,
          glabEnrichBudgetMs: 5000,
        })
        expect(result.available).toBe(true)
        if (!result.available) {
          throw new Error('expected available')
        }
        expect(result.mrs).toHaveLength(2)
        for (const mr of result.mrs) {
          expect(mr.changedFiles).toBe(5)
          expect(mr.checks).toEqual({
            passed: 1,
            failed: 0,
            pending: 0,
            skipped: 0,
            truncated: false,
          })
        }
      } finally {
        cleanup()
      }
    })

    test('an MR whose enrichment call fails keeps null fields but is never dropped from the list', async () => {
      const repo = tempRepoWithRemote()
      try {
        const execFn: ForgeMrsExecFn = (cli, args): Promise<CliOutcome> => {
          if (cli === 'gh') {
            return Promise.resolve({ kind: 'missing' })
          }
          if (args[0] === 'mr') {
            return Promise.resolve({ kind: 'ok', stdout: glabListStdout([1, 2]) })
          }
          if (args[1] === 'projects/:fullpath/merge_requests/1') {
            return Promise.resolve({ kind: 'error' })
          }
          return Promise.resolve({
            kind: 'ok',
            stdout: JSON.stringify({ changes_count: '2', pipeline: { status: 'failed' } }),
          })
        }
        const result = await listOpenMrs(repo, {
          execFn,
          glabEnrichConcurrency: 2,
          glabEnrichBudgetMs: 5000,
        })
        expect(result.available).toBe(true)
        if (!result.available) {
          throw new Error('expected available')
        }
        expect(result.mrs).toHaveLength(2)
        const mr1 = result.mrs.find((mr) => mr.number === 1)
        const mr2 = result.mrs.find((mr) => mr.number === 2)
        expect(mr1?.changedFiles).toBeNull()
        expect(mr1?.checks).toBeNull()
        expect(mr2?.changedFiles).toBe(2)
        expect(mr2?.checks).toEqual({
          passed: 0,
          failed: 1,
          pending: 0,
          skipped: 0,
          truncated: false,
        })
      } finally {
        cleanup()
      }
    })

    test('a missing glab mid-enrichment leaves fields null without dropping the MR', async () => {
      const repo = tempRepoWithRemote()
      try {
        const execFn: ForgeMrsExecFn = (cli, args): Promise<CliOutcome> => {
          if (cli === 'gh') {
            return Promise.resolve({ kind: 'missing' })
          }
          if (args[0] === 'mr') {
            return Promise.resolve({ kind: 'ok', stdout: glabListStdout([1]) })
          }
          return Promise.resolve({ kind: 'missing' })
        }
        const result = await listOpenMrs(repo, {
          execFn,
          glabEnrichConcurrency: 2,
          glabEnrichBudgetMs: 5000,
        })
        expect(result.available).toBe(true)
        if (!result.available) {
          throw new Error('expected available')
        }
        expect(result.mrs).toHaveLength(1)
        expect(result.mrs[0]?.changedFiles).toBeNull()
        expect(result.mrs[0]?.checks).toBeNull()
      } finally {
        cleanup()
      }
    })

    test('the enrichment time budget stops further calls but never removes an MR from the list', async () => {
      const repo = tempRepoWithRemote()
      try {
        let calls = 0
        const execFn: ForgeMrsExecFn = (cli, args): Promise<CliOutcome> => {
          if (cli === 'gh') {
            return Promise.resolve({ kind: 'missing' })
          }
          if (args[0] === 'mr') {
            return Promise.resolve({ kind: 'ok', stdout: glabListStdout([1, 2, 3]) })
          }
          calls += 1
          // Each per-MR call takes 30ms; a 10ms global budget lets at most
          // the in-flight first batch finish before the deadline is hit.
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                kind: 'ok',
                stdout: JSON.stringify({ changes_count: '1', pipeline: { status: 'success' } }),
              })
            }, 30)
          })
        }
        const result = await listOpenMrs(repo, {
          execFn,
          glabEnrichConcurrency: 1,
          glabEnrichBudgetMs: 10,
        })
        expect(result.available).toBe(true)
        if (!result.available) {
          throw new Error('expected available')
        }
        // The list itself is never truncated: all 3 MRs are still present.
        expect(result.mrs).toHaveLength(3)
        expect(result.mrs.map((mr) => mr.number)).toEqual([1, 2, 3])
        // The budget stopped enrichment well short of all 3 calls.
        expect(calls).toBeLessThan(3)
      } finally {
        cleanup()
      }
    })

    test('concurrency never exceeds the configured worker count', async () => {
      const repo = tempRepoWithRemote()
      try {
        let inFlight = 0
        let maxInFlight = 0
        const execFn: ForgeMrsExecFn = (cli, args): Promise<CliOutcome> => {
          if (cli === 'gh') {
            return Promise.resolve({ kind: 'missing' })
          }
          if (args[0] === 'mr') {
            return Promise.resolve({ kind: 'ok', stdout: glabListStdout([1, 2, 3, 4, 5, 6]) })
          }
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          return new Promise((resolve) => {
            setTimeout(() => {
              inFlight -= 1
              resolve({
                kind: 'ok',
                stdout: JSON.stringify({ changes_count: '1', pipeline: { status: 'success' } }),
              })
            }, 15)
          })
        }
        const result = await listOpenMrs(repo, {
          execFn,
          glabEnrichConcurrency: 2,
          glabEnrichBudgetMs: 5000,
        })
        expect(result.available).toBe(true)
        expect(maxInFlight).toBeLessThanOrEqual(2)
      } finally {
        cleanup()
      }
    })
  })

  describe('pagination and truncation', () => {
    function ghMinimalMr(n: number): Record<string, unknown> {
      return {
        number: n,
        title: `mr ${n}`,
        author: { login: 'a' },
        headRefName: `feat/${n}`,
        baseRefName: 'main',
        updatedAt: '2026-07-28T10:00:00Z',
        url: `https://github.test/acme/repo/pull/${n}`,
      }
    }

    function ghListStdout(count: number): string {
      return JSON.stringify(Array.from({ length: count }, (_, i) => ghMinimalMr(i + 1)))
    }

    function glabMinimalMr(n: number): Record<string, unknown> {
      return {
        iid: n,
        title: `mr ${n}`,
        author: { username: 'a' },
        source_branch: `feat/${n}`,
        target_branch: 'main',
        updated_at: '2026-07-28T09:30:00.123Z',
        web_url: `https://gitlab.example.test/a/b/-/merge_requests/${n}`,
      }
    }

    function glabPageStdout(startIid: number, count: number): string {
      return JSON.stringify(Array.from({ length: count }, (_, i) => glabMinimalMr(startIid + i)))
    }

    test('gh is asked for one more than the cap, via --limit', async () => {
      const repo = tempRepoWithRemote()
      try {
        let capturedArgs: string[] = []
        const execFn: ForgeMrsExecFn = (cli, args): Promise<CliOutcome> => {
          if (cli === 'gh') {
            capturedArgs = args
            return Promise.resolve({ kind: 'ok', stdout: '[]' })
          }
          return Promise.resolve({ kind: 'missing' })
        }
        await listOpenMrs(repo, { execFn })
        const limitIndex = capturedArgs.indexOf('--limit')
        expect(limitIndex).toBeGreaterThan(-1)
        expect(capturedArgs[limitIndex + 1]).toBe(String(MR_LIST_MAX + 1))
      } finally {
        cleanup()
      }
    })

    test('glab is asked per page with the 100-item GitLab clamp, page number incrementing', async () => {
      const repo = tempRepoWithRemote()
      try {
        const seenPages: (string | undefined)[] = []
        const execFn: ForgeMrsExecFn = (cli, args): Promise<CliOutcome> => {
          if (cli === 'gh') {
            return Promise.resolve({ kind: 'missing' })
          }
          expect(args).toContain('--per-page')
          expect(args[args.indexOf('--per-page') + 1]).toBe('100')
          expect(args).toContain('--output')
          seenPages.push(args[args.indexOf('--page') + 1])
          // A page shorter than 100 ends the walk immediately.
          return Promise.resolve({ kind: 'ok', stdout: '[]' })
        }
        await listOpenMrs(repo, { execFn })
        expect(seenPages).toEqual(['1'])
      } finally {
        cleanup()
      }
    })

    test('truncated is true when gh returns more than MR_LIST_MAX entries', async () => {
      const repo = tempRepoWithRemote()
      try {
        const execFn: ForgeMrsExecFn = (cli): Promise<CliOutcome> => {
          if (cli === 'gh') {
            return Promise.resolve({ kind: 'ok', stdout: ghListStdout(MR_LIST_MAX + 1) })
          }
          return Promise.resolve({ kind: 'missing' })
        }
        const result = await listOpenMrs(repo, { execFn })
        expect(result.available).toBe(true)
        if (!result.available) {
          throw new Error('expected available')
        }
        expect(result.truncated).toBe(true)
        expect(result.mrs).toHaveLength(MR_LIST_MAX)
      } finally {
        cleanup()
      }
    })

    test('truncated is false when gh returns exactly MR_LIST_MAX entries', async () => {
      const repo = tempRepoWithRemote()
      try {
        const execFn: ForgeMrsExecFn = (cli): Promise<CliOutcome> => {
          if (cli === 'gh') {
            return Promise.resolve({ kind: 'ok', stdout: ghListStdout(MR_LIST_MAX) })
          }
          return Promise.resolve({ kind: 'missing' })
        }
        const result = await listOpenMrs(repo, { execFn })
        expect(result.available).toBe(true)
        if (!result.available) {
          throw new Error('expected available')
        }
        expect(result.truncated).toBe(false)
        expect(result.mrs).toHaveLength(MR_LIST_MAX)
      } finally {
        cleanup()
      }
    })

    test('glab walks pages and truncates once a multi-page answer exceeds MR_LIST_MAX', async () => {
      const repo = tempRepoWithRemote()
      try {
        let calls = 0
        const execFn: ForgeMrsExecFn = (cli): Promise<CliOutcome> => {
          if (cli === 'gh') {
            return Promise.resolve({ kind: 'missing' })
          }
          calls += 1
          if (calls === 1) {
            return Promise.resolve({ kind: 'ok', stdout: glabPageStdout(1, 100) })
          }
          if (calls === 2) {
            return Promise.resolve({ kind: 'ok', stdout: glabPageStdout(101, 100) })
          }
          // Short page (1 < 100): ends the walk at 201 total.
          return Promise.resolve({ kind: 'ok', stdout: glabPageStdout(201, 1) })
        }
        // Enrichment budget 0 so the per-MR enrichment fan-out (up to 200
        // calls) never fires and never pollutes the `calls` count this test
        // asserts on: pagination is what is under test here, not enrichment.
        const result = await listOpenMrs(repo, { execFn, glabEnrichBudgetMs: 0 })
        expect(result.available).toBe(true)
        if (!result.available) {
          throw new Error('expected available')
        }
        expect(calls).toBe(3)
        expect(result.truncated).toBe(true)
        expect(result.mrs).toHaveLength(MR_LIST_MAX)
      } finally {
        cleanup()
      }
    })

    test('glab does not truncate when a multi-page answer stays at or under MR_LIST_MAX', async () => {
      const repo = tempRepoWithRemote()
      try {
        let calls = 0
        const execFn: ForgeMrsExecFn = (cli): Promise<CliOutcome> => {
          if (cli === 'gh') {
            return Promise.resolve({ kind: 'missing' })
          }
          calls += 1
          if (calls === 1) {
            return Promise.resolve({ kind: 'ok', stdout: glabPageStdout(1, 100) })
          }
          // Short page (99 < 100): ends the walk at 199 total.
          return Promise.resolve({ kind: 'ok', stdout: glabPageStdout(101, 99) })
        }
        const result = await listOpenMrs(repo, { execFn, glabEnrichBudgetMs: 0 })
        expect(result.available).toBe(true)
        if (!result.available) {
          throw new Error('expected available')
        }
        expect(calls).toBe(2)
        expect(result.truncated).toBe(false)
        expect(result.mrs).toHaveLength(199)
      } finally {
        cleanup()
      }
    })
  })

  describe('output buffer', () => {
    test('a payload past the default 1 MiB is not killed: FORGE_MR_MAX_BUFFER_BYTES covers it', async () => {
      const repo = mkdtempSync(join(tmpdir(), 'codesema-forge-mrs-buf-'))
      try {
        execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
        // Past node's 1 MiB default maxBuffer: `commits` (the full commit
        // list) and `body` (the full Markdown description) are exactly the
        // fields in this contract that can grow this large in a real answer.
        const bigSize = 2_000_000
        expect(bigSize).toBeLessThan(FORGE_MR_MAX_BUFFER_BYTES)
        writeFileSync(join(repo, 'big.txt'), 'x'.repeat(bigSize))
        const sha = execFileSync('git', ['hash-object', '-w', 'big.txt'], {
          cwd: repo,
          encoding: 'utf8',
        }).trim()
        const outcome = await runForgeCli('git', ['cat-file', '-p', sha], repo, 5000)
        expect(outcome.kind).toBe('ok')
        expect(outcome.kind === 'ok' && outcome.stdout.length).toBe(bigSize)
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    })
  })
})
