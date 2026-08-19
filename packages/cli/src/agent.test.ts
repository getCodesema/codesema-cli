import type { ChildProcess } from 'node:child_process'
import { describe, expect, test } from 'bun:test'
import {
  AGENT_KILL_GRACE_MS,
  AGENT_SETTLE_GRACE_MS,
  AGENT_WATCHDOG_DEFAULTS,
  agentEnv,
  agentReasonCode,
  AgentWatchdogError,
  claudeStreamCommand,
  createClaudeStreamParser,
  createClaudeTaskParser,
  createSemanticWatchdog,
  effectiveAbsoluteCapMs,
  emitsClaudeStreamJson,
  hardenedReviewCommand,
  MAX_TIMER_MS,
  runAgent,
  systemClock,
  TASK_TOOL_SUMMARY_MAX,
  WATCHDOG_CAP_MARGIN_MS,
  watchdogTickMs,
  type AgentClock,
  type AgentHeartbeat,
  type AgentWatchdogCause,
  type ClaudeTaskParserOptions,
  type WatchdogBudgets,
} from './agent.js'
import type { CostDegradation, PriceRow, SettledCost } from './cost.js'

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

  test('each assistant message streams under its own index, never concatenated', () => {
    const texts: [string, number][] = []
    const parser = createClaudeTaskParser({ onText: (text, seq) => texts.push([text, seq]) })
    const delta = (text: string) =>
      line({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      })
    // First message: streamed, then confirmed by its complete frame (which
    // also carries the tool call it ends on).
    parser.push(delta('let me '))
    parser.push(delta('look'))
    parser.push(
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'let me look' },
            { type: 'tool_use', name: 'Read', input: {} },
          ],
        },
      }),
    )
    parser.push(
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    )
    // Second message: a NEW index, starting from an empty text.
    parser.push(delta('found it'))
    parser.push(
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'found it' }] } }),
    )
    expect(texts).toEqual([
      ['let me ', 0],
      ['let me look', 0],
      ['let me look', 0],
      ['found it', 1],
      ['found it', 1],
    ])
    // No result frame: the LAST message is the reply, not every message glued.
    expect(parser.finalText()).toBe('found it')
  })

  test('a text-less assistant message only shifts the index, it opens nothing', () => {
    const texts: [string, number][] = []
    const parser = createClaudeTaskParser({ onText: (text, seq) => texts.push([text, seq]) })
    parser.push(
      line({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
      }),
    )
    parser.push(
      line({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } },
      }),
    )
    expect(texts).toEqual([['done', 1]])
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
      absoluteCapMs: 60_000,
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

// --- semantic watchdog (T1.7 / D3) ------------------------------------------

describe('createClaudeTaskParser activity', () => {
  const line = (event: unknown) => `${JSON.stringify(event)}\n`

  test('every decoded frame is activity, whatever its type', () => {
    let beats = 0
    const parser = createClaudeTaskParser({ onActivity: () => beats++ })
    parser.push(line({ type: 'system', subtype: 'init', session_id: 's' }))
    parser.push(
      line({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      }),
    )
    parser.push(line({ type: 'assistant', message: { content: [] } }))
    parser.push(line({ type: 'user', message: { content: [] } }))
    parser.push(line({ type: 'result', result: 'done' }))
    // An unknown frame type is still a frame: the stream is alive.
    parser.push(line({ type: 'something_new' }))
    expect(beats).toBe(6)
  })

  test('an illegible line is not a frame and never passes for activity', () => {
    let beats = 0
    const parser = createClaudeTaskParser({ onActivity: () => beats++ })
    parser.push('not json at all\n')
    parser.push('\n')
    expect(beats).toBe(0)
  })
})

