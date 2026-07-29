import { isRepoAgentTrusted, loadConfig, loadRepoConfig } from './config.js'
import { createFixRunner, DEFAULT_TIMEOUT_S } from './fix.js'
import { repoRoot } from './git.js'
import { t, uiLocale } from './i18n.js'
import { openBrowser } from './open.js'
import { archiveRecord, resolveRecord } from './record.js'
import { createSession, startServer } from './serve.js'
import { defaultCommand, detectAgents } from './wizard.js'

export async function show(opts: { review?: string; port?: number; open: boolean; cwd: string }): Promise<void> {
  const cwd = repoRoot(opts.cwd)

  const { record, fresh, sourcePath } = resolveRecord({ review: opts.review, cwd })
  if (fresh) {
    console.log(t('show.archived', { path: archiveRecord(record, cwd) }))
  } else {
    console.log(t('show.lastArchived', { path: sourcePath }))
  }

  const session = createSession({ record })
  const config = loadConfig(cwd)
  const [detected] = detectAgents(cwd)
  const agentCommand = config.agent ?? (detected ? defaultCommand(detected) : undefined)
  // A repo-provided agent command needs the same TOFU approval as in `review`;
  // show never prompts, so an untrusted one simply disables the fix button.
  const repoAgent = loadRepoConfig(cwd).agent
  const untrustedRepoAgent = Boolean(
    agentCommand && repoAgent === agentCommand && !isRepoAgentTrusted(cwd, agentCommand),
  )
  const fixRunner =
    agentCommand && !untrustedRepoAgent
      ? createFixRunner({
          getRecord: () => session.record(),
          cwd,
          command: agentCommand,
          timeoutMs: (config.timeout ?? DEFAULT_TIMEOUT_S) * 1000,
        })
      : undefined
  const { url } = await startServer(session, { port: opts.port ?? config.port, locale: uiLocale(), fixRunner })
  console.log('')
  console.log(`codesema — ${record.meta.branch} → ${record.meta.target}`)
  console.log(`  ${url}`)
  console.log(`  ${t('review.ctrlc')}`)
  if (opts.open) openBrowser(url)
}
