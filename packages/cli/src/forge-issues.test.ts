import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { ForgeIssue } from './forge-issues-parse.js'
import {
  closeIssue,
  commentIssue,
  createIssue,
  forgeIssueReason,
  getIssue,
  ISSUE_LIST_MAX,
  listIssues,
  runForgeCli,
  setLabels,
  type ForgeCli,
  type ForgeCliOutcome,
  type ForgeIssuesExecFn,
} from './forge-issues.js'
import { subprocessEnv } from './git.js'

const GH_FIELDS = 'number,title,body,state,labels,author,createdAt,updatedAt,url'
const GH_LIMIT = String(ISSUE_LIST_MAX + 1)
const GLAB_PAGE = '100'

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

/** n distinct valid issues, to exercise the cap without hand-writing 201 of them. */
function ghIssues(n: number, from = 1): string {
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({ ...GH_ISSUE, number: from + i })))
}

function glabIssues(n: number, from = 1): string {
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({ ...GLAB_ISSUE, iid: from + i })))
}

/** Real git repo in a tmpdir; `git remote add` never talks to the network. */
function makeRepo(remote: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'codesema-forge-issues-'))
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: subprocessEnv() })
  git(['init', '-b', 'main'])
  if (remote) {
    git(['remote', 'add', 'origin', remote])
  }
  return dir
}

