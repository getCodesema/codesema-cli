import { describe, expect, test } from 'bun:test'
import {
  acceptanceCriterionId,
  CRITERION_VERDICT_EVIDENCE_MAX,
  sanitizeReview,
  TICKET_CRITERIA_MAX,
  type AcceptanceCriterion,
  type CriterionVerdict,
} from './contract.js'
import {
  buildCriteriaChapter,
  CRITERIA_REASON_IDS_MAX,
  criteriaUnmetDetail,
  mergeCriterionVerdicts,
  resolveCriteria,
} from './task-criteria-gate.js'

// --- rig ------------------------------------------------------------------

/** Ids are DERIVED from the text (T2.3), so the fixtures mint them the real way. */
function criterion(text: string): AcceptanceCriterion {
  return { id: acceptanceCriterionId(text), text }
}

const C1 = criterion('WHEN a task ships THE SYSTEM SHALL write a recap')
const C2 = criterion('WHEN checks fail THE SYSTEM SHALL block the merge')
const C3 = criterion('WHEN a criterion is unclear THE SYSTEM SHALL refuse to merge')
const TASK_CRITERIA = [C1, C2, C3]

/**
 * A real unified diff: `src/gate.ts` has two hunks (lines 10-15 and 42-43),
 * `docs/gone.md` is deleted, and `src/ghost.ts` appears nowhere.
 */
const DIFF = [
  'diff --git a/src/gate.ts b/src/gate.ts',
  'index 1111111..2222222 100644',
  '--- a/src/gate.ts',
  '+++ b/src/gate.ts',
  '@@ -10,4 +10,6 @@ export function gate() {',
  ' line10',
  '+line11',
  '+line12',
  ' line13',
  ' line14',
  ' line15',
  '@@ -40,2 +42,2 @@',
  ' line42',
  '-old line',
  '+line43',
  'diff --git a/docs/gone.md b/docs/gone.md',
  'deleted file mode 100644',
  '--- a/docs/gone.md',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-a',
  '-b',
].join('\n')

const met = (c: AcceptanceCriterion, evidence: string): CriterionVerdict => ({
  criterion_id: c.id,
  status: 'met',
  evidence,
})

const ANCHORED = 'src/gate.ts:11 — the gate is added here'

// --- the prompt chapter ---------------------------------------------------

describe('buildCriteriaChapter', () => {
  test('emits one line per criterion, each carrying its stable id', () => {
    const chapter = buildCriteriaChapter(TASK_CRITERIA)
    const lines = chapter.split('\n')
    for (const c of TASK_CRITERIA) {
      const own = lines.filter((line) => line.includes(c.id))
      expect(own).toHaveLength(1)
      expect(own[0]).toContain(c.text)
    }
  })

  test('the ids are the DERIVED ones, never a positional [C1]/[C2] renumbering', () => {
    const chapter = buildCriteriaChapter(TASK_CRITERIA)
    // Reordering the list must not change which id names which criterion:
    // that is the whole point of a text-derived id (T2.3).
    const reordered = buildCriteriaChapter([C3, C1, C2])
    for (const c of TASK_CRITERIA) {
      expect(reordered).toContain(`[${c.id}] ${c.text}`)
    }
    expect(chapter).not.toMatch(/\[C\d]/)
  })

  test('forbids the two things invariant n° 4 refuses to read', () => {
    const chapter = buildCriteriaChapter(TASK_CRITERIA)
    expect(chapter).toContain('percentage')
    expect(chapter).toContain('overall criteria verdict')
    // …and it names the anchor the evidence must open with.
    expect(chapter).toContain('"path:line"')
  })
})

// --- exactly one status per criterion --------------------------------------