describe('createSemanticWatchdog', () => {
  const budgets: WatchdogBudgets = {
    inactivityMs: 30 * 60_000,
    toolBudgetMs: 120 * 60_000,
    heartbeatMs: 30_000,
  }

  type WatchdogRig = {
    watchdog: ReturnType<typeof createSemanticWatchdog>
    expiries: [AgentWatchdogCause, number][]
    beats: AgentHeartbeat[]
    /** Moves the injected clock and evaluates once per `heartbeatMs`, like runAgent does. */
    run: (ms: number) => void
  }

  function rig(over: Partial<WatchdogBudgets> = {}): WatchdogRig {
    const b = { ...budgets, ...over }
    let now = 1_000_000
    const expiries: [AgentWatchdogCause, number][] = []
    const beats: AgentHeartbeat[] = []
    const watchdog = createSemanticWatchdog({
      budgets: b,
      now: () => now,
      onHeartbeat: (beat) => beats.push(beat),
      onExpire: (cause, elapsedMs) => expiries.push([cause, elapsedMs]),
    })
    const step = watchdogTickMs(b)
    return {
      watchdog,
      expiries,
      beats,
      run(ms) {
        const target = now + ms
        while (now + step <= target) {
          now += step
          watchdog.tick()
        }
        now = target
      },
    }
  }

  test('a mute agent past the threshold expires on inactivity', () => {
    const r = rig()
    r.run(29 * 60_000)
    expect(r.expiries).toEqual([])
    r.run(2 * 60_000)
    expect(r.expiries).toHaveLength(1)
    expect(r.expiries[0]?.[0]).toBe('inactivity')
    expect(r.expiries[0]?.[1]).toBeGreaterThanOrEqual(budgets.inactivityMs)
  })

  test('an agent speaking every 25 s is never cut, however long the run', () => {
    const r = rig()
    for (let i = 0; i < 240; i++) {
      r.run(25_000)
      r.watchdog.markActivity()
    }
    // Two hours of a talkative run: the wall clock says "long", the watchdog
    // says "alive", and only the watchdog gets to decide.
    expect(r.expiries).toEqual([])
  })

  test('it expires ONCE, not on every tick past the threshold', () => {
    const r = rig()
    r.run(90 * 60_000)
    expect(r.expiries).toHaveLength(1)
  })

  test('a tool in flight suspends inactivity, and only the tool budget can cut it', () => {
    const r = rig()
    r.watchdog.openTool()
    expect(r.watchdog.inFlightTools()).toBe(1)
    // Past the inactivity threshold, well under the tool budget: an agent
    // waiting on a long test suite is not dead, it is waiting.
    r.run(90 * 60_000)
    expect(r.expiries).toEqual([])
    r.run(35 * 60_000)
    expect(r.expiries).toHaveLength(1)
    expect(r.expiries[0]?.[0]).toBe('tool_budget')
    expect(r.expiries[0]?.[1]).toBeGreaterThanOrEqual(budgets.toolBudgetMs)
  })

  test('a tool that comes back reopens the inactivity window', () => {
    const r = rig()
    r.watchdog.openTool()
    r.run(60 * 60_000)
    r.watchdog.closeTool()
    r.watchdog.markActivity()
    expect(r.watchdog.inFlightTools()).toBe(0)
    r.run(29 * 60_000)
    expect(r.expiries).toEqual([])
    r.run(2 * 60_000)
    expect(r.expiries[0]?.[0]).toBe('inactivity')
  })

  test('nested tools: the in-flight window spans from the first open to the last close', () => {
    const r = rig()
    r.watchdog.openTool()
    r.watchdog.openTool()
    expect(r.watchdog.inFlightTools()).toBe(2)
    expect(r.watchdog.closeTool()).toBe(true)
    expect(r.watchdog.inFlightTools()).toBe(1)
    r.run(121 * 60_000)
    expect(r.expiries[0]?.[0]).toBe('tool_budget')
  })

  test('an orphan tool_result never takes the counter negative', () => {
    const r = rig()
    expect(r.watchdog.closeTool()).toBe(false)
    expect(r.watchdog.closeTool()).toBe(false)
    expect(r.watchdog.inFlightTools()).toBe(0)
    // The costly failure this guards against: a negative counter would look
    // like a tool forever in flight and suspend the watchdog for good.
    r.run(31 * 60_000)
    expect(r.expiries[0]?.[0]).toBe('inactivity')
  })

  test('an orphan result after a real pair still leaves the counter at 0', () => {
    const r = rig()
    r.watchdog.openTool()
    expect(r.watchdog.closeTool()).toBe(true)
    expect(r.watchdog.closeTool()).toBe(false)
    expect(r.watchdog.inFlightTools()).toBe(0)
  })

  test('the heartbeat beats once per period, tools in flight included', () => {
    const r = rig()
    r.run(90_000)
    expect(r.beats).toHaveLength(3)
    expect(r.beats[2]?.idleMs).toBe(90_000)
    expect(r.beats[2]?.inFlightTools).toBe(0)
    r.watchdog.openTool()
    r.run(60_000)
    expect(r.beats).toHaveLength(5)
    expect(r.beats[4]?.inFlightTools).toBe(1)
  })

  test('a stopped watchdog neither beats nor expires', () => {
    const r = rig()
    r.watchdog.stop()
    r.run(120 * 60_000)
    expect(r.beats).toEqual([])
    expect(r.expiries).toEqual([])
  })
})

describe('watchdogTickMs', () => {
  test('D3 defaults poll at the heartbeat period, the smallest of the three', () => {
    expect(watchdogTickMs(AGENT_WATCHDOG_DEFAULTS)).toBe(30_000)
  })

  test('never coarser than 30 s, never finer than 10 ms', () => {
    expect(
      watchdogTickMs({ inactivityMs: 60 * 60_000, toolBudgetMs: 60 * 60_000, heartbeatMs: 60_000 }),
    ).toBe(30_000)
    expect(watchdogTickMs({ inactivityMs: 1, toolBudgetMs: 1, heartbeatMs: 1 })).toBe(10)
  })
})

describe('AgentWatchdogError', () => {
  test('names the D2 code beside the message it never replaces', () => {
    const err = new AgentWatchdogError('inactivity', 'agent said nothing')
    expect(err.reasonCode).toBe('inactivity_timeout')
    expect(err.message).toBe('agent said nothing')
    expect(err.watchdogCause).toBe('inactivity')
    expect(agentReasonCode(err)).toBe('inactivity_timeout')
  })

  test('a tool-budget cut is the same code: from outside, the run died of silence', () => {
    expect(new AgentWatchdogError('tool_budget', 'stuck').reasonCode).toBe('inactivity_timeout')
  })

  test('anything else names no code', () => {
    expect(agentReasonCode(new Error('boom'))).toBeNull()
    expect(agentReasonCode(null)).toBeNull()
    expect(agentReasonCode('inactivity_timeout')).toBeNull()
  })
})

describe('emitsClaudeStreamJson', () => {
  test('true whoever added the flags, false for a plain command', () => {
    expect(emitsClaudeStreamJson(claudeStreamCommand('claude -p') ?? '')).toBe(true)
    expect(emitsClaudeStreamJson('claude -p --output-format stream-json --verbose')).toBe(true)
    expect(emitsClaudeStreamJson('claude -p')).toBe(false)
    expect(emitsClaudeStreamJson('codex exec -')).toBe(false)
  })
})

describe('systemClock', () => {
  test('a delay past the 32-bit timer ceiling never fires, instead of firing at once', async () => {
    // setTimeout clamps anything over 2^31-1 ms to 1 ms (TimeoutOverflowWarning
    // on node and bun alike). Unclamped, a `watchdogToolBudgetSeconds` of
    // 2 147 484 — or a `timeout` that large — armed the ceiling at 1 ms and
    // every turn died at birth with `agent.timeout`.
    let fired = 0
    const cancel = systemClock.setTimer(() => fired++, MAX_TIMER_MS + 1)
    const huge = systemClock.setTimer(() => fired++, Number.MAX_SAFE_INTEGER)
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(fired).toBe(0)
    cancel()
    huge()
  })

  test('its timer fires and can be cancelled', async () => {
    expect(systemClock.now()).toBeGreaterThan(0)
    let fired = 0
    const cancel = systemClock.setTimer(() => fired++, 1)
    systemClock.setTimer(() => fired++, 1)()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fired).toBe(1)
    cancel()
  })
})

// --- runAgent under injected seams (no real process, no real wait) ----------

type FakeClock = AgentClock & { advance: (ms: number) => void }