async function withRepo<T>(remote: string | null, body: (repo: string) => Promise<T>): Promise<T> {
  const repo = makeRepo(remote)
  try {
    return await body(repo)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

type Call = { cli: ForgeCli; args: string[]; cwd: string }

/** The only way a forge binary is ever "run" in this file: the argv IS the assertion. */
function rig(reply: (call: Call) => ForgeCliOutcome) {
  const calls: Call[] = []
  const execFn: ForgeIssuesExecFn = (cli, args, cwd) => {
    const call = { cli, args, cwd }
    calls.push(call)
    return Promise.resolve(reply(call))
  }
  return { calls, execFn }
}

const ok = (stdout: string) => (): ForgeCliOutcome => ({ kind: 'ok', stdout })
const missing = (): ForgeCliOutcome => ({ kind: 'missing' })
const failing = (message: string) => (): ForgeCliOutcome => ({ kind: 'error', message })

const GITHUB_REMOTE = 'https://github.com/acme/repo.git'
const GITLAB_REMOTE = 'https://gitlab.com/acme/repo.git'
const SELF_HOSTED_REMOTE = 'https://forge.example.com/acme/repo.git'

describe('unavailability reasons', () => {
  test('no-remote is the answer of EVERY operation, and none of them probes', async () => {
    await withRepo(null, async (repo) => {
      const r = rig(ok('[]'))
      const execFn = r.execFn
      const results = [
        await listIssues({ cwd: repo, execFn }),
        await getIssue({ cwd: repo, execFn, number: 42 }),
        await createIssue({ cwd: repo, execFn, title: 'T', body: 'B' }),
        await commentIssue({ cwd: repo, execFn, number: 42, body: 'hi' }),
        await closeIssue({ cwd: repo, execFn, number: 42 }),
        await setLabels({ cwd: repo, execFn, number: 42, labels: ['bug'] }),
      ]
      for (const result of results) {
        expect(result).toMatchObject({ available: false, reason: 'no-remote' })
      }
      expect(r.calls).toEqual([])
    })
  })

  test('every forge binary missing is no-cli', async () => {
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      const r = rig(missing)
      expect(await listIssues({ cwd: repo, execFn: r.execFn })).toEqual({
        available: false,
        reason: 'no-cli',
      })
      expect(r.calls.map((c) => c.cli)).toEqual(['gh', 'glab'])
    })
  })

  test('a forge binary that exits in error is cli-error, and its own words ride along', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(failing('HTTP 401: Bad credentials'))
      expect(await listIssues({ cwd: repo, execFn: r.execFn })).toEqual({
        available: false,
        reason: 'cli-error',
        detail: 'gh: HTTP 401: Bad credentials',
      })
    })
  })

  test('unreadable output is cli-error too, and exposes not one partial issue', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const truncated = JSON.stringify([GH_ISSUE, GH_ISSUE]).slice(0, 120)
      const result = await listIssues({ cwd: repo, execFn: rig(ok(truncated)).execFn })
      expect(result).toEqual({
        available: false,
        reason: 'cli-error',
        detail: 'gh: unreadable output',
      })
      expect(result).not.toHaveProperty('issues')
    })
  })

  test('every operation degrades to a typed result instead of throwing', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const { execFn } = rig(failing('boom'))
      const results = [
        await listIssues({ cwd: repo, execFn }),
        await getIssue({ cwd: repo, execFn, number: 42 }),
        await createIssue({ cwd: repo, execFn, title: 'x' }),
        await commentIssue({ cwd: repo, execFn, number: 42, body: 'hi' }),
        await closeIssue({ cwd: repo, execFn, number: 42 }),
        await setLabels({ cwd: repo, execFn, number: 42, labels: ['bug'] }),
      ]
      for (const result of results) {
        expect(result.available).toBe(false)
        expect('reason' in result && result.reason).toBe('cli-error')
      }
    })
  })

  test('a refusal decided HERE is invalid-input, never cli-error', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok('{}'))
      const execFn = r.execFn
      // Nothing was asked of the forge, so nothing about the forge is broken:
      // calling these cli-error would make D2 journal a forge outage that did
      // not happen.
      expect(await getIssue({ cwd: repo, execFn, number: -1 })).toEqual({
        available: false,
        reason: 'invalid-input',
        detail: 'invalid issue number: -1',
      })
      expect(await closeIssue({ cwd: repo, execFn, number: 1.5 })).toEqual({
        available: false,
        reason: 'invalid-input',
        detail: 'invalid issue number: 1.5',
      })
      expect(await commentIssue({ cwd: repo, execFn, number: 1, body: '   ' })).toMatchObject({
        reason: 'invalid-input',
      })
      expect(await createIssue({ cwd: repo, execFn, title: ' ' })).toMatchObject({
        reason: 'invalid-input',
      })
      expect(r.calls).toEqual([])
    })
  })

  test('an argv the kernel would refuse is invalid-input, and stops the ladder', async () => {
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      const r = rig(() => ({ kind: 'invalid', message: 'argument of 300000 bytes exceeds …' }))
      // Nothing left this machine, and glab would be handed the same argv:
      // trying it would only refuse twice, and cli-error would blame a forge
      // that was never contacted.
      expect(await commentIssue({ cwd: repo, execFn: r.execFn, number: 1, body: 'x' })).toEqual({
        available: false,
        reason: 'invalid-input',
        detail: 'argument of 300000 bytes exceeds …',
      })
      expect(r.calls.map((c) => c.cli)).toEqual(['gh'])
    })
  })

  test('forgeIssueReason names a forge outage, and refuses to name what is not one', () => {
    expect(forgeIssueReason({ available: false, reason: 'no-cli' })).toEqual({
      code: 'forge_unreachable',
      detail: 'no-cli',
    })
    expect(
      forgeIssueReason({ available: false, reason: 'cli-error', detail: 'gh: HTTP 500' }),
    ).toEqual({ code: 'forge_unreachable', detail: 'cli-error: gh: HTTP 500' })
    // invalid-input never reached a forge: no D2 code at all, the message alone.
    expect(
      forgeIssueReason({ available: false, reason: 'invalid-input', detail: 'invalid number: 0' }),
    ).toBeNull()
  })
})

