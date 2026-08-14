import { describe, expect, test } from 'bun:test'
import { columnKey, forkDraft, workonDraft } from './useColumns'
import {
  deckCloseDraft,
  deckCloseProject,
  deckCloseTask,
  deckKeys,
  deckOpenDraft,
  deckOpenTask,
  deckPromoteDraft,
  deckSwapDraft,
  deckTogglePin,
  EMPTY_DECK,
  isPinned,
} from './useFocusDeck'

const P = 'proj1'

describe('deckOpenTask', () => {
  test('first open shows the conversation alone', () => {
    const deck = deckOpenTask(EMPTY_DECK, P, 'a')
    expect(deckKeys(deck)).toEqual(['proj1/a'])
  })

  test('opening again is a no-op (same reference: watchers stay quiet)', () => {
    const deck = deckOpenTask(EMPTY_DECK, P, 'a')
    expect(deckOpenTask(deck, P, 'a')).toBe(deck)
  })

  test('nothing pinned: the newcomer REPLACES the shown conversation', () => {
    const deck = deckOpenTask(deckOpenTask(EMPTY_DECK, P, 'a'), P, 'b')
    expect(deckKeys(deck)).toEqual(['proj1/b'])
  })

  test('a pinned conversation stays; the newcomer opens alongside it', () => {
    let deck = deckOpenTask(EMPTY_DECK, P, 'a')
    deck = deckTogglePin(deck, 'proj1/a')
    deck = deckOpenTask(deck, P, 'b')
    expect(deckKeys(deck)).toEqual(['proj1/a', 'proj1/b'])
  })

  test('the unpinned column is the one replaced, in its own slot', () => {
    let deck = deckOpenTask(EMPTY_DECK, P, 'a')
    deck = deckTogglePin(deck, 'proj1/a')
    deck = deckOpenTask(deck, P, 'b') // a(pinned) | b
    deck = deckOpenTask(deck, P, 'c') // a(pinned) | c — b replaced in place
    expect(deckKeys(deck)).toEqual(['proj1/a', 'proj1/c'])
  })

  test('two pins + one loose: three columns, the loose slot rotates', () => {
    let deck = deckOpenTask(EMPTY_DECK, P, 'a')
    deck = deckTogglePin(deck, 'proj1/a')
    deck = deckOpenTask(deck, P, 'b')
    deck = deckTogglePin(deck, 'proj1/b')
    deck = deckOpenTask(deck, P, 'c')
    expect(deckKeys(deck)).toEqual(['proj1/a', 'proj1/b', 'proj1/c'])
    deck = deckOpenTask(deck, P, 'd')
    expect(deckKeys(deck)).toEqual(['proj1/a', 'proj1/b', 'proj1/d'])
  })

  test('deck full of pins: FIFO evicts the oldest pin, pin pruned with it', () => {
    let deck = deckOpenTask(EMPTY_DECK, P, 'a')
    deck = deckTogglePin(deck, 'proj1/a')
    deck = deckOpenTask(deck, P, 'b')
    deck = deckTogglePin(deck, 'proj1/b')
    deck = deckOpenTask(deck, P, 'c')
    deck = deckTogglePin(deck, 'proj1/c')
    deck = deckOpenTask(deck, P, 'd')
    expect(deckKeys(deck)).toEqual(['proj1/d', 'proj1/b', 'proj1/c'])
    expect(isPinned(deck, 'proj1/a')).toBe(false)
    expect(isPinned(deck, 'proj1/b')).toBe(true)
  })

  test('unpinning turns a column back into the replacement target', () => {
    let deck = deckOpenTask(EMPTY_DECK, P, 'a')
    deck = deckTogglePin(deck, 'proj1/a')
    deck = deckOpenTask(deck, P, 'b')
    deck = deckTogglePin(deck, 'proj1/a') // unpin a
    deck = deckOpenTask(deck, P, 'c')
    // Both a and b were loose: c replaces the FIRST and the other closes —
    // "shows alone when nothing is pinned".
    expect(deckKeys(deck)).toEqual(['proj1/c'])
  })
})

