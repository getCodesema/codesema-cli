import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { setLanguage, t } from './i18n.js'
import {
  COMMAND_NAMES,
  parseFailOn,
  parseIntFlag,
  resolveCommand,
  type CliValues,
  type ResolvedCommand,
} from './index.js'
import { REVIEW_FLAGS } from './menu.js'
import { REVIEW_GATE_VALUES } from './review.js'

afterEach(() => setLanguage(null))

const TERMINAL = { interactive: true } as const
const PIPE = { interactive: false } as const

/** One plausible value per review flag, so the loops read like real command lines. */
const SAMPLE_FLAG_VALUES: Record<string, string | boolean> = {
  branch: 'feat/x',
  target: 'develop',
  agent: 'claude -p',
  full: true,
  dual: true,
  'no-open': true,
  port: '4400',
  timeout: '900',
  'fail-on': 'major',
}

function reviewOf(arg?: string): ResolvedCommand {
  return { kind: 'command', name: 'review', arg }
}

describe('resolveCommand — the --fail-on gate in a terminal', () => {
  // The bug: `--fail-on` was missing from REVIEW_FLAGS, so an interactive
  // `codesema --fail-on major` opened the workspace and the gated review never
  // ran — exit 0 in silence, exactly where the gate was supposed to bite.
  test('--fail-on major with no positional runs the review, never the workspace', () => {
    const resolved = resolveCommand({ 'fail-on': 'major' }, [], TERMINAL)
    expect(resolved).toEqual(reviewOf(undefined))
    expect(resolved.kind).not.toBe('workspace')
  })

  test('every --fail-on level reaches the review from a terminal', () => {
    for (const gate of REVIEW_GATE_VALUES) {
      expect(resolveCommand({ 'fail-on': gate }, [], TERMINAL)).toEqual(reviewOf(undefined))
    }
  })

  test('--fail-on combined with an explicit review positional still resolves to review', () => {
    expect(resolveCommand({ 'fail-on': 'critical' }, ['review'], TERMINAL)).toEqual(
      reviewOf(undefined),
    )
  })

  test('each flag listed in REVIEW_FLAGS falls through to review in a terminal', () => {
    for (const flag of REVIEW_FLAGS) {
      const value = SAMPLE_FLAG_VALUES[flag]
      // A flag added to REVIEW_FLAGS without a sample here fails loudly rather
      // than silently skipping its case.
      expect(value).toBeDefined()
      expect(resolveCommand({ [flag]: value } as CliValues, [], TERMINAL)).toEqual(
        reviewOf(undefined),
      )
    }
  })

  test('REVIEW_FLAGS holds fail-on and none of the flags review does not consume', () => {
    expect([...REVIEW_FLAGS]).toEqual([
      'branch',
      'target',
      'agent',
      'full',
      'dual',
      'no-open',
      'port',
      'timeout',
      'fail-on',
    ])
    // Arbitration of T0.1: `review`, `out` and `force` belong to show/export/sync,
    // `review` reads none of them, so they keep opening the workspace.
    for (const flag of ['review', 'out', 'force']) {
      expect([...REVIEW_FLAGS]).not.toContain(flag)
      expect(resolveCommand({ [flag]: 'x' } as CliValues, [], TERMINAL)).toEqual({
        kind: 'workspace',
      })
    }
  })
})

describe('resolveCommand — the workspace switch', () => {
  test('a bare interactive invocation opens the workspace', () => {
    expect(resolveCommand({}, [], TERMINAL)).toEqual({ kind: 'workspace' })
  })

  test('a bare non-interactive invocation keeps behaving like review (CI)', () => {
    expect(resolveCommand({}, [], PIPE)).toEqual(reviewOf(undefined))
  })

  test('a review flag outside a terminal also resolves to review', () => {
    expect(resolveCommand({ 'fail-on': 'major' }, [], PIPE)).toEqual(reviewOf(undefined))
  })

  test('a positional beats the workspace switch even in a terminal', () => {
    expect(resolveCommand({}, ['show'], TERMINAL)).toEqual({
      kind: 'command',
      name: 'show',
      arg: undefined,
    })
  })
})

