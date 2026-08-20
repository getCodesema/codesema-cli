import { afterEach, describe, expect, test } from 'bun:test'
import type { ProbeExecFn } from './git.js'
import { setLanguage, t } from './i18n.js'
import {
  AGENT_DEFS,
  defaultCommand,
  describeConfigEntries,
  detectAgents,
  parseOpencodeModels,
  pickOpencodeJudge,
  resolveKnownAgentCommand,
} from './wizard.js'

afterEach(() => setLanguage(null))

describe('describeConfigEntries', () => {
  test('lists agent, language, auto-sync then back, with current values as hints', () => {
    const entries = describeConfigEntries({
      agent: 'claude -p --model opus',
      language: 'fr',
      syncAutoPush: true,
    })
    expect(entries.map((entry) => entry.id)).toEqual(['agent', 'language', 'autoSync', 'back'])
    expect(entries[0]?.hint).toBe('claude -p --model opus')
    expect(entries[1]?.hint).toBe('Français')
    expect(entries[2]?.hint).toBe(t('config.autoSyncOn'))
  })

  test('falls back to explicit placeholders when nothing is configured', () => {
    const entries = describeConfigEntries({})
    expect(entries[0]?.hint).toBe(t('config.agentEntryUnset'))
    expect(entries[1]?.hint).toBe(t('config.languageAuto'))
    expect(entries[2]?.hint).toBe(t('config.autoSyncUnset'))
  })

  test('a declined auto-sync opt-in shows as off', () => {
    const entries = describeConfigEntries({ syncAutoPush: false })
    expect(entries[2]?.hint).toBe(t('config.autoSyncOff'))
  })

  test('labels follow the active i18n catalog', () => {
    setLanguage('fr')
    const entries = describeConfigEntries({ language: 'en' })
    expect(entries[0]?.label).toBe(t('config.agentEntry'))
    expect(entries[1]?.hint).toBe('English')
  })
})

describe('detectAgents', () => {
  /** Records every launch and holds the answers, so launches and answers are distinguishable. */
  function heldExec() {
    const launches: { cmd: string; args: string[]; cwd: string }[] = []
    const releases: ((value: string | null) => void)[] = []
    const execFn: ProbeExecFn = (cmd, args, cwd) => {
      launches.push({ cmd, args, cwd })
      return new Promise<string | null>((resolve) => releases.push(resolve))
    }
    return {
      launches,
      execFn,
      release: (values: (string | null)[]) => {
        releases.forEach((resolve, index) => resolve(values[index] ?? null))
      },
    }
  }

  test('every agent probe is launched before the first one answers', async () => {
    const rig = heldExec()
    const pending = detectAgents('/repo', rig.execFn)
    // No await yet: all three <bin> --version probes are already in flight.
    expect(rig.launches.map((l) => l.cmd)).toEqual(AGENT_DEFS.map((d) => d.bin))
    // Never a real binary and never a shell string: the assertion is the argv.
    expect(rig.launches.every((l) => l.args.length === 1 && l.args[0] === '--version')).toBe(true)
    expect(rig.launches.every((l) => l.cwd === '/repo')).toBe(true)

    rig.release(rig.launches.map(() => null))
    expect(await pending).toEqual([])
  })

  test('detected agents keep the AGENT_DEFS order, whatever the answer order', async () => {
    const rig = heldExec()
    const pending = detectAgents('/repo', rig.execFn)
    // codex is missing, the other two answer: the result follows AGENT_DEFS.
    rig.release(['claude 1.0', null, 'gemini 3.0'])
    expect((await pending).map((d) => d.id)).toEqual(['claude', 'gemini'])
  })

  test('a probe that expires only removes its own agent', async () => {
    const calls: string[] = []
    const execFn: ProbeExecFn = async (cmd) => {
      calls.push(cmd)
      await Promise.resolve()
      return cmd === 'codex' ? null : `${cmd} ok`
    }
    expect((await detectAgents('/repo', execFn)).map((d) => d.id)).toEqual([
      'claude',
      'gemini',
      'grok',
      'opencode',
    ])
    expect(calls).toEqual(AGENT_DEFS.map((d) => d.bin))
  })
})

describe('parseOpencodeModels', () => {
  test('keeps one provider/model id per line and skips junk', () => {
    expect(
      parseOpencodeModels(
        [
          'Available models:',
          '',
          'anthropic/claude-sonnet-4-5',
          'openai/gpt-4.1',
          'openrouter/google/gemini-2.5-flash',
          '  opencode/kimi-k2  ',
          'not a model',
          'spaces in / this',
          'anthropic/claude-sonnet-4-5',
        ].join('\n'),
      ),
    ).toEqual([
      'anthropic/claude-sonnet-4-5',
      'openai/gpt-4.1',
      'openrouter/google/gemini-2.5-flash',
      'opencode/kimi-k2',
    ])
  })
})

describe('pickOpencodeJudge', () => {
  test('prefers mini/flash/air/haiku/nano, else first, else empty', () => {
    expect(
      pickOpencodeJudge([
        'anthropic/claude-sonnet-4-5',
        'google/gemini-2.5-flash',
        'anthropic/claude-haiku-4',
      ]),
    ).toBe('google/gemini-2.5-flash')
    expect(pickOpencodeJudge(['anthropic/claude-sonnet-4-5', 'openai/gpt-4.1'])).toBe(
      'anthropic/claude-sonnet-4-5',
    )
    expect(pickOpencodeJudge([])).toBe('')
  })
})

describe('resolveKnownAgentCommand', () => {
  test('an AGENT_DEFS id or bin becomes that provider default', () => {
    expect(resolveKnownAgentCommand('opencode')).toBe('opencode run')
    expect(resolveKnownAgentCommand('claude')).toBe(defaultCommand(AGENT_DEFS[0]!))
    expect(resolveKnownAgentCommand('codex')).toBe('codex exec -')
  })

  test('a command whose first-token bin is known is kept', () => {
    expect(resolveKnownAgentCommand('opencode run -m anthropic/claude-sonnet-4-5')).toBe(
      'opencode run -m anthropic/claude-sonnet-4-5',
    )
    expect(resolveKnownAgentCommand('/usr/local/bin/claude -p --model opus')).toBe(
      '/usr/local/bin/claude -p --model opus',
    )
  })

  test('an unknown command is null', () => {
    expect(resolveKnownAgentCommand('my-agent run')).toBeNull()
    expect(resolveKnownAgentCommand('')).toBeNull()
  })
})
