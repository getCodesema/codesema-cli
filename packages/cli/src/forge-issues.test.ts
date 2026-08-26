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
  createLabel,
  FORGE_LABEL_COLOR,
  forgeIssueReason,
  getIssue,
  GLAB_HIERARCHY_CLEAR_PARENT,
  GLAB_HIERARCHY_SET_PARENT,
  ISSUE_COMMENT_LIST_MAX,
  ISSUE_LIST_MAX,
  LABEL_LIST_MAX,
  linkChildIssue,
  listChildIssues,
  listIssueComments,
  listIssues,
  listLabels,
  runForgeCli,
  setLabels,
  unlinkChildIssue,
  type ForgeCli,
  type ForgeCliOutcome,
  type ForgeIssuesExecFn,
  type IssueHierarchyCache,
} from './forge-issues.js'
import { subprocessEnv } from './git.js'

const GH_FIELDS = 'number,title,body,state,labels,author,createdAt,updatedAt,url'
const GH_LIMIT = String(ISSUE_LIST_MAX + 1)
const GLAB_PAGE = '100'
/** GitLab clamps `per_page` at 100 server-side; the fixtures below page against that. */
const GLAB_PAGE_SIZE = 100

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
  // Empty on purpose: this fixture backs the generic pagination/ladder tests
  // below, none of which is about labels, and a non-empty list here would
  // trigger the label-colour catalog fetch (T3.9) on every one of them,
  // adding an unrelated call their `r.calls` assertions do not expect. The
  // colour-enrichment behaviour itself has its own fixtures and its own
  // describe block further down.
  labels: [] as string[],
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
  labels: [{ name: 'bug', color: 'd73a4a' }],
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
  labels: [],
  author: 'jdoe',
  createdAt: '2026-07-20T09:30:00.123Z',
  updatedAt: '2026-07-28T09:30:00.123Z',
  url: 'https://gitlab.com/acme/repo/-/issues/7',
}

// T3.5 comment fixtures. gh answers `{comments:[…]}` with `author.login` and
// `createdAt`; glab answers the ISSUE payload plus a capitalised `Notes`,
// `author.username`, `created_at`, and system notes mixed in with real ones.
function ghComment(body: string) {
  return {
    id: 'IC_kwDO',
    author: { login: 'octocat' },
    authorAssociation: 'MEMBER',
    body,
    createdAt: '2026-07-21T09:00:00Z',
    includesCreatedEdit: false,
    isMinimized: false,
    reactionGroups: [],
    url: 'https://github.com/acme/repo/issues/42#issuecomment-1',
    viewerDidAuthor: false,
  }
}

function glabNote(body: string) {
  return {
    id: 1,
    body,
    author: { id: 1, username: 'jdoe', name: 'Jane Doe' },
    created_at: '2026-07-21T09:30:00Z',
    system: false,
  }
}

function glabSystemNote() {
  return { ...glabNote('changed the description'), id: 2, system: true }
}

function glabNotes(n: number) {
  return Array.from({ length: n }, (_, i) => ({ ...glabNote(`note ${i}`), id: i + 1 }))
}

/** n system notes — a label change, a state change, a cross-reference: no body anyone typed. */
function glabSystemNotes(n: number, from = 1000) {
  return Array.from({ length: n }, (_, i) => ({ ...glabSystemNote(), id: from + i }))
}

/** A full glab notes page: `--per-page` is clamped at 100 server-side. */
const glabPage = (notes: unknown[]) => JSON.stringify({ ...GLAB_ISSUE, Notes: notes })

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

// --- Hierarchy fixtures (T2.2) ------------------------------------------------
//
// GitHub's sub-issues answer through `gh api`, so the payload is the RAW REST
// issue shape — `user.login`, `created_at`/`updated_at`, `html_url` — never
// the porcelain's camelCase GH_ISSUE above uses. GitLab's children answer
// through `Query.workItem`, never `Query.issue` (CRITIQUE 1: `IssueType` has
// no `widgets` field at all): `iid`, `webPath` (relative — combined with an
// ORIGIN resolved off the REST answer, since `WorkItemType` has no absolute
// URL of its own), `author.username`, and description/labels living on their
// OWN nested widgets (`WorkItemWidgetDescription`, `WorkItemWidgetLabels`).
function ghRestIssue(number: number) {
  return {
    number,
    id: number * 100,
    title: 'Add sidebar',
    body: 'It needs a sidebar.',
    state: 'open',
    labels: [{ id: 1, name: 'bug', color: 'd73a4a' }],
    user: { login: 'octocat' },
    created_at: '2026-07-20T09:00:00Z',
    updated_at: '2026-07-28T10:00:00Z',
    html_url: `https://github.com/acme/repo/issues/${number}`,
  }
}

const GLAB_ORIGIN = 'https://gitlab.com'

/** `GET projects/:fullpath/issues/<n>` — used for EVERY glab resolve step
 * (link/unlink/parent-check/has-children only read `.id`; the children list
 * also reads `.web_url` for its origin). One fixture serves all of them. */
function glabIssueRestAnswer(n: number) {
  return JSON.stringify({ id: n * 100, web_url: `${GLAB_ORIGIN}/acme/repo/-/issues/${n}` })
}

function glabWorkItemChild(iid: number) {
  return {
    iid,
    title: 'Fix login',
    state: 'OPEN',
    webPath: `/acme/repo/-/issues/${iid}`,
    author: { username: 'jdoe' },
    createdAt: '2026-07-20T09:30:00.123Z',
    updatedAt: '2026-07-28T09:30:00.123Z',
    widgets: [{ description: 'Login is broken.' }, { labels: { nodes: [{ title: 'bug' }] } }],
  }
}