describe('resolveCriteria', () => {
  test('every criterion of the task gets exactly one status, in the ticket order', () => {
    const outcome = resolveCriteria(TASK_CRITERIA, [met(C2, ANCHORED)], DIFF)
    expect(outcome.verdicts.map((v) => v.criterion_id)).toEqual([C1.id, C2.id, C3.id])
  })

  test('a criterion the model never mentioned is unclear, never absent', () => {
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [met(C1, ANCHORED), { criterion_id: C2.id, status: 'unmet' }],
      DIFF,
    )
    expect(outcome.verdicts[2]).toEqual({ criterion_id: C3.id, status: 'unclear' })
  })

  test('a criterion reported twice keeps one status: the first surviving entry', () => {
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [{ criterion_id: C1.id, status: 'unmet' }, met(C1, ANCHORED)],
      DIFF,
    )
    const forC1 = outcome.verdicts.filter((v) => v.criterion_id === C1.id)
    expect(forC1).toHaveLength(1)
    expect(forC1[0]?.status).toBe('unmet')
  })

  test('an id this task does not carry is discarded and influences no status', () => {
    const invented = acceptanceCriterionId('WHEN the model invents THE SYSTEM SHALL be ignored')
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [
        { criterion_id: invented, status: 'met', evidence: ANCHORED },
        met(C1, ANCHORED),
        met(C2, ANCHORED),
        met(C3, ANCHORED),
      ],
      DIFF,
    )
    expect(outcome.verdicts).toHaveLength(3)
    expect(outcome.verdicts.map((v) => v.criterion_id)).not.toContain(invented)
    expect(outcome.unknown_ids).toBe(1)
    // The discarded entry did not push the tally anywhere either.
    expect(outcome.counts).toEqual({ met: 3, unmet: 0, unclear: 0 })
    expect(outcome.satisfied).toBe(true)
  })

  test('an evidence outside the diff is removed and takes the met down to unclear', () => {
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [met(C1, 'src/ghost.ts:3 — never in this diff'), met(C2, ANCHORED), met(C3, ANCHORED)],
      DIFF,
    )
    expect(outcome.verdicts[0]).toEqual({ criterion_id: C1.id, status: 'unclear' })
    expect(outcome.verdicts[0]?.evidence).toBeUndefined()
    expect(outcome.satisfied).toBe(false)
  })

  test('an evidence on a diff file but outside every hunk is removed the same way', () => {
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [met(C1, 'src/gate.ts:99 — outside both hunks'), met(C2, ANCHORED), met(C3, ANCHORED)],
      DIFF,
    )
    expect(outcome.verdicts[0]).toEqual({ criterion_id: C1.id, status: 'unclear' })
  })

  test('a met with no evidence at all is unclear: a positive claim needs a proof', () => {
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [{ criterion_id: C1.id, status: 'met' }, met(C2, ANCHORED), met(C3, ANCHORED)],
      DIFF,
    )
    expect(outcome.verdicts[0]?.status).toBe('unclear')
  })

  test('an evidence with no path:line anchor at all is not a proof either', () => {
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [met(C1, 'I checked and it is definitely done'), met(C2, ANCHORED), met(C3, ANCHORED)],
      DIFF,
    )
    expect(outcome.verdicts[0]?.status).toBe('unclear')
  })

  test('an anchored met survives with its evidence intact', () => {
    const outcome = resolveCriteria(TASK_CRITERIA, [met(C1, ANCHORED)], DIFF)
    expect(outcome.verdicts[0]).toEqual({ criterion_id: C1.id, status: 'met', evidence: ANCHORED })
  })

  test('the second hunk of a file anchors just as well as the first', () => {
    const outcome = resolveCriteria(TASK_CRITERIA, [met(C1, 'src/gate.ts:43 — second hunk')], DIFF)
    expect(outcome.verdicts[0]?.status).toBe('met')
  })

  test('an unreadable diff degrades instead of throwing, and passes nothing', () => {
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [met(C1, ANCHORED), met(C2, ANCHORED), met(C3, ANCHORED)],
      'this is not a diff',
    )
    expect(outcome.report.diff_unreadable).toBe(true)
    expect(outcome.counts).toEqual({ met: 0, unmet: 0, unclear: 3 })
    expect(outcome.satisfied).toBe(false)
  })

  test('a wildly malformed report never throws and settles every criterion', () => {
    const junk = [
      null,
      42,
      'met',
      { criterion_id: C1.id },
      { criterion_id: C1.id, status: 'partial' },
    ] as unknown as CriterionVerdict[]
    expect(() => resolveCriteria(TASK_CRITERIA, junk, DIFF)).not.toThrow()
    const outcome = resolveCriteria(TASK_CRITERIA, junk, DIFF)
    expect(outcome.verdicts).toHaveLength(3)
    expect(outcome.counts.met).toBe(0)
  })

  test('a task with no criteria is never "satisfied" by vacuity', () => {
    expect(resolveCriteria([], [], DIFF).satisfied).toBe(false)
  })
})