describe('forge hint targets the probe', () => {
  test('a github remote probes gh only', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok(JSON.stringify([GH_ISSUE])))
      expect(await listIssues({ cwd: repo, execFn: r.execFn })).toEqual({
        available: true,
        issues: [GH_ISSUE_PARSED],
        truncated: false,
      })
      expect(r.calls.map((c) => c.cli)).toEqual(['gh'])
    })
  })

  test('a gitlab remote probes glab only', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig(ok(JSON.stringify([GLAB_ISSUE])))
      expect(await listIssues({ cwd: repo, execFn: r.execFn })).toEqual({
        available: true,
        issues: [GLAB_ISSUE_PARSED],
        truncated: false,
      })
      expect(r.calls.map((c) => c.cli)).toEqual(['glab'])
    })
  })

  test('a self-hosted remote probes gh then glab, and the first real answer wins', async () => {
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      const r = rig((call) => (call.cli === 'gh' ? missing() : ok(JSON.stringify([GLAB_ISSUE]))()))
      expect(await listIssues({ cwd: repo, execFn: r.execFn })).toEqual({
        available: true,
        issues: [GLAB_ISSUE_PARSED],
        truncated: false,
      })
      expect(r.calls.map((c) => c.cli)).toEqual(['gh', 'glab'])
    })
  })
})

describe('a capped list says so', () => {
  test('gh is asked for one issue more than the cap, never for its own default of 30', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok('[]'))
      await listIssues({ cwd: repo, execFn: r.execFn })
      expect(r.calls[0]?.args).toEqual([
        'issue',
        'list',
        '--state',
        'open',
        '--limit',
        GH_LIMIT,
        '--json',
        GH_FIELDS,
      ])
    })
  })

  test('gh under the cap is complete, over it is truncated and capped', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const short = await listIssues({ cwd: repo, execFn: rig(ok(ghIssues(3))).execFn })
      expect(short).toMatchObject({ available: true, truncated: false })
      expect(short.available && short.issues).toHaveLength(3)

      const long = await listIssues({
        cwd: repo,
        execFn: rig(ok(ghIssues(ISSUE_LIST_MAX + 1))).execFn,
      })
      expect(long).toMatchObject({ available: true, truncated: true })
      // The extra issue proved there were more; it is never handed out.
      expect(long.available && long.issues).toHaveLength(ISSUE_LIST_MAX)
    })
  })

  test('glab pages, because GitLab clamps a page at 100, and stops at the short one', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig((call) =>
        call.args.includes('--page') && call.args.includes('2')
          ? ok(glabIssues(4, 101))()
          : ok(glabIssues(100))(),
      )
      const result = await listIssues({ cwd: repo, execFn: r.execFn })
      expect(result).toMatchObject({ available: true, truncated: false })
      expect(result.available && result.issues).toHaveLength(104)
      expect(r.calls.map((c) => c.args)).toEqual([
        ['issue', 'list', '--per-page', GLAB_PAGE, '--page', '1', '--output', 'json'],
        ['issue', 'list', '--per-page', GLAB_PAGE, '--page', '2', '--output', 'json'],
      ])
    })
  })

  test('glab past the cap is truncated, and stops paging there', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig((call) => ok(glabIssues(100, Number(call.args[5]) * 1000))())
      const result = await listIssues({ cwd: repo, execFn: r.execFn })
      expect(result).toMatchObject({ available: true, truncated: true })
      expect(result.available && result.issues).toHaveLength(ISSUE_LIST_MAX)
      // 3 pages of 100 is the first count that PROVES more than 200 exist.
      expect(r.calls).toHaveLength(3)
    })
  })

  test('glab in the 201-299 band is capped too, not handed out whole', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      // 100 + 100 + 50: the last page is SHORT, so the list is complete — and
      // 250 issues is still past the cap. Answering {250, truncated:false}
      // both broke the cap and disagreed with gh, which answers 200/true on
      // the very same repo.
      const r = rig((call) =>
        call.args[5] === '3' ? ok(glabIssues(50, 201))() : ok(glabIssues(100, 1))(),
      )
      const result = await listIssues({ cwd: repo, execFn: r.execFn })
      expect(result).toMatchObject({ available: true, truncated: true })
      expect(result.available && result.issues).toHaveLength(ISSUE_LIST_MAX)
      expect(r.calls).toHaveLength(3)
    })
  })

  test('the state filter each forge understands survives the pagination', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok('[]'))
      await listIssues({ cwd: repo, execFn: r.execFn, state: 'closed' })
      expect(r.calls[0]?.args).toEqual([
        'issue',
        'list',
        '--state',
        'closed',
        '--limit',
        GH_LIMIT,
        '--json',
        GH_FIELDS,
      ])
    })
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig(ok('[]'))
      await listIssues({ cwd: repo, execFn: r.execFn, state: 'closed' })
      await listIssues({ cwd: repo, execFn: r.execFn, state: 'all' })
      expect(r.calls[0]?.args).toEqual([
        'issue',
        'list',
        '--closed',
        '--per-page',
        GLAB_PAGE,
        '--page',
        '1',
        '--output',
        'json',
      ])
      expect(r.calls[1]?.args).toEqual([
        'issue',
        'list',
        '--all',
        '--per-page',
        GLAB_PAGE,
        '--page',
        '1',
        '--output',
        'json',
      ])
    })
  })
})