function glabChildrenPayload(
  children: number[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return JSON.stringify({
    data: {
      workItem: {
        widgets: [
          {
            children: {
              pageInfo: { hasNextPage, endCursor },
              nodes: children.map(glabWorkItemChild),
            },
          },
        ],
      },
    },
  })
}

function glabParentPayload(parentIid: number | null) {
  return JSON.stringify({
    data: { workItem: { widgets: [{ parent: parentIid === null ? null : { iid: parentIid } }] } },
  })
}

function glabHasChildrenPayload(hasAny: boolean) {
  return JSON.stringify({
    data: { workItem: { widgets: [{ children: { nodes: hasAny ? [{ iid: 999 }] : [] } }] } },
  })
}

const GLAB_MUTATION_OK = JSON.stringify({ data: { workItemUpdate: { errors: [] } } })
/** A RECOGNIZED schema gap: graphql-ruby's actual message (verified against
 * its source, `arguments_are_defined.rb`, the input-object-literal branch)
 * for an edition whose `WorkItemUpdateInput` never grew a `hierarchyWidget`
 * argument — `hierarchyWidget` is the one literal key both of this
 * module's mutations ever set, always spelled the same way (MAJEUR C's
 * fix). */
const GLAB_MUTATION_UNSUPPORTED = JSON.stringify({
  errors: [
    { message: "InputObject 'WorkItemUpdateInput' doesn't accept argument 'hierarchyWidget'" },
  ],
})
/** A top-level GraphQL error that is NOT a recognized schema gap — an
 * authorization refusal, naming none of this module's identifiers. Proves
 * CRITIQUE 2's fix: this must stay `cli-error`, never `unsupported`. */
const GLAB_TOPLEVEL_AUTH_ERROR = JSON.stringify({
  errors: [{ message: 'You are not authorized to perform this action' }],
})
const GLAB_MUTATION_BUSINESS_ERROR = JSON.stringify({
  data: { workItemUpdate: { errors: ["You don't have permission to update this work item"] } },
})
/** MAJEUR C: our OWN typo in a LEAF field of a widget we otherwise reach
 * correctly — graphql-ruby's real message shape (`fields_are_defined_on_
 * type.rb`) is IDENTICAL in form to a genuine gap ("Field 'x' doesn't exist
 * on type 'Y'"), differing only in which `Y` it names. `Y` here is one of
 * OUR widget types, never `Query`/`Mutation`, so this must NOT be read as
 * "the edition can't do this" — it can only be this module's own mistake. */
const GLAB_OUR_OWN_TYPO = JSON.stringify({
  errors: [{ message: "Field 'childrn' doesn't exist on type 'WorkItemWidgetHierarchy'" }],
})
/** MINEUR: two REAL schema-gap shapes an earlier, narrower pass did not
 * recognize (both verified against graphql-ruby's own source) — an edition
 * without work items answers with these, not with a "Field … doesn't exist
 * on type 'Query'" the way the entry-point case does. */
const GLAB_MISSING_FRAGMENT_TYPE = JSON.stringify({
  errors: [
    { message: "No such type WorkItemWidgetHierarchy, so it can't be a fragment condition" },
  ],
})
const GLAB_MISSING_INPUT_TYPE = JSON.stringify({
  errors: [{ message: "WorkItemID isn't a defined input type (on $id)" }],
})

/** `--field=query=…` is always argv element index 2 of a `glab api graphql` call. */
function glabQueryOf(call: { args: string[] }): string {
  return call.args[2] ?? ''
}

/** Wraps a WRITE-focused execFn with the standard "no real parent, no real
 * children" answers `guardOneLevel`'s two probes need to let a call through
 * — so a test can focus on what the WRITE itself answers, without repeating
 * the probe plumbing four times over. */
function passGuard(onWrite: ForgeIssuesExecFn): ForgeIssuesExecFn {
  return async (cli, args, cwd) => {
    const q = glabQueryOf({ args })
    if (q.includes('parent { iid }')) {
      return { kind: 'ok', stdout: glabParentPayload(null) }
    }
    if (q.includes('first: 1)')) {
      return { kind: 'ok', stdout: glabHasChildrenPayload(false) }
    }
    return onWrite(cli, args, cwd)
  }
}

/** Extracts the database id a `--field=id=gid://gitlab/WorkItem/<id>` argv
 * element carries, back into the test's own `n * 100` numbering. */
function glabIdArgOf(call: { args: string[] }): number | undefined {
  const arg = call.args.find((a) => a.startsWith('--field=id='))
  const id = arg ? Number(arg.split('/').pop()) : Number.NaN
  return Number.isFinite(id) ? id / 100 : undefined
}

/**
 * A self-consistent fake forge for the hierarchy trio: `state` maps
 * child → parent exactly like the module's own cache, but here it is the
 * SOURCE OF TRUTH the mocked CLIs answer from — so a fresh `linkChildIssue`
 * call (no shared cache) still gets a REAL answer about pre-existing
 * relationships, the guarantee MAJEUR 3 asked for.
 */
function hierarchyReply(state: Map<number, number>) {
  return (call: Call): ForgeCliOutcome => {
    if (call.cli === 'gh') {
      const path = call.args[1] ?? ''
      const match = /issues\/(\d+)(\/(sub_issues|sub_issue|parent))?$/.exec(path)
      const n = match ? Number(match[1]) : Number.NaN
      const suffix = match?.[3]
      if (suffix === 'sub_issues' && call.args.includes('POST')) {
        const idArg = call.args.find((a) => a.startsWith('--field=sub_issue_id='))
        state.set(Number(idArg?.split('=').pop()) / 100, n)
        return { kind: 'ok', stdout: '' }
      }
      if (suffix === 'sub_issue' && call.args.includes('DELETE')) {
        const idArg = call.args.find((a) => a.startsWith('--field=sub_issue_id='))
        state.delete(Number(idArg?.split('=').pop()) / 100)
        return { kind: 'ok', stdout: '' }
      }
      if (suffix === 'sub_issues') {
        const children = [...state.entries()].filter(([, p]) => p === n).map(([c]) => c)
        return { kind: 'ok', stdout: JSON.stringify(children.map(ghRestIssue)) }
      }
      if (suffix === 'parent') {
        const parent = state.get(n)
        // The exact message GitHub's REST API answers with for a genuinely
        // missing parent (checked live against api.github.com/repos/cli/cli
        // /issues/1/parent) — a generic "Not Found" would be a DIFFERENT
        // 404 (issue-not-found) and must NOT be read as "no parent".
        return parent === undefined
          ? { kind: 'error', message: 'gh: No parent issue found (HTTP 404)' }
          : { kind: 'ok', stdout: JSON.stringify({ number: parent }) }
      }
      return { kind: 'ok', stdout: JSON.stringify({ id: n * 100 }) }
    }
    const query = glabQueryOf(call)
    if (query === '') {
      // A plain REST resolve: projects/:fullpath/issues/<n> — no `--field=`
      // arguments at all, so glabIdArgOf (which reads a graphql `id` field)
      // would find nothing here; the number rides the PATH instead.
      const m = /issues\/(\d+)$/.exec(call.args[1] ?? '')
      return { kind: 'ok', stdout: glabIssueRestAnswer(m ? Number(m[1]) : 0) }
    }
    const n = glabIdArgOf(call)
    if (query.includes('parentId: null')) {
      if (n !== undefined) {
        state.delete(n)
      }
      return { kind: 'ok', stdout: GLAB_MUTATION_OK }
    }
    if (query.includes('$parentId')) {
      const parentArg = call.args.find((a) => a.startsWith('--field=parentId='))
      const parentN = parentArg ? Number(parentArg.split('/').pop()) / 100 : undefined
      if (n !== undefined && parentN !== undefined) {
        state.set(n, parentN)
      }
      return { kind: 'ok', stdout: GLAB_MUTATION_OK }
    }
    if (query.includes('parent { iid }')) {
      const parent = n === undefined ? undefined : state.get(n)
      return { kind: 'ok', stdout: glabParentPayload(parent ?? null) }
    }
    if (query.includes('first: 1)')) {
      const hasAny = n !== undefined && [...state.values()].includes(n)
      return { kind: 'ok', stdout: glabHasChildrenPayload(hasAny) }
    }
    if (query.includes('WorkItemWidgetHierarchy')) {
      const children =
        n === undefined ? [] : [...state.entries()].filter(([, p]) => p === n).map(([c]) => c)
      return { kind: 'ok', stdout: glabChildrenPayload(children) }
    }
    return { kind: 'ok', stdout: glabIssueRestAnswer(n ?? 0) }
  }
}

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
        // T3.7's two: the catalog read and the lazy creation are operations of
        // this module like any other, and a repo with no `origin` owes them
        // the same answer.
        await listLabels({ cwd: repo, execFn }),
        await createLabel({ cwd: repo, execFn, name: 'codesema:queued' }),
      ]
      expect(results).toHaveLength(8)
      for (const result of results) {
        expect(result).toMatchObject({ available: false, reason: 'no-remote' })
      }
      expect(r.calls).toEqual([])
    })
  })

  test('every forge binary missing is no-cli', async () => {
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      // One fresh rig per operation, so `no-cli` is asserted against the TWO
      // probes that operation made and not against a running total. A binary
      // that is merely absent never ran, so a WRITE walks the ladder here too.
      const operations: Record<string, (execFn: ForgeIssuesExecFn) => Promise<unknown>> = {
        listIssues: (execFn) => listIssues({ cwd: repo, execFn }),
        getIssue: (execFn) => getIssue({ cwd: repo, execFn, number: 42 }),
        createIssue: (execFn) => createIssue({ cwd: repo, execFn, title: 'T', body: 'B' }),
        commentIssue: (execFn) => commentIssue({ cwd: repo, execFn, number: 42, body: 'hi' }),
        closeIssue: (execFn) => closeIssue({ cwd: repo, execFn, number: 42 }),
        setLabels: (execFn) => setLabels({ cwd: repo, execFn, number: 42, labels: ['bug'] }),
        listLabels: (execFn) => listLabels({ cwd: repo, execFn }),
        createLabel: (execFn) => createLabel({ cwd: repo, execFn, name: 'codesema:queued' }),
      }
      expect(Object.keys(operations)).toHaveLength(8)
      for (const [name, run] of Object.entries(operations)) {
        const r = rig(missing)
        expect({ name, result: await run(r.execFn) }).toEqual({
          name,
          result: { available: false, reason: 'no-cli' },
        })
        expect({ name, probed: r.calls.map((c) => c.cli) }).toEqual({
          name,
          probed: ['gh', 'glab'],
        })
      }
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
        await listLabels({ cwd: repo, execFn }),
        await createLabel({ cwd: repo, execFn, name: 'codesema:queued' }),
      ]
      expect(results).toHaveLength(8)
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

// --- T3.9: GitLab label-colour enrichment (listIssues only) -------------------
//
// GitHub's issue list already carries colour for free (GH_ISSUE above), so
// none of this applies to it. GitLab's `issue list` payload is bare names:
// these fixtures are deliberately SEPARATE from GLAB_ISSUE (which stays
// label-free, see its own comment) so the generic pagination/ladder tests
// above never trigger this extra call.
function glabIssueWithLabels(labels: string[]) {
  return { ...GLAB_ISSUE, labels }
}

function glabLabelCatalog(entries: { name: string; color: string | null }[]): string {
  return JSON.stringify(
    entries.map((e) => ({ id: 1, name: e.name, ...(e.color === null ? {} : { color: e.color }) })),
  )
}

describe('GitLab label-colour enrichment (listIssues, T3.9)', () => {
  test('colours labels from one bounded catalog call, never one per issue', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig((call) =>
        call.args[0] === 'label'
          ? ok(
              glabLabelCatalog([
                { name: 'bug', color: '#D73A4A' },
                { name: 'ui', color: '#428bca' },
              ]),
            )()
          : ok(JSON.stringify([glabIssueWithLabels(['bug', 'ui'])]))(),
      )
      const result = await listIssues({ cwd: repo, execFn: r.execFn })
      expect(result).toMatchObject({ available: true })
      expect(result.available && result.issues[0]?.labels).toEqual([
        { name: 'bug', color: 'd73a4a' },
        { name: 'ui', color: '428bca' },
      ])
      // One issue-list call, one label-catalog call, never one per issue.
      expect(r.calls.map((c) => c.args[0])).toEqual(['issue', 'label'])
    })
  })

  test('no label anywhere in the page skips the catalog call entirely', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig(ok(JSON.stringify([glabIssueWithLabels([])])))
      await listIssues({ cwd: repo, execFn: r.execFn })
      expect(r.calls).toHaveLength(1)
      expect(r.calls[0]?.args[0]).toBe('issue')
    })
  })

  test('a catalog call that fails leaves every label at color: null, never fails the list', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig((call) =>
        call.args[0] === 'label'
          ? failing('HTTP 500')()
          : ok(JSON.stringify([glabIssueWithLabels(['bug'])]))(),
      )
      const result = await listIssues({ cwd: repo, execFn: r.execFn })
      expect(result).toMatchObject({ available: true })
      expect(result.available && result.issues[0]?.labels).toEqual([{ name: 'bug', color: null }])
    })
  })

  test('a catalog binary that is simply missing degrades the same way, never no-cli for the list', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig((call) =>
        call.args[0] === 'label' ? missing() : ok(JSON.stringify([glabIssueWithLabels(['bug'])]))(),
      )
      const result = await listIssues({ cwd: repo, execFn: r.execFn })
      expect(result).toMatchObject({ available: true })
      expect(result.available && result.issues[0]?.labels).toEqual([{ name: 'bug', color: null }])
    })
  })

  test('an unreadable catalog payload leaves every label at color: null too', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig((call) =>
        call.args[0] === 'label'
          ? ok('{ not an array')()
          : ok(JSON.stringify([glabIssueWithLabels(['bug'])]))(),
      )
      const result = await listIssues({ cwd: repo, execFn: r.execFn })
      expect(result).toMatchObject({ available: true })
      expect(result.available && result.issues[0]?.labels).toEqual([{ name: 'bug', color: null }])
    })
  })

  test('a name absent from the catalog keeps color: null, never a guessed colour', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig((call) =>
        call.args[0] === 'label'
          ? ok(glabLabelCatalog([{ name: 'ui', color: '#428bca' }]))()
          : ok(JSON.stringify([glabIssueWithLabels(['bug', 'ui'])]))(),
      )
      const result = await listIssues({ cwd: repo, execFn: r.execFn })
      expect(result.available && result.issues[0]?.labels).toEqual([
        { name: 'bug', color: null },
        { name: 'ui', color: '428bca' },
      ])
    })
  })

  test('the catalog fetch itself pages, and stops at the first short page', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig((call) => {
        if (call.args[0] !== 'label') {
          return ok(JSON.stringify([glabIssueWithLabels(['bug'])]))()
        }
        const page = call.args.at(-3)
        return page === '1'
          ? ok(
              glabLabelCatalog(
                Array.from({ length: GLAB_PAGE_SIZE }, (_, i) => ({
                  name: `l${i}`,
                  color: '#111111',
                })),
              ),
            )()
          : ok(glabLabelCatalog([{ name: 'bug', color: '#D73A4A' }]))()
      })
      const result = await listIssues({ cwd: repo, execFn: r.execFn })
      expect(result.available && result.issues[0]?.labels).toEqual([
        { name: 'bug', color: 'd73a4a' },
      ])
      // 100 (full page) then a short page: exactly two catalog calls.
      expect(r.calls.filter((c) => c.args[0] === 'label')).toHaveLength(2)
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
        answeredBy: 'gh',
      })
      expect(r.calls[0]?.args).toEqual(['issue', 'view', '42', '--json', GH_FIELDS])
    })
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig(ok(JSON.stringify(GLAB_ISSUE)))
      expect(await getIssue({ cwd: repo, execFn: r.execFn, number: 7 })).toEqual({
        available: true,
        issue: GLAB_ISSUE_PARSED,
        answeredBy: 'glab',
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

  // T3.5: the read the recap publication needs before it writes. The argv is
  // the assertion — no gh/glab runs, nothing touches the network.
  describe('listIssueComments', () => {
    test('gh asks the porcelain for the comments json field', async () => {
      await withRepo(GITHUB_REMOTE, async (repo) => {
        const r = rig(ok(JSON.stringify({ comments: [ghComment('hello'), ghComment('bye')] })))
        expect(await listIssueComments({ cwd: repo, execFn: r.execFn, number: 42 })).toEqual({
          available: true,
          truncated: false,
          comments: [
            { body: 'hello', author: 'octocat', createdAt: '2026-07-21T09:00:00Z', system: false },
            { body: 'bye', author: 'octocat', createdAt: '2026-07-21T09:00:00Z', system: false },
          ],
        })
        expect(r.calls).toHaveLength(1)
        expect(r.calls[0]?.args).toEqual(['issue', 'view', '42', '--json', 'comments'])
      })
    })

    test('glab asks its own view for notes, paged explicitly, and drops the system ones', async () => {
      await withRepo(GITLAB_REMOTE, async (repo) => {
        const r = rig(
          ok(JSON.stringify({ ...GLAB_ISSUE, Notes: [glabNote('hello'), glabSystemNote()] })),
        )
        expect(await listIssueComments({ cwd: repo, execFn: r.execFn, number: 7 })).toEqual({
          available: true,
          truncated: false,
          // The system note is GONE, not merely flagged: a note GitLab minted
          // from an activity carries no body anyone supplied, so it can never
          // hold the marker this read exists to look for.
          comments: [
            { body: 'hello', author: 'jdoe', createdAt: '2026-07-21T09:30:00Z', system: false },
          ],
        })
        // prettier-ignore
        expect(r.calls[0]?.args).toEqual(['issue', 'view', '7', '--comments', '--output', 'json', '--per-page', GLAB_PAGE, '--page', '1'])
      })
    })

    // MAJEUR 3. Verified against glab 1.53.0's own source: `--system-logs`
    // gates the TEXT rendering only (`if note.System && !opts.ShowSystemLogs
    // { continue }`, commands/issuable/view/issuable_view.go) — the JSON
    // marshals `IssueWithNotes{*Issue, Notes}` whole. So the filter has to be
    // here, and it has to run BEFORE the cap: GitLab mints a system note per
    // label, assignment, milestone, state change, cross-reference and
    // description edit, `publishTaskRecap` refuses to write on a capped read,
    // and nothing ever lowers that count again — the recap would be lost for
    // GOOD, behind a `forge_unreachable` that reads transitory. T3.7, the next
    // ticket in this chain, writes labels.
    test('202 notes of which 201 are system read as ONE comment, and the guard stays open', async () => {
      await withRepo(GITLAB_REMOTE, async (repo) => {
        const page = (n: number) =>
          n === 1
            ? [glabNote('the only thing anyone typed'), ...glabSystemNotes(99, 2000)]
            : glabSystemNotes(n === 2 ? GLAB_PAGE_SIZE : 2, n * 1000)
        const r = rig((call) => ({ kind: 'ok', stdout: glabPage(page(Number(call.args.at(-1)))) }))
        const result = await listIssueComments({ cwd: repo, execFn: r.execFn, number: 7 })
        expect(result).toEqual({
          available: true,
          truncated: false,
          comments: [
            {
              body: 'the only thing anyone typed',
              author: 'jdoe',
              createdAt: '2026-07-21T09:30:00Z',
              system: false,
            },
          ],
        })
        // The walk went on past a full page of pure churn instead of stopping
        // at a cap it had not reached.
        expect(r.calls.map((c) => c.args.at(-1))).toEqual(['1', '2', '3'])
      })
    })

    // The other half of the same filter: dropping system notes must never let
    // an INCOMPLETE walk look complete. Three full pages of 100 leave 0
    // comments once filtered, and `0 > 200` is false — length alone would then
    // answer "no comments at all, nothing was cut", which is exactly the proof
    // of absence `publishTaskRecap` writes a comment on.
    test('a page walk that ran out of pages is truncated even when the filter empties it', async () => {
      await withRepo(GITLAB_REMOTE, async (repo) => {
        const r = rig(ok(glabPage(glabSystemNotes(GLAB_PAGE_SIZE))))
        const result = await listIssueComments({ cwd: repo, execFn: r.execFn, number: 7 })
        expect(result).toMatchObject({ available: true, truncated: true })
        expect(result.available && result.comments).toEqual([])
        expect(r.calls).toHaveLength(3)
      })
    })

    // m6: the GitLab TWIN of the truncation guard the whole idempotence rests
    // on. Its gh side was asserted; this side had nothing at all.
    test('glab past the cap says so instead of looking complete, and stops paging there', async () => {
      await withRepo(GITLAB_REMOTE, async (repo) => {
        const r = rig(ok(glabPage(glabNotes(GLAB_PAGE_SIZE))))
        const result = await listIssueComments({ cwd: repo, execFn: r.execFn, number: 7 })
        expect(result).toMatchObject({ available: true, truncated: true })
        expect(result.available && result.comments).toHaveLength(ISSUE_COMMENT_LIST_MAX)
        // 100 + 100 + 1 past the cap: the third page is where it stops.
        expect(r.calls.map((c) => c.args.at(-1))).toEqual(['1', '2', '3'])
      })
    })

    // The other exit of the same walk, and the one the gh side has no
    // equivalent of: the notes END on a short page, but the FULL pages before
    // it already overshot the cap. 100 + 100 + 50 = 250 real comments, and
    // answering {250, truncated:false} here is the same defect the issue list
    // was fixed for — a list that looks complete while gh answers 200/true on
    // the very same ticket, and a marker search that would then post on it.
    test('a walk that ENDS on a short page is still capped, and says it was', async () => {
      await withRepo(GITLAB_REMOTE, async (repo) => {
        const r = rig((call) =>
          call.args.at(-1) === '3'
            ? { kind: 'ok', stdout: glabPage(glabNotes(50)) }
            : { kind: 'ok', stdout: glabPage(glabNotes(GLAB_PAGE_SIZE)) },
        )
        const result = await listIssueComments({ cwd: repo, execFn: r.execFn, number: 7 })
        expect(result).toMatchObject({ available: true, truncated: true })
        expect(result.available && result.comments).toHaveLength(ISSUE_COMMENT_LIST_MAX)
        expect(r.calls.map((c) => c.args.at(-1))).toEqual(['1', '2', '3'])
      })
    })

    test('a page that comes back unreadable MID-WALK is a cli-error, never a half-read list', async () => {
      await withRepo(GITLAB_REMOTE, async (repo) => {
        const r = rig((call) =>
          call.args.at(-1) === '1'
            ? { kind: 'ok', stdout: glabPage(glabNotes(GLAB_PAGE_SIZE)) }
            : { kind: 'ok', stdout: glabPage([{ author: {} }]) },
        )
        // A 100-comment page that WAS read is not an answer: the marker could
        // sit in the page that was not.
        expect(await listIssueComments({ cwd: repo, execFn: r.execFn, number: 7 })).toMatchObject({
          available: false,
          reason: 'cli-error',
        })
      })
    })

    test('a CLI that fails MID-WALK never degrades to the pages it already had', async () => {
      await withRepo(GITLAB_REMOTE, async (repo) => {
        const r = rig((call) =>
          call.args.at(-1) === '1'
            ? { kind: 'ok', stdout: glabPage(glabNotes(GLAB_PAGE_SIZE)) }
            : { kind: 'error', message: 'HTTP 502' },
        )
        expect(await listIssueComments({ cwd: repo, execFn: r.execFn, number: 7 })).toEqual({
          available: false,
          reason: 'cli-error',
          detail: 'glab: HTTP 502',
        })
      })
    })

    test('an issue glab answers without a Notes array has no comments, it is not unreadable', async () => {
      await withRepo(GITLAB_REMOTE, async (repo) => {
        const r = rig(ok(JSON.stringify(GLAB_ISSUE)))
        expect(await listIssueComments({ cwd: repo, execFn: r.execFn, number: 7 })).toEqual({
          available: true,
          comments: [],
          truncated: false,
        })
      })
    })

    test('glab walks pages until one comes back short', async () => {
      await withRepo(GITLAB_REMOTE, async (repo) => {
        const r = rig((call) =>
          call.args.includes('--page')
            ? {
                kind: 'ok',
                stdout: JSON.stringify({
                  ...GLAB_ISSUE,
                  Notes: glabNotes(call.args.at(-1) === '1' ? 100 : 3),
                }),
              }
            : { kind: 'missing' },
        )
        const result = await listIssueComments({ cwd: repo, execFn: r.execFn, number: 7 })
        expect(result).toMatchObject({ available: true, truncated: false })
        expect(result.available && result.comments).toHaveLength(103)
        expect(r.calls.map((c) => c.args.at(-1))).toEqual(['1', '2'])
      })
    })

    // m5: the twin of `buildMrDescription`'s "sized from a LITERAL 6 000, not
    // from MR_BODY_SUMMARY_MAX" test, which the ISSUE_COMMENT_LIST_MAX side was
    // missing. A cap measured against the very constant it is checking cannot
    // tell 200 from 2 000: both leave a 201-comment payload "one past the cap"
    // and a 300-comment payload untouched at one, cut at the other.
    test('the cap is 200 comments, whatever the constant is set to', async () => {
      await withRepo(GITHUB_REMOTE, async (repo) => {
        const r = rig(
          ok(JSON.stringify({ comments: Array.from({ length: 300 }, () => ghComment('x')) })),
        )
        const result = await listIssueComments({ cwd: repo, execFn: r.execFn, number: 42 })
        expect(result).toMatchObject({ available: true, truncated: true })
        expect(result.available && result.comments).toHaveLength(200)
      })
    })

    test('past the cap the answer says so instead of looking complete', async () => {
      await withRepo(GITHUB_REMOTE, async (repo) => {
        const r = rig(
          ok(
            JSON.stringify({
              comments: Array.from({ length: ISSUE_COMMENT_LIST_MAX + 1 }, () => ghComment('x')),
            }),
          ),
        )
        const result = await listIssueComments({ cwd: repo, execFn: r.execFn, number: 42 })
        expect(result).toMatchObject({ available: true, truncated: true })
        expect(result.available && result.comments).toHaveLength(ISSUE_COMMENT_LIST_MAX)
      })
    })

    test('an unreadable payload is a cli-error, never a half-read list', async () => {
      await withRepo(GITHUB_REMOTE, async (repo) => {
        const r = rig(ok(JSON.stringify({ comments: [ghComment('ok'), { author: {} }] })))
        expect(await listIssueComments({ cwd: repo, execFn: r.execFn, number: 42 })).toMatchObject({
          available: false,
          reason: 'cli-error',
        })
      })
    })

    test('no binary at all is no-cli, and it never throws', async () => {
      await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
        const r = rig(missing)
        expect(await listIssueComments({ cwd: repo, execFn: r.execFn, number: 42 })).toEqual({
          available: false,
          reason: 'no-cli',
        })
        expect(r.calls.map((c) => c.cli)).toEqual(['gh', 'glab'])
      })
    })

    test('a failing CLI is a cli-error carrying its own words', async () => {
      await withRepo(GITHUB_REMOTE, async (repo) => {
        const r = rig(failing('HTTP 404'))
        expect(await listIssueComments({ cwd: repo, execFn: r.execFn, number: 42 })).toEqual({
          available: false,
          reason: 'cli-error',
          detail: 'gh: HTTP 404',
        })
      })
    })

    test('an impossible issue number never launches anything', async () => {
      await withRepo(GITHUB_REMOTE, async (repo) => {
        const r = rig(ok('{}'))
        expect(await listIssueComments({ cwd: repo, execFn: r.execFn, number: 0 })).toMatchObject({
          available: false,
          reason: 'invalid-input',
        })
        expect(r.calls).toHaveLength(0)
      })
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

  // T3.7: the label CATALOG — read it, then create only what is provably
  // missing. Both operations go through the label porcelain (D5), and both
  // diverge between the forges in ways that are documented, not smoothed over.
  describe('label catalog (T3.7)', () => {
    const catalog = (names: string[]) => JSON.stringify(names.map((name) => ({ name })))

    test('gh asks one page past the cap; glab walks GitLab own pages', async () => {
      await withRepo(GITHUB_REMOTE, async (repo) => {
        const r = rig(ok(catalog(['bug', 'codesema:queued'])))
        expect(await listLabels({ cwd: repo, execFn: r.execFn })).toEqual({
          available: true,
          labels: ['bug', 'codesema:queued'],
          truncated: false,
        })
        expect(r.calls[0]?.args).toEqual([
          'label',
          'list',
          '--limit',
          String(LABEL_LIST_MAX + 1),
          '--json',
          'name',
        ])
      })
      await withRepo(GITLAB_REMOTE, async (repo) => {
        const full = Array.from({ length: 100 }, (_, i) => `l${String(i)}`)
        const r = rig((call) =>
          call.args.includes('1')
            ? { kind: 'ok', stdout: catalog(full) }
            : { kind: 'ok', stdout: catalog(['tail']) },
        )
        const answer = await listLabels({ cwd: repo, execFn: r.execFn })
        expect(answer).toMatchObject({ available: true, truncated: false })
        expect(answer.available && answer.labels).toHaveLength(101)
        expect(r.calls).toHaveLength(2)
        expect(r.calls[0]?.args).toEqual([
          'label',
          'list',
          '--per-page',
          GLAB_PAGE,
          '--page',
          '1',
          '--output',
          'json',
        ])
      })
    })

    test('a catalog past the cap says so instead of passing for complete', async () => {
      await withRepo(GITHUB_REMOTE, async (repo) => {
        const many = Array.from({ length: LABEL_LIST_MAX + 1 }, (_, i) => `l${String(i)}`)
        const r = rig(ok(catalog(many)))
        const answer = await listLabels({ cwd: repo, execFn: r.execFn })
        expect(answer).toMatchObject({ available: true, truncated: true })
        expect(answer.available && answer.labels).toHaveLength(LABEL_LIST_MAX)
      })
    })

    test('the cap bound is EXACT: a repo with exactly the cap is complete', async () => {
      await withRepo(GITHUB_REMOTE, async (repo) => {
        const exactly = Array.from({ length: LABEL_LIST_MAX }, (_, i) => `l${String(i)}`)
        const answer = await listLabels({ cwd: repo, execFn: rig(ok(catalog(exactly))).execFn })
        // `>=` instead of `>` here would be invisible on every other input and
        // would mean a repository sitting on exactly 200 labels could never
        // prove a name absent again — so `ensureCycleLabel` would decline to
        // create anything for it, for good.
        expect(answer).toMatchObject({ available: true, truncated: false })
        expect(answer.available && answer.labels).toHaveLength(LABEL_LIST_MAX)
        expect(answer.available && answer.labels.at(-1)).toBe(`l${String(LABEL_LIST_MAX - 1)}`)
      })
    })

    test('the cap applies to the page that ENDS the glab walk, not only to a full one', async () => {
      await withRepo(GITLAB_REMOTE, async (repo) => {
        // Two full pages then a short one: 250 names in, and the walk exits
        // through the SHORT-page return. `listIssues` shipped exactly this bug
        // once (250 names handed back with truncated:false), which is the
        // regression the comment in `glabLabelListCandidate` names.
        const page = (n: number, count: number) =>
          catalog(Array.from({ length: count }, (_, i) => `p${String(n)}-l${String(i)}`))
        const r = rig((call) => {
          const at = call.args[call.args.indexOf('--page') + 1]
          return { kind: 'ok', stdout: page(Number(at), at === '3' ? 50 : 100) }
        })
        const answer = await listLabels({ cwd: repo, execFn: r.execFn })
        expect(r.calls).toHaveLength(3)
        expect(answer).toMatchObject({ available: true, truncated: true })
        expect(answer.available && answer.labels).toHaveLength(LABEL_LIST_MAX)
      })
    })

    test('a catalog that is not an array at all is unreadable, never an EMPTY one', async () => {
      await withRepo(GITHUB_REMOTE, async (repo) => {
        // The distinction this pins is the whole of `ensureCycleLabel`'s
        // safety: an empty catalog is a positive claim ("this repo has no
        // labels"), and it reads as "the cycle label is missing" — so a
        // payload that says nothing of the sort must never degrade INTO one.
        for (const stdout of ['{}', '{"labels":[]}', 'null', '"bug"', '17']) {
          expect({
            stdout,
            answer: await listLabels({ cwd: repo, execFn: rig(ok(stdout)).execFn }),
          }).toEqual({
            stdout,
            answer: { available: false, reason: 'cli-error', detail: 'gh: unreadable output' },
          })
        }
      })
    })

    test('glab answering bare strings is read, and read as the same catalog', async () => {
      await withRepo(GITLAB_REMOTE, async (repo) => {
        // `glab label list --output json` is not pinned by a schema this repo
        // controls, and the tolerance for the bare-string shape was declared
        // in a comment and asserted nowhere. Both shapes answer the one
        // question a catalog is asked — "is this name already taken" — so both
        // are accepted, and they are accepted IDENTICALLY.
        const bare = JSON.stringify(['bug', 'codesema:queued'])
        const objects = catalog(['bug', 'codesema:queued'])
        const answers = []
        for (const stdout of [bare, objects]) {
          answers.push(await listLabels({ cwd: repo, execFn: rig(ok(stdout)).execFn }))
        }
        expect(answers[0]).toEqual({
          available: true,
          labels: ['bug', 'codesema:queued'],
          truncated: false,
        })
        expect(answers[0]).toEqual(answers[1])
      })
    })

    test('one EMPTY name still rejects the whole catalog, in either shape', async () => {
      await withRepo(GITHUB_REMOTE, async (repo) => {
        for (const stdout of [
          JSON.stringify(['bug', '']),
          JSON.stringify([{ name: 'bug' }, { name: '' }]),
          JSON.stringify(['bug', 42]),
        ]) {
          expect({
            stdout,
            answer: await listLabels({ cwd: repo, execFn: rig(ok(stdout)).execFn }),
          }).toMatchObject({ stdout, answer: { available: false, reason: 'cli-error' } })
        }
      })
    })

    test('one unreadable entry rejects the WHOLE catalog, never a partial one', async () => {
      await withRepo(GITHUB_REMOTE, async (repo) => {
        const r = rig(ok(JSON.stringify([{ name: 'bug' }, { colour: 'red' }])))
        // A partial catalog reads as "this label does not exist yet" and
        // provokes a creation that cannot succeed.
        expect(await listLabels({ cwd: repo, execFn: r.execFn })).toMatchObject({
          available: false,
          reason: 'cli-error',
        })
      })
    })

    test('createLabel: a positional name on gh, a flag on glab, and the colour differs', async () => {
      await withRepo(GITHUB_REMOTE, async (repo) => {
        const r = rig(ok(''))
        expect(
          await createLabel({
            cwd: repo,
            execFn: r.execFn,
            name: 'codesema:queued',
            description: 'Cycle',
          }),
        ).toEqual({ available: true })
        expect(r.calls[0]?.args).toEqual([
          'label',
          'create',
          'codesema:queued',
          `--color=${FORGE_LABEL_COLOR}`,
          '--description=Cycle',
        ])
      })
      await withRepo(GITLAB_REMOTE, async (repo) => {
        const r = rig(ok(''))
        await createLabel({ cwd: repo, execFn: r.execFn, name: 'codesema:queued' })
        expect(r.calls[0]?.args).toEqual([
          'label',
          'create',
          '--name=codesema:queued',
          `--color=#${FORGE_LABEL_COLOR}`,
        ])
      })
    })

    test('a name that would be read as a flag is refused before any spawn', async () => {
      await withRepo(GITHUB_REMOTE, async (repo) => {
        const r = rig(ok(''))
        // gh takes the name POSITIONALLY, so this one — and this one alone —
        // could reach the binary as an option.
        const refused = await createLabel({ cwd: repo, execFn: r.execFn, name: '--force' })
        expect(refused).toMatchObject({ available: false, reason: 'invalid-input' })
        // And the check `setLabels` applies still applies here: a name that
        // could never be written back onto an issue is not worth creating.
        expect(
          await createLabel({ cwd: repo, execFn: r.execFn, name: 'needs, triage' }),
        ).toMatchObject({ available: false, reason: 'invalid-input' })
        expect(r.calls).toEqual([])
      })
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
      await listLabels({ cwd: repo, execFn })
      await createLabel({ cwd: repo, execFn, name: 'codesema:queued' })
      // Eight operations, two probes each (every binary missing): an operation
      // dropped from this list would show up here before it showed up below.
      expect(r.calls.length).toBe(16)
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
      // T3.7's creation is a WRITE: `gh label create` may have created the
      // label before exiting non-zero, and replaying it on glab is a second
      // creation on a second forge. The scale is the whole guard — a
      // `createLabel` asking on the read scale would walk on to glab here.
      await createLabel({ cwd: repo, execFn, name: 'codesema:queued' })
      expect(r.calls.map((c) => c.cli)).toEqual(['gh', 'gh', 'gh', 'gh'])
      // And its READ sibling is the counter-proof, on the same rig and the
      // same failure: `listLabels` DOES walk on to glab. Reading a catalog
      // twice costs a round trip and nothing else. Asserting both here is what
      // makes the two scales discriminable — each of them alone would survive
      // being swapped for the other.
      await listLabels({ cwd: repo, execFn })
      expect(r.calls.map((c) => c.cli)).toEqual(['gh', 'gh', 'gh', 'gh', 'gh', 'glab'])
    })
  })
})

describe('a read that will be written back pins the write to its own forge (T3.7 MAJEUR 2)', () => {
  test('getIssue names the forge that answered, on either binary', async () => {
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      const onGh = await getIssue({
        cwd: repo,
        execFn: rig(ok(JSON.stringify(GH_ISSUE))).execFn,
        number: 42,
      })
      expect(onGh).toEqual({ available: true, issue: GH_ISSUE_PARSED, answeredBy: 'gh' })
      // gh unreachable, glab answers: the SAME payload, a different provenance.
      const fellThrough = await getIssue({
        cwd: repo,
        execFn: rig((call) =>
          call.cli === 'gh' ? failing('HTTP 502')() : ok(JSON.stringify(GLAB_ISSUE))(),
        ).execFn,
        number: 7,
      })
      expect(fellThrough).toEqual({
        available: true,
        issue: GLAB_ISSUE_PARSED,
        answeredBy: 'glab',
      })
    })
  })

  test('a pinned setLabels never PUTs one forge label set onto the other', async () => {
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      // The reproduction, verbatim: a self-hosted remote (both candidates are
      // probed), gh failing the read and answering the write. Unpinned, the
      // set read on GitLab is replayed as a TOTAL PUT on GitHub — `setLabels`
      // replaces, so that is a destruction of GitHub's own labels, not a
      // degradation.
      const r = rig((call) => (call.cli === 'gh' ? failing('HTTP 502')() : ok('')()))
      const read = await getIssue({
        cwd: repo,
        execFn: rig((call) =>
          call.cli === 'gh' ? failing('HTTP 502')() : ok(JSON.stringify(GLAB_ISSUE))(),
        ).execFn,
        number: 7,
      })
      expect(read.available && read.answeredBy).toBe('glab')
      const written = await setLabels({
        cwd: repo,
        execFn: r.execFn,
        number: 7,
        labels: ['bug', 'ui'],
        pin: read.available ? read.answeredBy : null,
      })
      expect(written).toEqual({ available: true })
      // ONE call, on the forge the set came from. gh is never even asked.
      expect(r.calls.map((c) => c.cli)).toEqual(['glab'])
      expect(r.calls[0]?.args[0]).toBe('api')
    })
  })

  test('the catalog and the creation are pinned by the same read', async () => {
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      const r = rig((call) =>
        call.cli === 'gh' ? failing('HTTP 502')() : ok(JSON.stringify(['bug']))(),
      )
      expect(await listLabels({ cwd: repo, execFn: r.execFn, pin: 'glab' })).toEqual({
        available: true,
        labels: ['bug'],
        truncated: false,
      })
      await createLabel({ cwd: repo, execFn: r.execFn, name: 'codesema:queued', pin: 'glab' })
      // GitHub's catalog answers nothing about GitLab's, and a label created
      // on the wrong forge is a label the write will not find.
      expect(r.calls.map((c) => c.cli)).toEqual(['glab', 'glab'])
    })
  })

  test('no pin means the ordinary ladder, unchanged', async () => {
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      const r = rig(missing)
      await setLabels({ cwd: repo, execFn: r.execFn, number: 1, labels: ['bug'], pin: null })
      expect(r.calls.map((c) => c.cli)).toEqual(['gh', 'glab'])
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

// --- T2.2: hierarchy ---------------------------------------------------------

describe('hierarchy: link, list, unlink (T2.2)', () => {
  test('GitHub: link probes the real parent and real children first, then resolves+writes', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(hierarchyReply(new Map()))
      expect(await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 10, child: 20 })).toEqual({
        available: true,
      })
      expect(r.calls.map((c) => c.cli)).toEqual(['gh', 'gh', 'gh', 'gh'])
      expect(r.calls[0]?.args).toEqual(['api', 'repos/{owner}/{repo}/issues/10/parent'])
      expect(r.calls[1]?.args).toEqual([
        'api',
        'repos/{owner}/{repo}/issues/20/sub_issues',
        '--method',
        'GET',
        '--field=per_page=1',
      ])
      expect(r.calls[2]?.args).toEqual(['api', 'repos/{owner}/{repo}/issues/20'])
      expect(r.calls[3]?.args).toEqual([
        'api',
        'repos/{owner}/{repo}/issues/10/sub_issues',
        '--method',
        'POST',
        '--field=sub_issue_id=2000',
      ])
      const r2 = rig(hierarchyReply(new Map([[20, 10]])))
      expect(
        await unlinkChildIssue({ cwd: repo, execFn: r2.execFn, parent: 10, child: 20 }),
      ).toEqual({ available: true })
      expect(r2.calls.map((c) => c.cli)).toEqual(['gh', 'gh'])
      expect(r2.calls[0]?.args).toEqual(['api', 'repos/{owner}/{repo}/issues/20'])
      expect(r2.calls[1]?.args).toEqual([
        'api',
        'repos/{owner}/{repo}/issues/10/sub_issue',
        '--method',
        'DELETE',
        '--field=sub_issue_id=2000',
      ])
    })
  })

  test('GitLab: link probes the real parent and real children first, then resolves+writes with a canonical WorkItem gid', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig(hierarchyReply(new Map()))
      expect(await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 10, child: 20 })).toEqual({
        available: true,
      })
      // Every glab hierarchy read needs its OWN resolve first — GraphQL
      // cannot turn a project-scoped number into a gid on its own, unlike
      // GitHub's REST paths, which take the plain number directly:
      //   resolve(10), parent-query(10),
      //   resolve(20), has-children-query(20),
      //   resolve(20), resolve(10), mutate.
      expect(r.calls.map((c) => c.cli)).toEqual(Array(7).fill('glab'))
      expect(r.calls[0]?.args).toEqual(['api', 'projects/:fullpath/issues/10'])
      expect(glabQueryOf(r.calls[1]!)).toContain('parent { iid }')
      expect(r.calls[1]?.args).toContain('--field=id=gid://gitlab/WorkItem/1000')
      expect(r.calls[2]?.args).toEqual(['api', 'projects/:fullpath/issues/20'])
      expect(glabQueryOf(r.calls[3]!)).toContain('first: 1)')
      expect(r.calls[3]?.args).toContain('--field=id=gid://gitlab/WorkItem/2000')
      expect(r.calls[4]?.args).toEqual(['api', 'projects/:fullpath/issues/20'])
      expect(r.calls[5]?.args).toEqual(['api', 'projects/:fullpath/issues/10'])
      expect(glabQueryOf(r.calls[6]!)).toContain('$parentId')
      expect(r.calls[6]?.args).toContain('--field=id=gid://gitlab/WorkItem/2000')
      expect(r.calls[6]?.args).toContain('--field=parentId=gid://gitlab/WorkItem/1000')

      const r2 = rig(hierarchyReply(new Map([[20, 10]])))
      expect(
        await unlinkChildIssue({ cwd: repo, execFn: r2.execFn, parent: 10, child: 20 }),
      ).toEqual({ available: true })
      // unlink runs no guard, no parent/has-children probe: resolve child then mutate.
      expect(r2.calls.map((c) => c.cli)).toEqual(['glab', 'glab'])
      expect(r2.calls[0]?.args).toEqual(['api', 'projects/:fullpath/issues/20'])
      expect(glabQueryOf(r2.calls[1]!)).toContain('parentId: null')
      expect(r2.calls[1]?.args).toContain('--field=id=gid://gitlab/WorkItem/2000')
      expect(r2.calls[1]?.args).not.toContain('--field=parentId=gid://gitlab/WorkItem/1000')
    })
  })

  test('listChildIssues reflects the forge after link and after unlink, on both forges', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const state = new Map<number, number>()
      const r = rig(hierarchyReply(state))
      await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 10, child: 20 })
      const after = await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10 })
      expect(after.available && after.issues.map((i) => i.number)).toEqual([20])
      await unlinkChildIssue({ cwd: repo, execFn: r.execFn, parent: 10, child: 20 })
      const gone = await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10 })
      expect(gone).toMatchObject({ available: true, issues: [], truncated: false })
    })
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const state = new Map<number, number>()
      const r = rig(hierarchyReply(state))
      await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 10, child: 20 })
      const after = await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10 })
      expect(after.available && after.issues.map((i) => i.number)).toEqual([20])
      await unlinkChildIssue({ cwd: repo, execFn: r.execFn, parent: 10, child: 20 })
      const gone = await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10 })
      expect(gone).toMatchObject({ available: true, issues: [], truncated: false })
    })
  })

  test('no hierarchy operation hands a credential to the forge CLI', async () => {
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      const r = rig(missing)
      const { execFn } = r
      await linkChildIssue({ cwd: repo, execFn, parent: 1, child: 2 })
      await unlinkChildIssue({ cwd: repo, execFn, parent: 1, child: 2 })
      await listChildIssues({ cwd: repo, execFn, parent: 1 })
      expect(r.calls.length).toBeGreaterThan(0)
      for (const call of r.calls) {
        expect(['gh', 'glab']).toContain(call.cli)
        expect(call.args.some((arg) => /token|password|authorization|bearer/i.test(arg))).toBe(
          false,
        )
      }
    })
  })
})

