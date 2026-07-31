import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { subprocessEnv } from './git.js'
import { buildImpactCandidates, changedSymbolsFromDiff } from './impact.js'

function tsDiff(file: string, minusLines: string[], plusLines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,5 +1,5 @@',
    ...minusLines.map((l) => `-${l}`),
    ...plusLines.map((l) => `+${l}`),
    '',
  ].join('\n')
}

describe('changedSymbolsFromDiff', () => {
  test('exported function present on both sides is modified', () => {
    const diff = tsDiff(
      'src/price.ts',
      ['export function computeTotal(items: Item[]): number {'],
      ['export function computeTotal(items: Item[], taxRate: number): number {'],
    )
    expect(changedSymbolsFromDiff(diff)).toEqual([
      { name: 'computeTotal', file: 'src/price.ts', change: 'modified' },
    ])
  })

  test('plus-only export is added, minus-only export is removed', () => {
    const diff = tsDiff(
      'src/api.ts',
      ['export class LegacyClient {'],
      ['export const retryBudget = 3'],
    )
    expect(changedSymbolsFromDiff(diff)).toEqual([
      { name: 'LegacyClient', file: 'src/api.ts', change: 'removed' },
      { name: 'retryBudget', file: 'src/api.ts', change: 'added' },
    ])
  })

  test('non-exported declarations are ignored in TS', () => {
    const diff = tsDiff('src/util.ts', [], ['function internalHelper() {', 'const localValue = 1'])
    expect(changedSymbolsFromDiff(diff)).toEqual([])
  })

  test('python top-level def and class are captured, methods and private names are not', () => {
    const diff = tsDiff(
      'app/models.py',
      [],
      [
        'def compute_score(user):',
        'class Invoice:',
        '    def method_inside(self):',
        'def _private_thing():',
      ],
    )
    expect(changedSymbolsFromDiff(diff)).toEqual([
      { name: 'compute_score', file: 'app/models.py', change: 'added' },
      { name: 'Invoice', file: 'app/models.py', change: 'added' },
    ])
  })

  test('unsupported extensions yield no symbols', () => {
    const diff = tsDiff('notes.txt', [], ['export function looksLikeCode() {'])
    expect(changedSymbolsFromDiff(diff)).toEqual([])
  })

  test('names shorter than 3 chars are filtered out', () => {
    const diff = tsDiff('src/tiny.ts', [], ['export const pi = 3.14', 'export const abc = 1'])
    expect(changedSymbolsFromDiff(diff)).toEqual([
      { name: 'abc', file: 'src/tiny.ts', change: 'added' },
    ])
  })
})

describe('buildImpactCandidates', () => {
  let repo: string

  function run(args: string[]) {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: repo,
      stdio: 'ignore',
      env: subprocessEnv(),
    })
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'codesema-impact-'))
    run(['init', '-b', 'main'])
    mkdirSync(join(repo, 'src'))
    writeFileSync(
      join(repo, 'src/price.ts'),
      'export function computeTotal(items: Item[]): number {\n  return 0\n}\n',
    )
    writeFileSync(
      join(repo, 'src/checkout.ts'),
      "import { computeTotal } from './price'\n\nconst total = computeTotal(cart.items)\n",
    )
    writeFileSync(
      join(repo, 'src/invoice.ts'),
      "import { computeTotal } from './price'\nexport const x = computeTotal(lines)\n",
    )
    writeFileSync(
      join(repo, 'src/usages.ts'),
      `import { formatLabel } from './hot'\n${Array.from({ length: 25 }, (_, i) => `formatLabel(${i})`).join('\n')}\n`,
    )
    writeFileSync(
      join(repo, 'src/hot.ts'),
      'export function formatLabel(n: number): string {\n  return String(n)\n}\n',
    )
    writeFileSync(join(repo, 'notes.txt'), 'computeTotal is documented here\n')
    run(['add', '-A'])
    run(['commit', '-m', 'init'])
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test('modified symbol lists callers outside the diff files, with path:line entries', () => {
    const diff = tsDiff(
      'src/price.ts',
      ['export function computeTotal(items: Item[]): number {'],
      ['export function computeTotal(items: Item[], taxRate: number): number {'],
    )
    const impact = buildImpactCandidates(diff, repo)
    expect(impact).not.toBeNull()
    const symbol = impact?.symbols.find((s) => s.name === 'computeTotal')
    expect(symbol?.change).toBe('modified')
    expect(symbol?.used_at).toContain('src/checkout.ts:3')
    expect(symbol?.used_at).toContain('src/invoice.ts:2')
    expect(symbol?.used_at.some((u) => u.startsWith('src/price.ts'))).toBe(false)
  })

  test('reverse imports list files importing the changed file', () => {
    const diff = tsDiff(
      'src/price.ts',
      ['export function computeTotal(items: Item[]): number {'],
      ['export function computeTotal(items: Item[], taxRate: number): number {'],
    )
    const impact = buildImpactCandidates(diff, repo)
    expect(impact?.imported_by['src/price.ts']).toContain('src/checkout.ts')
    expect(impact?.imported_by['src/price.ts']).toContain('src/invoice.ts')
  })

  test('usage list is capped per symbol', () => {
    const diff = tsDiff(
      'src/hot.ts',
      ['export function formatLabel(n: number): string {'],
      ['export function formatLabel(n: number, pad: boolean): string {'],
    )
    const impact = buildImpactCandidates(diff, repo)
    const symbol = impact?.symbols.find((s) => s.name === 'formatLabel')
    expect(symbol?.used_at.length).toBe(20)
  })

  test('added symbols are not searched for callers', () => {
    const diff = tsDiff('src/fresh.ts', [], ['export function brandNewThing() {'])
    expect(buildImpactCandidates(diff, repo)).toBeNull()
  })

  test('diff touching only unsupported files yields null', () => {
    const diff = tsDiff('notes.txt', ['old note'], ['new note'])
    expect(buildImpactCandidates(diff, repo)).toBeNull()
  })
})
