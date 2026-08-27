/**
 * Manual sync of the hub's exported `/api/cli` JSON Schemas into this
 * package's committed fixtures (D-contrat, asymmetric arbitration).
 *
 * The hub (backend/scripts/export-cli-schemas.ts, a SEPARATE repo) emits
 * its TypeBox body schemas as JSON Schema files. This script copies those
 * files into fixtures/hub-schemas/ so hub.test.ts can validate this
 * package's sanitizer output against the hub's ACTUAL wire contract, not a
 * hand-copied guess of it. That guess is exactly the class of bug that
 * motivated this: a 422 on `run_id` (uuid on the hub's side, a 12-hex
 * arm-generated id on this side) that neither repo's own tests could see,
 * because each repo only checked its own copy of the shape.
 *
 * Deliberately NOT wired into CI and NOT a network fetch: both repos are
 * assumed to sit as local sibling checkouts on the machine running this
 * script, and the sync is a manual step run after the hub regenerates its
 * schemas. The fixtures are therefore allowed to lag behind the hub by
 * design: that lag is the cost of keeping this repo's tests independent of
 * the hub repo's availability, not an oversight.
 *
 * Usage (from packages/contract/):
 *   node scripts/sync-hub-schemas.mjs                  # copy, report drift
 *   node scripts/sync-hub-schemas.mjs --check           # report only, exit 1 on drift
 *   node scripts/sync-hub-schemas.mjs /path/to/codesema # explicit hub repo path
 *   CODESEMA_HUB_REPO=/path/to/codesema node scripts/sync-hub-schemas.mjs
 *
 * Resolution order for the hub repo path: CLI argument, then
 * CODESEMA_HUB_REPO env var, then a default resolved relative to THIS
 * FILE (not the invocation cwd, which would make the default fragile
 * depending on where the script is run from): ../../../../codesema, i.e.
 * codesema-tools's own sibling directory named `codesema`.
 */

import { deepStrictEqual } from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEMA_NAMES = ['claim', 'heartbeat', 'transitions', 'events']

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.join(here, '..', 'fixtures', 'hub-schemas')
const DEFAULT_HUB_REPO = path.join(here, '..', '..', '..', '..', 'codesema')

function parseArgs(argv) {
  const check = argv.includes('--check')
  const positional = argv.find((arg) => arg !== '--check')
  const hubRepo = positional ?? process.env.CODESEMA_HUB_REPO ?? DEFAULT_HUB_REPO
  return { check, hubRepo: path.resolve(hubRepo) }
}

function readHubSchema(hubRepo, name) {
  const filePath = path.join(hubRepo, 'backend', 'contracts', 'cli', `${name}.schema.json`)
  if (!existsSync(filePath)) {
    throw new Error(
      `hub schema not found: ${filePath}\n` +
        `run its export script first: (cd ${hubRepo} && bun backend/scripts/export-cli-schemas.ts)`,
    )
  }
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function readFixture(name) {
  const filePath = path.join(FIXTURES_DIR, `${name}.schema.json`)
  return existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : null
}

function reportDrift(name, current, incoming) {
  console.log(`${name}: DRIFT`)
  try {
    deepStrictEqual(current, incoming)
  } catch (error) {
    console.log(error.message)
  }
}

function syncOne(name, hubRepo, check) {
  const incoming = readHubSchema(hubRepo, name)
  const current = readFixture(name)
  try {
    deepStrictEqual(current, incoming)
    console.log(`${name}: up to date`)
    return false
  } catch {
    reportDrift(name, current, incoming)
    if (!check) {
      const filePath = path.join(FIXTURES_DIR, `${name}.schema.json`)
      writeFileSync(filePath, `${JSON.stringify(incoming, null, 2)}\n`)
      console.log(`${name}: written to ${filePath}`)
    }
    return true
  }
}

function main() {
  const { check, hubRepo } = parseArgs(process.argv.slice(2))
  console.log(`hub repo: ${hubRepo}${check ? ' (--check: report only)' : ''}`)
  mkdirSync(FIXTURES_DIR, { recursive: true })

  const drifted = SCHEMA_NAMES.map((name) => syncOne(name, hubRepo, check)).some(Boolean)

  if (check && drifted) {
    console.error('\nfixtures are stale: run without --check to update them')
    process.exit(1)
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