describe('hierarchy: unavailability never throws, and unsupported is narrowly named (T2.2)', () => {
  test('every hierarchy operation degrades to a typed result instead of throwing', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const { execFn } = rig(failing('boom'))
      const results = [
        await linkChildIssue({ cwd: repo, execFn, parent: 1, child: 2 }),
        await unlinkChildIssue({ cwd: repo, execFn, parent: 1, child: 2 }),
        await listChildIssues({ cwd: repo, execFn, parent: 1 }),
      ]
      for (const result of results) {
        expect(result.available).toBe(false)
        expect('reason' in result && result.reason).toBe('cli-error')
      }
    })
  })

  test('GitLab: a RECOGNIZED schema gap answers a NAMED unavailability, not a bare cli-error', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const execFn = passGuard(async (_cli, args) =>
        glabQueryOf({ args }).includes('$parentId')
          ? { kind: 'ok', stdout: GLAB_MUTATION_UNSUPPORTED }
          : { kind: 'ok', stdout: glabIssueRestAnswer(1) },
      )
      const result = await linkChildIssue({ cwd: repo, execFn, parent: 1, child: 2 })
      expect(result).toMatchObject({ available: false, reason: 'unsupported' })
      expect('detail' in result && result.detail).toContain('glab:')
      expect('detail' in result && result.detail).toContain('hierarchyWidget')
      expect(!result.available && forgeIssueReason(result)).toBeNull()
    })
  })

  test('GitLab: an UNRECOGNIZED top-level error (authorization) stays cli-error, never "unsupported"', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const execFn = passGuard(async (_cli, args) =>
        args.includes('graphql')
          ? { kind: 'ok', stdout: GLAB_TOPLEVEL_AUTH_ERROR }
          : { kind: 'ok', stdout: glabIssueRestAnswer(1) },
      )
      const result = await linkChildIssue({ cwd: repo, execFn, parent: 1, child: 2 })
      expect(result).toMatchObject({ available: false, reason: 'cli-error' })
      expect('detail' in result && result.detail).toContain('not authorized')
    })
  })

  test('GitLab: an authorization refusal on the HAS-CHILDREN probe stays cli-error, and stays journalable', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      // The `first: 1` existence probe is the ONE hierarchy read whose
      // parser had no error-protocol test at all. A refusal there must
      // reach the caller as `cli-error` — `unsupported` would map to NO D2
      // code and NO journal line (see forgeIssueReason), which is exactly
      // the silent degradation invariant 2 forbids.
      const execFn: ForgeIssuesExecFn = async (_cli, args) => {
        const query = glabQueryOf({ args })
        if (query.includes('parent { iid }')) {
          return { kind: 'ok', stdout: glabParentPayload(null) }
        }
        if (query.includes('first: 1)')) {
          return { kind: 'ok', stdout: GLAB_TOPLEVEL_AUTH_ERROR }
        }
        return { kind: 'ok', stdout: glabIssueRestAnswer(1) }
      }
      const result = await linkChildIssue({ cwd: repo, execFn, parent: 1, child: 2 })
      expect(result).toMatchObject({ available: false, reason: 'cli-error' })
      expect('detail' in result && result.detail).toContain('not authorized')
      expect(!result.available && forgeIssueReason(result)).not.toBeNull()
    })
  })

  test('GitLab: OUR OWN typo in a widget leaf field stays cli-error, never "unsupported" (MAJEUR C)', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      // Same message SHAPE as a genuine gap ("Field 'x' doesn't exist on
      // type 'Y'"), but Y is one of OUR widget types, not Query/Mutation —
      // a blanket read of this shape is exactly what let this module's own
      // earlier bug (`issue.widgets`) hide as "the edition can't do this"
      // forever. This must be surfaced honestly instead.
      const execFn = passGuard(async (_cli, args) =>
        glabQueryOf({ args }).includes('$parentId')
          ? { kind: 'ok', stdout: GLAB_OUR_OWN_TYPO }
          : { kind: 'ok', stdout: glabIssueRestAnswer(1) },
      )
      const result = await linkChildIssue({ cwd: repo, execFn, parent: 1, child: 2 })
      expect(result).toMatchObject({ available: false, reason: 'cli-error' })
      expect('detail' in result && result.detail).toContain('childrn')
    })
  })

  test('GitLab: a missing hierarchy widget TYPE answers "unsupported", not cli-error (MINEUR)', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const execFn = passGuard(async (_cli, args) =>
        glabQueryOf({ args }).includes('$parentId')
          ? { kind: 'ok', stdout: GLAB_MISSING_FRAGMENT_TYPE }
          : { kind: 'ok', stdout: glabIssueRestAnswer(1) },
      )
      const result = await linkChildIssue({ cwd: repo, execFn, parent: 1, child: 2 })
      expect(result).toMatchObject({ available: false, reason: 'unsupported' })
    })
  })

  test('GitLab: a missing WorkItemID input type answers "unsupported", not cli-error (MINEUR)', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const execFn = passGuard(async (_cli, args) =>
        glabQueryOf({ args }).includes('$parentId')
          ? { kind: 'ok', stdout: GLAB_MISSING_INPUT_TYPE }
          : { kind: 'ok', stdout: glabIssueRestAnswer(1) },
      )
      const result = await linkChildIssue({ cwd: repo, execFn, parent: 1, child: 2 })
      expect(result).toMatchObject({ available: false, reason: 'unsupported' })
    })
  })

  test('a business rejection of the mutation stays an honest cli-error, never "unsupported"', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const execFn = passGuard(async (_cli, args) =>
        glabQueryOf({ args }).includes('$parentId')
          ? { kind: 'ok', stdout: GLAB_MUTATION_BUSINESS_ERROR }
          : { kind: 'ok', stdout: glabIssueRestAnswer(1) },
      )
      const result = await linkChildIssue({ cwd: repo, execFn, parent: 1, child: 2 })
      expect(result).toMatchObject({ available: false, reason: 'cli-error' })
      expect('detail' in result && result.detail).toContain("don't have permission")
    })
  })

  test('rien ne prétend que le lien existe: an unsupported link never enters the local cache', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const hierarchy: IssueHierarchyCache = new Map()
      const execFn = passGuard(async (_cli, args) =>
        glabQueryOf({ args }).includes('$parentId')
          ? { kind: 'ok', stdout: GLAB_MUTATION_UNSUPPORTED }
          : { kind: 'ok', stdout: glabIssueRestAnswer(1) },
      )
      const result = await linkChildIssue({ cwd: repo, execFn, parent: 1, child: 2, hierarchy })
      expect(result).toMatchObject({ available: false, reason: 'unsupported' })
      expect(hierarchy.has(2)).toBe(false)
    })
  })
})

