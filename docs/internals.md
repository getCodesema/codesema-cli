# Implementation notes

These notes were moved out of the README when it was rewritten for readers rather than
maintainers. They describe how three parts of the CLI behave in detail. The code and its
tests remain the source of truth.

## What the subprocesses inherit

These are not knobs to turn: they are what codesema keeps in — and strips from —
the environment of the processes it spawns.

- **A known review agent gets a minimal environment.** `agentEnv` (`agent.ts`)
  keeps the 27 names of `BASE_ENV_VARS` — `PATH`, `HOME`, `USER`, `LOGNAME`,
  `SHELL`, `TERM`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TZ`, the 8 proxy
  variables, the 4 `XDG_*` ones and the 4 CA-bundle ones — plus the provider's
  own prefixes (`ANTHROPIC_`/`CLAUDE_`, `OPENAI_`/`CODEX_`,
  `GEMINI_`/`GOOGLE_`, `XAI_`/`GROK_`, and for OpenCode `OPENCODE_`/`OPENROUTER_`
  plus every other provider prefix it can authenticate with), widened to `AWS_` or `GOOGLE_`/`GCP_` only when
  `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX` is set. Review, checks and
  eval wrap that in `reviewAgentEnv`, which additionally injects
  `OPENCODE_CONFIG_CONTENT` (wildcard permission deny, including `agent.build` /
  `agent.plan`, with `default_agent` pinned to `build`) when the command is OpenCode and the user did not set that
  variable. Everything else in your environment — cloud keys, tokens, database
  URLs — never reaches the subprocess. A custom agent command inherits the full
  environment (its needs are unknowable, and you chose it explicitly), and so
  does Windows, where narrowing the environment can break the spawn itself
  (`reviewAgentEnv` still returns the full source plus the OpenCode inject).
- **A caged task agent gets 6 provider variables, by name.**
  `CAGE_FORWARDED_ENV` (`task-isolation.ts`) forwards
  `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL`, and
  only those. They are passed as `-e NAME`, never as `-e NAME=value`: a value in
  argv would be readable in `ps` on the whole host. `CLAUDE_CODE_OAUTH_TOKEN`
  also decides how the cage bootstraps its credentials — when it is set, nothing
  is copied out of `~/.claude`.
- **Git subprocesses lose the repo-location variables.** `subprocessEnv`
  (`git.ts`) strips the 8 variables git sets on the hooks it invokes —
  `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
  `GIT_COMMON_DIR`, `GIT_PREFIX`, `GIT_ALTERNATE_OBJECT_DIRECTORIES` and
  `GIT_QUARANTINE_PATH` — so codesema invoked from inside a hook still reads the
  repo it was pointed at, not the one that set them. This is deliberately not a
  blanket `GIT_*`: `GIT_SSH_COMMAND`, `GIT_AUTHOR_*`/`GIT_COMMITTER_*` and
  `GIT_CONFIG_GLOBAL` are legitimate settings and reach git unchanged.

## Issue hierarchy (parent → child)

`packages/cli/src/forge-issues.ts` extends its issue client with a single-level parent → child hierarchy (`linkChildIssue`, `unlinkChildIssue`, `listChildIssues`), taking the greatest common denominator of what both forges offer (D8) rather than smoothing the two into one shape. GitHub's sub-issues and GitLab's work-item hierarchy are genuinely different API models, not two dialects of one, and the asymmetries below are assumed and documented rather than hidden:

