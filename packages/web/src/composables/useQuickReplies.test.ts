import { describe, expect, test } from 'bun:test'
import { extractQuickReplies } from './useQuickReplies'

describe('extractQuickReplies — inline "A ou B ?" disjunctions', () => {
  test('bare french disjunction', () => {
    expect(extractQuickReplies('Version v2 ou champ optionnel ?')).toEqual([
      'Version v2',
      'champ optionnel',
    ])
  })

  test('the question sentence is the LAST one; context sentences are ignored', () => {
    expect(
      extractQuickReplies(
        "Je casse l'API publique si je change le format du curseur. Version v2 ou champ optionnel ?",
      ),
    ).toEqual(['Version v2', 'champ optionnel'])
  })

  test('english "or" with interrogative lead-in stripped', () => {
    expect(
      extractQuickReplies('Should I version /v2/events or add an optional cursor_v2 field?'),
    ).toEqual(['version /v2/events', 'add an optional cursor_v2 field'])
  })

  test('french lead-in layers all strip: est-ce que + pronoun + verb + article', () => {
    expect(extractQuickReplies('Est-ce que tu préfères la v2 ou le champ optionnel ?')).toEqual([
      'v2',
      'le champ optionnel',
    ])
  })

  test('"Deux options : A ou B ?" — the enumeration lives after the colon', () => {
    expect(
      extractQuickReplies('Deux options : versionner en /v2/events ou ajouter cursor_v2 ?'),
    ).toEqual(['versionner en /v2/events', 'ajouter cursor_v2'])
  })

  test('yes/no phrased as a disjunction still yields both options', () => {
    expect(extractQuickReplies('On garde le cache, oui ou non ?')).toEqual(['oui', 'non'])
  })

  test('comma enumeration with a final ou', () => {
    expect(extractQuickReplies('Redis, Postgres ou SQLite ?')).toEqual([
      'Redis',
      'Postgres',
      'SQLite',
    ])
  })

  test('conditional lead-in fragment is dropped, not offered as an option', () => {
    expect(extractQuickReplies('Si tu veux, on peut versionner ou patcher ?')).toEqual([
      'versionner',
      'patcher',
    ])
  })

  test('guillemets and quotes are trimmed off the options', () => {
    expect(extractQuickReplies('«v2» ou «legacy» ?')).toEqual(['v2', 'legacy'])
  })
})

describe('extractQuickReplies — bulleted and numbered lists', () => {
  test('dash list', () => {
    expect(
      extractQuickReplies("Trois pistes :\n- garder l'offset\n- passer au curseur\n- les deux"),
    ).toEqual(["garder l'offset", 'passer au curseur', 'les deux'])
  })

  test('numbered list, both "1." and "2)" markers', () => {
    expect(extractQuickReplies('Which one?\n1. keep the offset\n2) switch to a cursor')).toEqual([
      'keep the offset',
      'switch to a cursor',
    ])
  })

  test('bullet marker • works too', () => {
    expect(extractQuickReplies('Choix :\n• option A\n• option B')).toEqual(['option A', 'option B'])
  })

  test('a list wins over an inline disjunction in the same question', () => {
    expect(extractQuickReplies('A ou B ?\n- premier choix\n- second choix')).toEqual([
      'premier choix',
      'second choix',
    ])
  })

  test('a single list item is not an enumeration', () => {
    expect(extractQuickReplies('Note :\n- un seul point\nOn continue ?')).toEqual([])
  })
})

describe('extractQuickReplies — refusals (no buttons is the honest default)', () => {
  test('open question without options', () => {
    expect(extractQuickReplies('Puis-je supprimer le fichier config.old ?')).toEqual([])
  })

  test('question without a question mark is not scanned for inline options', () => {
    expect(extractQuickReplies('Choisis entre A ou B')).toEqual([])
  })

  test('empty and whitespace-only input', () => {
    expect(extractQuickReplies('')).toEqual([])
    expect(extractQuickReplies('   \n  ')).toEqual([])
  })

  test('an over-long fragment disqualifies the whole set', () => {
    const long = 'ajouter un champ optionnel cursor_v2 avec une longue dépréciation douce en aval'
    expect(extractQuickReplies(`versionner ou ${long} ?`)).toEqual([])
  })

  test('more than four options reads as prose, not as quick replies', () => {
    expect(extractQuickReplies('lundi, mardi, mercredi, jeudi ou vendredi ?')).toEqual([])
  })

  test('case-insensitive duplicates collapse below the two-option minimum', () => {
    expect(extractQuickReplies('Redis ou redis ?')).toEqual([])
  })

  test('"or" inside a word never counts as a disjunction', () => {
    expect(extractQuickReplies('Do you want more colors?')).toEqual([])
  })
})
