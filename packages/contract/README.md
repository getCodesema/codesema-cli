# @codesema/contract

The review contract shared between the [codesema CLI](https://www.npmjs.com/package/codesema) and codesema.com: the types describing a review record, and the sanitizers that validate and bound any raw input into that shape.

This package is intentionally tiny and dependency-free. It contains no I/O, no network calls and no configuration: only pure functions and types.

## What it provides

- **Types**: `ReviewRecord` (a versioned, self-contained review of a merge request: metadata, commits, diff, and the review itself), `SanitizedReview`, `Finding`, `ReviewedFile`, `ReviewNarrative`, `DualStats` and their building blocks.
- **Sanitizers**: `sanitizeRecord`, `sanitizeReview`, `sanitizeFindings`, `sanitizeNarrative`. They whitelist fields, truncate oversized values and never throw, turning any untrusted input into a well-formed object (or `null` when unusable).
- **Grounding**: `groundReview` checks a sanitized review against the diff it claims to describe — findings on files absent from the diff are dropped, line anchors outside every hunk are removed, duplicates (same file, line and kind) merge keeping the highest severity, and an `approve` verdict left with a critical finding is escalated to `request_changes`. It returns the corrected review plus a `GroundingReport` of what was changed.
- **Secret scanner**: `detectDiffSecrets` returns the `SecretMatch`es in a diff (dotenv files, private keys, and AWS/GitHub/Slack/Google/Stripe/OpenAI/Anthropic credentials), so a diff carrying a committed secret is never uploaded.
- **JSON Schema**: `reviewRecordSchema`, the record shape as a schema, for validation outside TypeScript.

## Usage

```ts
import { sanitizeRecord, type ReviewRecord } from '@codesema/contract'

const record: ReviewRecord | null = sanitizeRecord(untrustedJson)
if (!record) throw new Error('unusable review record')
```

The codesema CLI uses these functions to validate agent output before archiving a review; codesema.com uses the very same functions to validate reviews synced from the CLI. One source of truth on both sides of the wire.

## Versioning

`ReviewRecord.version` identifies the record schema (currently `1`). The package follows semver: a breaking change to the record shape bumps the major version.

## License

MIT