/** Virtual time: the budgets of D3 are counted in hours, no test may wait one. */
function createFakeClock(start = 1_000_000): FakeClock {
  let now = start
  let nextId = 1
  const timers = new Map<number, { due: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = nextId++
      timers.set(id, { due: now + ms, fn })
      return () => timers.delete(id)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        let pick: [number, { due: number; fn: () => void }] | null = null
        for (const entry of timers) {
          if (entry[1].due <= target && (pick === null || entry[1].due < pick[1].due)) {
            pick = entry
          }
        }
        if (pick === null) {
          break
        }
        timers.delete(pick[0])
        now = pick[1].due
        pick[1].fn()
      }
      now = target
    },
  }
}

type FakeChild = {
  child: ChildProcess
  /** Every operation runAgent performed on the process, in order. */
  ops: string[]
  stdout: (chunk: string) => void
  close: (code: number | null) => void
  fail: (err: Error) => void
}

const FAKE_PID = 4242

/** What a kill of the process GROUP looks like on this platform (Windows has none). */
const killOp = (signal: string) =>
  process.platform === 'win32' ? `child.kill:${signal}` : `kill:${-FAKE_PID}:${signal}`

function createFakeChild(): FakeChild {
  const ops: string[] = []
  const stdoutListeners: ((d: Buffer) => void)[] = []
  const stdinErrorListeners: ((err: Error) => void)[] = []
  const closeListeners: ((code: number | null) => void)[] = []
  const errorListeners: ((err: Error) => void)[] = []
  let stdinEnded = false
  const child = {
    pid: FAKE_PID,
    stdin: {
      on(event: string, listener: (err: Error) => void) {
        if (event === 'error') {
          stdinErrorListeners.push(listener)
        }
        return this
      },
      write(text: string) {
        if (stdinEnded) {
          // What node does on a write after end: an error nobody may let
          // escape, or the EPIPE takes the host process down with it.
          ops.push('stdin:write-after-end')
          for (const listener of stdinErrorListeners) {
            listener(new Error('write after end'))
          }
          return false
        }
        ops.push(`stdin:write(${text})`)
        return true
      },
      end() {
        // node's end() on an already-finished stream is a no-op (it may raise
        // ERR_STREAM_ALREADY_FINISHED, which the guard absorbs): recorded as
        // such so the escalation sequence tells the truth about step 1.
        ops.push(stdinEnded ? 'stdin:end(noop)' : 'stdin:end')
        stdinEnded = true
      },
    },
    stdout: {
      on(event: string, listener: (d: Buffer) => void) {
        if (event === 'data') {
          stdoutListeners.push(listener)
        }
        return this
      },
      destroy() {
        ops.push('stdout:destroy')
      },
    },
    on(event: string, listener: (arg: never) => void) {
      if (event === 'close') {
        closeListeners.push(listener as (code: number | null) => void)
      }
      if (event === 'error') {
        errorListeners.push(listener as (err: Error) => void)
      }
      return this
    },
    kill(signal?: NodeJS.Signals) {
      ops.push(`child.kill:${signal}`)
      return true
    },
  }
  return {
    child: child as unknown as ChildProcess,
    ops,
    stdout: (chunk) => {
      for (const listener of stdoutListeners) {
        listener(Buffer.from(chunk))
      }
    },
    close: (code) => {
      for (const listener of closeListeners) {
        listener(code)
      }
    },
    fail: (err) => {
      for (const listener of errorListeners) {
        listener(err)
      }
    },
  }
}

type Rig = {
  clock: FakeClock
  fake: FakeChild
  promise: Promise<string>
  beats: AgentHeartbeat[]
  spawned: { command: string; detached: boolean }[]
}

const TEST_BUDGETS: WatchdogBudgets = {
  inactivityMs: 30 * 60_000,
  toolBudgetMs: 120 * 60_000,
  heartbeatMs: 30_000,
}

function startRun(
  over: { command?: string; watchdog?: WatchdogBudgets; absoluteCapMs?: number } = {},
): Rig {
  const clock = createFakeClock()
  const fake = createFakeChild()
  const beats: AgentHeartbeat[] = []
  const spawned: { command: string; detached: boolean }[] = []
  const promise = runAgent({
    command: over.command ?? 'claude -p',
    prompt: 'go',
    cwd: '/tmp',
    absoluteCapMs: over.absoluteCapMs ?? 10 * 60 * 60_000,
    watchdog: over.watchdog ?? TEST_BUDGETS,
    clock,
    onHeartbeat: (beat) => beats.push(beat),
    spawnFn: (command, options) => {
      spawned.push({ command, detached: options.detached === true })
      return fake.child
    },
    killFn: (pid, signal) => fake.ops.push(`kill:${pid}:${signal}`),
  })
  return { clock, fake, promise, beats, spawned }
}

const frame = (event: unknown) => `${JSON.stringify(event)}\n`
const toolUse = frame({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bun test' } }] },
})
const toolResult = frame({
  type: 'user',
  message: { content: [{ type: 'tool_result', content: 'ok' }] },
})