- **GitHub** goes through the sub-issues REST endpoints via `gh api` (checked against GitHub's current REST docs — an earlier note here claimed this was "verified … at gh 2.46.0", which is chronologically impossible: gh 2.46.0 shipped 2024-03-20, months before this REST API was even announced, on 2024-12-12): `POST …/issues/{parent}/sub_issues` to link, `DELETE …/issues/{parent}/sub_issue` to unlink, `GET …/issues/{parent}/sub_issues` to list. The parent keeps riding its plain issue **number** in the URL, like every other endpoint in this file, but the write body wants the child's internal database **id** — resolved first with one extra `gh api …/issues/{child}` read. Listing is a single call at `per_page=100`; GitHub's own docs describe "up to 100 sub-issues per parent" as a **product** limit, not a pagination guarantee this endpoint enforces, so `truncated` still follows the page length (a full page of exactly 100 is treated as possibly truncated) rather than being hard-coded to `false`. No `gh` version is cited for this surface, and that absence is deliberate: `gh api` is a bare REST passthrough with no shape of its own to verify, so the endpoint was checked against GitHub's current REST documentation rather than against one CLI build's behavior — attaching a version here would claim a verification that was never done.
- **GitLab** goes through the GraphQL work-item hierarchy widget via `glab api graphql` (verified against **glab 1.53.0**, the version whose `api graphql` passthrough this module's mutation/query text was checked against — glab ships the GraphQL _client_, not the schema, so the query strings below are this module's own, not generated): the root field is `workItem(id: WorkItemID!)` — `Query.issue` has no `widgets` field at all — and the mutation is `workItemUpdate(input: {id, hierarchyWidget: {parentId}})`, `parentId: null` to unlink. Listing walks the `children` connection of the `WorkItemWidgetHierarchy` widget with a real cursor (`first: 100`, `after`, `pageInfo.{hasNextPage,endCursor}`), since GitLab silently clamps any `first` above 100 rather than refusing it; `hasNextPage: true` answered with no cursor to reach the next page still forces `truncated: true` rather than falling back to a page-length check a short page could pass by accident — and so does the walk's OTHER exit, hitting the page cap without ever seeing `hasNextPage: false` (round 4 fix: the last page's own `hasNextPage` is carried into that return too, not just the "no cursor" one, since a permission-filtered empty tail page can legitimately still say `hasNextPage: true`). A child's URL comes from `webPath` (relative, nullable) resolved against the parent's own REST-resolved origin — `webUrl` does not exist on this type — and its description/labels live in nested `WorkItemWidgetDescription`/`WorkItemWidgetLabels` widgets, found by which key they carry, never by position in the `widgets` array. GraphQL cannot resolve a project-scoped issue number by itself, so **both** ids are resolved first through the REST shortcut `projects/:fullpath/issues/{n}` this module already uses for `setLabels`, then rebuilt as the canonical `gid://gitlab/WorkItem/<id>` global id — the deprecated `gid://gitlab/Issue/<id>` alias is not used, since GitLab documents it as removable without notice.
- **Unlinking is asymmetric.** GitHub's `DELETE …/sub_issue` validates the (parent, child) pair through the URL and the body together, and refuses if the child is not actually that parent's sub-issue. GitLab's `parentId: null` mutation takes no parent to confirm against: it clears whatever parent the child **currently** has, trusting the caller's `parent` argument rather than re-verifying it against the forge.
- **Capability is probed, never assumed — narrowly.** Only a GraphQL top-level error whose message matches a _recognized_ schema-gap signature (a `"…doesn't exist on type…"` complaint naming the hierarchy widget or its input types) is reported as the **named** unavailability `{ available: false, reason: 'unsupported' }`, distinct from an ordinary `cli-error`. Any other top-level error — an authorization refusal, a malformed query, a business rejection nested under `data.<op>.errors` — stays an honest `cli-error`: classifying every GraphQL error as "the edition can't do this" would silently disguise this module's own bugs as a forge limitation forever, since `forgeIssueReason` maps `unsupported` to no D2 code at all (nothing would ever get journaled). GitHub's asymmetric case (a GitHub Enterprise Server old enough to lack sub-issues) is not distinguished from any other REST 404: the forge CLI's own words still surface as an honest `cli-error`, but not under the distinct `unsupported` name, since a REST 404 does not reliably tell "not found" apart from "not supported" the way a GraphQL schema error does.
- **One level only (D8), enforced against the real forge — the only barrier GitHub has.** GitHub's own docs allow "up to eight levels of nested sub-issues": the forge never refuses a second level by itself, so this guard is not a courtesy that doubles a server-side rule, it is the sole thing enforcing D8 on GitHub. An auto-reference is refused purely locally. Beyond that, before any write, the guard reads the **real** forge state — the parent's actual current parent (`GET …/issues/{n}/parent` on GitHub, `WorkItemWidgetHierarchy.parent` on GitLab) and the child's actual children — rather than trusting only what this process happens to remember: a fresh call sharing no state with a previous one still catches "link A→B then B→C" or "link a parent to its own child". On GitHub, "no parent" is read from that endpoint's 404 answer, but ONLY when the message matches the exact phrase GitHub's API returns for a genuinely missing parent, `No parent issue found` (checked live against `api.github.com`) — any other 404-flavored text (a locked-issue validation error, a proxy's own 404 page relayed as a 502, a rate-limit message that happens to link a docs URL) is refused as an ordinary `cli-error` instead of guessed as "no parent": fail **closed**, never fail open, since a wrong guess here would let a real second level through. The caller-supplied `child → parent` cache (seeded by `listChildIssues`, updated by link/unlink) is consulted first and, on a hit, skips the forge read — an **accelerator**, never the source of truth. A non-`Map` value passed as `hierarchy` degrades to a fresh, empty cache rather than throwing. **The write is PINNED to whichever forge the guard's own reads actually answered from (round 4 fix)**: on a self-hosted remote where the forge is not known ahead of time, both `gh` and `glab` are probed until one answers, and a guard cleared entirely by `gh` must not let the following write fall through to `glab` on a blocked pre-write resolve — that would write to a forge whose state the guard never verified. When every guard read is answered by the SAME live forge (the only way a guard can clear at all — a cache hit only ever proves the opposite, a real parent or a real child, and refuses), the write ladder is narrowed to that one forge; a blocked resolve on it now refuses the call outright rather than trying the other.
- **Reading never over-claims.** `listChildIssues` validates the forge's answer field by field, on the pattern of `parseGhMrList`/`parseGlabMrList`: the first shape mismatch — a truncated payload, one child of the wrong type — rejects the **whole** array rather than a partial one.
- The hierarchy's unavailability never touches `packages/contract/src/reasons.ts`'s `REASON_CODES` table (DP5): that enum qualifies what stops a **task**, and a forge that cannot link a parent to a child stops nothing — it is carried entirely by the client's own result union, exactly like `no-remote`/`no-cli`/`cli-error`/`invalid-input` already are.

