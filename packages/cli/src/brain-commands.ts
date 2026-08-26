// `codesema brain …`: connect a workspace to a brain, inspect it, draft and
// publish a ticket by hand, or start the background daemon. Same shape as
// sync.ts's `syncCommand`/`linkCommand`: one action-dispatching entry point,
// each branch throwing a plain `Error` the CLI's top-level catch prints.

import type { runAgent } from './agent.js'
import { brainErrorMessage, brainRemoteUrl, listTickets, parseBrainToken } from './brain-client.js'
import { draftAndPublishTicket } from './brain-draft.js'
import { loadGlobalConfig, saveGlobalConfig } from './config.js'
import { t } from './i18n.js'
import { loadSyncCredentials } from './sync.js'
import { GREEN, paint, renderFieldRows, type FieldRow } from './ui.js'
import { workspace } from './workspace.js'

/** Same bkctl-style result block as sync.ts's own (private there, so restated here). */
function printResult(statusMessage: string, rows: FieldRow[]): void {
  console.log('')
  console.log(`  ${paint('✔', GREEN)} ${statusMessage}`)
  for (const line of renderFieldRows(rows)) {
    console.log(`  ${line}`)
  }
}

export type BrainCommandOptions = {
  action?: string | undefined
  cwd: string
  url?: string | undefined
  token?: string | undefined
  issue?: string | undefined
  title?: string | undefined
  prompt?: string | undefined
  /** Test seam. */
  fetchImpl?: typeof fetch | undefined
  /** Test seam. */
  runAgentFn?: typeof runAgent | undefined
}

async function brainConnect(opts: BrainCommandOptions): Promise<void> {
  if (!opts.url || !opts.token) {
    throw new Error(t('brain.connectMissingFlags'))
  }
  const parsed = parseBrainToken(opts.token)
  if (!parsed) {
    throw new Error(t('brain.badToken'))
  }
  // Same global credentials sync.ts's createWorkspace/linkWorkspace write:
  // `codesema sync`, `codesema link` and the brain daemon share one account.
  const path = saveGlobalConfig({
    ...loadGlobalConfig(),
    syncUrl: opts.url,
    syncWorkspaceId: parsed.workspaceId,
    syncSecret: parsed.secret,
  })
  printResult(t('brain.connected', { url: opts.url }), [
    { label: t('field.account'), value: parsed.workspaceId },
  ])
  console.log(`  ${t('brain.savedTo', { path })}`)
  console.log('')
}

async function brainStatus(opts: BrainCommandOptions): Promise<void> {
  const creds = loadSyncCredentials()
  if (!creds) {
    throw new Error(t('brain.notConnected'))
  }
  const remoteUrl = brainRemoteUrl(opts.cwd)
  const rows: FieldRow[] = [
    { label: t('brain.fieldUrl'), value: creds.url },
    { label: t('field.account'), value: creds.workspaceId },
    { label: t('brain.fieldRepo'), value: remoteUrl ?? t('brain.noRemote') },
  ]
  if (!remoteUrl) {
    printResult(t('brain.statusTitle'), rows)
    return
  }
  const result = await listTickets(creds, remoteUrl, 'published', opts.fetchImpl ?? fetch)
  rows.push({
    label: t('brain.fieldReady'),
    value: result.ok ? String(result.data.length) : brainErrorMessage(result.error),
  })
  printResult(t('brain.statusTitle'), rows)
}

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

async function brainTicket(opts: BrainCommandOptions): Promise<void> {
  const hasIssue = opts.issue !== undefined
  const hasPromptForm = opts.title !== undefined && opts.prompt !== undefined
  if (hasIssue === hasPromptForm) {
    throw new Error(t('brain.ticketUsage'))
  }

  const seams = {
    ...(opts.runAgentFn ? { runAgentFn: opts.runAgentFn } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  }
  const outcome = hasIssue
    ? await (async () => {
        const issueNumber = opts.issue ? parsePositiveInt(opts.issue) : null
        if (issueNumber === null) {
          throw new Error(t('brain.badIssueNumber', { value: opts.issue ?? '' }))
        }
        return draftAndPublishTicket({ kind: 'issue', cwd: opts.cwd, issueNumber }, seams)
      })()
    : await draftAndPublishTicket(
        {
          kind: 'prompt',
          cwd: opts.cwd,
          title: opts.title as string,
          prompt: opts.prompt as string,
        },
        seams,
      )

  if (!outcome.ok) {
    throw new Error(t('brain.draftFailed', { reason: outcome.reason }))
  }
  printResult(t('brain.ticketCreated', { title: outcome.ticket.title }), [
    { label: t('brain.fieldId'), value: outcome.ticket.id },
    { label: t('field.status'), value: outcome.ticket.status },
  ])
  console.log('')
  console.log(outcome.ticket.body)
  console.log('')
}

async function brainServe(opts: BrainCommandOptions): Promise<void> {
  // workspace() (workspace.ts) has a fixed options type this module does not
  // own, with no room for a brain flag, so the signal crosses into
  // startServer (serve.ts) the same way CODESEMA_SYNC_URL/CODESEMA_DEV_VITE
  // already do in this codebase: an env var read at the one place that needs
  // it, not threaded through every caller's signature.
  process.env.CODESEMA_BRAIN_MODE = '1'
  await workspace({ cwd: opts.cwd, open: true, port: undefined })
}

export async function brainCommand(opts: BrainCommandOptions): Promise<void> {
  switch (opts.action) {
    case 'connect':
      await brainConnect(opts)
      return
    case 'status':
      await brainStatus(opts)
      return
    case 'ticket':
      await brainTicket(opts)
      return
    case 'serve':
      await brainServe(opts)
      return
    case undefined:
      console.log(t('brain.usage'))
      return
    default:
      throw new Error(t('brain.unknownAction', { action: opts.action }))
  }
}
