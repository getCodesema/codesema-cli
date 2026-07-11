#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { loadConfig } from './config.js'
import { exportCommand } from './export.js'
import { tryGit } from './git.js'
import { prep } from './prep.js'
import { review } from './review.js'
import { show } from './show.js'
import { configCommand } from './wizard.js'

// Replaced at build time by tsdown (define) with the version from package.json.
declare const __CODESEMA_VERSION__: string
const VERSION = typeof __CODESEMA_VERSION__ !== 'undefined' ? __CODESEMA_VERSION__ : '0.0.0-dev'

const HELP = `codesema — local merge request review, step by step

Usage:
  codesema                            Interactive review: pick a local branch, the web UI opens
                                      immediately and fills in live while your AI agent reviews.
                                      First run only: a short wizard picks the agent, model and
                                      effort (saved globally — change it with \`codesema config\`)
  codesema review [--branch <name>] [--target <branch>] [--agent <cmd>] [--full] [--no-open]
                                      Same flow; --branch skips the branch picker (also skipped
                                      when stdin is not a terminal, e.g. CI). Re-runs on the same
                                      branch update the previous review incrementally; --full
                                      forces a review from scratch
  codesema config                     Change the AI agent, model and effort (interactive)
  codesema prep [--target <branch>]   Only detect branches, compute the MR diff, write
                                      .codesema/input.json for your own agent flow
  codesema show [--review <file>]     Only display a review (agent output) in the local web UI
  codesema export [--review <file>] [--out <file>]
                                      Export the review as Markdown (--out - for stdout)

Options:
  --branch <name>     Local branch to review (default: interactive picker, else current branch)
  --target <branch>   Target branch of the MR (default: auto-detected via glab/gh, origin/HEAD, then heuristic)
  --agent <cmd>       Agent command override for this run. Receives the prompt on stdin,
                      must print the review JSON on stdout
  --review <file>     Agent output to display (default: .codesema/review.json, else last archived review)
  --port <n>          Preferred port for the local server (default: 4400)
  --timeout <s>       Agent time budget in seconds for \`review\` (default: 900)
  --full              Review from scratch instead of updating the previous review
  --no-open           Do not open the browser
  -h, --help          Show this help
  -v, --version       Show version

Config precedence: CLI flags > .codesema/config.json (repo) > ~/.config/codesema/config.json (global).
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
      branch: { type: 'string' },
      target: { type: 'string' },
      agent: { type: 'string' },
      review: { type: 'string' },
      out: { type: 'string' },
      port: { type: 'string' },
      timeout: { type: 'string' },
      full: { type: 'boolean' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })

  if (values.version) {
    console.log(VERSION)
    return
  }
  if (values.help) {
    console.log(HELP)
    return
  }
  const command = positionals[0] ?? 'review'
  const repoRoot = tryGit(['rev-parse', '--show-toplevel'], process.cwd())

  switch (command) {
    case 'review':
      await review({
        branch: values.branch,
        target: values.target,
        agent: values.agent,
        port: parseIntFlag('port', values.port, 1, 65535),
        timeout: parseIntFlag('timeout', values.timeout, 1, 86400),
        full: values.full,
        open: !values['no-open'],
        cwd: process.cwd(),
      })
      break
    case 'prep':
      prep({ branch: values.branch, target: values.target ?? loadConfig(repoRoot).target, cwd: process.cwd() })
      break
    case 'show':
      await show({
        review: values.review,
        port: parseIntFlag('port', values.port, 1, 65535) ?? loadConfig(repoRoot).port,
        open: !values['no-open'],
        cwd: process.cwd(),
      })
      break
    case 'config':
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
  console.error(`codesema: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