describe('resolveCommand — version, help and unknown commands', () => {
  test('--version wins over everything else', () => {
    expect(resolveCommand({ version: true }, [], TERMINAL)).toEqual({ kind: 'version' })
    expect(resolveCommand({ version: true, help: true }, ['show'], PIPE)).toEqual({
      kind: 'version',
    })
  })

  test('--help wins over the workspace switch and over a command', () => {
    expect(resolveCommand({ help: true }, [], TERMINAL)).toEqual({ kind: 'help' })
    expect(resolveCommand({ help: true }, ['review'], PIPE)).toEqual({ kind: 'help' })
    expect(resolveCommand({ help: true, 'fail-on': 'major' }, [], TERMINAL)).toEqual({
      kind: 'help',
    })
  })

  test('an unknown command exits 1 instead of being routed', () => {
    for (const ctx of [TERMINAL, PIPE]) {
      expect(resolveCommand({}, ['nope'], ctx)).toEqual({
        kind: 'unknown',
        command: 'nope',
        exitCode: 1,
      })
    }
  })

  test('a command name is matched exactly, never by prefix or case', () => {
    for (const command of ['Review', 'reviews', 'rev', '']) {
      expect(resolveCommand({}, [command], PIPE)).toEqual({
        kind: 'unknown',
        command,
        exitCode: 1,
      })
    }
  })
})

describe('resolveCommand — the nine routed commands', () => {
  test('COMMAND_NAMES lists the nine commands the switch handles', () => {
    expect([...COMMAND_NAMES]).toEqual([
      'review',
      'prep',
      'workspace',
      'menu',
      'show',
      'config',
      'export',
      'sync',
      'link',
    ])
  })

  test('each of the nine resolves to its own command, in a terminal and outside one', () => {
    for (const name of COMMAND_NAMES) {
      for (const ctx of [TERMINAL, PIPE]) {
        expect(resolveCommand({}, [name], ctx)).toEqual({ kind: 'command', name, arg: undefined })
      }
    }
  })

  test('the second positional rides along for sync and link', () => {
    expect(resolveCommand({}, ['sync', 'delete'], TERMINAL)).toEqual({
      kind: 'command',
      name: 'sync',
      arg: 'delete',
    })
    expect(resolveCommand({}, ['link', 'ABCD-1234'], TERMINAL)).toEqual({
      kind: 'command',
      name: 'link',
      arg: 'ABCD-1234',
    })
  })
})

describe('resolveCommand — purity', () => {
  test('it decides synchronously, without touching its inputs', () => {
    const values = Object.freeze({ 'fail-on': 'major' })
    const positionals = Object.freeze([]) as readonly string[]
    const first = resolveCommand(values, positionals, TERMINAL)
    const second = resolveCommand(values, positionals, TERMINAL)

    expect(first).toEqual(second)
    expect(first).not.toBeInstanceOf(Promise)
    expect(values).toEqual({ 'fail-on': 'major' })
    expect(positionals).toEqual([])
  })

  test('the terminal state comes from ctx, not from the process', () => {
    // Same argv, opposite ctx: the seam is the only thing that decides.
    expect(resolveCommand({}, [], { interactive: true })).toEqual({ kind: 'workspace' })
    expect(resolveCommand({}, [], { interactive: false })).toEqual(reviewOf(undefined))
  })
})

