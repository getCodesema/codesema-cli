import { describe, expect, test } from 'bun:test'
import { parsePartialReview, repairTruncatedJson } from './partial.js'

const FULL = JSON.stringify({
  verdict: 'request_changes',
  summary: 'Deux problèmes de gestion d’erreur.',
  findings: [
    {
      file: 'src/a.ts',
      line: 12,
      severity: 'major',
      kind: 'design',
      title: 'Erreur avalée',
      message: 'Le catch vide masque la panne.',
    },
    {
      file: 'src/b.ts',
      severity: 'minor',
      kind: 'convention',
      title: 'Nommage',
      message: 'Renommer x en userCount.',
    },
  ],
  narrative: {
    intent: 'Fiabiliser les erreurs',
    confidence: 'high',
    steps: [{ title: 'Fondations' }],
  },
})

describe('repairTruncatedJson', () => {
  test('complete JSON returned as-is', () => {
    expect(JSON.parse(repairTruncatedJson(FULL)!)).toEqual(JSON.parse(FULL))
  })

  test('ignores prose and fence before the object', () => {
    const repaired = repairTruncatedJson('Sure!\n```json\n{"verdict":"approve"}\n```')
    expect(JSON.parse(repaired!)).toEqual({ verdict: 'approve' })
  })

  test('open string closed properly', () => {
    const repaired = repairTruncatedJson('{"verdict":"approve","summary":"tout va bi')
    expect(JSON.parse(repaired!)).toEqual({ verdict: 'approve', summary: 'tout va bi' })
  })

  test('partial key at end of buffer removed', () => {
    const repaired = repairTruncatedJson('{"verdict":"approve","summ')
    expect(JSON.parse(repaired!)).toEqual({ verdict: 'approve' })
  })

  test('complete key without value removed', () => {
    const repaired = repairTruncatedJson('{"verdict":"approve","summary":')
    expect(JSON.parse(repaired!)).toEqual({ verdict: 'approve' })
  })

  test('array truncated in the middle of an object', () => {
    const repaired = repairTruncatedJson(
      '{"findings":[{"file":"a.ts","message":"ok"},{"file":"b.ts","mess',
    )
    expect(JSON.parse(repaired!)).toEqual({
      findings: [{ file: 'a.ts', message: 'ok' }, { file: 'b.ts' }],
    })
  })

  test('escape sequence cut at end of string', () => {
    const repaired = repairTruncatedJson('{"summary":"avec \\')
    expect(JSON.parse(repaired!)).toEqual({ summary: 'avec ' })
  })

  test('incomplete unicode sequence purged', () => {
    const repaired = repairTruncatedJson('{"summary":"caf\\u00e')
    expect(JSON.parse(repaired!)).toEqual({ summary: 'caf' })
  })

  test('incomplete literal cut off', () => {
    const repaired = repairTruncatedJson('{"verdict":"approve","line":12,"ok":tru')
    expect(JSON.parse(repaired!)).toEqual({ verdict: 'approve', line: 12 })
  })

  test('no object started: null', () => {
    expect(repairTruncatedJson('The review is coming')).toBeNull()
  })
})

describe('parsePartialReview', () => {
  test('complete review', () => {
    const partial = parsePartialReview(FULL)!
    expect(partial.verdict).toBe('request_changes')
    expect(partial.summary).toContain('gestion d’erreur')
    expect(partial.findings).toHaveLength(2)
    expect(partial.findings[0]).toMatchObject({ file: 'src/a.ts', line: 12, severity: 'major' })
    expect(partial.stepTitles).toEqual(['Fondations'])
    expect(partial.intent).toBe('Fiabiliser les erreurs')
  })

  test('progressive prefix: each slice parses or returns null, without throwing', () => {
    for (let cut = 1; cut <= FULL.length; cut++) {
      const partial = parsePartialReview(FULL.slice(0, cut))
      if (cut === FULL.length) {
        expect(partial?.findings).toHaveLength(2)
      }
    }
  })

  test('finding without file/message ignored', () => {
    const partial = parsePartialReview(
      '{"verdict":"comment","findings":[{"file":"a.ts"},{"file":"b.ts","message":"ok"}]}',
    )!
    expect(partial.findings).toEqual([{ file: 'b.ts', message: 'ok' }])
  })

  test('buffer without any useful field: null', () => {
    expect(parsePartialReview('{"foo":1}')).toBeNull()
    expect(parsePartialReview('')).toBeNull()
  })
})