// --- the global verdict, computed here and nowhere else ---------------------

describe('the global verdict (invariant n° 4)', () => {
  test('all met with anchored evidence → satisfied', () => {
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [met(C1, ANCHORED), met(C2, 'src/gate.ts:12 x'), met(C3, 'src/gate.ts:43 y')],
      DIFF,
    )
    expect(outcome.satisfied).toBe(true)
  })

  test('a single unmet blocks, whatever the model asserts about the whole', () => {
    // The model's own "everything is satisfied" travels in the review body and
    // is NOT part of what the gate reads: the discriminating input is the same
    // list of statuses with one 'unmet' in it.
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [met(C1, ANCHORED), { criterion_id: C2.id, status: 'unmet' }, met(C3, 'src/gate.ts:43 y')],
      DIFF,
    )
    expect(outcome.satisfied).toBe(false)
    expect(outcome.counts.unmet).toBe(1)
  })

  test('a single unclear blocks exactly as hard as an unmet', () => {
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [met(C1, ANCHORED), met(C2, 'src/gate.ts:12 x'), { criterion_id: C3.id, status: 'unclear' }],
      DIFF,
    )
    expect(outcome.satisfied).toBe(false)
    expect(outcome.counts).toEqual({ met: 2, unmet: 0, unclear: 1 })
  })

  test('a percentage or a global claim in the model output reaches nothing', () => {
    // sanitizeReview is the only door the model's JSON comes through: whatever
    // it writes beside `criteria` is not carried onto the record at all.
    const review = sanitizeReview({
      verdict: 'approve',
      completion_percent: 100,
      criteria_verdict: 'all satisfied',
      criteria: [
        { criterion_id: C1.id, status: 'met', evidence: ANCHORED },
        { criterion_id: C2.id, status: 'unmet' },
        { criterion_id: C3.id, status: 'met', evidence: 'src/gate.ts:43 y' },
      ],
    })
    expect(review).not.toHaveProperty('completion_percent')
    expect(review).not.toHaveProperty('criteria_verdict')
    expect(resolveCriteria(TASK_CRITERIA, review.criteria, DIFF).satisfied).toBe(false)
  })
})

// --- the readable reason ---------------------------------------------------

