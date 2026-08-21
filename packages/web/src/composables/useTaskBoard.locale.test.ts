import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { catalogs } from '../i18n'
import type { TaskEventData } from '../types'

/**
 * Renders journal lines through the REAL `eventSummary`/`eventTone`, in a
 * process whose locale is French.
 *
 * Why a child process: `i18n.ts` captures the catalog ONCE, at module load,
 * from `window.__CODESEMA_LOCALE__`, and every test file of a `bun test` run
 * shares a single module registry — by the time this file executes, the
 * catalog is already frozen on 'en' by whichever web test imported it first
 * (and a cache-busting `?query` import does NOT re-instantiate `../i18n` for
 * the fresh copy, which was verified rather than assumed). A child process is
 * the only way to read what a French workspace actually shows. It runs this
 * repo's own source and nothing else: no network, no forge binary.
 */
async function renderInFrench(
  events: readonly TaskEventData[],
): Promise<{ summary: string; tone: string }[]> {
  const modulePath = join(import.meta.dir, 'useTaskBoard.ts')
  const script = [
    `globalThis.window = { __CODESEMA_LOCALE__: 'fr' }`,
    `const board = await import(${JSON.stringify(modulePath)})`,
    `const data = ${JSON.stringify(events)}`,
    `const lines = data.map((d) => {`,
    `  const event = { seq: 1, at: '2026-08-20T09:00:00.000Z', type: 'issue', data: d }`,
    `  return { summary: board.eventSummary(event), tone: board.eventTone(event) }`,
    `})`,
    `process.stdout.write(JSON.stringify(lines))`,
  ].join('\n')
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await child.exited
  if (!stdout.trim()) {
    throw new Error(`the French render never produced anything: ${stderr}`)
  }
  return JSON.parse(stdout) as { summary: string; tone: string }[]
}

/**
 * Round-5 adversarial review, MAJEUR 1, proven end to end. `unreachable` used
 * to be journaled as `type: 'error'`; `SUMMARY_KEYS.error` probes
 * `['message','error','summary']`, so the English sentence built by
 * `issueUnavailableMessage` was shown verbatim — in RED — on every ticketed
 * task, at every boot of a machine with no `gh`/`glab`, for a case the
 * CHANGELOG itself describes as "the task carries on unmodified on its
 * existing snapshot". This is the half nothing else in the repo covers: not
 * that a key exists, but what a French reader ends up with.
 */
describe('the T2.4 issue journal, read in French', () => {
  /** Verbatim what the server writes into `data.message` for this cause. */
  const SERVER_MESSAGE =
    "the forge could not be read to compare this task's ticket (no-cli: no forge CLI (gh or glab) is available to read the issue); the task carries on unmodified on its existing snapshot, and nothing is claimed about whether the issue moved"

  test('an unreachable forge reads in French, never as the server sentence, and never red', async () => {
    const [unreachable, bound] = await renderInFrench([
      { name: 'unreachable', message: SERVER_MESSAGE },
      { name: 'bound', message: 'task created from a forge issue' },
    ])
    expect(unreachable?.summary).toBe(
      "La forge n'a pas pu être lue : ce ticket n'a pas été comparé, la conversation continue sur sa copie figée",
    )
    // The negative half, crossed: not one word of the English sentence the
    // server posed on the very same event gets through.
    expect(unreachable?.summary).not.toContain(SERVER_MESSAGE)
    expect(unreachable?.summary).not.toContain('no forge CLI (gh or glab) is available')
    expect(unreachable?.summary).not.toContain('snapshot')
    // Its own line, not a sibling's: wiring the name to another key would
    // make these two identical.
    expect(unreachable?.summary).not.toBe(bound?.summary)
    expect(bound?.summary).toBe('Conversation créée depuis un ticket de la forge')
    // DP9: amber at worst. Red is what routing through 'error' produced.
    expect(unreachable?.tone).toBe('check')
    expect(unreachable?.tone).not.toBe('stop')
  })

  test('every issue cause reads in French, none of them falling back to the bare label', async () => {
    const names = [
      'bound',
      'coverage_gap',
      'cosmetic',
      'not_ticket',
      'snapshot_unreadable',
      'unreachable',
    ] as const
    const lines = await renderInFrench(names.map((name) => ({ name, message: 'ENGLISH SENTENCE' })))
    expect(lines).toHaveLength(names.length)
    for (const line of lines) {
      // 'Ticket' is the plain type label — the fallback for a name this
      // bundle does not know. Reaching it here would mean an unwired name.
      expect(line.summary).not.toBe('Ticket')
      expect(line.summary).not.toContain('ENGLISH SENTENCE')
      expect(line.tone).not.toBe('stop')
    }
    expect(new Set(lines.map((line) => line.summary)).size).toBe(names.length)
  })
})