describe('runAgent kill escalation', () => {
  test('stdin, SIGTERM, a bounded wait, SIGKILL, and only then stdout', async () => {
    const rig = startRun()
    // Start state: the prompt was written and stdin closed behind it.
    expect(rig.fake.ops).toEqual(['stdin:write(go)', 'stdin:end'])
    // Stops exactly on the tick that blew the budget, before the grace elapses.
    rig.clock.advance(30 * 60_000)
    // The wait is observable: nothing past SIGTERM yet, stdout still open, so
    // the agent's last words can still reach us. Step 1 is a NO-OP here and
    // the sequence says so: runAgent writes the prompt and ends stdin as soon
    // as the run starts, so by the time anything kills it, stdin is long
    // closed. It stays first because the order is the contract — the day a
    // caller keeps stdin open, EOF is the gentlest way to ask an agent to go.
    expect(rig.fake.ops.slice(2)).toEqual(['stdin:end(noop)', killOp('SIGTERM')])
    rig.clock.advance(AGENT_KILL_GRACE_MS)
    expect(rig.fake.ops.slice(2)).toEqual([
      'stdin:end(noop)',
      killOp('SIGTERM'),
      killOp('SIGKILL'),
      'stdout:destroy',
    ])
    rig.fake.close(null)
    await expect(rig.promise).rejects.toBeInstanceOf(AgentWatchdogError)
  })

  test('the group is what gets signalled, and the run is detached to make it so', async () => {
    const rig = startRun()
    expect(rig.spawned[0]?.detached).toBe(process.platform !== 'win32')
    rig.clock.advance(31 * 60_000 + AGENT_KILL_GRACE_MS)
    // Negative pid = the whole process group, so the shell's children die too.
    expect(rig.fake.ops).toContain(killOp('SIGKILL'))
    rig.fake.close(null)
    await expect(rig.promise).rejects.toThrow()
  })

  test('an agent that exits during the grace period is never SIGKILLed', async () => {
    const rig = startRun()
    rig.clock.advance(30 * 60_000)
    rig.fake.close(143)
    await expect(rig.promise).rejects.toBeInstanceOf(AgentWatchdogError)
    rig.clock.advance(10 * AGENT_KILL_GRACE_MS)
    expect(rig.fake.ops).not.toContain(killOp('SIGKILL'))
    expect(rig.fake.ops).not.toContain('stdout:destroy')
  })

  test('an already-closed stdin absorbs its error instead of taking the host down', async () => {
    const controller = new AbortController()
    controller.abort()
    const fake = createFakeChild()
    const promise = runAgent({
      command: 'claude -p',
      prompt: 'go',
      cwd: '/tmp',
      absoluteCapMs: 60_000,
      clock: createFakeClock(),
      signal: controller.signal,
      spawnFn: () => fake.child,
      killFn: (pid, signal) => fake.ops.push(`kill:${pid}:${signal}`),
    })
    // Aborted before the prompt was even written: the escalation closed stdin
    // first, so the write that follows errors — and the guard swallows it.
    expect(fake.ops).toEqual([
      'stdin:end',
      killOp('SIGTERM'),
      'stdin:write-after-end',
      'stdin:end(noop)',
    ])
    fake.close(null)
    await expect(promise).rejects.toThrow(/interrupted|interrompu/)
  })
})

describe('runAgent semantic watchdog', () => {
  test('a mute agent is cut with the inactivity_timeout reason code', async () => {
    const rig = startRun()
    rig.clock.advance(31 * 60_000 + AGENT_KILL_GRACE_MS)
    rig.fake.close(null)
    const err = await rig.promise.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentWatchdogError)
    expect((err as AgentWatchdogError).watchdogCause).toBe('inactivity')
    expect(agentReasonCode(err)).toBe('inactivity_timeout')
    // Invariant 2: the code is ADDED to a readable message, never a substitute.
    expect((err as AgentWatchdogError).message).toMatch(/30 min/)
  })

  test('an agent talking every 25 min under the threshold is never cut', async () => {
    const rig = startRun()
    for (let i = 0; i < 6; i++) {
      rig.clock.advance(25 * 60_000)
      rig.fake.stdout(frame({ type: 'stream_event', event: { type: 'ping' } }))
    }
    expect(rig.fake.ops).toEqual(['stdin:write(go)', 'stdin:end'])
    rig.fake.close(0)
    await expect(rig.promise).resolves.toContain('stream_event')
  })

  test('a tool in flight suspends inactivity; past its own budget it cuts', async () => {
    const rig = startRun()
    rig.fake.stdout(toolUse)
    // Well past the 30 min of inactivity, still under the 2 h tool budget.
    rig.clock.advance(100 * 60_000)
    expect(rig.fake.ops).toEqual(['stdin:write(go)', 'stdin:end'])
    rig.clock.advance(25 * 60_000 + AGENT_KILL_GRACE_MS)
    rig.fake.close(null)
    const err = await rig.promise.catch((e: unknown) => e)
    expect((err as AgentWatchdogError).watchdogCause).toBe('tool_budget')
    expect(agentReasonCode(err)).toBe('inactivity_timeout')
  })

  test('a tool that comes back hands the run back to the inactivity watchdog', async () => {
    const rig = startRun()
    rig.fake.stdout(toolUse)
    rig.clock.advance(60 * 60_000)
    rig.fake.stdout(toolResult)
    rig.clock.advance(31 * 60_000 + AGENT_KILL_GRACE_MS)
    rig.fake.close(null)
    const err = await rig.promise.catch((e: unknown) => e)
    expect((err as AgentWatchdogError).watchdogCause).toBe('inactivity')
  })

  test('partial stream_event frames are activity but never move the tool counter', async () => {
    const rig = startRun()
    // A partial frame can name a tool without the tool having started: reading
    // tools there would count each one twice, or open one that never opens.
    rig.fake.stdout(
      frame({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', name: 'Bash', input: {} },
        },
      }),
    )
    rig.fake.stdout(
      frame({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hm' } },
      }),
    )
    // No tool is in flight, so the inactivity watchdog is still the one armed.
    rig.clock.advance(30 * 60_000 + AGENT_KILL_GRACE_MS)
    rig.fake.close(null)
    const err = await rig.promise.catch((e: unknown) => e)
    expect((err as AgentWatchdogError).watchdogCause).toBe('inactivity')
  })

  test('an orphan tool_result never suspends the watchdog for good', async () => {
    const rig = startRun()
    // No tool_use ever: this result belongs to nothing and is ignored.
    rig.fake.stdout(toolResult)
    rig.clock.advance(31 * 60_000 + AGENT_KILL_GRACE_MS)
    rig.fake.close(null)
    const err = await rig.promise.catch((e: unknown) => e)
    expect((err as AgentWatchdogError).watchdogCause).toBe('inactivity')
  })

  test('the tool signals are read even when the CALLER added the stream flags', async () => {
    // The task runner's path: the command already carries --output-format
    // stream-json, so runAgent does not own the text — but it must still see
    // the tools, or a forty-minute test run would look like forty dead minutes.
    const rig = startRun({
      command: 'claude -p --output-format stream-json --include-partial-messages --verbose',
    })
    rig.fake.stdout(toolUse)
    rig.clock.advance(100 * 60_000)
    expect(rig.fake.ops).toEqual(['stdin:write(go)', 'stdin:end'])
    rig.clock.advance(25 * 60_000 + AGENT_KILL_GRACE_MS)
    rig.fake.close(null)
    const err = await rig.promise.catch((e: unknown) => e)
    expect((err as AgentWatchdogError).watchdogCause).toBe('tool_budget')
  })

  test('a provider with no readable stream still gets the inactivity guard', async () => {
    const rig = startRun({ command: 'my-agent --run' })
    rig.fake.stdout('some plain output\n')
    rig.clock.advance(20 * 60_000)
    expect(rig.fake.ops).toEqual(['stdin:write(go)', 'stdin:end'])
    rig.clock.advance(31 * 60_000 + AGENT_KILL_GRACE_MS)
    rig.fake.close(null)
    await expect(rig.promise).rejects.toBeInstanceOf(AgentWatchdogError)
  })

  test('the heartbeat beats every period so the UI can tell long from dead', async () => {
    const rig = startRun()
    rig.clock.advance(5 * 60_000)
    expect(rig.beats).toHaveLength(10)
    expect(rig.beats[9]?.idleMs).toBe(5 * 60_000)
    expect(rig.beats[9]?.inFlightTools).toBe(0)
    rig.fake.close(0)
    await expect(rig.promise).resolves.toBe('')
  })

  test('D3 defaults apply when the caller names no budgets', async () => {
    const clock = createFakeClock()
    const fake = createFakeChild()
    const beats: AgentHeartbeat[] = []
    const promise = runAgent({
      command: 'claude -p',
      prompt: 'go',
      cwd: '/tmp',
      absoluteCapMs: 10 * 60 * 60_000,
      clock,
      onHeartbeat: (beat) => beats.push(beat),
      spawnFn: () => fake.child,
      killFn: (pid, signal) => fake.ops.push(`kill:${pid}:${signal}`),
    })
    clock.advance(AGENT_WATCHDOG_DEFAULTS.heartbeatMs)
    expect(beats).toHaveLength(1)
    clock.advance(AGENT_WATCHDOG_DEFAULTS.inactivityMs + AGENT_KILL_GRACE_MS)
    fake.close(null)
    await expect(promise).rejects.toBeInstanceOf(AgentWatchdogError)
  })
})

