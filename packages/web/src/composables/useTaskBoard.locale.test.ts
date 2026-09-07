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

  // T3.7, the same guard for the cycle labels. `cycleLabelEvent`
  // (task-labels.ts) poses this exact English sentence in `data.message` for
  // the API and CLI readers; SUMMARY_KEYS.issue is empty precisely so it never
  // reaches a journal, and this is what proves it.
  test('a cycle label that could not be written reads in French, and is not painted red', async () => {
    const LABEL_MESSAGE =
      "the codesema:in-progress cycle label could not be posed on the forge (cli-error: gh: HTTP 502); the task's status is unaffected and the label is left as it was, to be corrected at the next transition"
    const [notPosed, unreachable] = await renderInFrench([
      {
        name: 'label_not_posed',
        label: 'codesema:in-progress',
        step: 'write',
        message: SERVER_MESSAGE,
      },
      { name: 'unreachable', message: 'ENGLISH' },
    ])
    expect(notPosed?.summary).toBe(
      "Le label de cycle n'a pas pu être écrit sur la forge : le ticket y affiche encore l'état précédent, et rien d'autre n'a changé",
    )
    expect(notPosed?.summary).not.toContain(LABEL_MESSAGE)
    expect(notPosed?.summary).not.toContain('HTTP 502')
    expect(notPosed?.summary).not.toContain('codesema:in-progress')
    // Its own line, not the forge-unreachable one it sits next to.
    expect(notPosed?.summary).not.toBe(unreachable?.summary)
    // Neutral, not amber and certainly not red: the task is untouched and the
    // next transition rewrites the label (DP9's cry-wolf).
    expect(notPosed?.tone).toBe('idle')
  })

  test('every issue cause reads in French, none of them falling back to the bare label', async () => {
    const names = [
      'bound',
      'coverage_gap',
      'cosmetic',
      'not_ticket',
      'snapshot_unreadable',
      'unreachable',
      'label_not_posed',
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

/**
 * T3.5 posts the recap on the ticket, and journals seven new causes on the
 * very same 'issue' type. `issueEventText` reads `data.name` and NEVER
 * `data.message`, so a name left out of `ISSUE_NAME_KEY` does not fail the
 * build, does not fail key parity, and shows a French reader the bare word
 * 'Ticket' — the exact hole T2.4 fell into.
 */
describe('the T3.5 recap-publication journal, read in French', () => {
  const SERVER_MESSAGE =
    'recap held back: it looks like it carries a secret (recap.md: an AWS access key id) — nothing was sent to the forge, the recap stays in .codesema'

  test('every publication cause reads in French, each with its own line and its own tone', async () => {
    const names = [
      'recap_posted',
      'recap_already_posted',
      'recap_missing',
      'recap_blocked_secrets',
      'recap_unreachable',
      'closed',
      'close_unreachable',
    ] as const
    const lines = await renderInFrench(names.map((name) => ({ name, message: SERVER_MESSAGE })))
    expect(lines).toHaveLength(names.length)
    for (const line of lines) {
      expect(line.summary).not.toBe('Ticket')
      expect(line.summary).not.toContain(SERVER_MESSAGE)
      expect(line.summary).not.toContain('recap held back')
      // Nothing here ever fails the task: amber at worst, never red.
      expect(line.tone).not.toBe('stop')
    }
    expect(new Set(lines.map((line) => line.summary)).size).toBe(names.length)
    // A settled fact stays neutral; a degradation asks for a look.
    expect(lines.map((line) => line.tone)).toEqual([
      'idle',
      'idle',
      'check',
      'check',
      'check',
      'idle',
      'check',
    ])
  })

  test('the blocked line says where the recap is, not only that nothing was posted', async () => {
    const [blocked] = await renderInFrench([
      { name: 'recap_blocked_secrets', message: SERVER_MESSAGE },
    ])
    expect(blocked?.summary).toContain('secret')
    expect(blocked?.summary).toContain('machine')
  })

  test('a publication failure never borrows the ticket-freshness line of T2.4', async () => {
    const [publish, compare] = await renderInFrench([
      { name: 'recap_unreachable', message: SERVER_MESSAGE },
      { name: 'unreachable', message: SERVER_MESSAGE },
    ])
    expect(publish?.summary).not.toBe(compare?.summary)
    // The T2.4 line claims the ticket was not COMPARED, which says nothing
    // about a recap and would be false on this path.
    expect(publish?.summary).not.toContain('comparé')
  })
})

/**
 * MAJEUR 2 (round 2), the chain proven end to end: `task-server.ts` writes
 * `data.name` on the 'shipped' event, `useTaskBoard` renders it, and a French
 * workspace reads a French sentence — not the server's English `data.note`,
 * and not the same green 'Publiée' as a ship that carried its recap.
 */
async function renderShippedInFrench(
  events: readonly TaskEventData[],
): Promise<{ summary: string; tone: string }[]> {
  const modulePath = join(import.meta.dir, 'useTaskBoard.ts')
  const script = [
    `globalThis.window = { __CODESEMA_LOCALE__: 'fr' }`,
    `const board = await import(${JSON.stringify(modulePath)})`,
    `const data = ${JSON.stringify(events)}`,
    `const lines = data.map((d) => {`,
    `  const event = { seq: 1, at: '2026-08-20T09:00:00.000Z', type: 'shipped', data: d }`,
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

describe('a ship that landed short of its recap, read in French', () => {
  /** Verbatim what task-ship.ts puts in `data.note` on this path. */
  const SERVER_NOTE =
    'recap withheld from the merge request: it looks like it carries a secret (recap.md: an AWS access key id)'

  const MR = 'https://github.com/o/r/pull/9'

  test('a withheld recap is no longer indistinguishable from a nominal ship', async () => {
    // This is the defect, in the exact terms it was measured in: same type,
    // same payload shape, one green word for both.
    const [blocked, nominal] = await renderShippedInFrench([
      { mr_url: MR, note: SERVER_NOTE, name: 'recap_blocked_secrets' },
      { mr_url: MR },
    ])
    expect(nominal).toEqual({ summary: 'Publiée', tone: 'go' })
    expect(blocked).toEqual({
      summary:
        'Publiée, récapitulatif retenu : il semble porter un secret. Rien n’a été envoyé à la forge, le récapitulatif reste sur cette machine',
      // Amber, never red: the push landed and the merge request is open.
      tone: 'check',
    })
  })

  test('not one word of the server sentence reaches a French reader', async () => {
    const [blocked] = await renderShippedInFrench([
      { mr_url: MR, note: SERVER_NOTE, name: 'recap_blocked_secrets' },
    ])
    const summary = blocked?.summary ?? ''
    expect(summary).not.toContain(SERVER_NOTE)
    expect(summary).not.toContain('withheld')
    expect(summary).not.toContain('recap.md')
    expect(summary).not.toContain(MR)
  })

  test('the three ways of landing short each read in French, each on its own line', async () => {
    const names = ['recap_missing', 'recap_blocked_secrets', 'recap_unscanned'] as const
    const lines = await renderShippedInFrench(names.map((name) => ({ name, note: SERVER_NOTE })))
    expect(lines).toHaveLength(names.length)
    for (const line of lines) {
      expect(line.summary).not.toBe('Publiée')
      expect(line.summary).not.toContain(SERVER_NOTE)
      expect(line.tone).toBe('check')
    }
    expect(new Set(lines.map((line) => line.summary)).size).toBe(names.length)
  })

  test('a degraded ship with only a note reads the French label, never the English note', async () => {
    const PUSH_ONLY =
      'no forge CLI (gh or glab) available — branch pushed, open the merge request manually'
    const [pushOnly] = await renderShippedInFrench([{ mr_url: null, note: PUSH_ONLY }])
    expect(pushOnly?.summary).toBe('Publiée')
    expect(pushOnly?.summary).not.toContain('no forge CLI')
    expect(pushOnly?.summary).not.toContain(PUSH_ONLY)
  })

  test('a name this bundle does not know degrades to the plain French label, never a raw token', async () => {
    const [unknown] = await renderShippedInFrench([{ name: 'shipped_from_the_future' }])
    expect(unknown?.summary).toBe('Publiée')
    expect(unknown?.tone).toBe('go')
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
      expect(line?.phrase).not.toBe('en pause · attend votre réponse')
      // ...and not the English server detail either.
      expect(line?.phrase).not.toContain('leaks a descriptor')
      expect(line?.phrase).not.toContain('acceptance criteria')
    }
    expect(asking?.phrase).toBe('en pause · attend votre réponse')
    expect(asking?.label).toBe('Besoin de toi')
    // The whole point of the split, in the language a human actually reads:
    // the parked task and the blocked review do NOT say the same thing.
    expect(blockedReview?.label).toBe('Review bloquée')
    expect(blockedReview?.phrase).toBe('review bloquée · findings à corriger')
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

async function renderMergeInFrench(
  events: readonly TaskEventData[],
): Promise<{ summary: string; tone: string }[]> {
  const modulePath = join(import.meta.dir, 'useTaskBoard.ts')
  const script = [
    `globalThis.window = { __CODESEMA_LOCALE__: 'fr' }`,
    `const board = await import(${JSON.stringify(modulePath)})`,
    `const data = ${JSON.stringify(events)}`,
    `const lines = data.map((d) => {`,
    `  const event = { seq: 1, at: '2026-08-21T09:00:00.000Z', type: 'merge', data: d }`,
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

describe('the T3.6 merge journal, read in French', () => {
  // Every merge line carries `data.message` — the server's English refusal
  // sentence, the one that names the way out. That field is exactly the trap
  // §6 quater describes: probed by SUMMARY_KEYS, it would be served verbatim
  // to a French journal and make the translated labels unreachable.
  const SERVER_MESSAGE =
    "this repository configures no checks, so the merge condition could not be evaluated — configure checks for this repository, set mergePolicy to 'human' and merge this branch yourself, or set allowMergeWithoutChecks to true if this repository legitimately has none"

  test('the four conditions read as four DISTINCT French lines, naming which one', async () => {
    const lines = await renderMergeInFrench([
      { name: 'condition_met', condition: 'review', satisfied: true },
      {
        name: 'condition_unmet',
        condition: 'checks',
        satisfied: false,
        detail: 'unconfigured',
        message: SERVER_MESSAGE,
      },
      { name: 'condition_unmet', condition: 'criteria', satisfied: false, detail: 'absent' },
      { name: 'condition_met', condition: 'branch', satisfied: true },
    ])
    expect(lines[0]?.summary).toBe('Condition de fusion remplie · review de code')
    expect(lines[1]?.summary).toBe('Condition de fusion non remplie · checks du dépôt')
    expect(lines[2]?.summary).toBe("Condition de fusion non remplie · critères d'acceptation")
    expect(lines[3]?.summary).toBe('Condition de fusion remplie · branche à jour avec sa cible')
    // Four lines, four distinct sentences: "checked and it passed" is legible
    // as a different thing from "checked and it failed", and from each other.
    expect(new Set(lines.map((line) => line.summary)).size).toBe(4)
    // Not one word of the server's English gets through.
    for (const line of lines) {
      expect(line.summary).not.toContain('allowMergeWithoutChecks')
      expect(line.summary).not.toContain('mergePolicy')
      expect(line.summary).not.toBe('Fusion')
    }
  })

  test('every merge incident reads in French, and only the ones waiting on you are amber', async () => {
    const names = [
      'condition_met',
      'condition_unmet',
      'condition_consented',
      'merged',
      'refused',
      'policy_human',
      'failed',
      'config_degraded',
    ] as const
    const lines = await renderMergeInFrench(
      names.map((name) => ({ name, message: 'ENGLISH SENTENCE' })),
    )
    expect(lines).toHaveLength(names.length)
    for (const line of lines) {
      // 'Fusion' is the plain type label — reaching it means an unwired name.
      expect(line.summary).not.toBe('Fusion')
      expect(line.summary).not.toContain('ENGLISH SENTENCE')
      // Never red: the work is committed, the merge request is open, and what
      // is missing is a decision or a fix.
      expect(line.tone).not.toBe('stop')
    }
    expect(new Set(lines.map((line) => line.summary)).size).toBe(names.length)
    const tone = Object.fromEntries(names.map((name, i) => [name, lines[i]?.tone]))
    expect(tone.condition_unmet).toBe('check')
    expect(tone.refused).toBe('check')
    expect(tone.failed).toBe('check')
    expect(tone.merged).toBe('go')
    expect(tone.condition_met).toBe('idle')
    expect(tone.condition_consented).toBe('idle')
  })

  test("an unknown incident from a newer server degrades to the label, never to the server's English", async () => {
    const [unknown] = await renderMergeInFrench([
      { name: 'a_fifth_outcome', message: 'ENGLISH SENTENCE' },
    ])
    expect(unknown?.summary).toBe('Fusion')
    expect(unknown?.tone).toBe('idle')
  })
})

describe('the T3.6 merge refusal, read in French on the card', () => {
  test('a merge-blocked task names its blocker, never "waiting for your answer"', async () => {
    const [unavailable, missing, asking] = await renderStatusInFrench([
      {
        status: 'waiting_for_you',
        reason: {
          code: 'checks_unavailable',
          detail:
            'this repository configures no checks, so the merge condition could not be evaluated',
        },
      },
      {
        status: 'waiting_for_you',
        reason: {
          code: 'criteria_missing',
          detail: 'no acceptance criterion was ever written for this task',
        },
      },
      { status: 'waiting_for_you' },
    ])
    expect(unavailable?.label).toBe('Checks indisponibles')
    expect(unavailable?.phrase).toBe("fusion suspendue · les checks n'ont pas pu être exécutés")
    expect(missing?.label).toBe('Critères manquants')
    expect(missing?.phrase).toBe("fusion suspendue · aucun critère d'acceptation validé")
    // The two codes DP1/DP2 minted precisely so they would not be confused
    // with their neighbours: "checks failed" and "criteria not met" are the
    // opposite statements, and neither may be shown here.
    expect(unavailable?.label).not.toBe('Checks en échec')
    expect(missing?.label).not.toBe('Critères non satisfaits')
    for (const line of [unavailable, missing]) {
      expect(line?.phrase).not.toBe('en pause · attend votre réponse')
      expect(line?.phrase).not.toContain('repository')
      expect(line?.phrase).not.toContain('acceptance criterion')
    }
    expect(asking?.phrase).toBe('en pause · attend votre réponse')
  })

  // Adversarial review of T3.6, MAJEUR 1: the gate posts SIX codes on
  // `waiting_for_you` and the ticket translated two. In a French workspace the
  // other four read "Besoin de toi · en pause — attend votre réponse" — a card
  // announcing a question nobody asked, for the refusal the design note calls
  // the most frequent one on an active repository (`branch_diverged`).
  test('the four exits the ticket left behind read in French too', async () => {
    const [conflict, forge, diverged, checks] = await renderStatusInFrench([
      {
        status: 'waiting_for_you',
        reason: {
          code: 'merge_conflict',
          detail: 'gh: not mergeable — resolve the overlap on the branch',
        },
      },
      {
        status: 'waiting_for_you',
        reason: { code: 'forge_unreachable', detail: 'no forge CLI (gh or glab) available' },
      },
      {
        status: 'waiting_for_you',
        reason: {
          code: 'branch_diverged',
          detail: "this branch is behind its target 'origin/main'",
        },
      },
      {
        status: 'waiting_for_you',
        reason: { code: 'checks_failed', detail: 'repository checks failed (bun test)' },
      },
    ])
    expect(conflict?.label).toBe('Conflit de fusion')
    expect(conflict?.phrase).toBe('fusion suspendue · la branche est en conflit avec sa cible')
    expect(forge?.label).toBe('Forge injoignable')
    expect(forge?.phrase).toBe("fusion suspendue · la forge n'a pas effectué la fusion")
    expect(diverged?.label).toBe('Branche pas à jour')
    expect(diverged?.phrase).toBe("fusion suspendue · la branche n'est pas à jour avec sa cible")
    // Same code as a blocked review, and deliberately NOT its sentence: the
    // review passed, it is the merge that is held.
    expect(checks?.label).toBe('Fusion suspendue')
    expect(checks?.phrase).toBe('fusion suspendue · les checks du dépôt ont échoué')
    expect(checks?.phrase).not.toBe('review bloquée · checks en échec')
    for (const line of [conflict, forge, diverged, checks]) {
      expect(line?.phrase).not.toBe('en pause · attend votre réponse')
      expect(line?.label).not.toBe('Besoin de toi')
      // Real French, not the English catalog leaking through a missing key.
      expect(line?.phrase).not.toContain('merge held')
      expect(line?.label).not.toMatch(/^workspace\./)
    }
  })
})