describe('hierarchy: one level is enforced against the REAL forge (T2.2, MAJEUR 3)', () => {
  test('auto-reference is refused before any forge call', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok('{}'))
      const result = await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 5, child: 5 })
      expect(result).toMatchObject({ available: false, reason: 'invalid-input' })
      expect(r.calls).toEqual([])
    })
  })

  test('A→B then B→C is refused on a FRESH call with NO shared cache: the guard asks the forge', async () => {
    // The whole point of MAJEUR 3: two SEPARATE processes (no cache in
    // common) must still refuse a real second level, because the second
    // call queries the forge itself rather than trusting its own memory.
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const state = new Map<number, number>()
      const r1 = rig(hierarchyReply(state))
      expect(await linkChildIssue({ cwd: repo, execFn: r1.execFn, parent: 10, child: 20 })).toEqual(
        { available: true },
      )
      // A fresh execFn/rig, no hierarchy option passed: nothing but `state`
      // (standing in for the forge) ties this call to the previous one.
      const r2 = rig(hierarchyReply(state))
      const result = await linkChildIssue({ cwd: repo, execFn: r2.execFn, parent: 20, child: 30 })
      expect(result).toMatchObject({ available: false, reason: 'invalid-input' })
      expect('detail' in result && result.detail).toContain('one level only')
      // The refusal came from the parent-probe read, never from a write.
      expect(r2.calls).toHaveLength(1)
      expect(r2.calls[0]?.args).toEqual(['api', 'repos/{owner}/{repo}/issues/20/parent'])
    })
  })

  test('linking a parent to its own child is refused, discovered from the forge', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const state = new Map([[10, 20]]) // 10 is already a child of 20, on the forge
      const r = rig(hierarchyReply(state))
      const result = await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 10, child: 20 })
      expect(result).toMatchObject({ available: false, reason: 'invalid-input' })
      expect('detail' in result && result.detail).toContain('already a child of 20')
      expect(r.calls).toHaveLength(1)
    })
  })

  test('a parent with real children cannot become someone else’s child either', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const state = new Map([[20, 10]]) // 10 already has a real child, 20
      const r = rig(hierarchyReply(state))
      const result = await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 99, child: 10 })
      expect(result).toMatchObject({ available: false, reason: 'invalid-input' })
      expect('detail' in result && result.detail).toContain('already has children')
      // The parent-probe (99 has none) ran, then the has-children probe (10
      // has some) — two reads, still zero writes.
      expect(r.calls).toHaveLength(2)
    })
  })

  test('a cache HIT skips the forge probe entirely: an accelerator, not the source of truth', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const hierarchy: IssueHierarchyCache = new Map([[20, 10]])
      const r = rig(hierarchyReply(new Map())) // the "forge" itself knows nothing
      const result = await linkChildIssue({
        cwd: repo,
        execFn: r.execFn,
        parent: 20,
        child: 30,
        hierarchy,
      })
      expect(result).toMatchObject({ available: false, reason: 'invalid-input' })
      // Refused purely from the cache: no argv at all, even though the
      // fake forge (if asked) would have said "no parent".
      expect(r.calls).toEqual([])
    })
  })

  test('a cache HIT on the CHILDREN side skips its probe too (mirror of realParentOf)', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      // The cache already maps 20 → 10, so 10 HAS a child by the cache
      // alone. The fake forge deliberately knows nothing: without the
      // cache-hit branch of `realHasChildren`, the probe would answer "no
      // children" and this link would be allowed through.
      const hierarchy: IssueHierarchyCache = new Map([[20, 10]])
      const r = rig(hierarchyReply(new Map()))
      const result = await linkChildIssue({
        cwd: repo,
        execFn: r.execFn,
        parent: 99,
        child: 10,
        hierarchy,
      })
      expect(result).toMatchObject({ available: false, reason: 'invalid-input' })
      expect('detail' in result && result.detail).toContain('already has children')
      // Only the parent-probe on 99 ran: the has-children probe was skipped
      // and no write was attempted.
      expect(r.calls).toHaveLength(1)
      expect(r.calls[0]?.args).toEqual(['api', 'repos/{owner}/{repo}/issues/99/parent'])
    })
  })

  test('the guard MEMOIZES the parent it just read: a later call on the same cache re-probes nothing', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      // On the forge, 20 is already 10's child. The first call discovers
      // that with one probe; the memoization in the guard is what lets the
      // second call refuse without asking again.
      const hierarchy: IssueHierarchyCache = new Map()
      const state = new Map([[20, 10]])
      const r1 = rig(hierarchyReply(state))
      const first = await linkChildIssue({
        cwd: repo,
        execFn: r1.execFn,
        parent: 20,
        child: 30,
        hierarchy,
      })
      expect(first).toMatchObject({ available: false, reason: 'invalid-input' })
      expect(r1.calls).toHaveLength(1)

      const r2 = rig(hierarchyReply(state))
      const second = await linkChildIssue({
        cwd: repo,
        execFn: r2.execFn,
        parent: 20,
        child: 31,
        hierarchy,
      })
      expect(second).toMatchObject({ available: false, reason: 'invalid-input' })
      expect('detail' in second && second.detail).toContain('already a child of 10')
      expect(r2.calls).toEqual([])
    })
  })

  test('a non-Map hierarchy value degrades to a fresh cache rather than throwing', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      // {} has no `.get`: without the `instanceof Map` guard, the very
      // first `hierarchy.get(...)` inside the guard would throw a
      // TypeError — parent !== child here on purpose, so the auto-reference
      // shortcut (which never touches `hierarchy`) cannot mask the bug.
      const poisoned = {} as unknown as IssueHierarchyCache
      const r = rig(hierarchyReply(new Map()))
      await expect(
        linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 5, child: 6, hierarchy: poisoned }),
      ).resolves.toEqual({ available: true })
    })
  })

  test('an id that is zero, negative, or not an integer is refused before any probe', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok('{}'))
      for (const bad of [0, -1, 1.5]) {
        expect(
          await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: bad, child: 1 }),
        ).toMatchObject({
          available: false,
          reason: 'invalid-input',
        })
        expect(
          await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 1, child: bad }),
        ).toMatchObject({ available: false, reason: 'invalid-input' })
      }
      expect(r.calls).toEqual([])
    })
  })
})