describe('parseIntFlag', () => {
  test('an absent flag stays absent', () => {
    expect(parseIntFlag('port', undefined, 1, 65535)).toBeUndefined()
  })

  test('--port keeps its 1..65535 bounds', () => {
    expect(parseIntFlag('port', '1', 1, 65535)).toBe(1)
    expect(parseIntFlag('port', '65535', 1, 65535)).toBe(65535)
    for (const raw of ['0', '65536']) {
      expect(() => parseIntFlag('port', raw, 1, 65535)).toThrow(
        t('cli.intFlagError', { name: 'port', raw, min: 1, max: 65535 }),
      )
    }
  })

  test('--timeout keeps its 1..86400 bounds', () => {
    expect(parseIntFlag('timeout', '1', 1, 86400)).toBe(1)
    expect(parseIntFlag('timeout', '86400', 1, 86400)).toBe(86400)
    for (const raw of ['0', '86401']) {
      expect(() => parseIntFlag('timeout', raw, 1, 86400)).toThrow(
        t('cli.intFlagError', { name: 'timeout', raw, min: 1, max: 86400 }),
      )
    }
  })

  test('anything that is not an integer is refused', () => {
    for (const raw of ['1.5', 'abc', '', ' ', '-1', 'Infinity', 'NaN']) {
      expect(() => parseIntFlag('port', raw, 1, 65535)).toThrow(
        t('cli.intFlagError', { name: 'port', raw, min: 1, max: 65535 }),
      )
    }
    // Documented tolerance of `Number()`, unchanged by this ticket: an
    // exponent notation that lands on an in-range integer is accepted.
    expect(parseIntFlag('port', '1e3', 1, 65535)).toBe(1000)
  })

  test('the bound error is worded by the active language', () => {
    expect(() => parseIntFlag('port', '0', 1, 65535)).toThrow(
      '--port 0: expected an integer between 1 and 65535',
    )
    setLanguage('fr')
    expect(() => parseIntFlag('port', '0', 1, 65535)).toThrow(
      '--port 0 : entier attendu entre 1 et 65535',
    )
  })
})

describe('parseFailOn', () => {
  test('an absent flag stays absent', () => {
    expect(parseFailOn(undefined)).toBeUndefined()
  })

  test('every gate value is accepted unchanged', () => {
    for (const gate of REVIEW_GATE_VALUES) {
      expect(parseFailOn(gate)).toBe(gate)
    }
  })

  test('an unknown level is refused with the list of valid ones', () => {
    expect(() => parseFailOn('bogus')).toThrow(
      t('cli.failOnError', { raw: 'bogus', values: REVIEW_GATE_VALUES.join(', ') }),
    )
    expect(() => parseFailOn('MAJOR')).toThrow('MAJOR')
  })

  test('the refusal is worded by the active language', () => {
    expect(() => parseFailOn('bogus')).toThrow(
      'invalid --fail-on bogus: expected one of critical, major, minor, info, request_changes',
    )
    setLanguage('fr')
    expect(() => parseFailOn('bogus')).toThrow(
      "--fail-on bogus invalide : attendu l'un de critical, major, minor, info, request_changes",
    )
  })
})

// --- the workspace command's flag wiring (T1.4 round 6, MAJEUR M1) ---------
//
// `--agent` and `--timeout` on `codesema workspace` are the CLI half of the
// documented precedence "flag > repo file > global file": they become
// `ProjectConfigFlags` and win for EVERY registered project. `runCommand` is
// not exported (each branch of it runs a real command — a server, an agent, a
// browser), so this is the same source-shape assertion
// `workspace-lifecycle.test.ts` uses for `workspace()`'s own boot lines, and
// for the same reason: dropping either line from the `workspace({…})` call
// left `tsc` green (both options are optional) and the whole suite at 0 fail,
// while the two flags silently stopped applying anywhere.
//
// Not tautological: it compares nothing to the constant that produces it.
describe('codesema workspace passes its CLI flags on', () => {
  test('--agent and --timeout reach workspace(), parsed like everywhere else', () => {
    const source = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')
      // Comment lines may name the flags on purpose; only code counts.
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .join('\n')
    const marker = "case 'workspace':"
    const start = source.indexOf(marker)
    expect(start).toBeGreaterThanOrEqual(0)
    const block = source.slice(start, source.indexOf("case 'menu':", start))
    expect(block).toContain('await workspace({')
    expect(/agent:\s*values\.agent/.test(block)).toBe(true)
    // Same bounds as `codesema review`: 1 s to 24 h, refused loudly otherwise.
    expect(
      /timeout:\s*parseIntFlag\('timeout',\s*values\.timeout,\s*1,\s*86400\)/.test(block),
    ).toBe(true)
  })
})