describe('argv per operation', () => {
  test('getIssue uses the porcelain view on both forges', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok(JSON.stringify(GH_ISSUE)))
      expect(await getIssue({ cwd: repo, execFn: r.execFn, number: 42 })).toEqual({
        available: true,
        issue: GH_ISSUE_PARSED,
      })
      expect(r.calls[0]?.args).toEqual(['issue', 'view', '42', '--json', GH_FIELDS])
    })
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig(ok(JSON.stringify(GLAB_ISSUE)))
      expect(await getIssue({ cwd: repo, execFn: r.execFn, number: 7 })).toEqual({
        available: true,
        issue: GLAB_ISSUE_PARSED,
      })
      expect(r.calls[0]?.args).toEqual(['issue', 'view', '7', '--output', 'json'])
    })
  })

  test('createIssue produces two distinct expected argv, github vs gitlab', async () => {
    const gh = await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok('https://github.com/acme/repo/issues/42\n'))
      expect(
        await createIssue({ cwd: repo, execFn: r.execFn, title: 'Add sidebar', body: 'Please.' }),
      ).toEqual({ available: true, url: 'https://github.com/acme/repo/issues/42' })
      return r.calls
    })
    const glab = await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig(ok('https://gitlab.com/acme/repo/-/issues/7\n'))
      expect(
        await createIssue({ cwd: repo, execFn: r.execFn, title: 'Add sidebar', body: 'Please.' }),
      ).toEqual({ available: true, url: 'https://gitlab.com/acme/repo/-/issues/7' })
      return r.calls
    })
    expect(gh[0]?.cli).toBe('gh')
    expect(gh[0]?.args).toEqual(['issue', 'create', '--title=Add sidebar', '--body=Please.'])
    expect(glab[0]?.cli).toBe('glab')
    expect(glab[0]?.args).toEqual([
      'issue',
      'create',
      '--title=Add sidebar',
      '--description=Please.',
      '--no-editor',
      '--yes',
    ])
    expect(gh[0]?.args).not.toEqual(glab[0]?.args ?? [])
  })

  test('createIssue without a body still forbids glab its editor and its prompt', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig(ok(''))
      await createIssue({ cwd: repo, execFn: r.execFn, title: 'T' })
      // An empty --description= alone would leave glab free to open $EDITOR on
      // a pipe and hang until the 8s timeout.
      expect(r.calls[0]?.args).toEqual([
        'issue',
        'create',
        '--title=T',
        '--description=',
        '--no-editor',
        '--yes',
      ])
    })
  })

  test('createIssue passes labels as attached values', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok(''))
      await createIssue({ cwd: repo, execFn: r.execFn, title: 'T', labels: ['bug', 'help wanted'] })
      expect(r.calls[0]?.args).toEqual([
        'issue',
        'create',
        '--title=T',
        '--body=',
        '--label=bug',
        '--label=help wanted',
      ])
    })
  })

  test('createIssue that printed no URL is still a success with nothing to link to', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok('done'))
      expect(await createIssue({ cwd: repo, execFn: r.execFn, title: 'T' })).toEqual({
        available: true,
        url: null,
      })
    })
  })

  test('commentIssue: gh calls it a comment with --body, glab a note with --message', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok(''))
      expect(await commentIssue({ cwd: repo, execFn: r.execFn, number: 42, body: 'ack' })).toEqual({
        available: true,
      })
      expect(r.calls[0]?.args).toEqual(['issue', 'comment', '42', '--body=ack'])
    })
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig(ok(''))
      expect(await commentIssue({ cwd: repo, execFn: r.execFn, number: 7, body: 'ack' })).toEqual({
        available: true,
      })
      expect(r.calls[0]?.args).toEqual(['issue', 'note', '7', '--message=ack'])
    })
  })

  test('closeIssue is the same porcelain verb on both forges', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok(''))
      expect(await closeIssue({ cwd: repo, execFn: r.execFn, number: 42 })).toEqual({
        available: true,
      })
      expect(r.calls[0]?.args).toEqual(['issue', 'close', '42'])
    })
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig(ok(''))
      await closeIssue({ cwd: repo, execFn: r.execFn, number: 7 })
      expect(r.calls[0]?.args).toEqual(['issue', 'close', '7'])
    })
  })

  test('setLabels falls back to the api mode the porcelain does not cover', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok(''))
      expect(
        await setLabels({ cwd: repo, execFn: r.execFn, number: 42, labels: ['bug', 'ui'] }),
      ).toEqual({ available: true })
      expect(r.calls[0]?.args).toEqual([
        'api',
        'repos/{owner}/{repo}/issues/42/labels',
        '--method',
        'PUT',
        '--raw-field=labels[]=bug',
        '--raw-field=labels[]=ui',
      ])
    })
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig(ok(''))
      await setLabels({ cwd: repo, execFn: r.execFn, number: 7, labels: ['bug', 'ui'] })
      expect(r.calls[0]?.args).toEqual([
        'api',
        'projects/:fullpath/issues/7',
        '--method',
        'PUT',
        '--raw-field=labels=bug,ui',
      ])
    })
  })

  test('an empty label set clears through each forge own idiom', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok(''))
      await setLabels({ cwd: repo, execFn: r.execFn, number: 42, labels: [] })
      expect(r.calls[0]?.args).toEqual([
        'api',
        'repos/{owner}/{repo}/issues/42/labels',
        '--method',
        'DELETE',
      ])
    })
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig(ok(''))
      await setLabels({ cwd: repo, execFn: r.execFn, number: 7, labels: [] })
      expect(r.calls[0]?.args).toEqual([
        'api',
        'projects/:fullpath/issues/7',
        '--method',
        'PUT',
        '--raw-field=labels=',
      ])
    })
  })

  test('no operation ever hands a credential to the forge CLI', async () => {
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      const r = rig(missing)
      const { execFn } = r
      await listIssues({ cwd: repo, execFn })
      await getIssue({ cwd: repo, execFn, number: 1 })
      await createIssue({ cwd: repo, execFn, title: 'T', body: 'B' })
      await commentIssue({ cwd: repo, execFn, number: 1, body: 'B' })
      await closeIssue({ cwd: repo, execFn, number: 1 })
      await setLabels({ cwd: repo, execFn, number: 1, labels: ['bug'] })
      expect(r.calls.length).toBe(12)
      for (const call of r.calls) {
        expect(['gh', 'glab']).toContain(call.cli)
        // argv only, never a shell string, and nothing that smells like a secret.
        expect(call.args.every((arg) => typeof arg === 'string')).toBe(true)
        expect(call.args).not.toContain('-c')
        expect(call.args.some((arg) => /token|password|authorization|bearer/i.test(arg))).toBe(
          false,
        )
      }
    })
  })
})