describe('criteriaUnmetDetail', () => {
  test('leads with the complete counts and names the blocking criteria', () => {
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [met(C1, ANCHORED), { criterion_id: C2.id, status: 'unmet' }],
      DIFF,
    )
    const detail = criteriaUnmetDetail(outcome)
    expect(detail).toContain('2 of 3')
    expect(detail).toContain('1 unmet')
    expect(detail).toContain('1 unclear')
    expect(detail).toContain(`${C2.id}: unmet`)
    expect(detail).toContain(`${C3.id}: unclear`)
    // The one that passed is not named as a problem.
    expect(detail).not.toContain(C1.id)
  })

  test('an unreadable diff is NAMED, not folded into a plain pile of unclears', () => {
    const blind = criteriaUnmetDetail(
      resolveCriteria(TASK_CRITERIA, [met(C1, ANCHORED)], 'this is not a diff'),
    )
    const judged = criteriaUnmetDetail(
      resolveCriteria(TASK_CRITERIA, [{ criterion_id: C1.id, status: 'unclear' }], DIFF),
    )
    // Same tally on both sides — 3 unclear — so the tally alone cannot be the
    // discriminator: the sentence has to carry the reason.
    expect(blind).toContain('3 unclear')
    expect(judged).toContain('3 unclear')
    expect(blind).toContain('could not be indexed')
    expect(judged).not.toContain('could not be indexed')
  })

  test('stops naming ids past the cap but keeps the counts exact', () => {
    const many = Array.from({ length: CRITERIA_REASON_IDS_MAX + 3 }, (_, i) =>
      criterion(`WHEN case ${i} happens THE SYSTEM SHALL handle it`),
    )
    const detail = criteriaUnmetDetail(resolveCriteria(many, [], DIFF))
    expect(detail).toContain(`${many.length} of ${many.length}`)
    expect(detail).toContain(`${many.length} unclear`)
    expect(detail).toContain('…')
    expect(detail).not.toContain(many[CRITERIA_REASON_IDS_MAX]?.id as string)
  })
})

// --- dual-lane reconciliation ----------------------------------------------

describe('mergeCriterionVerdicts (dual)', () => {
  test('the pessimistic status wins on a disagreement', () => {
    const merged = mergeCriterionVerdicts(
      [met(C1, ANCHORED), met(C2, ANCHORED)],
      [
        { criterion_id: C1.id, status: 'unmet' },
        { criterion_id: C2.id, status: 'unclear' },
      ],
    )
    expect(merged).toEqual([
      { criterion_id: C1.id, status: 'unmet' },
      { criterion_id: C2.id, status: 'unclear' },
    ])
  })

  test('a named failure beats a shrug, whichever lane produced it', () => {
    expect(
      mergeCriterionVerdicts(
        [{ criterion_id: C1.id, status: 'unclear' }],
        [{ criterion_id: C1.id, status: 'unmet' }],
      ),
    ).toEqual([{ criterion_id: C1.id, status: 'unmet' }])
    expect(
      mergeCriterionVerdicts(
        [{ criterion_id: C1.id, status: 'unmet' }],
        [{ criterion_id: C1.id, status: 'unclear' }],
      ),
    ).toEqual([{ criterion_id: C1.id, status: 'unmet' }])
  })

  test('two agreeing met keep the evidence of the entry that won', () => {
    expect(mergeCriterionVerdicts([met(C1, ANCHORED)], [met(C1, 'src/gate.ts:12 other')])).toEqual([
      met(C1, ANCHORED),
    ])
  })

  test('a criterion only one lane judged still travels', () => {
    expect(mergeCriterionVerdicts([met(C1, ANCHORED)], undefined)).toEqual([met(C1, ANCHORED)])
    expect(mergeCriterionVerdicts(undefined, [met(C2, ANCHORED)])).toEqual([met(C2, ANCHORED)])
    expect(mergeCriterionVerdicts(undefined, undefined)).toEqual([])
  })

  test('ARBITRATED (round 2, mineur 6): one lane’s SILENCE is not a doubt', () => {
    // Both lanes answered, each about a different criterion. The pessimistic
    // rule applies between statuses two lanes both STATED; where only one
    // spoke, its status stands — so dual mode is no stricter here than simple
    // mode, where the same single reviewer's word would also stand.
    //
    // The stricter reading ("a criterion only one lane spoke about is
    // unclear") was refused on purpose: it makes a quiet lane — a truncated
    // answer, a prosecutor that skipped the chapter — block every ticketed
    // task in dual mode, which is the failure mode majeur 2 had to close on
    // the neighbouring branch.
    const merged = mergeCriterionVerdicts([met(C1, ANCHORED)], [met(C2, ANCHORED)])
    expect(merged).toEqual([met(C1, ANCHORED), met(C2, ANCHORED)])

    // …and that is not a hole in the gate: the criterion NEITHER lane spoke
    // about is still forced to `unclear`, and every surviving evidence is
    // still grounded against the diff.
    const outcome = resolveCriteria(TASK_CRITERIA, merged, DIFF)
    expect(outcome.verdicts[2]).toEqual({ criterion_id: C3.id, status: 'unclear' })
    expect(outcome.satisfied).toBe(false)
  })
})

