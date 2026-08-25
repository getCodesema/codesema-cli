import { describe, expect, test } from 'bun:test'
import { diffBarBlocks } from './DiffBar'

describe('diffBarBlocks', () => {
  test('pure additions fill every block green', () => {
    expect(diffBarBlocks(100, 0)).toEqual(['add', 'add', 'add', 'add', 'add'])
  })

  test('pure deletions fill every block red', () => {
    expect(diffBarBlocks(0, 100)).toEqual(['del', 'del', 'del', 'del', 'del'])
  })

  test('a measured zero/zero renders no bar at all: there is no neutral block', () => {
    expect(diffBarBlocks(0, 0)).toBeNull()
  })

  test('a tiny addition against a huge deletion still floors to one green block', () => {
    expect(diffBarBlocks(1, 1000)).toEqual(['add', 'del', 'del', 'del', 'del'])
  })

  test('a tiny deletion against a huge addition still caps at four green blocks', () => {
    expect(diffBarBlocks(1000, 1)).toEqual(['add', 'add', 'add', 'add', 'del'])
  })

  test('a single deletion never gets floored: the floor only applies to additions', () => {
    expect(diffBarBlocks(0, 1)).toEqual(['del', 'del', 'del', 'del', 'del'])
  })

  test('an even split rounds to nearest (2.5 rounds up)', () => {
    expect(diffBarBlocks(50, 50)).toEqual(['add', 'add', 'add', 'del', 'del'])
  })
})