describe('a write is never replayed', () => {
  test('a write that RAN and failed stops there: no second forge, no duplicate issue', async () => {
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      const r = rig(failing('HTTP 502'))
      // gh may have created the issue before failing (or timed out on a request
      // the forge accepted). Replaying on glab would risk a duplicate.
      expect(await createIssue({ cwd: repo, execFn: r.execFn, title: 'T', body: 'B' })).toEqual({
        available: false,
        reason: 'cli-error',
        detail: 'gh: HTTP 502',
      })
      expect(r.calls.map((c) => c.cli)).toEqual(['gh'])
    })
  })

  test('the same failure on a READ does walk the ladder: a read costs nothing to retry', async () => {
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      const r = rig((call) =>
        call.cli === 'gh' ? failing('HTTP 502')() : ok(JSON.stringify([GLAB_ISSUE]))(),
      )
      expect(await listIssues({ cwd: repo, execFn: r.execFn })).toMatchObject({ available: true })
      expect(r.calls.map((c) => c.cli)).toEqual(['gh', 'glab'])
    })
  })

  test('a MISSING binary is not a run, so a write still tries the other forge', async () => {
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      const r = rig((call) => (call.cli === 'gh' ? missing() : ok('')()))
      expect(await commentIssue({ cwd: repo, execFn: r.execFn, number: 1, body: 'hi' })).toEqual({
        available: true,
      })
      expect(r.calls.map((c) => c.cli)).toEqual(['gh', 'glab'])
    })
  })

  test('every write stops at the first forge that answered, whatever it answered', async () => {
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      const r = rig(failing('boom'))
      const execFn = r.execFn
      await commentIssue({ cwd: repo, execFn, number: 1, body: 'hi' })
      await closeIssue({ cwd: repo, execFn, number: 1 })
      await setLabels({ cwd: repo, execFn, number: 1, labels: ['bug'] })
      expect(r.calls.map((c) => c.cli)).toEqual(['gh', 'gh', 'gh'])
    })
  })
})