describe('hierarchy: a forge read failure during the one-level guard fails CLOSED, never open (T2.2, MAJEUR D)', () => {
  test('the parent-probe itself failing (not a real 404) blocks the write entirely', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig((call) => {
        if (call.cli === 'gh' && call.args.includes(`repos/{owner}/{repo}/issues/1/parent`)) {
          // A genuine failure to read — a timeout, a transient 500 — never
          // GitHub's specific "no parent" 404. Guessing "no parent" here
          // would let a write through with NO idea whether `parent` already
          // has one: the fail-open this MAJEUR is about.
          return { kind: 'error', message: 'timed out after 8s' }
        }
        throw new Error(`unexpected call: ${JSON.stringify(call)}`)
      })
      const result = await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 1, child: 2 })
      expect(result).toMatchObject({ available: false, reason: 'cli-error' })
      // Only the failed probe ran: the has-children probe and the write
      // itself never got a chance to fire.
      expect(r.calls).toHaveLength(1)
    })
  })

  test('the has-children-probe itself failing blocks the write entirely', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig((call) => {
        if (call.cli !== 'gh') {
          throw new Error(`unexpected call: ${JSON.stringify(call)}`)
        }
        if (call.args.includes(`repos/{owner}/{repo}/issues/1/parent`)) {
          return { kind: 'error', message: 'gh: No parent issue found (HTTP 404)' }
        }
        if (call.args.includes(`repos/{owner}/{repo}/issues/2/sub_issues`)) {
          return { kind: 'error', message: 'connection reset' }
        }
        throw new Error(`unexpected call: ${JSON.stringify(call)}`)
      })
      const result = await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 1, child: 2 })
      expect(result).toMatchObject({ available: false, reason: 'cli-error' })
      // The parent-probe ran (found none, honestly), then the has-children
      // probe ran and failed: two reads, and still no write.
      expect(r.calls).toHaveLength(2)
    })
  })
})

