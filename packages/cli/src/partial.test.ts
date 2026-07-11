import { describe, expect, test } from 'bun:test'
import { parsePartialReview, repairTruncatedJson } from './partial.js'

const FULL = JSON.stringify({
  verdict: 'request_changes',
  summary: 'Deux problèmes de gestion d’erreur.',
  findings: [
    { file: 'src/a.ts', line: 12, severity: 'major', kind: 'design', title: 'Erreur avalée', message: 'Le catch vide masque la panne.' },
    { file: 'src/b.ts', severity: 'minor', kind: 'convention', title: 'Nommage', message: 'Renommer x en userCount.' },
  ],
  narrative: { intent: 'Fiabiliser les erreurs', confidence: 'high', chapters: [{ title: 'Fondations' }] },
})

describe('repairTruncatedJson', () => {
  test('JSON complet rendu tel quel', () => {
    expect(JSON.parse(repairTruncatedJson(FULL)!)).toEqual(JSON.parse(FULL))
  })

  test('ignore la prose et le fence avant l’objet', () => {
    const repaired = repairTruncatedJson('Sure!\n```json\n{"verdict":"approve"}\n```')
    expect(JSON.parse(repaired!)).toEqual({ verdict: 'approve' })
  })

  test('string ouverte fermée proprement', () => {
    const repaired = repairTruncatedJson('{"verdict":"approve","summary":"tout va bi')
    expect(JSON.parse(repaired!)).toEqual({ verdict: 'approve', summary: 'tout va bi' })
  })

  test('clé partielle en fin de buffer supprimée', () => {
    const repaired = repairTruncatedJson('{"verdict":"approve","summ')
    expect(JSON.parse(repaired!)).toEqual({ verdict: 'approve' })
  })

  test('clé complète sans valeur supprimée', () => {
    const repaired = repairTruncatedJson('{"verdict":"approve","summary":')
    expect(JSON.parse(repaired!)).toEqual({ verdict: 'approve' })
  })

  test('tableau tronqué au milieu d’un objet', () => {
    const repaired = repairTruncatedJson('{"findings":[{"file":"a.ts","message":"ok"},{"file":"b.ts","mess')
    expect(JSON.parse(repaired!)).toEqual({ findings: [{ file: 'a.ts', message: 'ok' }, { file: 'b.ts' }] })
  })

  test('échappement coupé en fin de string', () => {
    const repaired = repairTruncatedJson('{"summary":"avec \\')
    expect(JSON.parse(repaired!)).toEqual({ summary: 'avec ' })
  })

  test('séquence unicode incomplète purgée', () => {
    const repaired = repairTruncatedJson('{"summary":"caf\\u00e')
    expect(JSON.parse(repaired!)).toEqual({ summary: 'caf' })
  })

  test('littéral incomplet coupé', () => {
    const repaired = repairTruncatedJson('{"verdict":"approve","line":12,"ok":tru')
    expect(JSON.parse(repaired!)).toEqual({ verdict: 'approve', line: 12 })
  })

  test('aucun objet commencé → null', () => {
    expect(repairTruncatedJson('The review is coming')).toBeNull()
  })
})

describe('parsePartialReview', () => {
  test('review complète', () => {
    const partial = parsePartialReview(FULL)!
    expect(partial.verdict).toBe('request_changes')
    expect(partial.summary).toContain('gestion d’erreur')
    expect(partial.findings).toHaveLength(2)
    expect(partial.findings[0]).toMatchObject({ file: 'src/a.ts', line: 12, severity: 'major' })
    expect(partial.chapterTitles).toEqual(['Fondations'])
    expect(partial.intent).toBe('Fiabiliser les erreurs')
  })

  test('préfixe progressif : chaque tranche parse ou rend null, sans throw', () => {
    for (let cut = 1; cut <= FULL.length; cut++) {
      const partial = parsePartialReview(FULL.slice(0, cut))
      if (cut === FULL.length) expect(partial?.findings).toHaveLength(2)
    }
  })

  test('finding sans file/message ignoré', () => {
    const partial = parsePartialReview('{"verdict":"comment","findings":[{"file":"a.ts"},{"file":"b.ts","message":"ok"}]}')!
    expect(partial.findings).toEqual([{ file: 'b.ts', message: 'ok' }])
  })

  test('buffer sans aucun champ utile → null', () => {
    expect(parsePartialReview('{"foo":1}')).toBeNull()
    expect(parsePartialReview('')).toBeNull()
  })
})
