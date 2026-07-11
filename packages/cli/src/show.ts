// `mr-review show` : sanitize la sortie de l'agent, archive la review en JSON,
// sert l'UI web embarquée sur un serveur local éphémère et ouvre le navigateur.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { repoRoot } from './git.js'
import { openBrowser } from './open.js'
import { resolveRecord } from './record.js'

const WEB_DIST = fileURLToPath(new URL('../web-dist', import.meta.url))

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'review'
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function listen(app: Hono, startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    const ok = await new Promise<boolean>((resolve) => {
      const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => resolve(true))
      server.on('error', (err: NodeJS.ErrnoException) => {
        server.close()
        if (err.code !== 'EADDRINUSE') console.error(err.message)
        resolve(false)
      })
    })
    if (ok) return port
  }
  throw new Error(`no free port between ${startPort} and ${startPort + 19}`)
}

export async function show(opts: { review?: string; port?: number; open: boolean; cwd: string }): Promise<void> {
  const cwd = repoRoot(opts.cwd)
  const dir = join(cwd, '.mr-review')

  const { record, fresh, sourcePath } = resolveRecord({ review: opts.review, cwd })
  if (fresh) {
    const reviewsDir = join(dir, 'reviews')
    mkdirSync(reviewsDir, { recursive: true })
    const savedPath = join(reviewsDir, `${slug(record.meta.branch)}-${stamp(new Date())}.json`)
    writeFileSync(savedPath, JSON.stringify(record, null, 2))
    console.log(`review archived: ${savedPath}`)
  } else {
    console.log(`showing last archived review: ${sourcePath}`)
  }

  if (!existsSync(join(WEB_DIST, 'index.html'))) {
    throw new Error(`embedded web UI not found at ${WEB_DIST} — broken install/build`)
  }
  const indexHtml = readFileSync(join(WEB_DIST, 'index.html'), 'utf8')

  const app = new Hono()
  app.get('/api/review', (c) => c.json(record))
  app.get('/', (c) => c.html(indexHtml))
  app.use('/*', serveStatic({ root: WEB_DIST }))

  const port = await listen(app, opts.port ?? 4400)
  const url = `http://localhost:${port}`
  console.log('')
  console.log(`mr-review — ${record.meta.branch} → ${record.meta.target}`)
  console.log(`  ${url}`)
  console.log('  Ctrl+C to stop')
  if (opts.open) openBrowser(url)
}