// --- bounds -----------------------------------------------------------------

describe('bounds', () => {
  test('an oversized evidence is truncated by the contract, not by this module', () => {
    const long = `src/gate.ts:11 ${'x'.repeat(CRITERION_VERDICT_EVIDENCE_MAX * 2)}`
    const review = sanitizeReview({
      criteria: [{ criterion_id: C1.id, status: 'met', evidence: long }],
    })
    const evidence = review.criteria?.[0]?.evidence ?? ''
    expect([...evidence].length).toBe(CRITERION_VERDICT_EVIDENCE_MAX)
    // …and what survives is still anchored, so the truncation does not itself
    // turn a proven criterion into an unclear one.
    expect(resolveCriteria([C1], review.criteria, DIFF).verdicts[0]?.status).toBe('met')
  })
})

// --- round 2, majeur 1(a): the gate reads a decorated anchor as an anchor ---

describe('the gate does not charge a formatting tax to the work', () => {
  // The reproduction the verification filed, kept verbatim: the SAME criterion
  // with the SAME proof, decorated four ways. It used to pass on exactly one
  // of them.
  const DECORATIONS = [
    ['bare, the form the prompt asks for', 'src/gate.ts:11 — the gate lands here'],
    ['backticked', '`src/gate.ts:11` — the gate lands here'],
    ['quoted', '"src/gate.ts:11" — the gate lands here'],
    ['the b/ side the diff itself prints', 'b/src/gate.ts:11 — the gate lands here'],
    ['behind prose', 'the gate lands here, at src/gate.ts:11'],
  ] as const

  for (const [name, evidence] of DECORATIONS) {
    test(`a proof written ${name} still satisfies the gate`, () => {
      const outcome = resolveCriteria(
        TASK_CRITERIA,
        [met(C1, evidence), met(C2, evidence), met(C3, evidence)],
        DIFF,
      )
      expect(outcome.satisfied).toBe(true)
      expect(outcome.counts).toEqual({ met: 3, unmet: 0, unclear: 0 })
    })
  }

  test('…and a decorated anchor that points nowhere still blocks', () => {
    // The other half of the arbitration: recognition widened, severity did not.
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [met(C1, '`src/ghost.ts:11` — never in this diff'), met(C2, ANCHORED), met(C3, ANCHORED)],
      DIFF,
    )
    expect(outcome.satisfied).toBe(false)
    expect(outcome.verdicts[0]).toEqual({ criterion_id: C1.id, status: 'unclear' })
  })
})

// --- round 2, mineur 5: the 32-entry ceiling falls on the noise -------------