describe('runAgent rejections stay distinct', () => {
  test('the absolute cap is still armed, and rejects as a timeout of its own', async () => {
    const rig = startRun({ absoluteCapMs: 15 * 60_000 })
    // Alive the whole way: a frame every 5 min, no tool ever stuck. Only the
    // last-resort ceiling can end this run.
    for (let i = 0; i < 3; i++) {
      rig.clock.advance(5 * 60_000)
      rig.fake.stdout(frame({ type: 'stream_event', event: { type: 'ping' } }))
    }
    rig.clock.advance(AGENT_KILL_GRACE_MS)
    expect(rig.fake.ops).toContain(killOp('SIGKILL'))
    rig.fake.close(null)
    const err = await rig.promise.catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(AgentWatchdogError)
    expect(agentReasonCode(err)).toBeNull()
    expect((err as Error).message).toMatch(/900s/)
  })

  test('a non-zero exit code rejects as itself', async () => {
    const rig = startRun()
    rig.fake.stdout(frame({ type: 'result', result: 'nope' }))
    rig.fake.close(2)
    const err = await rig.promise.catch((e: unknown) => e)
    expect(agentReasonCode(err)).toBeNull()
    expect((err as Error).message).toMatch(/2/)
  })

  test('an interrupt rejects as itself, watchdog or not', async () => {
    const controller = new AbortController()
    const clock = createFakeClock()
    const fake = createFakeChild()
    const promise = runAgent({
      command: 'claude -p',
      prompt: 'go',
      cwd: '/tmp',
      absoluteCapMs: 60 * 60_000,
      watchdog: TEST_BUDGETS,
      clock,
      signal: controller.signal,
      spawnFn: () => fake.child,
      killFn: (pid, signal) => fake.ops.push(`kill:${pid}:${signal}`),
    })
    controller.abort()
    expect(fake.ops).toContain(killOp('SIGTERM'))
    fake.close(null)
    const err = await promise.catch((e: unknown) => e)
    expect(agentReasonCode(err)).toBeNull()
    expect((err as Error).message).toMatch(/interrupted|interrompu/)
  })

  test('a spawn error rejects with the spawn error and disarms every timer', async () => {
    const rig = startRun()
    rig.fake.fail(new Error('spawn ENOENT'))
    await expect(rig.promise).rejects.toThrow('spawn ENOENT')
    // Nothing left ticking: a dead run neither beats nor gets killed.
    rig.clock.advance(10 * 60 * 60_000)
    expect(rig.beats).toEqual([])
    expect(rig.fake.ops).toEqual(['stdin:write(go)', 'stdin:end'])
  })

  test('an absurdly large ceiling does not kill the run on the spot', async () => {
    // End to end on the REAL clock: only the process is a double. Before the
    // clamp, this ceiling was armed at 1 ms and the run was SIGTERMed before
    // the prompt had finished being written.
    const fake = createFakeChild()
    const promise = runAgent({
      command: 'claude -p',
      prompt: 'go',
      cwd: '/tmp',
      absoluteCapMs: MAX_TIMER_MS + 60_000,
      watchdog: {
        inactivityMs: MAX_TIMER_MS * 2,
        toolBudgetMs: MAX_TIMER_MS * 3,
        heartbeatMs: 30_000,
      },
      spawnFn: () => fake.child,
      killFn: (pid, signal) => fake.ops.push(`kill:${pid}:${signal}`),
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(fake.ops).toEqual(['stdin:write(go)', 'stdin:end'])
    fake.stdout(frame({ type: 'result', result: 'still alive' }))
    fake.close(0)
    await expect(promise).resolves.toBe('still alive')
  })

  test('a clean exit resolves with the parsed final text', async () => {
    const rig = startRun()
    rig.fake.stdout(frame({ type: 'result', result: 'all done' }))
    rig.fake.close(0)
    await expect(rig.promise).resolves.toBe('all done')
  })
})

describe('runAgent settles even when the child never reports its death', () => {
  test('a process that survives SIGKILL still settles, with the watchdog cause', async () => {
    const rig = startRun()
    rig.clock.advance(30 * 60_000 + AGENT_KILL_GRACE_MS)
    expect(rig.fake.ops).toContain(killOp('SIGKILL'))
    // No 'close' will ever come: an uninterruptible process, or an inherited
    // pipe held open by a grandchild. shutdown() awaits this promise, so a run
    // that can never settle turns Ctrl-C into a hang.
    rig.clock.advance(AGENT_SETTLE_GRACE_MS)
    const err = await rig.promise.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentWatchdogError)
    expect(agentReasonCode(err)).toBe('inactivity_timeout')
  })

  test('the absolute cap settles the same way when nothing closes', async () => {
    const rig = startRun({ absoluteCapMs: 60_000 })
    rig.clock.advance(60_000 + AGENT_KILL_GRACE_MS + AGENT_SETTLE_GRACE_MS)
    const err = await rig.promise.catch((e: unknown) => e)
    expect(agentReasonCode(err)).toBeNull()
    expect((err as Error).message).toMatch(/60s/)
  })

  test('a close that DOES arrive settles first; the settle timer never double-fires', async () => {
    const rig = startRun()
    rig.clock.advance(30 * 60_000 + AGENT_KILL_GRACE_MS)
    rig.fake.close(137)
    await expect(rig.promise).rejects.toBeInstanceOf(AgentWatchdogError)
    // Anything the timers do afterwards must not throw on a settled promise.
    rig.clock.advance(10 * AGENT_SETTLE_GRACE_MS)
    rig.fake.close(0)
  })
})

describe('runAgent: a watchdog cut owns the outcome', () => {
  test('a human Stop during the kill grace does not erase the watchdog cause', async () => {
    const controller = new AbortController()
    const clock = createFakeClock()
    const fake = createFakeChild()
    const promise = runAgent({
      command: 'claude -p',
      prompt: 'go',
      cwd: '/tmp',
      absoluteCapMs: 10 * 60 * 60_000,
      watchdog: TEST_BUDGETS,
      clock,
      signal: controller.signal,
      spawnFn: () => fake.child,
      killFn: (pid, signal) => fake.ops.push(`kill:${pid}:${signal}`),
    })
    clock.advance(30 * 60_000)
    expect(fake.ops).toContain(killOp('SIGTERM'))
    // The human is REACTING to a task that already stopped answering; the cut
    // is what happened, and it carries the reason code and the resumable
    // status that go with it.
    controller.abort()
    clock.advance(AGENT_KILL_GRACE_MS)
    fake.close(null)
    const err = await promise.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentWatchdogError)
    expect(agentReasonCode(err)).toBe('inactivity_timeout')
  })

  test('a Stop on a healthy run is still an interrupt, with no reason code', async () => {
    const controller = new AbortController()
    const clock = createFakeClock()
    const fake = createFakeChild()
    const promise = runAgent({
      command: 'claude -p',
      prompt: 'go',
      cwd: '/tmp',
      absoluteCapMs: 10 * 60 * 60_000,
      watchdog: TEST_BUDGETS,
      clock,
      signal: controller.signal,
      spawnFn: () => fake.child,
      killFn: (pid, signal) => fake.ops.push(`kill:${pid}:${signal}`),
    })
    controller.abort()
    fake.close(null)
    const err = await promise.catch((e: unknown) => e)
    expect(agentReasonCode(err)).toBeNull()
    expect((err as Error).message).toMatch(/interrupted|interrompu/)
  })
})

