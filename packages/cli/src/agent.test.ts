import { describe, expect, test } from 'bun:test'
import {
  agentEnv,
  claudeStreamCommand,
  createClaudeStreamParser,
  createClaudeTaskParser,
  hardenedReviewCommand,
  runAgent,
  TASK_TOOL_SUMMARY_MAX,
} from './agent.js'

describe('claudeStreamCommand', () => {
  test('claude -p basic: stream flags added', () => {
    expect(claudeStreamCommand('claude -p')).toBe(
      'claude -p --output-format stream-json --include-partial-messages --verbose',
    )
  })

  test('claude -p with model and effort', () => {
    expect(claudeStreamCommand('claude -p --model opus --effort high')).toContain(
      '--output-format stream-json',
    )
  })

  test('non-claude command: null', () => {
    expect(claudeStreamCommand('codex exec -')).toBeNull()
    expect(claudeStreamCommand('gemini -m gemini-2.5-pro')).toBeNull()
    expect(claudeStreamCommand('my-claude-wrapper -p')).toBeNull()
  })

  test('claude without -p: null', () => {
    expect(claudeStreamCommand('claude --model opus')).toBeNull()
  })

  test('output-format already present: null (custom command respected)', () => {
    expect(claudeStreamCommand('claude -p --output-format json')).toBeNull()
  })
})

describe('hardenedReviewCommand', () => {
  test('claude: tools disabled, MCP locked, project settings ignored', () => {
    expect(hardenedReviewCommand('claude -p --model sonnet')).toBe(
      'claude -p --model sonnet --tools "" --strict-mcp-config --setting-sources user',
    )
  })

  test('claude: flags already set by the user are not duplicated', () => {
    expect(hardenedReviewCommand('claude -p --tools "Read" --setting-sources user,project')).toBe(
      'claude -p --tools "Read" --setting-sources user,project --strict-mcp-config',
    )
  })

  test('codex: read-only sandbox, approvals off, stdin marker stays last', () => {
    expect(hardenedReviewCommand('codex exec -')).toBe(
      'codex exec --sandbox read-only --ask-for-approval never -c project_doc_max_bytes=0 -',
    )
  })

  test('codex: an explicit bypass is left alone', () => {
    const command = 'codex exec --dangerously-bypass-approvals-and-sandbox -'
    expect(hardenedReviewCommand(command)).toBe(command)
  })

  test('codex: user sandbox choice kept, missing flags still added', () => {
    expect(hardenedReviewCommand('codex exec --sandbox workspace-write -')).toBe(
      'codex exec --sandbox workspace-write --ask-for-approval never -c project_doc_max_bytes=0 -',
    )
  })

  test('gemini and custom commands are unchanged', () => {
    expect(hardenedReviewCommand('gemini -m gemini-2.5-pro')).toBe('gemini -m gemini-2.5-pro')
    expect(hardenedReviewCommand('opencode run "$(cat)"')).toBe('opencode run "$(cat)"')
  })

  test('an absolute path to a known binary is recognized', () => {
    expect(hardenedReviewCommand('/usr/local/bin/claude -p')).toBe(
      '/usr/local/bin/claude -p --tools "" --strict-mcp-config --setting-sources user',
    )
  })

  test('a flag name quoted inside another argument does not disable hardening', () => {
    const command =
      'claude -p --append-system-prompt "never mention --tools or --setting-sources here"'
    const hardened = hardenedReviewCommand(command)
    expect(hardened).toContain('--tools ""')
    expect(hardened).toContain('--setting-sources user')
    expect(hardened).toContain('--strict-mcp-config')
  })

  test('a flag name as a prefix of another word does not count as present', () => {
    expect(hardenedReviewCommand('claude -p --toolset x')).toContain('--tools ""')
  })
})

