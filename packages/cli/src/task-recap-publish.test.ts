import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { RecapRecord, SecretMatch, TaskEvent, TaskRecord } from './contract.js'
import type { ForgeCliOutcome, ForgeIssueComment, ForgeWriteResult } from './forge-issues.js'
import { subprocessEnv } from './git.js'
import {
  buildRecapComment,
  hasRecapMarker,
  publishTaskRecap,
  RECAP_MARKER_PREFIX,
  recapMarker,
  recapScanPayload,
  recapSecretsMessage,
  scanRecapSecrets,
  type PublishRecapOptions,
} from './task-recap-publish.js'
import { renderRecapMarkdown, writeTaskRecap } from './task-recap.js'
import { appendTaskEvent, readTaskEvents } from './tasks-store.js'

// --- rig ---------------------------------------------------------------------

const cleanups: string[] = []

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codesema-recap-publish-'))
  cleanups.push(dir)
  return dir
}

const TASK_ID = 'abcdef123456'
/** A SECOND task bound to the same ticket: the marker is per task, not per issue. */
const OTHER_TASK_ID = '0123456789ab'

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString()
  return {
    version: 1,
    id: TASK_ID,
    title: 'Fix the login flow',
    status: 'shipped',
    base: 'origin/main',
    branch: 'codesema/task-fix-the-login-flow',
    worktree: '/nowhere/worktree',
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: false,
    work_on: false,
    isolation: 'policy',
    created_at: now,
    updated_at: now,
    issue: {
      forge: 'github',
      project: 'acme/repo',
      iid: 42,
      url: 'https://github.com/acme/repo/issues/42',
    },
    ...overrides,
  }
}

function makeRecap(overrides: Partial<RecapRecord> = {}): RecapRecord {
  return {
    version: 1,
    summary: 'Rewired the login flow.',
    changes: ['auth: single entry point'],
    decisions: [],
    files: ['src/auth.ts'],
    tests: [{ command: 'bun test', status: 'passed' }],
    branch: 'codesema/task-fix-the-login-flow',
    ...overrides,
  }
}

type ForgeCall = { op: 'list' | 'comment' | 'close'; number: number; body?: string }

/**
 * Records WHICH forge operation was asked for and in what ORDER — the ordering
 * assertion of the closing path lives on this list. Every operation answers
 * available unless told otherwise; nothing here runs a binary.
 */
function forge(
  opts: {
    comments?: ForgeIssueComment[]
    truncated?: boolean
    listFails?: boolean
    commentFails?: boolean
    closeFails?: boolean
  } = {},
) {
  const calls: ForgeCall[] = []
  const unavailable = { available: false, reason: 'cli-error', detail: 'gh: HTTP 500' } as const
  return {
    calls,
    listIssueCommentsFn: (o: { number: number }) => {
      calls.push({ op: 'list', number: o.number })
      return Promise.resolve(
        opts.listFails
          ? unavailable
          : {
              available: true as const,
              comments: opts.comments ?? [],
              truncated: opts.truncated ?? false,
            },
      )
    },
    commentIssueFn: (o: { number: number; body: string }): Promise<ForgeWriteResult> => {
      calls.push({ op: 'comment', number: o.number, body: o.body })
      return Promise.resolve(opts.commentFails ? unavailable : { available: true })
    },
    closeIssueFn: (o: { number: number }): Promise<ForgeWriteResult> => {
      calls.push({ op: 'close', number: o.number })
      return Promise.resolve(opts.closeFails ? unavailable : { available: true })
    },
  }
}

function comment(body: string): ForgeIssueComment {
  return { body, author: 'octocat', createdAt: '2026-08-01T09:00:00Z', system: false }
}

function publish(
  cwd: string,
  extra: Partial<PublishRecapOptions> & Pick<PublishRecapOptions, 'merged'>,
  task = makeTask(),
) {
  return publishTaskRecap({ cwd, task, ...extra } as PublishRecapOptions)
}

/** `data.name` of every journal line the publication wrote, in order. */
function names(events: TaskEvent[]): unknown[] {
  return events.map((event) => event.data.name)
}