describe('the contract ceiling never eats a real verdict first', () => {
  /** `n` well-formed ids no ticket carries. */
  const foreign = (n: number): CriterionVerdict[] =>
    Array.from({ length: n }, (_, i) => ({
      criterion_id: `ac-${i.toString(16).padStart(12, '0')}`,
      status: 'met' as const,
      evidence: ANCHORED,
    }))

  test('32 foreign ids in front of the real verdicts no longer push them out', () => {
    // Measured before the fix: `{met:0, unmet:0, unclear:3}` — three anchored
    // `met` lost at the ceiling, and not one counter said so.
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [...foreign(TICKET_CRITERIA_MAX), met(C1, ANCHORED), met(C2, ANCHORED), met(C3, ANCHORED)],
      DIFF,
    )
    expect(outcome.counts).toEqual({ met: 3, unmet: 0, unclear: 0 })
    expect(outcome.satisfied).toBe(true)
    expect(outcome.unknown_ids).toBe(TICKET_CRITERIA_MAX)
    expect(outcome.overflowed).toBe(false)
  })

  test('a list already cut to the ceiling upstream SAYS it may have been cut', () => {
    // The production shape: `sanitizeReview` capped the archive at 32 long
    // before this gate read it, so the real verdicts are simply gone. Nothing
    // here can bring them back — but the tally must stop reading like a
    // reviewer that judged and doubted.
    const outcome = resolveCriteria(TASK_CRITERIA, foreign(TICKET_CRITERIA_MAX), DIFF)
    expect(outcome.counts).toEqual({ met: 0, unmet: 0, unclear: 3 })
    expect(outcome.overflowed).toBe(true)
    expect(outcome.unjudged).toBe(3)
    expect(criteriaUnmetDetail(outcome)).toContain('ceiling')
  })

  test('a full, correct list of verdicts is not accused of overflowing', () => {
    const many = Array.from({ length: TICKET_CRITERIA_MAX }, (_, i) =>
      criterion(`WHEN case ${i} happens THE SYSTEM SHALL handle it`),
    )
    const outcome = resolveCriteria(
      many,
      many.map((c) => met(c, ANCHORED)),
      DIFF,
    )
    expect(outcome.overflowed).toBe(false)
    expect(outcome.satisfied).toBe(true)
  })

  test('a foreign id repeated many times is still ONE unknown id', () => {
    const dup = { criterion_id: 'ac-0123456789ab', status: 'met' as const }
    const outcome = resolveCriteria(TASK_CRITERIA, [dup, { ...dup }, { ...dup }], DIFF)
    expect(outcome.unknown_ids).toBe(1)
  })
})

// --- round 2, majeur 1(b): the causes are measured AND said -----------------