describe('runAgent activity is decoded frames, not bytes', () => {
  test('a readable stream dribbling undecodable bytes is not alive', async () => {
    const rig = startRun()
    // The command emits claude JSONL, so frames are the signal. Garbage on
    // that stream proves nothing about the agent — counting it as life would
    // let a broken provider hold the watchdog open forever.
    for (let i = 0; i < 5; i++) {
      rig.clock.advance(5 * 60_000)
      rig.fake.stdout('not json at all\n')
    }
    rig.clock.advance(5 * 60_000 + AGENT_KILL_GRACE_MS)
    rig.fake.close(null)
    const err = await rig.promise.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentWatchdogError)
    expect((err as AgentWatchdogError).watchdogCause).toBe('inactivity')
  })

  test('the same bytes DO count for a provider whose stream cannot be decoded', async () => {
    const rig = startRun({ command: 'my-agent --run' })
    for (let i = 0; i < 8; i++) {
      rig.clock.advance(5 * 60_000)
      rig.fake.stdout('still working\n')
    }
    expect(rig.fake.ops).toEqual(['stdin:write(go)', 'stdin:end'])
    rig.fake.close(0)
    await expect(rig.promise).resolves.toContain('still working')
  })
})

describe('effectiveAbsoluteCapMs', () => {
  test('a ceiling under the budgets is raised above them, escalation included', () => {
    // The shipped default: a 900 s ceiling under a 1 800 s inactivity budget —
    // the watchdog could never fire once, so every live task still died of the
    // wall clock at 15 min and every dead one still went unnamed.
    const cap = effectiveAbsoluteCapMs(900_000, AGENT_WATCHDOG_DEFAULTS)
    expect(cap).toBeGreaterThan(AGENT_WATCHDOG_DEFAULTS.inactivityMs)
    expect(cap).toBeGreaterThan(AGENT_WATCHDOG_DEFAULTS.toolBudgetMs)
    expect(cap).toBe(
      AGENT_WATCHDOG_DEFAULTS.toolBudgetMs +
        AGENT_KILL_GRACE_MS +
        AGENT_SETTLE_GRACE_MS +
        WATCHDOG_CAP_MARGIN_MS,
    )
  })

  test('a ceiling already above the budgets is left exactly as configured', () => {
    const generous = 24 * 60 * 60_000
    expect(effectiveAbsoluteCapMs(generous, AGENT_WATCHDOG_DEFAULTS)).toBe(generous)
  })

  test('it follows the budgets, not a hardcoded number', () => {
    const budgets = { inactivityMs: 10_000, toolBudgetMs: 5_000, heartbeatMs: 1_000 }
    expect(effectiveAbsoluteCapMs(1, budgets)).toBe(
      10_000 + AGENT_KILL_GRACE_MS + AGENT_SETTLE_GRACE_MS + WATCHDOG_CAP_MARGIN_MS,
    )
  })
})