## Cycle labels on the forge (opt-in)

**Decision D15 is settled: cycle labels are opt-in per project, and disabled by default.** Nothing is written to any forge until a `.codesema/config.json` (or the global file) says `"forgeCycleLabels": true`.

The reason is the one that decided it: posting labels into somebody else's repository without being asked is a **pollution**, and native monitoring is not worth that price by default. Turning it on by default and letting people turn it off would invert the burden — a user who merely upgrades the CLI would find five new labels in a shared repo. The opt-in is **per project**, not global, because the price of the pollution is paid in one repository, so that repository is where it is accepted: `resolveProjectConfig` resolves it with the usual precedence (CLI flags > `.codesema/config.json` > `~/.config/codesema/config.json`), and a repo `false` therefore overrides a global `true`.

Once it is on, a status transition poses **exactly one** `codesema:*` label on the issue the task is bound to:

| Task status                                             | Label                  |
| ------------------------------------------------------- | ---------------------- |
| `queued`                                                | `codesema:queued`      |
| `running`                                               | `codesema:in-progress` |
| `reviewing`, `review_ok`, `shipped`                     | `codesema:reviewing`   |
| `waiting_for_you`, `review_ko`, `failed`, `interrupted` | `codesema:blocked`     |
| _(no status — posed by the merge itself)_               | `codesema:merged`      |

The grouping reads as "what is happening to this ticket, seen from outside": the machine is working (`in-progress`), the work exists and is under review (`reviewing` — `review_ok` waits to be shipped, `shipped` waits for a human to merge its MR; neither is merged), or a person is needed (`blocked`). `codesema:merged` is deliberately reachable from **no** status: a task record stays `shipped` after its branch lands, so that label is posed by whatever performed the merge, never inferred.

What this never does:

- **It never touches a label that is not prefixed `codesema:`.** No forge CLI can _replace_ an issue's label set — `gh issue edit` and `glab issue update` only add or remove — so the write goes through `gh api` / `glab api`, which replaces everything. A partial write would therefore **destroy** the issue's other labels. Every pose is read-recompose-reemit: the current set is read, only the `codesema:` part is recomputed, and every other label is re-emitted verbatim. `codesema-legacy` has no colon, is not a cycle label, and survives untouched.
- **It never reads on one forge and writes on the other.** The read walks the usual ladder (a self-hosted remote names neither forge, so both `gh` and `glab` are tried); everything after it — the catalog, the creation, the write — is **pinned to the forge that actually answered the read**. Without that pin, a repository where `gh` fails the read and succeeds the write would take GitLab's label set and `PUT` it whole onto GitHub's copy of the issue, which is not a missing label but somebody else's labels gone.
- **It never writes twice for the same state.** The current set is compared to the target, and nothing is sent when they already agree.
- **It never creates a label ahead of time.** A missing `codesema:*` label is created (through `gh label create` / `glab label create`) at the moment it is first needed, and only after the repository's label catalog proves it absent — a project whose tasks never reach a merge never sees `codesema:merged` appear.
- **It never turns "that label already exists" into a failure.** The catalog is a snapshot and it can be wrong in ways being truncated does not cover: a human or a second process creating the label between the listing and the creation, or a name already held in a different casing. A creation the forge refuses **in those words** falls back on posing the label, which is what the label being there means; any other refusal is still a failure. Without that fallback a casing collision would be permanent — every later transition would re-attempt the same creation, get the same refusal, and never pose anything.
- **It never leaves two cycle labels on an issue.** Ownership is the prefix and the prefix alone, but it is matched **case-insensitively**: a `Codesema:queued` is unmistakably one of ours to anyone reading the issue, so it is recomposed away rather than left to sit next to the label just posed. `codesema-legacy` still has no colon and is still not ours, in any casing.
- **It never blocks a task.** A forge that cannot be reached, an absent `gh`/`glab`, a command that fails: the transition completes exactly as it would with the labels off — same status, same record — and the degradation is stated instead, as a journal line carrying `forge_unreachable`. The task record itself is never modified by this channel.

**One asymmetry, documented rather than smoothed over (D8):** the prefix uses a **simple** colon, not GitLab's scoped-label form (`scope::value`). A scoped label would give GitLab forge-side mutual exclusion for free, but GitHub has no such notion, so half the users would get an exclusion the other half would not. The exclusion is therefore computed by codesema, identically on both forges; the consequence on GitLab is that `codesema:` labels are ordinary labels there — no scoped behaviour, no forge-side exclusion, no scoped rendering in its UI.