describe('hierarchy: GitHub\'s 404 discriminator names the REAL "no parent" answer, nothing else (T2.2, MAJEUR A)', () => {
  test('the exact "No parent issue found" 404 (checked live against api.github.com) reads as no parent, write proceeds', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const state = new Map<number, number>()
      const r = rig(hierarchyReply(state))
      const result = await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 1, child: 2 })
      expect(result).toEqual({ available: true })
    })
  })

  test.each([
    [
      'a locked-issue validation error that happens to mention 404 in a URL',
      'Validation Failed: issue "Fix 404 page on /docs" is locked (HTTP 422)',
    ],
    [
      'a proxy relaying its OWN 404 page as a 502',
      '<html><title>404 Not Found</title></html> (HTTP 502)',
    ],
    [
      'a rate-limit message whose docs link ends in a 404 anchor',
      'API rate limit exceeded. See https://docs.github.com/rest/issues#404 (HTTP 403)',
    ],
    [
      'an old GHES build number that happens to contain 404',
      'unsupported by this GitHub Enterprise Server (build 404) (HTTP 501)',
    ],
    ['a plain "issue not found" 404 — a DIFFERENT 404 than "no parent"', 'Not Found (HTTP 404)'],
    [
      'the exact sentinel phrase but a DIFFERENT status code — not a 404 at all',
      'upstream said No parent issue found (HTTP 500)',
    ],
  ])(
    '%s never reads as "no parent": the write is refused, not attempted',
    async (_label, serverMessage) => {
      await withRepo(GITHUB_REMOTE, async (repo) => {
        const r = rig((call) => {
          if (call.cli === 'gh' && call.args.includes(`repos/{owner}/{repo}/issues/1/parent`)) {
            return { kind: 'error', message: `gh: ${serverMessage}` }
          }
          throw new Error(`unexpected call: ${JSON.stringify(call)}`)
        })
        const result = await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 1, child: 2 })
        expect(result).toMatchObject({ available: false, reason: 'cli-error' })
        expect(r.calls).toHaveLength(1)
      })
    },
  )
})

