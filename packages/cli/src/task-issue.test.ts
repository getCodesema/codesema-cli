import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  TASK_TITLE_MAX,
  TASK_TURN_TEXT_MAX,
  TICKET_BODY_HASH_TAG,
  type TaskIssueRef,
} from './contract.js'
import type { ForgeCli, ForgeCliOutcome, ForgeIssuesExecFn } from './forge-issues.js'
import { subprocessEnv } from './git.js'
import {
  admitIssue,
  hashCanonicalBody,
  hashRawBody,
  hashSections,
  issueBoundEvent,
  issueCoverageGapEvent,
  issueReconcileEvent,
  reconcileIssueSnapshot,
  validateIssueRef,
  type IssueReconcile,
  type IssueRefInput,
} from './task-issue.js'

// --- Fixtures ---------------------------------------------------------------

/** Real git repo in a tmpdir with a github remote; `getIssue` needs one to probe. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codesema-task-issue-'))
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: subprocessEnv() })
  git(['init', '-b', 'main'])
  git(['remote', 'add', 'origin', 'https://github.com/acme/repo.git'])
  return dir
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

/** A gh `issue view --json <fields>` payload, as `parseGhIssue` reads it. */
function ghIssuePayload(body: string, title = 'Fix flaky worktree cleanup'): string {
  return JSON.stringify({
    number: 42,
    title,
    body,
    state: 'OPEN',
    labels: [],
    author: { id: 'u1', is_bot: false, login: 'octocat', name: 'The Octocat' },
    createdAt: '2026-07-20T09:00:00Z',
    updatedAt: '2026-07-28T10:00:00Z',
    url: 'https://github.com/acme/repo/issues/42',
  })
}

/** A gh candidate that answers `body` for `issue view`, whatever else it is asked. */
function ghAnswers(body: string, title?: string) {
  return rig((call) => {
    if (call.cli === 'gh' && call.args[0] === 'issue' && call.args[1] === 'view') {
      return { kind: 'ok', stdout: ghIssuePayload(body, title) }
    }
    return { kind: 'missing' }
  })
}

const CRITERIA = [
  'WHEN a ticket is launched THE SYSTEM SHALL lint its body',
  'WHEN a section is missing THE SYSTEM SHALL name that section',
  'WHEN the body is conforming THE SYSTEM SHALL accept it',
]

/** A conforming ticket body (five sections, three EARS criteria). */
function ticketBody(
  overrides: Partial<Record<'context' | 'goal' | 'scope' | 'outOfScope', string>> = {},
) {
  return [
    `**Context**\n\n${overrides.context ?? 'Tickets are launched from the workspace.'}`,
    `**Goal**\n\n${overrides.goal ?? 'Freeze the ticket format once.'}`,
    `**Scope**\n\n${overrides.scope ?? 'packages/contract/src/ticket.ts'}`,
    `**Acceptance criteria**\n\n${CRITERIA.map((c) => `- ${c}`).join('\n')}`,
    `**Out of scope**\n\n${overrides.outOfScope ?? 'Posting the issue on the forge.'}`,
  ].join('\n\n')
}

const REF: TaskIssueRef = {
  forge: 'github',
  project: 'acme/repo',
  iid: 42,
  url: 'https://github.com/acme/repo/issues/42',
}

// --- validateIssueRef --------------------------------------------------------

describe('validateIssueRef', () => {
  const valid: IssueRefInput = { forge: 'github', project: 'acme/repo', iid: 42, url: REF.url }

  test('a conforming reference is accepted', () => {
    expect(validateIssueRef(valid)).toEqual({ ok: true, ref: REF })
  })

  test('an unknown forge is refused', () => {
    expect(validateIssueRef({ ...valid, forge: 'bitbucket' }).ok).toBe(false)
  })

  test('an empty project is refused', () => {
    expect(validateIssueRef({ ...valid, project: '' }).ok).toBe(false)
    expect(validateIssueRef({ ...valid, project: '   ' }).ok).toBe(false)
  })

  test('iid must be a positive decimal integer: numeric strings, floats and hex are all refused', () => {
    for (const iid of ['12', '12a', 1.5, '0x1f', 0, -1, Number.NaN, null, undefined]) {
      expect(validateIssueRef({ ...valid, iid }).ok).toBe(false)
    }
  })

  test('url must be a valid http(s) URL', () => {
    for (const url of ['not a url', 'ftp://example.com/1', '', 'javascript:alert(1)']) {
      expect(validateIssueRef({ ...valid, url }).ok).toBe(false)
    }
  })
})

