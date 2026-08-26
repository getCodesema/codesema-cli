/**
 * Manual sync of the brain's exported `/api/cli` JSON Schemas into this
 * package's committed fixtures (D-contrat, asymmetric arbitration).
 *
 * The brain (backend/scripts/export-cli-schemas.ts, a SEPARATE repo) emits
 * its TypeBox body schemas as JSON Schema files. This script copies those
 * files into fixtures/cerveau-schemas/ so brain.test.ts can validate this
 * package's sanitizer output against the brain's ACTUAL wire contract, not a
 * hand-copied guess of it. That guess is exactly the class of bug that
 * motivated this: a 422 on `run_id` (uuid on the brain's side, a 12-hex
 * arm-generated id on this side) that neither repo's own tests could see,
 * because each repo only checked its own copy of the shape.
 *
 * Deliberately NOT wired into CI and NOT a network fetch: both repos are
 * assumed to sit as local sibling checkouts on the machine running this
 * script, and the sync is a manual step run after the brain regenerates its
 * schemas. The fixtures are therefore allowed to lag behind the brain by
 * design: that lag is the cost of keeping this repo's tests independent of
 * the brain repo's availability, not an oversight.
 *
 * Usage (from packages/contract/):
 *   node scripts/sync-brain-schemas.mjs                  # copy, report drift
 *   node scripts/sync-brain-schemas.mjs --check           # report only, exit 1 on drift
 *   node scripts/sync-brain-schemas.mjs /path/to/codesema # explicit brain repo path
 *   CODESEMA_BRAIN_REPO=/path/to/codesema node scripts/sync-brain-schemas.mjs
 *
 * Resolution order for the brain repo path: CLI argument, then
 * CODESEMA_BRAIN_REPO env var, then a default resolved relative to THIS
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
const FIXTURES_DIR = path.join(here, '..', 'fixtures', 'cerveau-schemas')
const DEFAULT_BRAIN_REPO = path.join(here, '..', '..', '..', '..', 'codesema')

function parseArgs(argv) {
  const check = argv.includes('--check')
  const positional = argv.find((arg) => arg !== '--check')
  const brainRepo = positional ?? process.env.CODESEMA_BRAIN_REPO ?? DEFAULT_BRAIN_REPO
  return { check, brainRepo: path.resolve(brainRepo) }
}

function readBrainSchema(brainRepo, name) {
  const filePath = path.join(brainRepo, 'backend', 'contracts', 'cli', `${name}.schema.json`)
  if (!existsSync(filePath)) {
    throw new Error(
      `brain schema not found: ${filePath}\n` +
        `run its export script first: (cd ${brainRepo} && bun backend/scripts/export-cli-schemas.ts)`,
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

function syncOne(name, brainRepo, check) {
  const incoming = readBrainSchema(brainRepo, name)
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
  const { check, brainRepo } = parseArgs(process.argv.slice(2))
  console.log(`brain repo: ${brainRepo}${check ? ' (--check: report only)' : ''}`)
  mkdirSync(FIXTURES_DIR, { recursive: true })

  const drifted = SCHEMA_NAMES.map((name) => syncOne(name, brainRepo, check)).some(Boolean)

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
