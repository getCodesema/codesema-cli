import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatRules, loadRules, parseRules } from './rules.js'

describe('parseRules', () => {
  test('one rule per line, blanks, headings and comments skipped', () => {
    const rules = parseRules(
      [
        '# Team rules',
        '',
        '<!-- keep ordered by yield -->',
        'No any in exported signatures | Where to look: *.d.ts, public APIs',
        '  Errors carry a cause | Bad: throw new Error(msg) | Good: throw new Error(msg, { cause })',
      ].join('\n'),
    )
    expect(rules).toEqual([
      'No any in exported signatures | Where to look: *.d.ts, public APIs',
      'Errors carry a cause | Bad: throw new Error(msg) | Good: throw new Error(msg, { cause })',
    ])
  })

  test('list markers and author-written [Cn] ids stripped', () => {
    expect(parseRules('- first rule\n* second rule\n3. third rule\n[C9] fourth rule')).toEqual([
      'first rule',
      'second rule',
      'third rule',
      'fourth rule',
    ])
  })

  test('capped at 50 rules, each capped at 1000 chars', () => {
    const many = parseRules(Array.from({ length: 60 }, (_, i) => `rule ${i}`).join('\n'))
    expect(many).toHaveLength(50)
    const [long] = parseRules('x'.repeat(1500))
    expect(long?.length).toBe(1000)
  })

  test('empty content: no rules', () => {
    expect(parseRules('')).toEqual([])
    expect(parseRules('# only a heading\n\n')).toEqual([])
  })
})

describe('formatRules', () => {
  test('positional ids starting at C1, file order preserved', () => {
    expect(formatRules(['a', 'b'])).toEqual(['[C1] a', '[C2] b'])
  })
})

describe('loadRules', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'codesema-rules-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('null when .codesema/RULES.md does not exist', () => {
    expect(loadRules(dir)).toBeNull()
  })

  test('null when the file holds no rules', () => {
    mkdirSync(join(dir, '.codesema'), { recursive: true })
    writeFileSync(join(dir, '.codesema', 'RULES.md'), '# nothing yet\n')
    expect(loadRules(dir)).toBeNull()
  })

  test('formatted grid lines when rules exist', () => {
    writeFileSync(join(dir, '.codesema', 'RULES.md'), '# Rules\n- no any\n- errors carry a cause\n')
    expect(loadRules(dir)).toEqual(['[C1] no any', '[C2] errors carry a cause'])
  })
})
