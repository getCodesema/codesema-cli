import { repoRoot } from './git.js'
import { t, uiLocale } from './i18n.js'
import { openBrowser } from './open.js'
import { archiveRecord, resolveRecord } from './record.js'
import { createSession, startServer } from './serve.js'
import { printUpdateNotice } from './ui.js'
import { startUpdateCheck } from './version.js'

export async function show(opts: { review?: string; port?: number; open: boolean; cwd: string }): Promise<void> {
  const latestVersion = startUpdateCheck()
  const cwd = repoRoot(opts.cwd)

  const { record, fresh, sourcePath } = resolveRecord({ review: opts.review, cwd })
  if (fresh) {
    console.log(t('show.archived', { path: archiveRecord(record, cwd) }))
  } else {
    console.log(t('show.lastArchived', { path: sourcePath }))
  }

  const session = createSession({ record })
  const { url } = await startServer(session, { port: opts.port, locale: uiLocale() })
  console.log('')
  console.log(`codesema — ${record.meta.branch} → ${record.meta.target}`)
  console.log(`  ${url}`)
  console.log(`  ${t('review.ctrlc')}`)
  if (opts.open) openBrowser(url)
  printUpdateNotice(await latestVersion)
}
