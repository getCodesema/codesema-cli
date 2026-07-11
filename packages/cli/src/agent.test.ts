import { describe, expect, test } from 'bun:test'
import { claudeStreamCommand, createClaudeStreamParser } from './agent.js'

describe('claudeStreamCommand', () => {
  test('claude -p basique → flags stream ajoutés', () => {
    expect(claudeStreamCommand('claude -p')).toBe(
      'claude -p --output-format stream-json --include-partial-messages --verbose',
    )
  })

  test('claude -p avec modèle et effort', () => {
    expect(claudeStreamCommand('claude -p --model opus --effort high')).toContain('--output-format stream-json')
  })

  test('commande non claude → null', () => {
    expect(claudeStreamCommand('codex exec -')).toBeNull()
    expect(claudeStreamCommand('gemini -m gemini-2.5-pro')).toBeNull()
    expect(claudeStreamCommand('my-claude-wrapper -p')).toBeNull()
  })

  test('claude sans -p → null', () => {
    expect(claudeStreamCommand('claude --model opus')).toBeNull()
  })

  test('output-format déjà présent → null (commande custom respectée)', () => {
    expect(claudeStreamCommand('claude -p --output-format json')).toBeNull()
  })
})

describe('createClaudeStreamParser', () => {
  const delta = (text: string) =>
    `${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })}\n`

  test('text_delta cumulés et onText appelé', () => {
    const seen: string[] = []
    const parser = createClaudeStreamParser((text) => seen.push(text))
    parser.push(delta('{"verdict":'))
    parser.push(delta('"approve"}'))
    expect(seen).toEqual(['{"verdict":', '{"verdict":"approve"}'])
    expect(parser.finalText()).toBe('{"verdict":"approve"}')
  })

  test('chunk coupé au milieu d’une ligne JSONL', () => {
    const parser = createClaudeStreamParser()
    const line = delta('hello')
    parser.push(line.slice(0, 20))
    parser.push(line.slice(20))
    expect(parser.finalText()).toBe('hello')
  })

  test('événement result prioritaire sur le cumul', () => {
    const parser = createClaudeStreamParser()
    parser.push(delta('partial'))
    parser.push(`${JSON.stringify({ type: 'result', result: '{"verdict":"comment"}' })}\n`)
    expect(parser.finalText()).toBe('{"verdict":"comment"}')
  })

  test('thinking_delta et lignes non JSON ignorés', () => {
    const parser = createClaudeStreamParser()
    parser.push(
      `${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } })}\n`,
    )
    parser.push('not json at all\n')
    parser.push(delta('ok'))
    expect(parser.finalText()).toBe('ok')
  })

  test('message assistant complet resynchronise le texte', () => {
    const parser = createClaudeStreamParser()
    parser.push(delta('partial tex'))
    parser.push(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'full text' }] } })}\n`)
    expect(parser.finalText()).toBe('full text')
  })
})