describe('argument injection', () => {
  test('a title starting with -- travels as data, never as an option', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok(''))
      await createIssue({ cwd: repo, execFn: r.execFn, title: '--repo attacker/evil', body: 'x' })
      expect(r.calls[0]?.args).toEqual([
        'issue',
        'create',
        '--title=--repo attacker/evil',
        '--body=x',
      ])
      expect(r.calls[0]?.args).not.toContain('--repo')
      expect(r.calls[0]?.args).not.toContain('attacker/evil')
    })
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig(ok(''))
      await createIssue({ cwd: repo, execFn: r.execFn, title: '-t pwned', body: '--yes' })
      expect(r.calls[0]?.args).toEqual([
        'issue',
        'create',
        '--title=-t pwned',
        '--description=--yes',
        '--no-editor',
        '--yes',
      ])
      // The user's "--yes" stayed inside its attached value; only ours is a flag.
      expect(r.calls[0]?.args.filter((arg) => arg === '--yes')).toHaveLength(1)
    })
  })

  test('a body full of control characters is neutralised, and adds no argument', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok(''))
      const body = 'line one \u0000\u001B[31m\r\nline two\ttabbed'
      await commentIssue({ cwd: repo, execFn: r.execFn, number: 42, body })
      const args = r.calls[0]?.args ?? []
      expect(args).toHaveLength(4)
      expect(args[3]).toBe('--body=line one [31m\nline two\ttabbed')
    })
  })

  test('a label that could pass for a flag stays inside its attached value', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok(''))
      await setLabels({ cwd: repo, execFn: r.execFn, number: 42, labels: ['--method DELETE'] })
      expect(r.calls[0]?.args).toEqual([
        'api',
        'repos/{owner}/{repo}/issues/42/labels',
        '--method',
        'PUT',
        '--raw-field=labels[]=--method DELETE',
      ])
    })
  })

  test('a title or body that sanitises to nothing is refused before any probe', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok(''))
      expect(await createIssue({ cwd: repo, execFn: r.execFn, title: '\u0000 \u001F' })).toEqual({
        available: false,
        reason: 'invalid-input',
        detail: 'issue title is empty after sanitisation',
      })
      expect(
        await commentIssue({ cwd: repo, execFn: r.execFn, number: 1, body: '\u0000' }),
      ).toEqual({
        available: false,
        reason: 'invalid-input',
        detail: 'comment body is empty after sanitisation',
      })
      expect(r.calls).toEqual([])
    })
  })

  test('a label no forge could WRITE is refused by name, not silently dropped', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok(''))
      // The read side keeps such a label verbatim (forge-issues-parse.test.ts):
      // the asymmetry is deliberate, and the refusal says why.
      const refused = await setLabels({
        cwd: repo,
        execFn: r.execFn,
        number: 42,
        labels: ['needs, triage'],
      })
      expect(refused).toMatchObject({ available: false, reason: 'invalid-input' })
      expect('detail' in refused && refused.detail).toContain('comma-separated')
      expect(
        (await createIssue({ cwd: repo, execFn: r.execFn, title: 'T', labels: ['   '] })).available,
      ).toBe(false)
      expect(r.calls).toEqual([])
    })
  })
})

