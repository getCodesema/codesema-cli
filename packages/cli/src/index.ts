#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadConfig } from './config.js'
import { exportCommand } from './export.js'
import { tryGit } from './git.js'
import { setLanguage, t } from './i18n.js'
import { reviewFlagsPassed, runMenu } from './menu.js'
import { prep } from './prep.js'
import { review, REVIEW_GATE_VALUES, type ReviewGate } from './review.js'
import { runnerCommand } from './runner-commands.js'
import { show } from './show.js'
import { linkCommand, syncCommand } from './sync.js'
import { isInteractive } from './tui.js'
import { maybeOfferUpgrade } from './upgrade.js'
import { VERSION } from './version.js'
import { configCommand } from './wizard.js'
import { workspace } from './workspace.js'

/**
 * Any flag bag, as `parseArgs` hands one over: absent, a string, or a boolean.
 * `resolveCommand` only ever asks for flags by name, so it stays usable from a
 * test with a bare object literal.
 */
export type CliValues = {
  readonly [flag: string]: string | boolean | undefined
}

/** The flags this CLI declares, with the exact type `parseArgs` gives each one. */
type ParsedValues = {
  branch?: string | undefined
  target?: string | undefined
  agent?: string | undefined
  review?: string | undefined
  out?: string | undefined
  port?: string | undefined
  timeout?: string | undefined
  full?: boolean | undefined
  dual?: boolean | undefined
  force?: boolean | undefined
  'fail-on'?: string | undefined
  'no-open'?: boolean | undefined
  help?: boolean | undefined
  version?: boolean | undefined
  runner?: boolean | undefined
  url?: string | undefined
  token?: string | undefined
  issue?: string | undefined
  title?: string | undefined
  prompt?: string | undefined
  detach?: boolean | undefined
  'secrets-file'?: string | undefined
  fingerprint?: string | undefined
  'gh-token-from-gh'?: boolean | undefined
  'claude-token'?: string | undefined
  'repo-url'?: string | undefined
  'git-name'?: string | undefined
  'git-email'?: string | undefined
}

export const COMMAND_NAMES = [
  'review',
  'prep',
  'workspace',
  'menu',
  'show',
  'config',
  'export',
  'sync',
  'link',
  'runner',
] as const

export type CommandName = (typeof COMMAND_NAMES)[number]

/**
 * What the command line asks for, decided without touching the world.
 * `unknown` carries its own exit code so the caller stays a plain dispatcher.
 */
export type ResolvedCommand =
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'workspace' }
  | { kind: 'command'; name: CommandName; arg: string | undefined }
  | { kind: 'unknown'; command: string; exitCode: 1 }

export function parseIntFlag(
  name: string,
  raw: string | undefined,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined) {
    return undefined
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(t('cli.intFlagError', { name, raw, min, max }))
  }
  return n
}

export function parseFailOn(raw: string | undefined): ReviewGate | undefined {
  if (raw === undefined) {
    return undefined
  }
  if ((REVIEW_GATE_VALUES as readonly string[]).includes(raw)) {
    return raw as ReviewGate
  }
  throw new Error(t('cli.failOnError', { raw, values: REVIEW_GATE_VALUES.join(', ') }))
}

function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value)
}

/**
 * The whole dispatch decision, pure: no I/O, no `await`, nothing read from the
 * process. The terminal state enters through `ctx.interactive` (injection seam)
 * so the branch that used to be reachable only from a real TTY is testable.
 *
 * The order below mirrors `main()` exactly — `--version`, then `--help`, then
 * the workspace switch, then the command table — because `main()` interleaves
 * side effects between those steps and must keep its historical sequence.
 */
export function resolveCommand(
  values: CliValues,
  positionals: readonly string[],
  ctx: { interactive: boolean },
): ResolvedCommand {
  if (values.version === true) {
    return { kind: 'version' }
  }
  if (values.help === true) {
    return { kind: 'help' }
  }
  // The workspace IS the product (plan decision n°7): a bare interactive
  // `codesema` opens it. Review flags keep their historical meaning (they fall
  // through to `review` below) and non-TTY keeps the old default, so CI
  // pipelines built on bare `codesema` are untouched. The old menu stays
  // reachable as `codesema menu`.
  if (positionals[0] === undefined && !reviewFlagsPassed(values) && ctx.interactive) {
    return { kind: 'workspace' }
  }
  const command = positionals[0] ?? 'review'
  if (!isCommandName(command)) {
    return { kind: 'unknown', command, exitCode: 1 }
  }
  return { kind: 'command', name: command, arg: positionals[1] }
}

