import { repoRoot } from './git.js'
import { openBrowser } from './open.js'
import { archiveRecord, resolveRecord } from './record.js'
import { createSession, startServer } from './serve.js'

export async function show(opts: { review?: string; port?: number; open: boolean; cwd: string }): Promise<void> {
  const cwd = repoRoot(opts.cwd)

  const { record, fresh, sourcePath } = resolveRecord({ review: opts.review, cwd })
  if (fresh) {
    console.log(`review archived: ${archiveRecord(record, cwd)}`)
  } else {
    console.log(`showing last archived review: ${sourcePath}`)
  }

  const session = createSession({ record })
  const { url } = await startServer(session, { port: opts.port })
  console.log('')
  console.log(`codesema — ${record.meta.branch} → ${record.meta.target}`)
  console.log(`  ${url}`)
  console.log('  Ctrl+C to stop')
  if (opts.open) openBrowser(url)
}