describe('hierarchy: a write never replays on a resolve-only failure (T2.2, MAJEUR 4)', () => {
  test('linkChildIssue on a self-hosted remote where gh is unreachable end to end settles on glab', async () => {
    // Renamed and re-scoped (round 5, MAJEUR): this used to claim it proved
    // "a failed pre-write resolve still reaches glab" — i.e. that a `blocked`
    // outcome falls through the write ladder. It never did: `pin` (MAJEUR 3)
    // pins `linkChildIssue`'s write to whichever forge the GUARD verified,
    // and here the guard itself never sees gh succeed, so it settles on glab
    // BEFORE any write is attempted — `ghLinkCandidate`'s write-mode resolve,
    // and therefore `blockedOnResolve`, is never even reached. What this
    // test actually exercises is the guard settling on glab end to end (see
    // the "one level is enforced" and "PINNED" describe blocks for that
    // mechanism in isolation). The `blocked`/`error` distinction this title
    // used to claim is proven below, on `unlinkChildIssue`, the one
    // operation with no guard and no pin to intercept it first.
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      const state = new Map<number, number>()
      const r = rig((call) => {
        if (call.cli === 'gh') {
          return { kind: 'error', message: 'could not determine repository' }
        }
        return hierarchyReply(state)(call)
      })
      const result = await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 10, child: 20 })
      expect(result).toEqual({ available: true })
      expect(r.calls.map((c) => c.cli)).toContain('gh')
      expect(r.calls.map((c) => c.cli)).toContain('glab')
    })
  })

  test('unlinkChildIssue: a blocked pre-write resolve on gh still falls through to a healthy glab (T2.2, round 5 MAJEUR)', async () => {
    // `unlinkChildIssue` has no guard and no pin (design.md decision 3: the
    // guard only exists for `linkChildIssue`), so it is the ONLY live
    // consumer of the distinction `blockedOnResolve` draws between a failed
    // pre-write READ (`blocked`, safe to keep walking the ladder even in
    // write mode) and a failed WRITE itself (`error`, ladder stops — may
    // already have landed). Killing ground for three mutants at once:
    //   - blockedOnResolve → identity (no remap): the gh resolve failure
    //     stays `error`, and write-mode's "a write never replays" rule stops
    //     the ladder right there — glab is never tried.
    //   - blockedOnResolve → always `blocked`: harmless on its own here, but
    //     paired with the `continue` below it changes nothing observable
    //     UNLESS the remap is what lets the ladder walk on to glab in the
    //     first place — remove the remap (previous bullet) and this survives
    //     with it; this test's SAME setup catches both because either
    //     mutation, verified in isolation, turns this green test red.
    //   - `attempt`'s `blocked` branch → `break` instead of `continue`: the
    //     ladder stops at gh even though `blocked` is explicitly a "nothing
    //     was written yet" outcome — glab is never tried either.
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      const state = new Map<number, number>([[20, 10]]) // 20 is already a child of 10.
      const r = rig((call) => {
        if (call.cli === 'gh') {
          // The pre-write resolve of the child (`gh api …/issues/20`) fails
          // — nothing was ever written, so this must not be treated as a
          // failed write.
          return { kind: 'error', message: 'could not determine repository' }
        }
        return hierarchyReply(state)(call)
      })
      const result = await unlinkChildIssue({ cwd: repo, execFn: r.execFn, parent: 10, child: 20 })
      expect(result).toEqual({ available: true })
      expect(r.calls.map((c) => c.cli)).toContain('gh')
      expect(r.calls.map((c) => c.cli)).toContain('glab')
    })
  })

  test('unlinkChildIssue: a MISSING gh binary at the pre-write resolve passes through as missing, never as blocked (T2.2, round 5 MAJEUR)', async () => {
    // Companion to the test above, targeting `blockedOnResolve`'s OTHER
    // half of its contract: `missing` (ENOENT) already means "nothing ran"
    // and must pass through UNCHANGED, exactly like `invalid` does — only a
    // genuine `error` gets remapped to `blocked`. On GITHUB_REMOTE, `gh` is
    // the only candidate `unlinkChildIssue` is given (the hint excludes
    // glab), so if the missing binary were wrongly turned into `blocked`
    // here, `attempt` would set a `detail` that was never meant to exist,
    // and the final reason would read `cli-error` instead of the honest
    // `no-cli` — the same distinction a mutant that forces `blockedOnResolve`
    // to ALWAYS answer `blocked` (regardless of input) collapses.
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const { execFn } = rig(missing)
      const result = await unlinkChildIssue({ cwd: repo, execFn, parent: 1, child: 2 })
      expect(result).toEqual({ available: false, reason: 'no-cli' })
    })
  })
})

describe('hierarchy: a write is PINNED to the forge the guard actually verified (T2.2, MAJEUR 3)', () => {
  test('a guard fully answered by gh refuses the write rather than falling through to glab on a blocked resolve', async () => {
    // Reproduces the round-3 finding: on a self-hosted remote, gh answers
    // BOTH guard probes honestly (no parent, no children) — the guard
    // therefore validated GitHub's state, never GitLab's. If gh's pre-write
    // resolve then fails, letting the ladder fall through to glab would
    // write to a forge whose state the guard never checked. The write must
    // refuse instead.
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      const r = rig((call) => {
        if (call.cli !== 'gh') {
          throw new Error(`glab must never be called: ${JSON.stringify(call)}`)
        }
        const path = call.args[1] ?? ''
        if (path.endsWith('/parent')) {
          return { kind: 'error', message: 'gh: No parent issue found (HTTP 404)' }
        }
        if (call.args.includes('--field=per_page=1')) {
          return { kind: 'ok', stdout: '[]' }
        }
        // The pre-write resolve of the child (`GET .../issues/20`).
        return { kind: 'error', message: 'gh: API rate limit exceeded (HTTP 403)' }
      })
      const result = await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 10, child: 20 })
      expect(result).toMatchObject({ available: false, reason: 'cli-error' })
      expect(r.calls.map((c) => c.cli)).toEqual(['gh', 'gh', 'gh'])
    })
  })

  test('a guard fully answered by glab pins the write to glab, even on a self-hosted remote where gh becomes reachable again by write time', async () => {
    // Rewritten (round 5, MINEUR 2): this used to claim "self-hosted remote
    // where gh is also reachable" while actually running on GITLAB_REMOTE —
    // there, `detectForgeHint` already excludes gh from every candidate
    // list on its own (`hint !== 'gitlab'`), so the `pin` guard in
    // `candidatesFor` (`&& pin !== 'glab'`) was never exercised: the test
    // passed for a reason that had nothing to do with the code it named.
    // This version runs on a SELF-HOSTED remote — hint decides nothing — and
    // makes gh fail during BOTH guard reads (so the guard settles on glab,
    // pin = 'glab') but SUCCEED again by write time: only the `pin !==
    // 'glab'` clause in `candidatesFor` stops the write ladder from trying
    // gh first, since hint alone no longer excludes it here.
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      const state = new Map<number, number>()
      let ghCalls = 0
      const r = rig((call) => {
        if (call.cli === 'gh') {
          ghCalls += 1
          if (ghCalls <= 2) {
            // Both guard probes (parent-of-parent, has-children): gh is down.
            return { kind: 'error', message: 'could not determine repository' }
          }
          // gh is reachable again by write time — a leaked pin would let it
          // happily answer the write it must never be asked to attempt.
          return hierarchyReply(state)(call)
        }
        return hierarchyReply(state)(call)
      })
      const result = await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 10, child: 20 })
      expect(result).toEqual({ available: true })
      // Exactly the two guard-probe calls: the write itself never asks gh.
      expect(ghCalls).toBe(2)
      expect(r.calls.some((c) => c.cli === 'glab')).toBe(true)
    })
  })
})

describe('hierarchy: a guard split across two forges pins nothing usable (T2.2, MINEUR 1 round 5)', () => {
  test('parent state read from gh and children state read from glab refuses locally, before any write is attempted', async () => {
    // M04: forcing the `answeredBy` mismatch check to `false` in
    // `guardOneLevel` survives with no test rougissant it. Reproduced here:
    // on a self-hosted remote, gh answers the parent-of-parent probe
    // honestly (no parent) but then goes down for the has-children probe,
    // which therefore falls through to glab. The guard verified TWO
    // DIFFERENT forges' state, never one forge's state as a whole — pinning
    // a write to either would write to a forge whose relevant half was
    // never actually checked. The correct answer is a local refusal, with
    // zero write attempted.
    await withRepo(SELF_HOSTED_REMOTE, async (repo) => {
      const r = rig((call) => {
        if (call.cli === 'gh') {
          const path = call.args[1] ?? ''
          if (path.endsWith('/parent')) {
            return { kind: 'error', message: 'gh: No parent issue found (HTTP 404)' }
          }
          if (call.args.includes('--field=per_page=1')) {
            return { kind: 'error', message: 'gh: internal server error (HTTP 500)' }
          }
          // Only reached if the guard incorrectly proceeds to a pinned gh
          // write (the mutant's behavior): the pre-write resolve fails too,
          // so the observable reason still differs from the pristine one.
          return { kind: 'error', message: 'gh: internal server error (HTTP 500)' }
        }
        const query = glabQueryOf(call)
        if (query === '') {
          return { kind: 'ok', stdout: glabIssueRestAnswer(2) }
        }
        if (query.includes('first: 1)')) {
          return { kind: 'ok', stdout: glabHasChildrenPayload(false) }
        }
        throw new Error(`unexpected glab call: ${JSON.stringify(call)}`)
      })
      const result = await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 1, child: 2 })
      expect(result).toMatchObject({ available: false, reason: 'invalid-input' })
      expect('detail' in result && result.detail).toContain(
        'cannot pin the write to a single forge',
      )
      // 1 gh parent-probe + 1 gh has-children-probe (fails) + glab resolve +
      // glab has-children query = 4 reads, and NOT ONE write attempt.
      expect(r.calls).toHaveLength(4)
    })
  })
})

describe('hierarchy: the local cache is actually maintained (T2.2, MAJEUR 5)', () => {
  test('a successful link WRITES child → parent into the cache', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const hierarchy: IssueHierarchyCache = new Map()
      const r = rig(hierarchyReply(new Map()))
      await linkChildIssue({ cwd: repo, execFn: r.execFn, parent: 10, child: 20, hierarchy })
      expect(hierarchy.get(20)).toBe(10)
    })
  })

  test('a successful unlink EVICTS the entry from the cache', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const hierarchy: IssueHierarchyCache = new Map([[20, 10]])
      const r = rig(hierarchyReply(new Map([[20, 10]])))
      await unlinkChildIssue({ cwd: repo, execFn: r.execFn, parent: 10, child: 20, hierarchy })
      expect(hierarchy.has(20)).toBe(false)
    })
  })

  test('unlink does NOT evict a cache entry belonging to a DIFFERENT parent', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      // The cache thinks 20's parent is 99 (stale or simply wrong); this
      // call unlinks it from 10. The forge write still runs (and would
      // detach whatever 20's REAL parent on the forge is — a documented
      // GitLab-side asymmetry), but the cache entry for 20→99 is not this
      // call's fact to erase.
      const hierarchy: IssueHierarchyCache = new Map([[20, 99]])
      const r = rig(hierarchyReply(new Map([[20, 10]])))
      await unlinkChildIssue({ cwd: repo, execFn: r.execFn, parent: 10, child: 20, hierarchy })
      expect(hierarchy.get(20)).toBe(99)
    })
  })

  test('a successful listChildIssues SEEDS the cache for each returned child', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const hierarchy: IssueHierarchyCache = new Map()
      const r = rig(hierarchyReply(new Map([[20, 10]])))
      await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10, hierarchy })
      expect(hierarchy.get(20)).toBe(10)
    })
  })

  test('a successful listChildIssues PURGES a stale entry no longer returned by the forge', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      // The cache still believes 20 is a child of 10; the forge (now)
      // disagrees — 10 has no children at all.
      const hierarchy: IssueHierarchyCache = new Map([[20, 10]])
      const r = rig(hierarchyReply(new Map()))
      await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10, hierarchy })
      expect(hierarchy.has(20)).toBe(false)
    })
  })
})