// --- the marker ---------------------------------------------------------------

describe('the provenance marker', () => {
  test('is an HTML comment carrying the task id, so it is invisible once rendered', () => {
    expect(recapMarker(TASK_ID)).toBe(`<!-- ${RECAP_MARKER_PREFIX}${TASK_ID} -->`)
    expect(recapMarker(TASK_ID).startsWith('<!--')).toBe(true)
  })

  test('is the FIRST line of the body, so a truncated tail can never remove it', () => {
    const body = buildRecapComment(makeRecap(), TASK_ID)
    expect(body.split('\n')[0]).toBe(recapMarker(TASK_ID))
  })

  test('recognises its own comment and nothing else', () => {
    expect(hasRecapMarker(buildRecapComment(makeRecap(), TASK_ID), TASK_ID)).toBe(true)
    // Another task's recap on the same ticket is not this task's.
    expect(hasRecapMarker(buildRecapComment(makeRecap(), OTHER_TASK_ID), TASK_ID)).toBe(false)
    expect(hasRecapMarker('LGTM, shipping it', TASK_ID)).toBe(false)
  })

  // The one that made the old `body.includes()` a defect with an IRREVERSIBLE
  // consequence on the forge, and the reason this whole describe exists.
  describe('a marker is only ever recognised where THIS module writes it', () => {
    test('a marker the model merely quoted inside a recap is not a published recap', () => {
      // `renderRecapMarkdown` escapes the LINE-OPENING character of model
      // prose and nothing else, so the marker of ANOTHER task rides through
      // verbatim, one blockquote deep, inside task A's own comment.
      const poisoned = buildRecapComment(
        makeRecap({ summary: `see ${recapMarker(OTHER_TASK_ID)} for context` }),
        TASK_ID,
      )
      expect(poisoned).toContain(recapMarker(OTHER_TASK_ID))
      // A's own marker is on line 1 and still recognised; B's is prose.
      expect(hasRecapMarker(poisoned, TASK_ID)).toBe(true)
      expect(hasRecapMarker(poisoned, OTHER_TASK_ID)).toBe(false)
    })

    test('nor is one quoted, fenced, or dropped mid-sentence by anybody else', () => {
      const marker = recapMarker(TASK_ID)
      for (const body of [
        `## Notes\n\n${marker}`,
        `> ${marker}`,
        `\`\`\`\n${marker}\n\`\`\``,
        `please read ${marker} first`,
        `${marker} and then some`,
      ]) {
        expect(hasRecapMarker(body, TASK_ID)).toBe(false)
      }
    })

    test('what a body WE produced can pick up on the way is still recognised', () => {
      const marker = recapMarker(TASK_ID)
      for (const body of [
        buildRecapComment(makeRecap(), TASK_ID),
        // CRLF and a lone CR are both CommonMark line terminators.
        `${marker}\r\n\r\n## Summary`,
        `${marker}\r\r## Summary`,
        // Leading blank lines and whitespace around the marker line.
        `\n\n${marker}\n\n## Summary`,
        `  ${marker}  \n\n## Summary`,
        // The marker alone is a body too: the whole comment is one line.
        marker,
      ]) {
        expect(hasRecapMarker(body, TASK_ID)).toBe(true)
      }
    })
  })

  test('the recap markdown itself is carried verbatim, with nothing reformatted', () => {
    const recap = makeRecap()
    const body = buildRecapComment(recap, TASK_ID)
    expect(body).toContain('## Summary')
    expect(body).toContain('> Rewired the login flow.')
    expect(body).toContain('## Files (1)')
    expect(body.endsWith('**Branch:** `codesema/task-fix-the-login-flow`')).toBe(true)
  })
})

// --- the secret gate ----------------------------------------------------------