describe('drafts in the deck', () => {
  test('a draft keeps its column when a conversation opens', () => {
    let deck = deckOpenDraft(EMPTY_DECK, P, forkDraft('main'))
    deck = deckOpenTask(deck, P, 'a')
    expect(deckKeys(deck)).toEqual(['proj1/#draft/fork/main', 'proj1/a'])
  })

  test('opening a draft replaces the unpinned conversation', () => {
    let deck = deckOpenTask(EMPTY_DECK, P, 'a')
    deck = deckOpenDraft(deck, P, workonDraft('fix/x', null))
    expect(deckKeys(deck)).toEqual(['proj1/#draft/workon/fix/x'])
  })

  test('same draft twice is a no-op', () => {
    const deck = deckOpenDraft(EMPTY_DECK, P, forkDraft('main'))
    expect(deckOpenDraft(deck, P, forkDraft('main'))).toBe(deck)
  })

  test('drafts are not pinnable', () => {
    const deck = deckOpenDraft(EMPTY_DECK, P, forkDraft('main'))
    expect(deckTogglePin(deck, 'proj1/#draft/fork/main')).toBe(deck)
  })

  test('mode swap keeps the slot and the other columns', () => {
    let deck = deckOpenTask(EMPTY_DECK, P, 'a')
    deck = deckTogglePin(deck, 'proj1/a')
    deck = deckOpenDraft(deck, P, forkDraft('fix/x'))
    deck = deckSwapDraft(deck, P, forkDraft('fix/x'), workonDraft('fix/x', 'main'))
    expect(deckKeys(deck)).toEqual(['proj1/a', 'proj1/#draft/workon/fix/x'])
    expect(isPinned(deck, 'proj1/a')).toBe(true)
  })

  test('promotion turns the draft column into the task column in place', () => {
    let deck = deckOpenTask(EMPTY_DECK, P, 'a')
    deck = deckTogglePin(deck, 'proj1/a')
    deck = deckOpenDraft(deck, P, forkDraft('main'))
    deck = deckPromoteDraft(deck, P, forkDraft('main'), 'b')
    expect(deckKeys(deck)).toEqual(['proj1/a', 'proj1/b'])
    // The promoted conversation is unpinned: the next open replaces it.
    deck = deckOpenTask(deck, P, 'c')
    expect(deckKeys(deck)).toEqual(['proj1/a', 'proj1/c'])
  })
})

describe('pin toggle and closes', () => {
  test('pinning an unknown key is a no-op', () => {
    const deck = deckOpenTask(EMPTY_DECK, P, 'a')
    expect(deckTogglePin(deck, 'proj1/ghost')).toBe(deck)
  })

  test('closing a pinned conversation drops its pin', () => {
    let deck = deckOpenTask(EMPTY_DECK, P, 'a')
    deck = deckTogglePin(deck, 'proj1/a')
    deck = deckCloseTask(deck, P, 'a')
    expect(deckKeys(deck)).toEqual([])
    expect(isPinned(deck, 'proj1/a')).toBe(false)
  })

  test('closing a draft removes its column', () => {
    let deck = deckOpenDraft(EMPTY_DECK, P, forkDraft('main'))
    deck = deckCloseDraft(deck, P, forkDraft('main'))
    expect(deckKeys(deck)).toEqual([])
  })

  test('closing a project drops all of its columns and pins', () => {
    let deck = deckOpenTask(EMPTY_DECK, P, 'a')
    deck = deckTogglePin(deck, 'proj1/a')
    deck = deckOpenTask(deck, 'proj2', 'z')
    deck = deckCloseProject(deck, P)
    expect(deckKeys(deck)).toEqual(['proj2/z'])
    expect(isPinned(deck, 'proj1/a')).toBe(false)
  })

  test('close of an absent column returns the same reference', () => {
    const deck = deckOpenTask(EMPTY_DECK, P, 'a')
    expect(deckCloseTask(deck, P, 'ghost')).toBe(deck)
    expect(deckCloseProject(deck, 'ghost')).toBe(deck)
  })
})

describe('columnKey compatibility', () => {
  test('deck keys are useColumns columnKeys (taskKey-compatible for tasks)', () => {
    const deck = deckOpenTask(EMPTY_DECK, P, 'a')
    const only = deck.cols.columns[0]
    expect(only).toBeDefined()
    expect(only === undefined ? '' : columnKey(only)).toBe('proj1/a')
  })
})