describe('agentEnv', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/dev',
    AWS_SECRET_ACCESS_KEY: 'leak-me-not',
    DATABASE_URL: 'postgres://secret',
    ANTHROPIC_API_KEY: 'sk-ant-x',
    OPENAI_API_KEY: 'sk-openai-x',
    GEMINI_API_KEY: 'g-x',
    HTTPS_PROXY: 'http://proxy:3128',
  }

  test('claude: base vars, proxy and ANTHROPIC_* only', () => {
    expect(agentEnv('claude -p', source)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      HTTPS_PROXY: 'http://proxy:3128',
    })
  })

  test('codex: OPENAI_* passes, other providers stripped', () => {
    const env = agentEnv('codex exec -', source)
    expect(env?.OPENAI_API_KEY).toBe('sk-openai-x')
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env?.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  })

  test('gemini: GEMINI_* and GOOGLE_* pass', () => {
    const env = agentEnv('gemini', { ...source, GOOGLE_CLOUD_PROJECT: 'p' })
    expect(env?.GEMINI_API_KEY).toBe('g-x')
    expect(env?.GOOGLE_CLOUD_PROJECT).toBe('p')
    expect(env?.DATABASE_URL).toBeUndefined()
  })

  test('custom command: undefined, the subprocess inherits everything', () => {
    expect(agentEnv('opencode run "$(cat)"', source)).toBeUndefined()
  })

  test('windows: no narrowing, cmd.exe needs its system variables', () => {
    expect(agentEnv('claude -p', source, 'win32')).toBeUndefined()
  })

  test('ALL_PROXY passes through for SOCKS proxies', () => {
    const env = agentEnv('claude -p', {
      ...source,
      ALL_PROXY: 'socks5://proxy:1080',
      all_proxy: 'socks5://proxy:1080',
    })
    expect(env?.ALL_PROXY).toBe('socks5://proxy:1080')
    expect(env?.all_proxy).toBe('socks5://proxy:1080')
  })

  test('CA bundle variables always pass through', () => {
    const env = agentEnv('claude -p', {
      ...source,
      NODE_EXTRA_CA_CERTS: '/ca.pem',
      SSL_CERT_FILE: '/ca.pem',
    })
    expect(env?.NODE_EXTRA_CA_CERTS).toBe('/ca.pem')
    expect(env?.SSL_CERT_FILE).toBe('/ca.pem')
  })

  test('claude on bedrock keeps the AWS credentials', () => {
    const env = agentEnv('claude -p', { ...source, CLAUDE_CODE_USE_BEDROCK: '1' })
    expect(env?.AWS_SECRET_ACCESS_KEY).toBe('leak-me-not')
    expect(env?.CLAUDE_CODE_USE_BEDROCK).toBe('1')
  })

  test('claude on vertex keeps the google credentials and region', () => {
    const env = agentEnv('claude -p', {
      ...source,
      CLAUDE_CODE_USE_VERTEX: '1',
      GOOGLE_APPLICATION_CREDENTIALS: '/sa.json',
      CLOUD_ML_REGION: 'us-east5',
    })
    expect(env?.GOOGLE_APPLICATION_CREDENTIALS).toBe('/sa.json')
    expect(env?.CLOUD_ML_REGION).toBe('us-east5')
  })
})