describe('the secret scan over a rendered recap', () => {
  test('sees a secret on an ordinary markdown line, which a raw diff scan would skip', () => {
    // No leading '+' or '-': in a real diff this line is context, and
    // detectDiffSecrets ignores context lines entirely.
    const markdown = 'The key is AKIAIOSFODNN7EXAMPLE, sorry.'
    expect(scanRecapSecrets(markdown)).toEqual([
      { file: 'recap.md', reason: 'content', detail: 'an AWS access key id' },
    ])
  })

  test('sees one on a line that would otherwise read as a diff marker', () => {
    expect(scanRecapSecrets('++ AKIAIOSFODNN7EXAMPLE')).toHaveLength(1)
    expect(scanRecapSecrets('+++ AKIAIOSFODNN7EXAMPLE')).toHaveLength(1)
    expect(scanRecapSecrets('--- AKIAIOSFODNN7EXAMPLE')).toHaveLength(1)
  })

  test('a recap line that looks like a diff header cannot open a pseudo-file', () => {
    expect(scanRecapSecrets('diff --git a/.env b/.env')).toEqual([])
  })

  test('an ordinary recap matches nothing', () => {
    expect(scanRecapSecrets(buildRecapComment(makeRecap(), TASK_ID))).toEqual([])
  })

  test('the payload keeps every line of the document, one per scanned line', () => {
    const payload = recapScanPayload('a\nb\nc')
    expect(payload.split('\n')).toHaveLength(4)
    expect(payload.split('\n').slice(1)).toEqual(['+a', '+b', '+c'])
  })
})

// --- the scan covers the WHOLE document, field by field -----------------------
//
// MAJEUR 1. Every secret fixture in this ticket used to plant its secret in
// `summary`, on both surfaces — so the one thing the ticket promises ("nothing
// derived from the recap reaches a forge unscanned") was proven for ONE of the
// seven fields `renderRecapMarkdown` puts on the page. The other six were
// covered by the code and by nothing that would notice if they stopped being.
// `tests[].command` is the sharpest of them: it can be filled straight from
// `.codesema/config.json`'s `checks.commands[]`, a repo-declared string this
// contract does not otherwise bound.
//
// The record is built so the secret lives in THAT field and NOWHERE else, and
// the base record is asserted clean, so a block can only ever be the field's
// doing.

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'

const RENDERED_FIELDS: readonly { field: string; overrides: Partial<RecapRecord> }[] = [
  { field: 'summary', overrides: { summary: `the key is ${AWS_KEY}` } },
  { field: 'changes[]', overrides: { changes: [`auth: rotate ${AWS_KEY}`] } },
  { field: 'decisions[]', overrides: { decisions: [`kept ${AWS_KEY} out of the env file`] } },
  { field: 'files[]', overrides: { files: [`src/${AWS_KEY}.ts`] } },
  {
    field: 'tests[].command',
    overrides: { tests: [{ command: `AWS_ACCESS_KEY_ID=${AWS_KEY} bun test`, status: 'passed' }] },
  },
  { field: 'branch', overrides: { branch: `codesema/task-${AWS_KEY}` } },
  { field: 'mr_url', overrides: { mr_url: `https://forge.example/mr/${AWS_KEY}` } },
]

describe('every field the recap RENDERS is scanned, not only its summary', () => {
  test('the base record this suite mutates carries no secret of its own', () => {
    expect(scanRecapSecrets(renderRecapMarkdown(makeRecap()))).toEqual([])
  })

  for (const { field, overrides } of RENDERED_FIELDS) {
    test(`a secret in ${field} is seen in the rendering`, () => {
      const rendered = renderRecapMarkdown(makeRecap(overrides))
      expect(rendered).toContain(AWS_KEY)
      expect(scanRecapSecrets(rendered)).toEqual([
        { file: 'recap.md', reason: 'content', detail: 'an AWS access key id' },
      ])
    })

    test(`a secret in ${field} holds the publication back before any forge call`, async () => {
      const cwd = makeDir()
      writeTaskRecap(cwd, TASK_ID, makeRecap(overrides))
      const f = forge()
      const result = await publish(cwd, { merged: true, ...f })
      expect(f.calls).toEqual([])
      expect(result).toMatchObject({ comment: 'blocked_secrets', close: 'skipped' })
      expect(result.note).toContain('an AWS access key id')
      expect(names(result.events)).toEqual(['recap_blocked_secrets'])
    })
  }
})

