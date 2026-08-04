import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { listOpenMrs, parseGhMrList, parseGlabMrList } from './forge-mrs.js'

describe('parseGhMrList', () => {
  test('parses a valid gh pr list --json payload', () => {
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
})

describe('parseGlabMrList', () => {
  test('parses a valid glab mr list --output json payload', () => {
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
      },
    ])
  })

  test('returns an empty array for no open MRs', () => {
    expect(parseGlabMrList('[]')).toEqual([])
  })

  test('rejects invalid json', () => {
    expect(parseGlabMrList('{not json')).toBeNull()
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
})

describe('listOpenMrs', () => {
  test('reports no-remote for a repo without an origin remote', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'codesema-forge-mrs-'))
    try {
      expect(await listOpenMrs(repo)).toEqual({ available: false, reason: 'no-remote' })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
