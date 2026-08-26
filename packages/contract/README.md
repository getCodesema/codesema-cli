# @codesema/contract

The review contract shared between the [codesema CLI](https://www.npmjs.com/package/codesema) and codesema.com: the types describing a review record, and the sanitizers that validate and bound any raw input into that shape.

This package is intentionally tiny and dependency-free. It contains no I/O, no network calls and no configuration: only pure functions and types.

## What it provides

- **Types**: `ReviewRecord` (a versioned, self-contained review of a merge request: metadata, commits, diff, and the review itself), `SanitizedReview`, `Finding`, `ReviewedFile`, `ReviewNarrative`, `DualStats` and their building blocks.
- **Sanitizers**: `sanitizeRecord`, `sanitizeReview`, `sanitizeFindings`, `sanitizeNarrative`. They whitelist fields, truncate oversized values and never throw, turning any untrusted input into a well-formed object (or `null` when unusable).
- **Grounding**: `groundReview` checks a sanitized review against the diff it claims to describe — findings on files absent from the diff are dropped, line anchors outside every hunk are removed, duplicates (same file, line and kind) merge keeping the highest severity, and an `approve` verdict left with a critical finding is escalated to `request_changes`. It returns the corrected review plus a `GroundingReport` of what was changed.
- **Secret scanner**: `detectDiffSecrets` returns the `SecretMatch`es in a diff (dotenv files, private keys, and AWS/GitHub/Slack/Google/Stripe/OpenAI/Anthropic credentials), so a diff carrying a committed secret is never uploaded.
- **Ticket contract**: `TicketBody` (five sections with verbatim English headings) and `AcceptanceCriterion` (`{ id, text }`, the `id` derived from the text so reordering the list renames nothing), with the deterministic lint that gates a ticket about to be launched — `lintTicketBody`, `lintCriteria` — and the tolerant read-back side `sanitizeTicketBody`, `readAcceptanceCriteria`, `extractAcceptanceCriteria`.
- **Brain wire types**: the types and sanitizers for the tickets, transitions and events exchanged between the brain (the local SaaS that owns a repository's tickets) and the arm (this CLI, claiming and executing them): `ArmTicketRequest` and `ArmTicket` (a ticket at proposal time and once published, `ArmTicket.status` a closed lifecycle enum), `ArmTransition` (one fact the arm reports back, e.g. `mr_opened`, `merged`, gated on a mandatory `idempotency_key`), `ArmEvent` (one line of the arm's execution journal) and `ArmClaimResult` (the brain's claim/lease response), with their sanitizers `sanitizeArmTicketRequest`, `sanitizeArmTicket`, `sanitizeArmTransition`, `sanitizeArmEvent`, `sanitizeArmClaimResult`. `TaskRecord.brain_ticket` (tasks.ts) carries the write-once pointer back from a task to the brain ticket it was claimed from.
- **JSON Schemas**: `reviewRecordSchema`, `ticketBodySchema`, `recapRecordSchema`, `armTicketSchema` and `armTransitionSchema`, the record, ticket-body, recap, arm-ticket and arm-transition shapes as draft 2020-12 schemas, for validation outside TypeScript.

## Usage

```ts
import { sanitizeRecord, type ReviewRecord } from '@codesema/contract'

const record: ReviewRecord | null = sanitizeRecord(untrustedJson)
if (!record) throw new Error('unusable review record')
```

The codesema CLI uses these functions to validate agent output before archiving a review; codesema.com uses the very same functions to validate reviews synced from the CLI. One source of truth on both sides of the wire.

## Cross-repo conformance with the brain

The brain (a separate repo: the local SaaS whose `/api/cli` routes the `Arm*` sanitizers above exist to talk to) publishes its own TypeBox body schemas for those routes. `fixtures/cerveau-schemas/*.schema.json` is a committed, hand-synced copy of them, and `brain.test.ts`'s "cross-repo" tests validate this package's sanitizer output against those copies with [ajv](https://ajv.js.org) (a devDependency, test-only: the published package stays runtime dependency-free), on top of the tests that validate output against this package's own published schemas.

This exists because of a real incident: a 422 on `run_id` crossed both repos' test suites unnoticed, because the brain required a uuid shape while the arm sends a 12-hex task id, and each repo only ever checked its own copy of the shape.

**Syncing the fixtures.** Run from a machine with both repos checked out as local siblings:

```
bun run --cwd packages/contract sync-brain-schemas -- --check   # report drift, exit 1 if stale, writes nothing
bun run --cwd packages/contract sync-brain-schemas               # copy the brain's current schemas over the fixtures
```

The brain repo path defaults to this repo's sibling directory named `codesema`; override it with a positional argument or the `CODESEMA_BRAIN_REPO` env var. The brain must have already run its own export (`bun backend/scripts/export-cli-schemas.ts` from the brain repo) so its `backend/contracts/cli/*.schema.json` files exist.

The sync is manual and deliberately NOT wired into CI: the fixtures are allowed to lag behind the brain's actual schemas between syncs, on purpose, so this package's own test suite never depends on the brain repo being present or reachable. Run it after a change to the brain's `/api/cli` body schemas, or whenever the cross-repo tests in `brain.test.ts` look suspicious.

## Versioning

`ReviewRecord.version` identifies the record schema (currently `1`). The package follows semver: a breaking change to the record shape bumps the major version.

## License

MIT