async function runCommand(
  name: CommandName,
  arg: string | undefined,
  values: ParsedValues,
  repoRoot: string | null,
): Promise<void> {
  switch (name) {
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
      await prep({
        branch: values.branch,
        target: values.target ?? loadConfig(repoRoot).target,
        cwd: process.cwd(),
      })
      break
    case 'workspace':
      if (values.runner) {
        // workspace() (workspace.ts) has a fixed options type with no room
        // for a runner flag; the signal crosses into startServer (serve.ts)
        // the same way CODESEMA_SYNC_URL/CODESEMA_DEV_VITE already do in
        // this codebase, read at the one place that needs it.
        process.env.CODESEMA_RUNNER_MODE = '1'
      }
      await workspace({
        port: parseIntFlag('port', values.port, 1, 65535),
        open: !values['no-open'],
        cwd: process.cwd(),
        agent: values.agent,
        timeout: parseIntFlag('timeout', values.timeout, 1, 86400),
      })
      break
    case 'menu':
      await runMenu({ cwd: process.cwd() })
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
      await syncCommand({ action: arg, cwd: process.cwd(), force: values.force })
      break
    case 'link':
      await linkCommand({ code: arg })
      break
    case 'runner':
      await runnerCommand({
        action: arg,
        cwd: process.cwd(),
        url: values.url,
        token: values.token,
        issue: values.issue,
        title: values.title,
        prompt: values.prompt,
        detach: values.detach,
        envFile: values['secrets-file'],
        fingerprint: values.fingerprint,
        ghTokenFromGh: values['gh-token-from-gh'],
        claudeToken: values['claude-token'],
        repoUrl: values['repo-url'],
        gitName: values['git-name'],
        gitEmail: values['git-email'],
        timeoutSeconds: parseIntFlag('timeout', values.timeout, 1, 86400),
      })
      break
  }
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
      runner: { type: 'boolean' },
      url: { type: 'string' },
      token: { type: 'string' },
      issue: { type: 'string' },
      title: { type: 'string' },
      prompt: { type: 'string' },
      detach: { type: 'boolean' },
      'secrets-file': { type: 'string' },
      fingerprint: { type: 'string' },
      'gh-token-from-gh': { type: 'boolean' },
      'claude-token': { type: 'string' },
      'repo-url': { type: 'string' },
      'git-name': { type: 'string' },
      'git-email': { type: 'string' },
    },
  })

  const resolved = resolveCommand(values, positionals, { interactive: isInteractive() })
  if (resolved.kind === 'version') {
    console.log(VERSION)
    return
  }
  const repoRoot = tryGit(['rev-parse', '--show-toplevel'], process.cwd())
  setLanguage(loadConfig(repoRoot).language)
  if (resolved.kind === 'help') {
    console.log(t('cli.help'))
    return
  }
  await maybeOfferUpgrade()
  if (resolved.kind === 'workspace') {
    await workspace({ port: undefined, open: true, cwd: process.cwd() })
    return
  }
  if (resolved.kind === 'unknown') {
    console.error(`${t('cli.unknownCommand', { command: resolved.command })}\n`)
    console.log(t('cli.help'))
    process.exitCode = resolved.exitCode
    return
  }
  await runCommand(resolved.name, resolved.arg, values, repoRoot)
}

/**
 * This module is both the executable entry point and the home of the exported
 * `resolveCommand`, which its test imports: run `main()` only when the process
 * was started ON this file (a bin symlink realpaths back to it), never when a
 * test — or anything else — imports it.
 */
function isProcessEntrypoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) {
    return false
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isProcessEntrypoint()) {
  main().catch((err: unknown) => {
    console.error(`codesema: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