describe('emitsClaudeStreamJson token forms', () => {
  test('both spellings of the flag count', () => {
    expect(emitsClaudeStreamJson('claude -p --output-format stream-json --verbose')).toBe(true)
    expect(emitsClaudeStreamJson('claude -p --output-format=stream-json')).toBe(true)
    expect(emitsClaudeStreamJson(claudeStreamCommand('claude -p') ?? '')).toBe(true)
  })

  test('another value, a longer flag or quoted prose never count', () => {
    expect(emitsClaudeStreamJson('claude -p --output-format json')).toBe(false)
    expect(emitsClaudeStreamJson('claude -p --output-formats stream-json')).toBe(false)
    expect(emitsClaudeStreamJson('claude -p --output-format stream-json-lines')).toBe(false)
    expect(
      emitsClaudeStreamJson('claude -p --append-system-prompt "--output-format stream-json"'),
    ).toBe(false)
    expect(emitsClaudeStreamJson('claude -p')).toBe(false)
  })
})

describe('createClaudeTaskParser countOnly', () => {
  test('counting consumers pay nothing for summaries they never read', () => {
    const line = (event: unknown) => `${JSON.stringify(event)}\n`
    const seen: string[] = []
    let tools = 0
    const parser = createClaudeTaskParser({
      countOnly: true,
      onToolUse: (_name, input) => {
        tools++
        seen.push(input)
      },
      onToolResult: (summary) => seen.push(summary),
    })
    parser.push(
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Write', input: { content: 'x'.repeat(100_000) } }],
        },
      }),
    )
    parser.push(
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'y'.repeat(100_000) }] },
      }),
    )
    expect(tools).toBe(1)
    expect(seen).toEqual(['', ''])
  })

  test('a huge payload is still summarized to the ceiling for consumers that want it', () => {
    const line = (event: unknown) => `${JSON.stringify(event)}\n`
    const inputs: string[] = []
    const parser = createClaudeTaskParser({ onToolUse: (_n, input) => inputs.push(input) })
    parser.push(
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Write', input: { content: '𝔘'.repeat(200_000) } }],
        },
      }),
    )
    // Astral code points: two UTF-16 units each, so the coarse scan window
    // still holds far more than the ceiling and the result is unchanged.
    expect(Array.from(inputs[0] ?? '')).toHaveLength(TASK_TOOL_SUMMARY_MAX)
    expect(inputs[0]?.endsWith('…')).toBe(true)
  })
})

// --- per-turn cost (T1.8) ---------------------------------------------------

const line = (obj: unknown) => JSON.stringify(obj) + '\n'

/** One assistant frame, with the message id the stream repeats across blocks. */
const assistant = (
  model: string,
  usage: Record<string, unknown>,
  id = 'msg_01',
  content: unknown[] = [],
) => line({ type: 'assistant', message: { id, model, content, usage } })

/** A task parser wired to record everything the cost meter publishes. */
const collect = (options: ClaudeTaskParserOptions = {}) => {
  const costs: (SettledCost | null)[] = []
  const degraded: CostDegradation[] = []
  const parser = createClaudeTaskParser(
    {
      onCost: (cost) => costs.push(cost),
      onCostDegraded: (d) => degraded.push(d),
    },
    { at: '2026-08-19T10:00:00.000Z', env: {}, ...options },
  )
  return { costs, degraded, parser }
}