// --- admitIssue --------------------------------------------------------------

describe('admitIssue', () => {
  test('a conforming issue is admitted: title, prompt and a frozen snapshot', async () => {
    const repo = makeRepo()
    try {
      const { calls, execFn } = ghAnswers(ticketBody())
      const admitted = await admitIssue({ cwd: repo, ref: REF, execFn })
      expect(admitted.ok).toBe(true)
      if (!admitted.ok) {
        throw new Error('unreachable')
      }
      expect(admitted.title).toBe('Fix flaky worktree cleanup')
      expect(admitted.prompt).toBe(ticketBody().trim())
      expect(admitted.snapshot.criteria.map((c) => c.text)).toEqual(CRITERIA)
      expect(admitted.snapshot.body_hash.startsWith(`${TICKET_BODY_HASH_TAG}:`)).toBe(true)
      expect(admitted.snapshot.raw_body_hash?.startsWith('sha256:raw:')).toBe(true)
      expect(admitted.coverage_gap).toBe(false)
      // The read went through the injected seam: no real binary, no network.
      expect(calls.some((c) => c.cli === 'gh' && c.args.includes('view'))).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an issue whose body fails the ticket lint is refused (400), naming the problem', async () => {
    const repo = makeRepo()
    try {
      const body = ticketBody().replace('**Goal**', '**Not a section**')
      const { execFn } = ghAnswers(body)
      const admitted = await admitIssue({ cwd: repo, ref: REF, execFn })
      expect(admitted.ok).toBe(false)
      if (admitted.ok) {
        throw new Error('unreachable')
      }
      expect(admitted.code).toBe(400)
      expect(admitted.error).toContain('section_missing')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an issue with no title is refused', async () => {
    const repo = makeRepo()
    try {
      const { execFn } = ghAnswers(ticketBody(), '   ')
      const admitted = await admitIssue({ cwd: repo, ref: REF, execFn })
      expect(admitted.ok).toBe(false)
      if (admitted.ok) {
        throw new Error('unreachable')
      }
      expect(admitted.code).toBe(400)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an issue title past TASK_TITLE_MAX is refused, never truncated', async () => {
    const repo = makeRepo()
    try {
      const { execFn } = ghAnswers(ticketBody(), 'x'.repeat(TASK_TITLE_MAX + 1))
      const admitted = await admitIssue({ cwd: repo, ref: REF, execFn })
      expect(admitted.ok).toBe(false)
      if (admitted.ok) {
        throw new Error('unreachable')
      }
      expect(admitted.code).toBe(400)
      expect(admitted.error).toContain('title too long')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a body too long to use as the initial prompt is refused, never truncated', async () => {
    const repo = makeRepo()
    try {
      // Five sections near their own bound plus many long criteria:
      // individually conforming, but the whole body exceeds TASK_TURN_TEXT_MAX.
      const long = 'x'.repeat(3_999)
      const critText = (i: number) =>
        `WHEN case ${i} happens THE SYSTEM SHALL react to it in a sufficiently long descriptive way that pads things out as much as reasonably possible while staying under the five hundred character per criterion bound so the whole ticket remains a conforming one for this test fixture and nothing else needs to change about it at all really truly indeed yes`
      const manyCriteria = Array.from({ length: 32 }, (_, i) => critText(i))
      const body = [
        `**Context**\n\n${long}`,
        `**Goal**\n\n${long}`,
        `**Scope**\n\n${long}`,
        `**Acceptance criteria**\n\n${manyCriteria.map((c) => `- ${c}`).join('\n')}`,
        `**Out of scope**\n\n${long}`,
      ].join('\n\n')
      expect(body.length).toBeGreaterThan(TASK_TURN_TEXT_MAX)
      const { execFn } = ghAnswers(body)
      const admitted = await admitIssue({ cwd: repo, ref: REF, execFn })
      expect(admitted.ok).toBe(false)
      if (admitted.ok) {
        throw new Error('unreachable')
      }
      expect(admitted.code).toBe(400)
      expect(admitted.error).toContain('too long')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('content outside the five recognized sections sets coverage_gap, without refusing the creation', async () => {
    const repo = makeRepo()
    try {
      // Prepended, not appended: content AFTER the last heading's block is
      // read as more of THAT section (still covered) — only content BEFORE
      // the first recognized heading is genuinely outside every section.
      const stray = 'Some unrelated note nobody put under a recognized heading, on and on. '.repeat(
        10,
      )
      const { execFn } = ghAnswers(`${stray}\n\n${ticketBody()}`)
      const admitted = await admitIssue({ cwd: repo, ref: REF, execFn })
      expect(admitted.ok).toBe(true)
      if (!admitted.ok) {
        throw new Error('unreachable')
      }
      expect(admitted.coverage_gap).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('forge unreachable (no CLI answers) refuses with 502 and forge_unreachable', async () => {
    const repo = makeRepo()
    try {
      const { execFn } = rig(() => ({ kind: 'missing' }))
      const admitted = await admitIssue({ cwd: repo, ref: REF, execFn })
      expect(admitted.ok).toBe(false)
      if (admitted.ok) {
        throw new Error('unreachable')
      }
      expect(admitted.code).toBe(502)
      expect(admitted.reason_code).toBe('forge_unreachable')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

// --- reconcileIssueSnapshot ---------------------------------------------------

describe('reconcileIssueSnapshot', () => {
  async function admittedSnapshot(repo: string, body: string) {
    const { execFn } = ghAnswers(body)
    const admitted = await admitIssue({ cwd: repo, ref: REF, execFn })
    if (!admitted.ok) {
      throw new Error('fixture setup failed')
    }
    return admitted.snapshot
  }

  test('an untouched issue reconciles as unchanged', async () => {
    const repo = makeRepo()
    try {
      const body = ticketBody()
      const snapshot = await admittedSnapshot(repo, body)
      const { execFn } = ghAnswers(body)
      const outcome = await reconcileIssueSnapshot({ cwd: repo, issue: REF, snapshot, execFn })
      expect(outcome).toEqual({ kind: 'unchanged' })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('CRLF-only re-serving is cosmetic: raw moved, canonical meaning did not', async () => {
    const repo = makeRepo()
    try {
      const body = ticketBody()
      const snapshot = await admittedSnapshot(repo, body)
      const crlf = body.replaceAll('\n', '\r\n')
      const { execFn } = ghAnswers(crlf)
      const outcome = await reconcileIssueSnapshot({ cwd: repo, issue: REF, snapshot, execFn })
      expect(outcome).toEqual({ kind: 'cosmetic' })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a reworded prose section is edited, naming that section and no criteria diff', async () => {
    const repo = makeRepo()
    try {
      const body = ticketBody()
      const snapshot = await admittedSnapshot(repo, body)
      const edited = ticketBody({ context: 'Tickets are launched from a DIFFERENT place now.' })
      const { execFn } = ghAnswers(edited)
      const outcome = await reconcileIssueSnapshot({ cwd: repo, issue: REF, snapshot, execFn })
      expect(outcome.kind).toBe('edited')
      if (outcome.kind !== 'edited') {
        throw new Error('unreachable')
      }
      expect(outcome.sections).toEqual(['context'])
      expect(outcome.criteria_added).toEqual([])
      expect(outcome.criteria_removed).toEqual([])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a reworded criterion is edited, naming the criteria diff by stable id and no section', async () => {
    const repo = makeRepo()
    try {
      const body = ticketBody()
      const snapshot = await admittedSnapshot(repo, body)
      const reworded = body.replace(CRITERIA[0] ?? '', 'WHEN reworded THE SYSTEM SHALL still lint')
      const { execFn } = ghAnswers(reworded)
      const outcome = await reconcileIssueSnapshot({ cwd: repo, issue: REF, snapshot, execFn })
      expect(outcome.kind).toBe('edited')
      if (outcome.kind !== 'edited') {
        throw new Error('unreachable')
      }
      expect(outcome.sections).toEqual([])
      expect(outcome.criteria_added).toHaveLength(1)
      expect(outcome.criteria_removed).toHaveLength(1)
      // A reworded criterion is a NEW id, not the old one reused.
      expect(outcome.criteria_added[0]).not.toBe(outcome.criteria_removed[0])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  // Round-4 adversarial review, MAJEUR 1: DP13 requires the warning to carry
  // "the criteria diff by stable id", and NOTHING pinned which side of that
  // diff was which — every existing case had one added and one removed, so
  // swapping the two fields kept every assertion green while the journal
  // would have said the opposite of what happened. This diff is ASYMMETRIC on
  // purpose (two in, one out): a swap cannot survive it.
  test('the criteria diff tells additions from removals: two added, one removed, never the reverse', async () => {
    const repo = makeRepo()
    try {
      const NEW_A = 'WHEN a fourth rule lands THE SYSTEM SHALL apply it'
      const NEW_B = 'WHEN a fifth rule lands THE SYSTEM SHALL apply it too'
      const base = ticketBody()
      const snapshot = await admittedSnapshot(repo, base)
      const edited = base.replace(
        CRITERIA.map((c) => `- ${c}`).join('\n'),
        [CRITERIA[0], CRITERIA[1], NEW_A, NEW_B].map((c) => `- ${c}`).join('\n'),
      )
      const { execFn } = ghAnswers(edited)
      const outcome = await reconcileIssueSnapshot({ cwd: repo, issue: REF, snapshot, execFn })
      expect(outcome.kind).toBe('edited')
      if (outcome.kind !== 'edited') {
        throw new Error('unreachable')
      }
      expect(outcome.criteria_added).toHaveLength(2)
      expect(outcome.criteria_removed).toHaveLength(1)
      // And the ids on each side are the RIGHT ones: the dropped criterion's
      // frozen id is the removed one, and neither new id appears there.
      const dropped = snapshot.criteria.find((c) => c.text.includes('conforming'))?.id
      expect(dropped).toBeTruthy()
      expect(outcome.criteria_removed).toEqual([dropped!])
      expect(outcome.criteria_added).not.toContain(dropped!)
      // The event built from it keeps the two sides apart on the wire too.
      const event = issueReconcileEvent(outcome)
      expect(String(event.data.criteria_added).split(',')).toHaveLength(2)
      expect(event.data.criteria_removed).toBe(dropped)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a body that no longer lints is not_ticket, never confused with edited', async () => {
    const repo = makeRepo()
    try {
      const body = ticketBody()
      const snapshot = await admittedSnapshot(repo, body)
      const broken = body.replace('**Goal**', '**Not a section**')
      const { execFn } = ghAnswers(broken)
      const outcome = await reconcileIssueSnapshot({ cwd: repo, issue: REF, snapshot, execFn })
      expect(outcome.kind).toBe('not_ticket')
      if (outcome.kind !== 'not_ticket') {
        throw new Error('unreachable')
      }
      expect(outcome.message).toContain('section_missing')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('an unreachable forge continues on the snapshot: unreachable, forge_unreachable', async () => {
    const repo = makeRepo()
    try {
      const body = ticketBody()
      const snapshot = await admittedSnapshot(repo, body)
      const { execFn } = rig(() => ({ kind: 'missing' }))
      const outcome = await reconcileIssueSnapshot({ cwd: repo, issue: REF, snapshot, execFn })
      expect(outcome.kind).toBe('unreachable')
      if (outcome.kind !== 'unreachable') {
        throw new Error('unreachable')
      }
      expect(outcome.reason.code).toBe('forge_unreachable')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  // Round-5 adversarial review, mineur: the `?? taskReason('forge_unreachable',
  // …)` fallback is reached on exactly ONE input — `invalid-input`, the only
  // unavailability `forgeIssueReason` maps to no code — and nothing exercised
  // it, so the five-line invariant justifying that mapping had no test behind
  // it while the code IS raised to the API. `getIssue` refuses a non-positive
  // iid before probing anything, which is the reachable way in.
  test('an "invalid-input" refusal still degrades under forge_unreachable, with its own words', async () => {
    const repo = makeRepo()
    try {
      const snapshot = await admittedSnapshot(repo, ticketBody())
      const { calls, execFn } = rig(() => ({ kind: 'missing' }))
      const outcome = await reconcileIssueSnapshot({
        cwd: repo,
        issue: { ...REF, iid: 0 },
        snapshot,
        execFn,
      })
      expect(outcome.kind).toBe('unreachable')
      if (outcome.kind !== 'unreachable') {
        throw new Error('unreachable')
      }
      // The branch really is the no-code one: no forge binary was ever asked
      // anything, so `forgeIssueReason` returned null and only the fallback
      // could have produced this code.
      expect(calls).toHaveLength(0)
      expect(outcome.reason.code).toBe('forge_unreachable')
      // Invariant 2: the code is ADDED to the refusal's own words, never
      // substituted for them.
      expect(outcome.reason.detail).toContain('invalid issue number: 0')
      // T2.7 round-2 adversarial review, mineur 6: and it is composed the ONE
      // way every `forge_unreachable` detail is (degraded-mode.ts) — the
      // motif FIRST and verbatim, the sentence after. This site used to lead
      // with the English sentence, so a reader taking the motif off the front
      // of a detail could not tell whether this one carried one at all.
      expect(outcome.reason.detail?.startsWith('invalid-input: ')).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  // Adversarial review, majeur 1: reordering the SAME three criteria used to
  // move the CANONICAL hash (list-order serialization), reporting 'edited'
  // with an empty sections/criteria diff — the bare "the issue changed" DP13
  // forbids. Sorted-by-id hashing fixes this at the source: the canonical
  // meaning is provably unchanged, so this is now 'cosmetic' (the raw bytes
  // did move — the criteria really are in a different order on the forge —
  // but nothing under the ticket contract did), never 'edited' with nothing
  // to name.
  test('reordering the acceptance criteria (same wording) reconciles as cosmetic, never edited', async () => {
    const repo = makeRepo()
    try {
      const reordered = [
        '**Context**\n\nTickets are launched from the workspace.',
        '**Goal**\n\nFreeze the ticket format once.',
        '**Scope**\n\npackages/contract/src/ticket.ts',
        `**Acceptance criteria**\n\n${[CRITERIA[2], CRITERIA[0], CRITERIA[1]].map((c) => `- ${c}`).join('\n')}`,
        '**Out of scope**\n\nPosting the issue on the forge.',
      ].join('\n\n')
      const snapshot = await admittedSnapshot(repo, ticketBody())
      const { execFn } = ghAnswers(reordered)
      const outcome = await reconcileIssueSnapshot({ cwd: repo, issue: REF, snapshot, execFn })
      expect(outcome).toEqual({ kind: 'cosmetic' })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  // Adversarial review, majeur 2: a section re-served in the OTHER Unicode
  // normalization form (NFD vs NFC) used to read as 'edited' with an empty
  // explanation — the same false alarm DP13 exists to rule out. `Café`
  // typed with a precomposed 'é' (NFC) vs 'e' + combining acute (NFD).
  test('the same prose re-served in NFD instead of NFC is cosmetic, not edited', async () => {
    const repo = makeRepo()
    try {
      const composed = ticketBody({
        context: 'Tickets café résumé are launched from the workspace.',
      })
      const decomposed = composed.normalize('NFD')
      expect(decomposed).not.toBe(composed) // sanity: the two really do differ byte for byte
      const snapshot = await admittedSnapshot(repo, composed)
      const { execFn } = ghAnswers(decomposed)
      const outcome = await reconcileIssueSnapshot({ cwd: repo, issue: REF, snapshot, execFn })
      expect(outcome).toEqual({ kind: 'cosmetic' })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  // Adversarial review, majeur 2: two trailing spaces are a markdown hard
  // line break inside a section's prose (not at the very edge of the whole
  // block, where the pre-existing overall trim already covers it) — gh and
  // glab do not render them identically, and this used to read as 'edited'.
  test('trailing whitespace inside a multi-line section is cosmetic, not edited', async () => {
    const repo = makeRepo()
    try {
      const clean = ticketBody({
        context: 'Tickets are launched from the workspace.\nA second line.',
      })
      const trailing = ticketBody({
        context: 'Tickets are launched from the workspace.  \nA second line.\t',
      })
      const snapshot = await admittedSnapshot(repo, clean)
      const { execFn } = ghAnswers(trailing)
      const outcome = await reconcileIssueSnapshot({ cwd: repo, issue: REF, snapshot, execFn })
      expect(outcome).toEqual({ kind: 'cosmetic' })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  // Mineur, adversarial review: `section_hashes` is optional on
  // `TaskIssueSnapshot` (a spec-conforming producer may omit it). Losing it
  // must never lose reconciliation itself — only the ability to NAME which
  // section moved.
  test('a snapshot with no section_hashes breakdown still reconciles: edited, sections_unknown, sections empty', async () => {
    const repo = makeRepo()
    try {
      const body = ticketBody()
      const fullSnapshot = await admittedSnapshot(repo, body)
      const bareSnapshot = { ...fullSnapshot }
      delete bareSnapshot.section_hashes
      const edited = ticketBody({ context: 'Tickets are launched from a DIFFERENT place now.' })
      const { execFn } = ghAnswers(edited)
      const outcome = await reconcileIssueSnapshot({
        cwd: repo,
        issue: REF,
        snapshot: bareSnapshot,
        execFn,
      })
      expect(outcome.kind).toBe('edited')
      if (outcome.kind !== 'edited') {
        throw new Error('unreachable')
      }
      expect(outcome.sections_unknown).toBe(true)
      expect(outcome.sections).toEqual([])
      // The criteria diff is independent of section_hashes and still works.
      expect(outcome.criteria_added).toEqual([])
      expect(outcome.criteria_removed).toEqual([])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  // Round-2 adversarial review, majeur 2: `hashSection` normalizing through
  // `canonicalizeSection` was uncovered — every existing NFD/whitespace test
  // reconciled as 'cosmetic'/'unchanged' as a WHOLE, and every 'edited' test
  // moved BOTH forms of the same section together, so a broken normalization
  // in `hashSection` alone (as opposed to `canonicalTicketBody`) never showed
  // up: `sections` is only ever consulted once `body_hash` already differs,
  // and it never did in those fixtures. These two cross a REAL edit in one
  // section against a MERELY cosmetic re-serving of ANOTHER, in the same
  // body — the only shape that can catch `hashSection` alone drifting from
  // `canonicalTicketBody`'s own normalization (DP13's "two halves of the
  // snapshot speak different languages").
  test('a genuinely edited section is named correctly even when another section is merely re-served in NFD form', async () => {
    const repo = makeRepo()
    try {
      const originalGoal = 'Freeze the café ticket format once and for all.'
      const body = ticketBody({ goal: originalGoal })
      const snapshot = await admittedSnapshot(repo, body)
      const edited = ticketBody({
        goal: originalGoal.normalize('NFD'), // cosmetically identical, different bytes
        scope: 'A genuinely different scope now.',
      })
      expect(edited).not.toBe(body) // sanity: the raw bodies really do differ
      const { execFn } = ghAnswers(edited)
      const outcome = await reconcileIssueSnapshot({ cwd: repo, issue: REF, snapshot, execFn })
      expect(outcome.kind).toBe('edited')
      if (outcome.kind !== 'edited') {
        throw new Error('unreachable')
      }
      expect(outcome.sections).toEqual(['scope'])
      expect(outcome.sections).not.toContain('goal')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a genuinely edited section is named correctly even when another section merely gains trailing whitespace', async () => {
    const repo = makeRepo()
    try {
      const originalContext = 'Tickets are launched from the workspace.\nA second line here.'
      const body = ticketBody({ context: originalContext })
      const snapshot = await admittedSnapshot(repo, body)
      const edited = ticketBody({
        context: 'Tickets are launched from the workspace.  \nA second line here.\t', // cosmetic only
        goal: 'A genuinely different goal now.',
      })
      const { execFn } = ghAnswers(edited)
      const outcome = await reconcileIssueSnapshot({ cwd: repo, issue: REF, snapshot, execFn })
      expect(outcome.kind).toBe('edited')
      if (outcome.kind !== 'edited') {
        throw new Error('unreachable')
      }
      expect(outcome.sections).toEqual(['goal'])
      expect(outcome.sections).not.toContain('context')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

// --- journal event builders --------------------------------------------------

describe('issue journal event builders (DP9: domain type, cause in data.name)', () => {
  test('issueBoundEvent names the domain and carries the hashes', () => {
    const snapshot = {
      body_hash: `${TICKET_BODY_HASH_TAG}:${'a'.repeat(64)}`,
      section_hashes: {
        context: `${TICKET_BODY_HASH_TAG}:${'b'.repeat(64)}`,
        goal: `${TICKET_BODY_HASH_TAG}:${'c'.repeat(64)}`,
        scope: `${TICKET_BODY_HASH_TAG}:${'d'.repeat(64)}`,
        out_of_scope: `${TICKET_BODY_HASH_TAG}:${'e'.repeat(64)}`,
      },
      criteria: [],
      raw_body_hash: `sha256:raw:${'f'.repeat(64)}`,
      taken_at: '2026-08-14T09:00:00.000Z',
    }
    const event = issueBoundEvent(snapshot)
    expect(event.type).toBe('issue')
    expect(event.data.name).toBe('bound')
    expect(event.data.body_hash).toBe(snapshot.body_hash)
    expect(event.data.raw_digest).toBe(snapshot.raw_body_hash)
  })

  test('issueCoverageGapEvent names the domain and the coverage_gap cause', () => {
    const event = issueCoverageGapEvent()
    expect(event.type).toBe('issue')
    expect(event.data.name).toBe('coverage_gap')
  })

  test('issueReconcileEvent — cosmetic', () => {
    const event = issueReconcileEvent({ kind: 'cosmetic' })
    expect(event.type).toBe('issue')
    expect(event.data.name).toBe('cosmetic')
  })

  test('issueReconcileEvent — edited carries sections and criteria diffs as flat strings', () => {
    const outcome: Extract<IssueReconcile, { kind: 'edited' }> = {
      kind: 'edited',
      sections: ['context', 'goal'],
      sections_unknown: false,
      criteria_added: ['ac-000000000001'],
      criteria_removed: ['ac-000000000002'],
    }
    const event = issueReconcileEvent(outcome)
    expect(event.type).toBe('issue')
    expect(event.data.name).toBe('edited')
    expect(event.data.sections).toBe('context,goal')
    expect(event.data.criteria_added).toBe('ac-000000000001')
    expect(event.data.criteria_removed).toBe('ac-000000000002')
  })

  // Mineur, adversarial review: a snapshot with no section_hashes breakdown
  // must never report "sections changed: (none)" — that would claim the
  // OPPOSITE of what body_hash already proved.
  test('issueReconcileEvent — edited with sections_unknown never claims "(none)" changed', () => {
    const outcome: Extract<IssueReconcile, { kind: 'edited' }> = {
      kind: 'edited',
      sections: [],
      sections_unknown: true,
      criteria_added: [],
      criteria_removed: [],
    }
    const event = issueReconcileEvent(outcome)
    expect(event.data.name).toBe('edited')
    // The wire carries the FACT (a flag), not a rendered English parenthetical
    // the UI would have to show verbatim in a French journal (round-4 review,
    // majeur 1) — an empty `sections` alone would read as "none moved", the
    // opposite of what body_hash just proved, hence the separate flag.
    expect(event.data.sections).toBe('')
    expect(event.data.sections_unknown).toBe(true)
    // The English `message` stays for API/CLI readers that have no catalog.
    expect(String(event.data.message)).toContain('unknown')
  })

  // Round-4 review, majeur 1: the three diff fields are DATA, not prose. An
  // empty axis is an empty string, never '(none)' — a value a UI has to
  // translate must not arrive pre-worded in English.
  test('issueReconcileEvent — an empty diff axis is an empty string, never English prose', () => {
    const event = issueReconcileEvent({
      kind: 'edited',
      sections: ['goal'],
      sections_unknown: false,
      criteria_added: [],
      criteria_removed: [],
    })
    expect(event.data.sections).toBe('goal')
    expect(event.data.criteria_added).toBe('')
    expect(event.data.criteria_removed).toBe('')
    expect(event.data.sections_unknown).toBeUndefined()
  })

  test('issueReconcileEvent — not_ticket carries the lint message, distinct name from edited', () => {
    const event = issueReconcileEvent({ kind: 'not_ticket', message: 'section_missing: **Goal**' })
    expect(event.type).toBe('issue')
    expect(event.data.name).toBe('not_ticket')
    expect(event.data.message).toContain('section_missing')
  })

  // Round-5 adversarial review, MAJEUR 1. 'unreachable' used to be routed to
  // `type: 'error'` — red, and (because SUMMARY_KEYS.error probes
  // ['message','error','summary']) with its English sentence read straight
  // into a French journal, on every ticketed task, at every boot of a machine
  // with no gh/glab. DP15 lists it among the 'issue' domain's data.names and
  // DP9 forbids painting a non-event red: the task carries on unmodified.
  test('issueReconcileEvent — unreachable is an "issue" fact, never an "error"', () => {
    const event = issueReconcileEvent({
      kind: 'unreachable',
      reason: { code: 'forge_unreachable', detail: 'no-cli: no forge CLI is available' },
    })
    expect(event.type).toBe('issue')
    expect(event.type).not.toBe('error')
    expect(event.data.name).toBe('unreachable')
    // The D2 code still rides the event: `reason_code` is a field of its own,
    // independent of the type — that is invariant 2's API leg, and it is the
    // only thing routing through `error` was really buying.
    expect(event.reason_code).toBe('forge_unreachable')
    // The producer's own words survive next to the code, for the API and CLI
    // readers that have no catalog (the web renders from `data.name`).
    expect(String(event.data.message)).toContain('no forge CLI is available')
    // DP13: no claim either way about whether the issue actually moved.
    expect(String(event.data.message)).toContain('existing snapshot')
  })
})

// --- hashSections / hashRawBody sanity (beyond ticket.test.ts's canonical coverage) --

describe('hashSections / hashRawBody', () => {
  test('hashSections changes exactly the section that changed', async () => {
    const repo = makeRepo()
    try {
      const base = ticketBody()
      const { execFn: e1 } = ghAnswers(base)
      const a1 = await admitIssue({ cwd: repo, ref: REF, execFn: e1 })
      const edited = ticketBody({ goal: 'A completely different goal.' })
      const { execFn: e2 } = ghAnswers(edited)
      const a2 = await admitIssue({ cwd: repo, ref: REF, execFn: e2 })
      if (!a1.ok || !a2.ok) {
        throw new Error('fixture setup failed')
      }
      // admitIssue always populates section_hashes fully: the non-null
      // assertions below assert exactly that, not just the section diff.
      expect(a1.snapshot.section_hashes).toBeDefined()
      expect(a2.snapshot.section_hashes).toBeDefined()
      expect(a1.snapshot.section_hashes?.context).toBe(a2.snapshot.section_hashes?.context)
      expect(a1.snapshot.section_hashes?.goal).not.toBe(a2.snapshot.section_hashes?.goal)
      expect(a1.snapshot.section_hashes?.scope).toBe(a2.snapshot.section_hashes?.scope)
      expect(a1.snapshot.section_hashes?.out_of_scope).toBe(
        a2.snapshot.section_hashes?.out_of_scope,
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('hashRawBody differs on a byte-level change even when hashCanonicalBody would not', () => {
    expect(hashRawBody('a')).not.toBe(hashRawBody('a\r'))
  })

  test('hashSections is stable across two calls on the same body', () => {
    const body = {
      version: 1 as const,
      context: 'a',
      goal: 'b',
      scope: 'c',
      acceptance_criteria: [],
      out_of_scope: 'd',
    }
    expect(hashSections(body)).toEqual(hashSections(body))
    expect(hashCanonicalBody(body)).toBe(hashCanonicalBody(body))
  })
})