async function renderCriteriaInFrench(
  events: readonly TaskEventData[],
): Promise<{ summary: string; tone: string }[]> {
  const modulePath = join(import.meta.dir, 'useTaskBoard.ts')
  const script = [
    `globalThis.window = { __CODESEMA_LOCALE__: 'fr' }`,
    `const board = await import(${JSON.stringify(modulePath)})`,
    `const data = ${JSON.stringify(events)}`,
    `const lines = data.map((d) => {`,
    `  const event = { seq: 1, at: '2026-08-20T09:00:00.000Z', type: 'criteria', data: d }`,
    `  return { summary: board.eventSummary(event), tone: board.eventTone(event) }`,
    `})`,
    `process.stdout.write(JSON.stringify(lines))`,
  ].join('\n')
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await child.exited
  if (!stdout.trim()) {
    throw new Error(`the French render never produced anything: ${stderr}`)
  }
  return JSON.parse(stdout) as { summary: string; tone: string }[]
}

describe('the T2.5 criteria journal, read in French', () => {
  const SERVER_MESSAGE =
    'the agent reply did not carry a criteria draft protocol, so the task continues without acceptance criteria'

  test('an unreadable draft reads in French, never as the server sentence, and never red', async () => {
    const [unparsed, validated] = await renderCriteriaInFrench([
      { name: 'draft_unparsed', message: SERVER_MESSAGE },
      { name: 'validated', message: 'acceptance criteria validated' },
    ])
    expect(unparsed?.summary).toBe(
      "Le brouillon de critères n'était pas lisible : la tâche continue sans critères",
    )
    expect(unparsed?.summary).not.toContain(SERVER_MESSAGE)
    expect(unparsed?.summary).not.toContain('draft protocol')
    expect(unparsed?.summary).not.toBe(validated?.summary)
    expect(validated?.summary).toBe("Critères d'acceptation validés")
    expect(unparsed?.tone).not.toBe('stop')
    expect(validated?.tone).not.toBe('stop')
  })

  // T3.2: the gate is the ticket's whole point, and what a French user reads
  // when it blocks is the half that keeps being forgotten. The server puts no
  // sentence in `data` for these three at all, so a missing key here would
  // surface as the bare 'Critères' label, not as English.
  test('the gate lines and the draft proposal all read in French, and only the block is amber', async () => {
    const [blocked, passed, proposed] = await renderCriteriaInFrench([
      { name: 'gate_blocked', met: 2, unmet: 1, unclear: 0 },
      { name: 'gate_passed', met: 3, unmet: 0, unclear: 0 },
      { name: 'draft_proposed', count: 3 },
    ])
    expect(blocked?.summary).toBe(
      "Critères d'acceptation non satisfaits : cette tâche n'est pas prête à merger",
    )
    expect(passed?.summary).toBe(
      "Tous les critères d'acceptation sont satisfaits, preuve à l'appui dans le diff",
    )
    expect(proposed?.summary).toBe(
      "L'agent a proposé des critères d'acceptation : ils ne comptent pas tant que vous ne les avez pas validés",
    )
    for (const line of [blocked, passed, proposed]) {
      // 'Critères' is the plain type label: reaching it means an unwired name.
      expect(line?.summary).not.toBe('Critères')
      expect(line?.tone).not.toBe('stop')
    }
    expect(blocked?.tone).toBe('check')
    expect(passed?.tone).toBe('idle')
  })
})

/**
 * Renders a conversation's HEADER phrase and short label through the real
 * `statusPhraseKey`/`statusLabelKey` and the real `t()`, in a French process.
 * Same child-process reason as above: the catalog is frozen once per process.
 */