describe('createClaudeTaskParser cost', () => {
  test('the lower bound is counted by the CLI from the stream counters', () => {
    const { costs, degraded, parser } = collect()
    // claude-opus-5: $5/MTok base input => 50 000 ticks per token.
    parser.push(assistant('claude-opus-5', { input_tokens: 100, output_tokens: 50 }))
    expect(costs).toEqual([{ ticks: 100 * 50_000, basis: 'lower_bound' }])
    expect(degraded).toEqual([])
  })

  test('cache reads and both cache-write TTLs are billed, at their own rates', () => {
    const { costs, parser } = collect()
    parser.push(
      assistant('claude-opus-5', {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 1_000,
          ephemeral_1h_input_tokens: 2_000,
        },
      }),
    )
    // input 100 x 50 000 + read 20 000 x 5 000 + 5m 1 000 x 62 500 + 1h 2 000 x 100 000.
    expect(costs).toEqual([
      {
        ticks: 100 * 50_000 + 20_000 * 5_000 + 1_000 * 62_500 + 2_000 * 100_000,
        basis: 'lower_bound',
      },
    ])
  })

  test('the frames of ONE response are charged once, however many blocks it has', () => {
    const { costs, parser } = collect()
    const usage = { input_tokens: 1_000, output_tokens: 50, cache_read_input_tokens: 10_000 }
    // Claude Code emits one frame per content block, all with the same id and
    // the same usage: counting frames would inflate the turn several-fold.
    parser.push(assistant('claude-opus-5', usage, 'msg_A'))
    parser.push(assistant('claude-opus-5', usage, 'msg_A'))
    parser.push(assistant('claude-opus-5', usage, 'msg_A'))
    expect(costs).toEqual([{ ticks: 1_000 * 50_000 + 10_000 * 5_000, basis: 'lower_bound' }])
  })

  test('the TOKEN meter deduplicates by message id too — the same bug, same fix', () => {
    const seen: number[] = []
    const usage = { input_tokens: 100, output_tokens: 50 }
    const parser = createClaudeTaskParser({ onTokens: (n) => seen.push(n) })
    parser.push(assistant('claude-opus-5', usage, 'msg_A'))
    parser.push(assistant('claude-opus-5', usage, 'msg_A'))
    parser.push(assistant('claude-opus-5', usage, 'msg_B'))
    expect(seen).toEqual([150, 300])
  })

  test('subagent frames never reach the price table', () => {
    const { costs, parser } = collect()
    parser.push(assistant('claude-opus-5', { input_tokens: 1_000 }, 'msg_main'))
    // Claude Code stamps a subagent's frames with the tool call that spawned
    // them; the official cost-tracking guide skips exactly these.
    parser.push(
      line({
        type: 'assistant',
        parent_tool_use_id: 'toolu_01',
        message: {
          id: 'msg_sub',
          model: 'claude-opus-5',
          content: [],
          usage: { input_tokens: 500_000 },
        },
      }),
    )
    expect(costs).toEqual([{ ticks: 1_000 * 50_000, basis: 'lower_bound' }])
  })

  test('subagent tokens ARE still counted: the turn burned them', () => {
    const seen: number[] = []
    const parser = createClaudeTaskParser({ onTokens: (n) => seen.push(n) })
    parser.push(assistant('claude-opus-5', { input_tokens: 100, output_tokens: 50 }, 'msg_main'))
    parser.push(
      line({
        type: 'assistant',
        parent_tool_use_id: 'toolu_01',
        message: {
          id: 'msg_sub',
          model: 'claude-opus-5',
          content: [],
          usage: { input_tokens: 200, output_tokens: 80 },
        },
      }),
    )
    expect(seen).toEqual([150, 430])
  })

  test('a figure the model merely SAYS is never the cost', () => {
    const { costs, parser } = collect()
    parser.push(
      assistant('claude-opus-5', { input_tokens: 10, output_tokens: 10 }, 'msg_01', [
        { type: 'text', text: 'This turn cost me $12.34, about 999999999 ticks.' },
      ]),
    )
    // Derived from the counters alone; the prose in the reply changes nothing.
    expect(costs).toEqual([{ ticks: 10 * 50_000, basis: 'lower_bound' }])
  })

  test('the result frame supersedes the bound with the harness estimate', () => {
    const { costs, parser } = collect()
    parser.push(assistant('claude-opus-5', { input_tokens: 100, output_tokens: 50 }))
    parser.push(
      line({
        type: 'result',
        subtype: 'success',
        result: 'done',
        total_cost_usd: 0.25,
        modelUsage: { 'claude-opus-5': { costUSD: 0.25 } },
        usage: { input_tokens: 400, output_tokens: 150 },
      }),
    )
    expect(costs.at(-1)).toEqual({ ticks: 2_500_000_000, basis: 'harness' })
  })

  test('a result frame that FAILED leaves the bound in place, zeroes and all', () => {
    const { costs, parser } = collect()
    parser.push(assistant('claude-opus-5', { input_tokens: 100, output_tokens: 50 }))
    parser.push(
      line({
        type: 'result',
        subtype: 'error_during_execution',
        result: 'crashed',
        total_cost_usd: 0,
        usage: {},
      }),
    )
    // A 0 on an error frame is UNKNOWN: it must not overwrite what we counted.
    expect(costs.at(-1)).toEqual({ ticks: 100 * 50_000, basis: 'lower_bound' })
  })

  test('a model with no price row: no cost at all, and a named degradation', () => {
    const { costs, degraded, parser } = collect()
    parser.push(assistant('some-other-model-v3', { input_tokens: 100, output_tokens: 50 }))
    expect(costs).toEqual([])
    expect(degraded).toEqual([{ cause: 'model_unpriced', model: 'some-other-model-v3' }])
  })

  test('a run on a partner platform is left unpriced, on either signal', () => {
    const byEnv = collect({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } })
    byEnv.parser.push(assistant('claude-opus-5', { input_tokens: 100, output_tokens: 50 }))
    expect(byEnv.costs).toEqual([])
    expect(byEnv.degraded).toEqual([
      { cause: 'partner_platform', signal: 'CLAUDE_CODE_USE_BEDROCK' },
    ])

    const byShape = collect()
    byShape.parser.push(
      assistant('us.anthropic.claude-opus-4-5-20251101-v1:0', {
        input_tokens: 100,
        output_tokens: 50,
      }),
    )
    expect(byShape.costs).toEqual([])
    expect(byShape.degraded[0]?.cause).toBe('partner_platform')
  })

  test('the degradation is reported once per model, not once per frame', () => {
    const { degraded, parser } = collect()
    parser.push(assistant('some-other-model-v3', { input_tokens: 10 }, 'a'))
    parser.push(assistant('some-other-model-v3', { input_tokens: 10 }, 'b'))
    parser.push(assistant('some-other-model-v3', { input_tokens: 10 }, 'c'))
    expect(degraded).toEqual([{ cause: 'model_unpriced', model: 'some-other-model-v3' }])
  })

  test('a frame with no usage never fires the cost meter', () => {
    const { costs, degraded, parser } = collect()
    parser.push(
      line({ type: 'assistant', message: { id: 'x', content: [], model: 'claude-opus-5' } }),
    )
    parser.push(line({ type: 'result', subtype: 'success', result: 'done' }))
    expect(costs).toEqual([])
    expect(degraded).toEqual([])
  })

  test('the price is read at the TURN’s date, not at "now"', () => {
    const rows: PriceRow[] = [
      {
        model: 'claude-opus-5',
        until: '2026-08-18',
        input_cents_per_mtok: 500,
        cache_read_cents_per_mtok: 50,
        cache_write_5m_cents_per_mtok: 625,
        cache_write_1h_cents_per_mtok: 1_000,
      },
    ]
    const before = collect({ at: '2026-08-17T10:00:00.000Z', prices: rows })
    before.parser.push(assistant('claude-opus-5', { input_tokens: 1_000 }))
    expect(before.costs).toEqual([{ ticks: 1_000 * 50_000, basis: 'lower_bound' }])

    const after = collect({ at: '2026-08-19T10:00:00.000Z', prices: rows })
    after.parser.push(assistant('claude-opus-5', { input_tokens: 1_000 }))
    expect(after.costs).toEqual([])
    expect(after.degraded).toEqual([
      { cause: 'price_expired', model: 'claude-opus-5', at: '2026-08-19T10:00:00.000Z' },
    ])
  })

  test('the token meter is untouched by the cost path', () => {
    const tokens: number[] = []
    const parser = createClaudeTaskParser({ onTokens: (n) => tokens.push(n) })
    parser.push(assistant('some-other-model-v3', { input_tokens: 100, output_tokens: 50 }, 'a'))
    parser.push(assistant('claude-opus-5', { input_tokens: 200, output_tokens: 80 }, 'b'))
    // Tokens are counted whether or not the model can be priced.
    expect(tokens).toEqual([150, 430])
  })
})