// --- what a blocked message actually says -------------------------------------

const match = (detail: string): SecretMatch => ({ file: 'recap.md', reason: 'content', detail })

describe('recapSecretsMessage', () => {
  const DETAILS = [
    'a private key',
    'an AWS access key id',
    'a GitHub token',
    'a Slack token',
    'a Google API key',
  ]

  // Sized against a LITERAL 3, never against the constant it is checking: a
  // test that counts what it was given cannot tell a bound of 3 from a bound
  // of 30 (both quote all five of the matches below at one of the two).
  test('quotes three matches and no more, whatever the bound is set to', () => {
    const message = recapSecretsMessage(DETAILS.map(match))
    for (const detail of DETAILS.slice(0, 3)) {
      expect(message).toContain(detail)
    }
    expect(message).not.toContain('a Slack token')
    expect(message).not.toContain('a Google API key')
    // A dump is what the bound exists to avoid; the file is named on each.
    expect(message.split('recap.md:')).toHaveLength(4)
  })

  test('the ones it did not quote are COUNTED, never dropped in silence', () => {
    expect(recapSecretsMessage(DETAILS.map(match))).toContain(', and 2 more')
    expect(recapSecretsMessage(DETAILS.slice(0, 4).map(match))).toContain(', and 1 more')
  })

  test('at or under the bound there is no queue to announce', () => {
    for (const n of [1, 2, 3]) {
      const message = recapSecretsMessage(DETAILS.slice(0, n).map(match))
      // Not merely "no ', and 0 more'": no queue clause at all, and none with
      // a negative count either — both are what an off-by-one produces here.
      expect(message).not.toMatch(/, and -?\d+ more/)
    }
  })

  test('it names WHAT and WHERE, and never the secret itself', () => {
    const message = recapSecretsMessage([match('an AWS access key id')])
    expect(message).toContain('recap.md: an AWS access key id')
    expect(message).toContain('nothing was sent to the forge')
    expect(message).toContain('.codesema')
  })

  test('a real recap carrying four distinct secrets announces the queue too', async () => {
    const cwd = makeDir()
    writeTaskRecap(
      cwd,
      TASK_ID,
      makeRecap({
        summary: 'the key is AKIAIOSFODNN7EXAMPLE',
        changes: ['token ghp_0123456789abcdefghijklmnopqrstuvwxyz'],
        decisions: ['slack xoxb-0123456789-abcdefghij'],
        files: ['src/a.ts'],
        tests: [{ command: 'echo -----BEGIN PRIVATE KEY----- | bun test', status: 'passed' }],
      }),
    )
    const f = forge()
    const result = await publish(cwd, { merged: true, ...f })
    expect(result.comment).toBe('blocked_secrets')
    expect(result.note).toContain(', and 1 more')
  })
})

// --- publication --------------------------------------------------------------