async function renderStatusInFrench(
  records: readonly { status: string; reason?: { code: string; detail?: string } }[],
): Promise<{ phrase: string; label: string }[]> {
  const boardPath = join(import.meta.dir, 'useTaskBoard.ts')
  const i18nPath = join(import.meta.dir, '..', 'i18n.ts')
  const script = [
    `globalThis.window = { __CODESEMA_LOCALE__: 'fr' }`,
    `const board = await import(${JSON.stringify(boardPath)})`,
    `const { t } = await import(${JSON.stringify(i18nPath)})`,
    `const data = ${JSON.stringify(records)}`,
    `const lines = data.map((record) => ({`,
    `  phrase: t(board.statusPhraseKey(record, false)),`,
    `  label: t(board.statusLabelKey(record)),`,
    `}))`,
    `process.stdout.write(JSON.stringify(lines))`,
  ].join('\n')
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await child.exited
  if (!stdout.trim()) {
    throw new Error(`the French render never produced anything: ${stderr}`)
  }
  return JSON.parse(stdout) as { phrase: string; label: string }[]
}

describe('the T3.3 fix-loop exit, read in French', () => {
  test('a task the loop gave up on reads as blocked, never as "waiting for your answer"', async () => {
    const [findings, criteria, asking, blockedReview] = await renderStatusInFrench([
      {
        status: 'waiting_for_you',
        reason: { code: 'review_blocked', detail: 'a.ts:3 leaks a descriptor' },
      },
      {
        status: 'waiting_for_you',
        reason: { code: 'criteria_unmet', detail: '1 of 3 acceptance criteria are not satisfied' },
      },
      // The ordinary case, unchanged: a conversation that asked a question.
      { status: 'waiting_for_you' },
      // The comparison that matters: the SAME code, on the status the
      // reviewer settles — a verdict a human may still assume and ship.
      { status: 'review_ko', reason: { code: 'review_blocked', detail: 'a.ts:3 leaks' } },
    ])
    expect(findings?.label).toBe('Correction auto arrêtée')
    expect(findings?.phrase).toContain('corrections automatiques arrêtées')
    expect(criteria?.label).toBe('Correction auto arrêtée')
    expect(criteria?.phrase).toContain("critères d'acceptation encore non satisfaits")
    // What a human cannot deduce from the status, and needs before clicking
    // Fix: their own turn restarts the automatic budget from zero.
    for (const line of [findings, criteria]) {
      expect(line?.phrase).toContain('budget de correction complet')
      // The sentence that would be a lie: nobody asked anything.
      expect(line?.phrase).not.toBe('en pause — attend votre réponse')
      // ...and not the English server detail either.
      expect(line?.phrase).not.toContain('leaks a descriptor')
      expect(line?.phrase).not.toContain('acceptance criteria')
    }
    expect(asking?.phrase).toBe('en pause — attend votre réponse')
    expect(asking?.label).toBe('Besoin de toi')
    // The whole point of the split, in the language a human actually reads:
    // the parked task and the blocked review do NOT say the same thing.
    expect(blockedReview?.label).toBe('Review bloquée')
    expect(blockedReview?.phrase).toBe('review bloquée — findings à corriger')
    expect(blockedReview?.label).not.toBe(findings?.label)
    expect(blockedReview?.phrase).not.toBe(findings?.phrase)
  })

  test('the same sentence carries in ENGLISH, catalog by catalog', () => {
    // Found by mutating this ticket's own correction: the French phrase was
    // asserted verbatim and the English one was not, so the English copy could
    // be gutted with nothing going red. The thing that must survive a reword
    // is the FACT — a reply restarts the budget — not the wording, so both
    // catalogs are checked for it and neither is checked letter by letter.
    for (const locale of ['en', 'fr'] as const) {
      const catalog = catalogs[locale] as Record<string, string>
      for (const key of [
        'workspace.phaseFixLoopStopped',
        'workspace.phaseFixLoopStoppedCriteria',
      ] as const) {
        const phrase = catalog[key] ?? ''
        expect(phrase).toMatch(/budget/i)
        // ...and it says the automatic rounds are over, not that the review is
        // simply blocked — that is the sentence the `review_ko` already owns.
        expect(phrase).toMatch(locale === 'en' ? /automatic fixes stopped/i : /automatiques/i)
      }
      expect(catalog['workspace.statusFixLoopStopped']).toBeTruthy()
      expect(catalog['workspace.statusFixLoopStopped']).not.toBe(
        catalog['workspace.statusReviewKo'],
      )
    }
  })
})