describe('runForgeCli', () => {
  test('a binary that does not exist is missing, not error', async () => {
    await withRepo(null, async (repo) => {
      // A shell would answer 127 (an error) here; execFile answers ENOENT,
      // which is the proof there is no host-side interpolation in between.
      expect(await runForgeCli('codesema-no-such-forge-cli', ['issue', 'list'], repo)).toEqual({
        kind: 'missing',
      })
    })
  })

  test('a command that exits non-zero is an error carrying its own words', async () => {
    await withRepo(null, async (repo) => {
      const outcome = await runForgeCli('git', ['rev-parse', '--verify', 'no/such/ref'], repo)
      expect(outcome.kind).toBe('error')
      expect(outcome.kind === 'error' && outcome.message.length > 0).toBe(true)
    })
  })

  test('argv is handed through verbatim, never joined into a command line', async () => {
    await withRepo(null, async (repo) => {
      // '--git-dir' is a real flag; a shell-joined command line would need
      // quoting and would break on the very first argument that carries a space.
      const outcome = await runForgeCli('git', ['rev-parse', '--git-dir'], repo)
      expect(outcome.kind).toBe('ok')
    })
  })

  test('a binary that never gives back the hand times out, and SAYS it timed out', async () => {
    await withRepo(null, async (repo) => {
      // The budget is a parameter only so this test costs 50ms instead of 8s;
      // production uses FORGE_ISSUE_TIMEOUT_MS.
      const outcome = await runForgeCli('sleep', ['5'], repo, 50)
      expect(outcome).toEqual({ kind: 'error', message: 'timed out after 50ms' })
      // Never the argv: `Command failed: sleep 5` is what execFile hands over,
      // and it makes a timeout indistinguishable from a bad exit code.
      expect(outcome.kind === 'error' && outcome.message).not.toContain('sleep')
    })
  })

  test('an argument past the kernel limit is refused BEFORE any spawn', async () => {
    await withRepo(null, async (repo) => {
      // The binary does not exist: a spawn would answer ENOENT ('missing').
      // Getting 'invalid' instead is the proof nothing was launched at all.
      const outcome = await runForgeCli('codesema-no-such-forge-cli', ['x'.repeat(200_000)], repo)
      expect(outcome).toEqual({
        kind: 'invalid',
        message: 'argument of 200000 bytes exceeds the 131071 the kernel accepts',
      })
    })
  })

  test('the E2BIG the guard cannot see is still an outcome, not a throw', async () => {
    await withRepo(null, async (repo) => {
      // Every argument is under the per-argument cap; their TOTAL is not, and
      // execFile raises E2BIG synchronously — inside a promise executor that
      // would become a rejection the callers must never see.
      const many = Array.from({ length: 200 }, () => 'x'.repeat(100_000))
      const outcome = await runForgeCli('git', ['--version', ...many], repo)
      expect(outcome).toEqual({
        kind: 'invalid',
        message: 'argument list too long for the kernel (E2BIG)',
      })
    })
  })

  test('the output buffer is dimensioned for issues that carry bodies', async () => {
    await withRepo(null, async (repo) => {
      // 2 MiB is past node's 1 MiB default maxBuffer: inherited, this read
      // would come back as an opaque failure with nothing in it.
      writeFileSync(join(repo, 'big.txt'), 'x'.repeat(2_000_000))
      const sha = execFileSync('git', ['hash-object', '-w', 'big.txt'], {
        cwd: repo,
        encoding: 'utf8',
        env: subprocessEnv(),
      }).trim()
      const outcome = await runForgeCli('git', ['cat-file', '-p', sha], repo)
      expect(outcome.kind).toBe('ok')
      expect(outcome.kind === 'ok' && outcome.stdout.length).toBe(2_000_000)
    })
  })
})
