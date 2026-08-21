import { describe, expect, test } from 'bun:test'
import { firstTokenBin, parseModelFlag } from './agentCommand'

describe('firstTokenBin', () => {
  test('strips the path and every flag', () => {
    expect(firstTokenBin('claude -p')).toBe('claude')
    expect(firstTokenBin('  /home/me/.opencode/bin/opencode run -m x  ')).toBe('opencode')
    expect(firstTokenBin('')).toBe('')
  })
})

describe('parseModelFlag', () => {
  test('reads every flag spelling the known agents use', () => {
    expect(parseModelFlag('opencode run -m openrouter/anthropic/claude-sonnet-4')).toBe(
      'openrouter/anthropic/claude-sonnet-4',
    )
    expect(parseModelFlag('claude -p --model opus')).toBe('opus')
    expect(parseModelFlag('claude -p --model=sonnet')).toBe('sonnet')
    expect(parseModelFlag('grok --prompt-file /tmp/p -m grok-4.6')).toBe('grok-4.6')
  })

  test("no model pinned reads as '', and codex's stdin dash is not a model", () => {
    expect(parseModelFlag('opencode run')).toBe('')
    expect(parseModelFlag('codex exec -')).toBe('')
    expect(parseModelFlag('codex exec -m -')).toBe('')
    expect(parseModelFlag('')).toBe('')
  })
})
