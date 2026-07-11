#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { loadConfig } from './config.js'
import { exportCommand } from './export.js'
import { tryGit } from './git.js'
import { prep } from './prep.js'
import { review } from './review.js'
import { show } from './show.js'
import { configCommand } from './wizard.js'

const VERSION = '0.1.0'

const HELP = `mr-review — local merge request review, told as chapters

Usage:
  mr-review review [--target <branch>] [--agent <cmd>] [--port <n>] [--timeout <s>] [--no-open]
                                       All-in-one: prep, review with your AI agent CLI, then show
  mr-review prep [--target <branch>]   Detect branches, compute the MR diff, write .mr-review/input.json
  mr-review show [--review <file>] [--port <n>] [--no-open]
                                       Display the review (agent output) in a local web UI
  mr-review config                     Pick the AI agent, model and effort for this repo (interactive)
  mr-review export [--review <file>] [--out <file>]
                                       Export the review as Markdown (--out - for stdout)

Options:
  --target <branch>   Target branch of the MR (default: auto-detected via glab/gh, origin/HEAD, then heuristic)
  --agent <cmd>       Agent command for one-shot review (default: "claude -p"). Receives the prompt on stdin,
                      must print the review JSON on stdout
  --review <file>     Agent output to display (default: .mr-review/review.json, else last archived review)
  --port <n>          Preferred port for the local server (default: 4400)
  --timeout <s>       Agent time budget in seconds for \`review\` (default: 900)
  --no-open           Do not open the browser
  -h, --help          Show this help
  -v, --version       Show version
`

function parseIntFlag(name: string, raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`--${name} ${raw}: expected an integer between ${min} and ${max}`)
  }
  return n
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      target: { type: 'string' },
      agent: { type: 'string' },
      review: { type: 'string' },
      out: { type: 'string' },
      port: { type: 'string' },
      timeout: { type: 'string' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })

  if (values.version) {
    console.log(VERSION)
    return
  }
  const command = positionals[0]
  if (values.help || !command) {
    console.log(HELP)
    return
  }

  // Config du repo (.mr-review/config.json) : flags CLI prioritaires partout.
  const repoRoot = tryGit(['rev-parse', '--show-toplevel'], process.cwd())
  const config = repoRoot ? loadConfig(repoRoot) : {}

  switch (command) {
    case 'review':
      await review({
        target: values.target ?? config.target,
        agent: values.agent ?? config.agent,
        port: parseIntFlag('port', values.port, 1, 65535) ?? config.port,
        timeout: parseIntFlag('timeout', values.timeout, 1, 86400) ?? config.timeout,
        open: !values['no-open'],
        cwd: process.cwd(),
      })
      break
    case 'prep':
      prep({ target: values.target ?? config.target, cwd: process.cwd() })
      break
    case 'show':
      await show({
        review: values.review,
        port: parseIntFlag('port', values.port, 1, 65535) ?? config.port,
        open: !values['no-open'],
        cwd: process.cwd(),
      })
      break
    case 'config':
      if (!repoRoot) throw new Error('not inside a git repository — run `mr-review config` from your repo')
      await configCommand(repoRoot)
      break
    case 'export':
      exportCommand({ review: values.review, out: values.out, cwd: process.cwd() })
      break
    default:
      console.error(`unknown command: ${command}\n`)
      console.log(HELP)
      process.exitCode = 1
  }
}

main().catch((err: unknown) => {
  console.error(`mr-review: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
