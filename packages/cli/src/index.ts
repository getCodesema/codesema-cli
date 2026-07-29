#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { loadConfig } from './config.js'
import { setLanguage, t } from './i18n.js'
import { exportCommand } from './export.js'
import { tryGit } from './git.js'
import { reviewFlagsPassed, runMenu } from './menu.js'
import { prep } from './prep.js'
import { review, REVIEW_GATE_VALUES, type ReviewGate } from './review.js'
import { show } from './show.js'
import { linkCommand, syncCommand } from './sync.js'
import { isInteractive } from './tui.js'
import { maybeOfferUpgrade } from './upgrade.js'
import { VERSION } from './version.js'
import { configCommand } from './wizard.js'

function parseIntFlag(name: string, raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(t('cli.intFlagError', { name, raw, min, max }))
  }
  return n
}

function parseFailOn(raw: string | undefined): ReviewGate | undefined {
  if (raw === undefined) return undefined
  if ((REVIEW_GATE_VALUES as readonly string[]).includes(raw)) return raw as ReviewGate
  throw new Error(t('cli.failOnError', { raw, values: REVIEW_GATE_VALUES.join(', ') }))
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
      dual: { type: 'boolean' },
      force: { type: 'boolean' },
      'fail-on': { type: 'string' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })

  if (values.version) {
    console.log(VERSION)
    return
  }
  const repoRoot = tryGit(['rev-parse', '--show-toplevel'], process.cwd())
  setLanguage(loadConfig(repoRoot).language)
  if (values.help) {
    console.log(t('cli.help'))
    return
  }
  await maybeOfferUpgrade()
  if (positionals[0] === undefined && !reviewFlagsPassed(values) && isInteractive()) {
    await runMenu({ cwd: process.cwd() })
    return
  }
  const command = positionals[0] ?? 'review'

  switch (command) {
    case 'review':
      await review({
        branch: values.branch,
        target: values.target,
        agent: values.agent,
        port: parseIntFlag('port', values.port, 1, 65535),
        timeout: parseIntFlag('timeout', values.timeout, 1, 86400),
        full: values.full,
        dual: values.dual,
        failOn: parseFailOn(values['fail-on']),
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
    case 'sync':
      await syncCommand({ action: positionals[1], cwd: process.cwd(), force: values.force })
      break
    case 'link':
      await linkCommand({ code: positionals[1] })
      break
    default:
      console.error(`${t('cli.unknownCommand', { command })}\n`)
      console.log(t('cli.help'))
      process.exitCode = 1
  }
}

main().catch((err: unknown) => {
  console.error(`codesema: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