describe('createClaudeStreamParser', () => {
  const delta = (text: string) =>
    `${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })}\n`

  test('text_delta accumulated and onText called', () => {
    const seen: string[] = []
    const parser = createClaudeStreamParser((text) => seen.push(text))
    parser.push(delta('{"verdict":'))
    parser.push(delta('"approve"}'))
    expect(seen).toEqual(['{"verdict":', '{"verdict":"approve"}'])
    expect(parser.finalText()).toBe('{"verdict":"approve"}')
  })

  test('chunk cut in the middle of a JSONL line', () => {
    const parser = createClaudeStreamParser()
    const line = delta('hello')
    parser.push(line.slice(0, 20))
    parser.push(line.slice(20))
    expect(parser.finalText()).toBe('hello')
  })

  test('result event takes priority over the accumulation', () => {
    const parser = createClaudeStreamParser()
    parser.push(delta('partial'))
    parser.push(`${JSON.stringify({ type: 'result', result: '{"verdict":"comment"}' })}\n`)
    expect(parser.finalText()).toBe('{"verdict":"comment"}')
  })

  test('thinking_delta and non-JSON lines ignored', () => {
    const parser = createClaudeStreamParser()
    parser.push(
      `${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } })}\n`,
    )
    parser.push('not json at all\n')
    parser.push(delta('ok'))
    expect(parser.finalText()).toBe('ok')
  })

  test('complete assistant message resynchronizes the text', () => {
    const parser = createClaudeStreamParser()
    parser.push(delta('partial tex'))
    parser.push(
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'full text' }] } })}\n`,
    )
    expect(parser.finalText()).toBe('full text')
  })
})

describe('createClaudeTaskParser', () => {
  const line = (event: unknown) => `${JSON.stringify(event)}\n`

  test('captures the session id from the system init event', () => {
    let sessionId = ''
    const parser = createClaudeTaskParser({
      onInit: (id) => {
        sessionId = id
      },
    })
    parser.push(line({ type: 'system', subtype: 'init', session_id: 'sess-abc' }))
    expect(sessionId).toBe('sess-abc')
  })

  test('reports tool_use with a summarized input, once per complete message', () => {
    const calls: [string, string][] = []
    const parser = createClaudeTaskParser({
      onToolUse: (name, input) => calls.push([name, input]),
    })
    parser.push(
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'bun test' } },
            { type: 'text', text: 'running the tests' },
          ],
        },
      }),
    )
    expect(calls).toEqual([['Bash', '{"command":"bun test"}']])
  })

  test('tool inputs and results are truncated to the summary ceiling', () => {
    const inputs: string[] = []
    const results: string[] = []
    const parser = createClaudeTaskParser({
      onToolUse: (_name, input) => inputs.push(input),
      onToolResult: (summary) => results.push(summary),
    })
    const big = 'x'.repeat(5000)
    parser.push(
      line({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', input: { content: big } }] },
      }),
    )
    parser.push(
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: big }] } }),
    )
    expect(inputs[0]?.length).toBeLessThanOrEqual(TASK_TOOL_SUMMARY_MAX)
    expect(inputs[0]?.endsWith('…')).toBe(true)
    expect(results[0]?.length).toBeLessThanOrEqual(TASK_TOOL_SUMMARY_MAX)
  })

  test('tool_result content given as text blocks is flattened', () => {
    const results: string[] = []
    const parser = createClaudeTaskParser({ onToolResult: (summary) => results.push(summary) })
    parser.push(
      line({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              content: [
                { type: 'text', text: 'line one ' },
                { type: 'text', text: 'line two' },
              ],
            },
          ],
        },
      }),
    )
    expect(results).toEqual(['line one line two'])
  })

  test('text streaming and the final result behave like the review parser', () => {
    const texts: string[] = []
    const parser = createClaudeTaskParser({ onText: (text) => texts.push(text) })
    parser.push(
      line({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } },
      }),
    )
    parser.push(
      line({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
      }),
    )
    parser.push(line({ type: 'result', result: 'final answer' }))
    expect(texts).toEqual(['hel', 'hello'])
    expect(parser.finalText()).toBe('final answer')
  })

  test('corrupt lines and unknown events are ignored', () => {
    const parser = createClaudeTaskParser({})
    parser.push('not json\n')
    parser.push(line({ type: 'system', subtype: 'other' }))
    parser.push(line({ type: 'user', message: { content: 'plain string content' } }))
    expect(parser.finalText()).toBeNull()
  })
})

describe('runAgent abort', () => {
  test('aborting the signal kills the agent and rejects as interrupted', async () => {
    const controller = new AbortController()
    const promise = runAgent({
      command: 'sleep 5',
      prompt: '',
      cwd: process.cwd(),
      timeoutMs: 60_000,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 50)
    await expect(promise).rejects.toThrow(/interrupted|interrompu/)
  })
})

describe('createClaudeTaskParser tokens', () => {
  test('accumulates assistant usage and lets the result frame settle the total', () => {
    const seen: number[] = []
    const parser = createClaudeTaskParser({ onTokens: (n) => seen.push(n) })
    const line = (obj: unknown) => JSON.stringify(obj) + '\n'
    parser.push(
      line({
        type: 'assistant',
        message: { content: [], usage: { input_tokens: 100, output_tokens: 50 } },
      }),
    )
    parser.push(
      line({
        type: 'assistant',
        message: { content: [], usage: { input_tokens: 200, output_tokens: 80 } },
      }),
    )
    // The provider-billed total on the result frame wins when larger.
    parser.push(
      line({ type: 'result', result: 'done', usage: { input_tokens: 400, output_tokens: 150 } }),
    )
    expect(seen).toEqual([150, 430, 550])
  })

  test('frames without usage never fire the meter', () => {
    const seen: number[] = []
    const parser = createClaudeTaskParser({ onTokens: (n) => seen.push(n) })
    parser.push(JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n')
    parser.push(JSON.stringify({ type: 'result', result: 'done' }) + '\n')
    expect(seen).toEqual([])
  })
})
