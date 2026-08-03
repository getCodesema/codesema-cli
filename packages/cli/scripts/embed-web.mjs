// Copie le build de packages/web dans le package CLI (web-dist), embarqué dans le tarball npm.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url))
const target = fileURLToPath(new URL('../web-dist', import.meta.url))

if (!existsSync(webDist)) {
  console.error(
    '[embed-web] packages/web/dist not found — run the web build first (bun run build:web)',
  )
  process.exit(1)
}

rmSync(target, { recursive: true, force: true })
cpSync(webDist, target, { recursive: true })
console.log('[embed-web] web-dist embedded')