describe('publishTaskRecap', () => {
  test('first publication: reads the comments, finds no marker, posts exactly one comment', async () => {
    const cwd = makeDir()
    writeTaskRecap(cwd, TASK_ID, makeRecap())
    const f = forge({ comments: [comment('unrelated chatter')] })
    const result = await publish(cwd, { merged: false, ...f })
    expect(result).toMatchObject({ comment: 'posted', close: 'not_merged', note: null })
    expect(f.calls.map((c) => c.op)).toEqual(['list', 'comment'])
    expect(f.calls[1]?.number).toBe(42)
    expect(f.calls[1]?.body).toContain(recapMarker(TASK_ID))
    expect(f.calls[1]?.body).toContain('## Summary')
    expect(names(result.events)).toEqual(['recap_posted'])
  })

  test('merged: the comment lands FIRST and the closure second', async () => {
    const cwd = makeDir()
    writeTaskRecap(cwd, TASK_ID, makeRecap())
    const f = forge()
    const result = await publish(cwd, { merged: true, ...f })
    expect(f.calls.map((c) => c.op)).toEqual(['list', 'comment', 'close'])
    expect(result).toMatchObject({ comment: 'posted', close: 'closed' })
    expect(names(result.events)).toEqual(['recap_posted', 'closed'])
  })

  test('not merged: the issue is never closed', async () => {
    const cwd = makeDir()
    writeTaskRecap(cwd, TASK_ID, makeRecap())
    const f = forge()
    const result = await publish(cwd, { merged: false, ...f })
    expect(f.calls.some((c) => c.op === 'close')).toBe(false)
    expect(result.close).toBe('not_merged')
  })

  test('replayed with the marker already there: no second write, and no edit either', async () => {
    const cwd = makeDir()
    const recap = makeRecap()
    writeTaskRecap(cwd, TASK_ID, recap)
    const existing = buildRecapComment(recap, TASK_ID)
    const f = forge({ comments: [comment('chatter'), comment(existing)] })
    const result = await publish(cwd, { merged: false, ...f })
    expect(f.calls.map((c) => c.op)).toEqual(['list'])
    expect(result).toMatchObject({ comment: 'already_posted', close: 'not_merged' })
    expect(names(result.events)).toEqual(['recap_already_posted'])
  })

  test('replayed after the merge: still no second comment, but the issue does get closed', async () => {
    const cwd = makeDir()
    const recap = makeRecap()
    writeTaskRecap(cwd, TASK_ID, recap)
    const f = forge({ comments: [comment(buildRecapComment(recap, TASK_ID))] })
    const result = await publish(cwd, { merged: true, ...f })
    expect(f.calls.map((c) => c.op)).toEqual(['list', 'close'])
    expect(result).toMatchObject({ comment: 'already_posted', close: 'closed' })
  })

  test('a task with no issue publishes nothing, says nothing, and reports no failure', async () => {
    const cwd = makeDir()
    writeTaskRecap(cwd, TASK_ID, makeRecap())
    const f = forge()
    const task = makeTask()
    delete task.issue
    const result = await publish(cwd, { merged: true, ...f }, task)
    expect(f.calls).toEqual([])
    expect(result).toEqual({
      comment: 'no_issue',
      close: 'skipped',
      note: null,
      reason: null,
      events: [],
    })
    expect(readTaskEvents(cwd, TASK_ID)).toEqual([])
  })

  test('no recap on disk: nothing is posted, and the journal says why', async () => {
    const cwd = makeDir()
    const f = forge()
    const result = await publish(cwd, { merged: true, ...f })
    expect(f.calls).toEqual([])
    expect(result).toMatchObject({ comment: 'no_recap', close: 'skipped', reason: null })
    expect(result.note).toContain('no recap on disk')
    expect(names(result.events)).toEqual(['recap_missing'])
  })

  test('a secret in the recap blocks the send BEFORE any forge call, and recap.json survives', async () => {
    const cwd = makeDir()
    writeTaskRecap(cwd, TASK_ID, makeRecap({ summary: 'token AKIAIOSFODNN7EXAMPLE leaked' }))
    const before = readFileSync(join(cwd, '.codesema', 'tasks', TASK_ID, 'recap.json'), 'utf8')
    const f = forge()
    const result = await publish(cwd, { merged: true, ...f })
    expect(f.calls).toEqual([])
    expect(result).toMatchObject({ comment: 'blocked_secrets', close: 'skipped' })
    expect(result.note).toContain('an AWS access key id')
    expect(names(result.events)).toEqual(['recap_blocked_secrets'])
    expect(readFileSync(join(cwd, '.codesema', 'tasks', TASK_ID, 'recap.json'), 'utf8')).toBe(
      before,
    )
  })

  test('the comments cannot be read: forge_unreachable, nothing written, task not failed', async () => {
    const cwd = makeDir()
    writeTaskRecap(cwd, TASK_ID, makeRecap())
    const before = readFileSync(join(cwd, '.codesema', 'tasks', TASK_ID, 'recap.json'), 'utf8')
    const f = forge({ listFails: true })
    const result = await publish(cwd, { merged: true, ...f })
    expect(f.calls.map((c) => c.op)).toEqual(['list'])
    expect(result).toMatchObject({ comment: 'unreachable', close: 'skipped' })
    expect(result.reason?.code).toBe('forge_unreachable')
    expect(result.reason?.detail).toContain('gh: HTTP 500')
    // BOTH halves of the readable reason: the CLI's own words are the useful
    // half, and `cli-error` alone is a category nobody can act on (m7c).
    expect(result.note).toContain('cli-error: gh: HTTP 500')
    expect(names(result.events)).toEqual(['recap_unreachable'])
    expect(result.events[0]?.reason_code).toBe('forge_unreachable')
    expect(readFileSync(join(cwd, '.codesema', 'tasks', TASK_ID, 'recap.json'), 'utf8')).toBe(
      before,
    )
  })

  test('the comment itself fails: forge_unreachable, the recap stays, the issue is not closed', async () => {
    const cwd = makeDir()
    writeTaskRecap(cwd, TASK_ID, makeRecap())
    const f = forge({ commentFails: true })
    const result = await publish(cwd, { merged: true, ...f })
    expect(f.calls.map((c) => c.op)).toEqual(['list', 'comment'])
    expect(result).toMatchObject({ comment: 'unreachable', close: 'skipped' })
    expect(result.reason?.code).toBe('forge_unreachable')
    expect(result.note).toContain('cli-error: gh: HTTP 500')
    expect(result.note).toContain('stays in .codesema')
  })

  test('an unavailability with no detail is said in the words it does have', async () => {
    const cwd = makeDir()
    writeTaskRecap(cwd, TASK_ID, makeRecap())
    const calls: string[] = []
    const result = await publish(cwd, {
      merged: true,
      listIssueCommentsFn: (o: { number: number }) => {
        calls.push(`list:${o.number}`)
        // No `detail`: nothing ran, so there is nothing for a CLI to have said.
        return Promise.resolve({ available: false as const, reason: 'no-cli' as const })
      },
    })
    expect(calls).toEqual(['list:42'])
    expect(result.note).toContain('no-cli')
    // The empty half is not glued on as a bare separator.
    expect(result.note).not.toContain('no-cli:')
    expect(result.reason?.detail).toBe('no-cli')
  })

  test('a truncated comment read never posts: absence could not be proven', async () => {
    const cwd = makeDir()
    writeTaskRecap(cwd, TASK_ID, makeRecap())
    const f = forge({ comments: [comment('chatter')], truncated: true })
    const result = await publish(cwd, { merged: true, ...f })
    expect(f.calls.map((c) => c.op)).toEqual(['list'])
    expect(result).toMatchObject({ comment: 'unreachable', close: 'skipped' })
    expect(result.reason?.code).toBe('forge_unreachable')
    expect(result.note).toContain('cannot be ruled out')
  })

  test('the closure fails after a posted comment: both degradations are said, not one', async () => {
    const cwd = makeDir()
    writeTaskRecap(cwd, TASK_ID, makeRecap())
    const f = forge({ closeFails: true })
    const result = await publish(cwd, { merged: true, ...f })
    expect(f.calls.map((c) => c.op)).toEqual(['list', 'comment', 'close'])
    expect(result).toMatchObject({ comment: 'posted', close: 'unreachable' })
    expect(result.reason?.code).toBe('forge_unreachable')
    expect(result.note).toContain('could not be closed')
    expect(result.note).toContain('cli-error: gh: HTTP 500')
    expect(names(result.events)).toEqual(['recap_posted', 'close_unreachable'])
  })

  test('a closure that fails after an ALREADY posted comment keeps both sentences', async () => {
    const cwd = makeDir()
    const recap = makeRecap()
    writeTaskRecap(cwd, TASK_ID, recap)
    const f = forge({ comments: [comment(buildRecapComment(recap, TASK_ID))], closeFails: true })
    const result = await publish(cwd, { merged: true, ...f })
    expect(result.note).toContain('already on issue #42')
    expect(result.note).toContain('could not be closed')
  })

  // The seam the ticket actually asks for (§ 0.4): ONE injected `execFn`, the
  // whole path underneath it real — `listIssueComments`, `commentIssue` and
  // `closeIssue` as they ship. Nothing runs gh or glab, and the argv IS the
  // assertion, including the ORDER the three appear in.
  test('driven through the forge exec seam alone: the real argv, comment before close', async () => {
    const cwd = makeDir()
    execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore', env: subprocessEnv() })
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/repo.git'], {
      cwd,
      stdio: 'ignore',
      env: subprocessEnv(),
    })
    writeTaskRecap(cwd, TASK_ID, makeRecap())
    const argvs: string[][] = []
    const execFn = (_cli: 'gh' | 'glab', args: string[]): Promise<ForgeCliOutcome> => {
      argvs.push(args)
      return Promise.resolve({
        kind: 'ok',
        stdout: args.includes('--json') ? JSON.stringify({ comments: [] }) : '',
      })
    }
    const result = await publishTaskRecap({ cwd, task: makeTask(), merged: true, execFn })
    expect(result).toMatchObject({ comment: 'posted', close: 'closed' })
    expect(argvs[0]).toEqual(['issue', 'view', '42', '--json', 'comments'])
    expect(argvs[1]?.slice(0, 3)).toEqual(['issue', 'comment', '42'])
    // The body rides an ATTACHED value, so pflag can never re-read it as an option.
    expect(argvs[1]?.[3]?.startsWith('--body=<!-- codesema-recap:')).toBe(true)
    expect(argvs[2]).toEqual(['issue', 'close', '42'])
    expect(argvs).toHaveLength(3)
  })

  // MINEUR promu, on the path that actually costs something: task A's comment
  // carries task B's marker in prose. Before the anchoring, B read it back,
  // believed itself published, abstained — and, `merged` being true, CLOSED
  // the issue. Nothing about that is recoverable from B's side.
  test('a poisoned marker never makes another task abstain, nor close the issue', async () => {
    const cwd = makeDir()
    const recapB = makeRecap()
    writeTaskRecap(cwd, TASK_ID, recapB)
    const poisoned = buildRecapComment(
      makeRecap({ summary: `see ${recapMarker(TASK_ID)} for context` }),
      OTHER_TASK_ID,
    )
    expect(poisoned).toContain(recapMarker(TASK_ID))
    const f = forge({ comments: [comment(poisoned)] })
    const result = await publish(cwd, { merged: true, ...f })
    // B posts its own recap, and only then is the issue closed.
    expect(f.calls.map((c) => c.op)).toEqual(['list', 'comment', 'close'])
    expect(result).toMatchObject({ comment: 'posted', close: 'closed' })
    expect(names(result.events)).toEqual(['recap_posted', 'closed'])
  })

  // m8: `publishTaskRecap` is documented as NEVER throwing, and it runs after
  // — sometimes long after — a comment already landed on a forge. A journal
  // write that fails costs a LINE, never the publication, and `events` keeps
  // matching what is on disk rather than what was attempted.
  test('a journal that cannot be written does not take the publication down', async () => {
    const cwd = makeDir()
    writeTaskRecap(cwd, TASK_ID, makeRecap())
    const f = forge()
    const result = await publish(cwd, {
      merged: true,
      ...f,
      appendTaskEventFn: () => {
        throw new Error('ENOSPC: no space left on device')
      },
    })
    expect(f.calls.map((c) => c.op)).toEqual(['list', 'comment', 'close'])
    expect(result).toMatchObject({ comment: 'posted', close: 'closed', note: null })
    expect(result.events).toEqual([])
    expect(readTaskEvents(cwd, TASK_ID)).toEqual([])
  })

  test('the journal lines it returns are the ones actually on disk', async () => {
    const cwd = makeDir()
    writeTaskRecap(cwd, TASK_ID, makeRecap())
    // A pre-existing line, so the seq of what this publication appends is not
    // trivially 1 and the return value cannot be a fabrication.
    appendTaskEvent(cwd, TASK_ID, { type: 'shipped', data: { mr_url: null } })
    const f = forge()
    const result = await publish(cwd, { merged: true, ...f })
    expect(readTaskEvents(cwd, TASK_ID).slice(1)).toEqual(result.events)
    expect(result.events.map((e) => e.seq)).toEqual([2, 3])
  })
})