describe('hierarchy: pagination is real, and honest about its cap (T2.2)', () => {
  test('GitLab walks the cursor across pages and caps at ISSUE_LIST_MAX, truncated true', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig((call) => {
        if (call.cli === 'glab' && glabQueryOf(call).includes('WorkItemWidgetHierarchy')) {
          const after = call.args
            .find((a) => a.startsWith('--field=after='))
            ?.split('=')
            .pop()
          const page = after === undefined ? 1 : Number(after.replace('cursor', '')) + 1
          const from = (page - 1) * 100 + 1
          return {
            kind: 'ok',
            stdout: glabChildrenPayload(
              Array.from({ length: 100 }, (_, i) => from + i),
              true,
              `cursor${page}`,
            ),
          }
        }
        return { kind: 'ok', stdout: glabIssueRestAnswer(10) }
      })
      const result = await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10 })
      expect(result).toMatchObject({ available: true, truncated: true })
      expect(result.available && result.issues).toHaveLength(ISSUE_LIST_MAX)
      // 3 pages of 100 is the first count that proves more than 200 exist —
      // same budget the REST paths in this file already use.
      expect(
        r.calls.filter((c) => c.cli === 'glab' && glabQueryOf(c).includes('Hierarchy')).length,
      ).toBe(3)
    })
  })

  test('GitLab: hasNextPage false ends the walk without a wasted extra page', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig((call) =>
        call.cli === 'glab' && glabQueryOf(call).includes('WorkItemWidgetHierarchy')
          ? { kind: 'ok', stdout: glabChildrenPayload([20], false, null) }
          : { kind: 'ok', stdout: glabIssueRestAnswer(10) },
      )
      const result = await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10 })
      expect(result).toMatchObject({ available: true, truncated: false })
      expect(
        r.calls.filter((c) => c.cli === 'glab' && glabQueryOf(c).includes('Hierarchy')).length,
      ).toBe(1)
    })
  })

  test('GitHub: sub-issues answer in a single call, never paginated', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(hierarchyReply(new Map(Array.from({ length: 42 }, (_, i) => [i + 1, 10]))))
      const result = await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10 })
      expect(result.available && result.issues).toHaveLength(42)
      expect(r.calls).toHaveLength(1)
      expect(r.calls[0]?.args).toEqual([
        'api',
        'repos/{owner}/{repo}/issues/10/sub_issues',
        '--method',
        'GET',
        '--field=per_page=100',
      ])
    })
  })

  test('GitHub: a page short of 100 proves the list complete, truncated false (MAJEUR E)', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(hierarchyReply(new Map(Array.from({ length: 99 }, (_, i) => [i + 1, 10]))))
      const result = await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10 })
      expect(result).toMatchObject({ available: true, truncated: false })
    })
  })

  test('GitHub: a FULL page of exactly 100 does NOT prove completeness, truncated true (MAJEUR E)', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      // GitHub's "up to 100 sub-issues per parent" is documented as a
      // PRODUCT limit, not a pagination guarantee this endpoint enforces —
      // a full page must not be silently read as "that's everything", the
      // same silent-truncation shape `capPage` exists to catch elsewhere.
      const r = rig(hierarchyReply(new Map(Array.from({ length: 100 }, (_, i) => [i + 1, 10]))))
      const result = await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10 })
      expect(result).toMatchObject({ available: true, truncated: true })
      expect(result.available && result.issues).toHaveLength(100)
      expect(r.calls).toHaveLength(1)
    })
  })

  test('GitLab: loop-exhaustion exit (empty page 3, hasNextPage true) is still truncated true (MAJEUR 1)', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      // Pages 1 and 2 render exactly 100 nodes each — the cursor keeps
      // advancing because `all.length > ISSUE_LIST_MAX` (200) is false at
      // exactly 200. Page 3 renders ZERO nodes with hasNextPage:true, which
      // is what a permission-filtered tail slice normally looks like: the
      // loop reaches GLAB_CHILDREN_MAX_PAGES and falls through to the
      // post-loop return WITHOUT ever hitting the `!hasNextPage` or
      // `endCursor === null` early returns. Deriving `truncated` from length
      // alone there would silently report 200 children as complete even
      // though the forge just said there are more.
      let call = 0
      const r = rig((c) => {
        if (c.cli === 'glab' && glabQueryOf(c).includes('WorkItemWidgetHierarchy')) {
          call += 1
          if (call <= 2) {
            const from = (call - 1) * 100 + 1
            return {
              kind: 'ok',
              stdout: glabChildrenPayload(
                Array.from({ length: 100 }, (_, i) => from + i),
                true,
                `cursor${call}`,
              ),
            }
          }
          return { kind: 'ok', stdout: glabChildrenPayload([], true, 'cursor3') }
        }
        return { kind: 'ok', stdout: glabIssueRestAnswer(10) }
      })
      const result = await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10 })
      expect(result).toMatchObject({ available: true, truncated: true })
      expect(result.available && result.issues).toHaveLength(200)
      expect(
        r.calls.filter((c) => c.cli === 'glab' && glabQueryOf(c).includes('Hierarchy')).length,
      ).toBe(3)
    })
  })

  test('GitLab: hasNextPage true with NO cursor forces truncated true rather than a length check (MAJEUR B)', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      // The forge explicitly says "there is more" (`hasNextPage: true`) but
      // hands back no cursor to reach it — a single short page (1 child)
      // would pass a length-only check as "complete", which is exactly the
      // silent truncation this module's own comment on `glabChildrenCandidate`
      // invokes to justify walking a cursor in the first place.
      const r = rig((call) =>
        call.cli === 'glab' && glabQueryOf(call).includes('WorkItemWidgetHierarchy')
          ? { kind: 'ok', stdout: glabChildrenPayload([20], true, null) }
          : { kind: 'ok', stdout: glabIssueRestAnswer(10) },
      )
      const result = await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10 })
      expect(result).toMatchObject({ available: true, truncated: true })
      expect(result.available && result.issues).toHaveLength(1)
      // Nothing further COULD be walked to (no cursor): still a single call.
      expect(
        r.calls.filter((c) => c.cli === 'glab' && glabQueryOf(c).includes('Hierarchy')).length,
      ).toBe(1)
    })
  })
})

describe('hierarchy: listChildIssues rejects the whole array on a shape mismatch (T2.2)', () => {
  test('GitHub sub_issues: a truncated payload or one bad field rejects everything', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const good = JSON.stringify([ghRestIssue(20)])
      const truncated = good.slice(0, 30)
      const oneBad = JSON.stringify([ghRestIssue(20), { ...ghRestIssue(21), number: '21' }])
      for (const payload of [truncated, oneBad]) {
        const r = rig((call) =>
          call.args[1] === 'repos/{owner}/{repo}/issues/10/sub_issues'
            ? { kind: 'ok', stdout: payload }
            : { kind: 'ok', stdout: '{}' },
        )
        const result = await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10 })
        expect(result).toMatchObject({ available: false, reason: 'cli-error' })
        expect(result).not.toHaveProperty('issues')
      }
    })
  })

  test('GitLab hierarchy widget: a truncated payload or one bad field rejects everything', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const good = glabChildrenPayload([20])
      const truncated = good.slice(0, 40)
      const oneBad = JSON.stringify({
        data: {
          workItem: {
            widgets: [
              {
                children: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [glabWorkItemChild(20), { ...glabWorkItemChild(21), iid: '21' }],
                },
              },
            ],
          },
        },
      })
      for (const payload of [truncated, oneBad]) {
        const r = rig((call) =>
          call.args.includes('graphql')
            ? { kind: 'ok', stdout: payload }
            : { kind: 'ok', stdout: glabIssueRestAnswer(10) },
        )
        const result = await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10 })
        expect(result).toMatchObject({ available: false, reason: 'cli-error' })
        expect(result).not.toHaveProperty('issues')
      }
    })
  })

  test('a hierarchy widget absent from the answer reads as no children, not a refusal', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const noWidget = JSON.stringify({ data: { workItem: { widgets: [] } } })
      const r = rig((call) =>
        call.args.includes('graphql')
          ? { kind: 'ok', stdout: noWidget }
          : { kind: 'ok', stdout: glabIssueRestAnswer(10) },
      )
      const result = await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10 })
      expect(result).toMatchObject({ available: true, issues: [], truncated: false })
    })
  })

  test('the hierarchy widget is found by its KEY, not its position in the widgets array', async () => {
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const reordered = JSON.stringify({
        data: {
          workItem: {
            widgets: [
              { irrelevant: true },
              {
                children: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [glabWorkItemChild(20)],
                },
              },
            ],
          },
        },
      })
      const r = rig((call) =>
        call.args.includes('graphql')
          ? { kind: 'ok', stdout: reordered }
          : { kind: 'ok', stdout: glabIssueRestAnswer(10) },
      )
      const result = await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10 })
      expect(result.available && result.issues.map((i) => i.number)).toEqual([20])
    })
  })

  test('valid payloads still parse field by field: gh and glab shapes both come through', async () => {
    await withRepo(GITHUB_REMOTE, async (repo) => {
      const r = rig(ok(JSON.stringify([ghRestIssue(20)])))
      const result = await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10 })
      expect(result).toMatchObject({
        available: true,
        truncated: false,
        issues: [
          {
            number: 20,
            title: 'Add sidebar',
            author: 'octocat',
            labels: [{ name: 'bug', color: 'd73a4a' }],
            url: 'https://github.com/acme/repo/issues/20',
          },
        ],
      })
    })
    await withRepo(GITLAB_REMOTE, async (repo) => {
      const r = rig((call) =>
        call.args.includes('graphql')
          ? { kind: 'ok', stdout: glabChildrenPayload([20]) }
          : { kind: 'ok', stdout: glabIssueRestAnswer(10) },
      )
      const result = await listChildIssues({ cwd: repo, execFn: r.execFn, parent: 10 })
      expect(result).toMatchObject({
        available: true,
        truncated: false,
        issues: [
          {
            number: 20,
            title: 'Fix login',
            author: 'jdoe',
            labels: [{ name: 'bug', color: null }],
            // origin (from the RESOLVED parent's web_url) + webPath.
            url: `${GLAB_ORIGIN}/acme/repo/-/issues/20`,
          },
        ],
      })
    })
  })
})

describe('hierarchy mutation constants (T2.2, MINEUR 3 round 5)', () => {
  // The read-side counterparts (GLAB_HIERARCHY_CHILDREN_QUERY etc.) are
  // locked in forge-issues-parse.test.ts's "hierarchy query constants". The
  // two WRITE constants lived unexported and unlocked until round 5: a typo
  // here (`hierarchywidget`) reads to `looksLikeSchemaGap` exactly like a
  // real schema gap, so our own bug would present GitLab as unable to link —
  // silently, since `unsupported` maps to no journaled D2 code at all.
  test('the set-parent mutation spells workItemUpdate and hierarchyWidget correctly', () => {
    expect(GLAB_HIERARCHY_SET_PARENT).toContain('hierarchyWidget: {parentId: $parentId}')
    // The ENTRY POINT name is the other half of `looksLikeSchemaGap`'s
    // premise ("both always spelled correctly here"): its recognition list
    // is compared lowercased, so `workitemUpdate` would be indistinguishable
    // from an edition that genuinely has no such mutation.
    expect(GLAB_HIERARCHY_SET_PARENT).toContain('workItemUpdate(input:')
  })

  test('the clear-parent mutation spells workItemUpdate and hierarchyWidget correctly', () => {
    expect(GLAB_HIERARCHY_CLEAR_PARENT).toContain('hierarchyWidget: {parentId: null}')
    expect(GLAB_HIERARCHY_CLEAR_PARENT).toContain('workItemUpdate(input:')
  })
})