describe('the gate says WHY, not only how many', () => {
  test('"the reviewer judged and doubted" and "nothing came back" stop reading alike', () => {
    // Both produce `{met:0, unmet:0, unclear:3}`. That tally was the whole
    // message, so a human read "the reviewer is unsure" for both.
    const doubted = resolveCriteria(
      TASK_CRITERIA,
      TASK_CRITERIA.map((c) => ({ criterion_id: c.id, status: 'unclear' as const })),
      DIFF,
    )
    const silent = resolveCriteria(TASK_CRITERIA, undefined, DIFF)
    expect(doubted.counts).toEqual(silent.counts)

    expect(doubted.unjudged).toBe(0)
    expect(silent.unjudged).toBe(3)
    expect(criteriaUnmetDetail(doubted)).not.toContain('no verdict back')
    expect(criteriaUnmetDetail(silent)).toContain(
      '3 criteria got no verdict back from the reviewer',
    )
  })

  test('the three shapes of "nothing usable came back" all read as unjudged', () => {
    // A reviewer that said nothing, one that named its criteria in prose
    // instead of in `criterion_id`, and a `criteria` that was not even an
    // array: three different accidents, one honest description.
    const shapes: unknown[] = [
      undefined,
      [{ criterion_id: 'the first one', status: 'met' }],
      'every criterion is met',
    ]
    for (const reported of shapes) {
      const outcome = resolveCriteria(TASK_CRITERIA, reported as CriterionVerdict[], DIFF)
      expect(outcome.unjudged).toBe(3)
      expect(outcome.unknown_ids).toBe(0)
      expect(criteriaUnmetDetail(outcome)).toContain('no verdict back')
    }
  })

  test('an evidence that pointed nowhere is NAMED, not folded into the unclear pile', () => {
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [met(C1, 'src/ghost.ts:3 — never in this diff'), met(C2, ANCHORED), met(C3, ANCHORED)],
      DIFF,
    )
    expect(outcome.dropped_evidence).toBe(1)
    expect(outcome.demoted).toBe(1)
    const detail = criteriaUnmetDetail(outcome)
    expect(detail).toContain('1 evidence quote pointed at a line this diff does not carry')
    expect(detail).toContain("1 verdict fell back to 'unclear'")
  })

  test('a met with no evidence at all is demoted but nothing was dropped', () => {
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [{ criterion_id: C1.id, status: 'met' }, met(C2, ANCHORED), met(C3, ANCHORED)],
      DIFF,
    )
    expect(outcome.dropped_evidence).toBe(0)
    expect(outcome.demoted).toBe(1)
    const detail = criteriaUnmetDetail(outcome)
    expect(detail).not.toContain('pointed at a line')
    expect(detail).toContain("1 verdict fell back to 'unclear'")
  })

  test('a reviewer that judged criteria this ticket does not carry is said out loud', () => {
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [{ criterion_id: 'ac-0123456789ab', status: 'met', evidence: ANCHORED }],
      DIFF,
    )
    expect(criteriaUnmetDetail(outcome)).toContain('1 id this task does not carry')
  })

  test('an unindexable diff still leads, and swallows the anchor causes', () => {
    // Blaming the reviewer for evidence that "pointed nowhere" would be a lie
    // when nothing at all could be indexed: the failure is on our side.
    const outcome = resolveCriteria(TASK_CRITERIA, [met(C1, ANCHORED)], 'this is not a diff')
    expect(outcome.report.diff_unreadable).toBe(true)
    const detail = criteriaUnmetDetail(outcome)
    expect(detail).toContain('could not be indexed')
    expect(detail).not.toContain('pointed at a line')
  })

  test('a gate blocked on judgement alone says nothing extra', () => {
    // The discriminator against "the sentence always tacks a cause on": a real
    // `unmet`, judged, anchored, with nothing anomalous around it.
    const outcome = resolveCriteria(
      TASK_CRITERIA,
      [met(C1, ANCHORED), { criterion_id: C2.id, status: 'unmet' }, met(C3, ANCHORED)],
      DIFF,
    )
    const detail = criteriaUnmetDetail(outcome)
    expect(detail).toContain('1 unmet')
    expect(detail).not.toContain('no verdict back')
    expect(detail).not.toContain('pointed at a line')
    expect(detail).not.toContain('ceiling')
    expect(detail).not.toContain('does not carry')
    expect(detail).not.toContain('could not be indexed')
  })

  test('the counts are pluralised, so the sentence never reads "1 criteria"', () => {
    const one = resolveCriteria([C1, C2, C3], [met(C2, ANCHORED), met(C3, ANCHORED)], DIFF)
    expect(criteriaUnmetDetail(one)).toContain('1 criterion got no verdict back')
    const two = resolveCriteria([C1, C2, C3], [met(C3, ANCHORED)], DIFF)
    expect(criteriaUnmetDetail(two)).toContain('2 criteria got no verdict back')
  })
})

// --- round 2, mineur 4: the cap is a VALUE, not whatever the constant says ---

describe('CRITERIA_REASON_IDS_MAX', () => {
  test('is 6, pinned to the number and not to itself', () => {
    // The test that exercised the cap built `CRITERIA_REASON_IDS_MAX + 3`
    // criteria: parameterised by the very constant it was meant to fix, so
    // raising it to 100 changed nothing and reddened nothing.
    expect(CRITERIA_REASON_IDS_MAX).toBe(6)
  })

  test('names exactly six blocking ids out of nine, then stops', () => {
    const nine = Array.from({ length: 9 }, (_, i) =>
      criterion(`WHEN case ${i} happens THE SYSTEM SHALL handle it`),
    )
    const detail = criteriaUnmetDetail(resolveCriteria(nine, [], DIFF))
    const named = nine.filter((c) => detail.includes(c.id))
    expect(named).toHaveLength(6)
    // …the first six, in the ticket's own order, and the rest behind an ellipsis.
    expect(named.map((c) => c.id)).toEqual(nine.slice(0, 6).map((c) => c.id))
    expect(detail).toContain('…')
    // The COUNTS stay complete whatever the cap does to the names.
    expect(detail).toContain('9 of 9')
    expect(detail).toContain('9 unclear')
  })
})
