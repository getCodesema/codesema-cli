# Recovery doctrine

How codesema detects, absorbs, and escalates failure. This is the reference the state
machine, the healthchecks, and every retry in the codebase must be written against.

The founding rule, in one sentence: **everything mechanizable is mechanized; a human
(or an agent) is only reached once the machine has provably exhausted its bounded
options; and every step of that ladder is bounded, tested, and validated.**

## The ladder

Every failure walks the same ladder, from the cheapest rung to the most expensive.
A rung is only reached when the one below it is exhausted.

| Rung | Name                        | What it is                                                                                                     | Example                                                                                                     |
| ---- | --------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 0    | Prevention by construction  | An illegal state cannot be represented: contract types, DB CHECK constraints, config validated at install time | `mr_opened` requires a merge-request URL; a merge strategy is asked for before the first merge can ever run |
| 1    | Mechanical detection        | Probes, invariants, healthchecks, checks. Silence is never read as success                                     | The egress proxy is probed right after start; a caged turn is watched by the semantic watchdog              |
| 2    | Bounded mechanical recovery | Retry, replay, reconcile, re-claim — each with a name, a persisted counter, a ceiling, and a journal event     | A vanished agent session is dropped and the turn replayed exactly once                                      |
| 3    | Human escalation            | Only after rung 2 is exhausted: the report carries the proof (the run's dying words) AND the way out           | "merge refused: no strategy configured — set one in settings, then reply to replay the cycle"               |
| 4    | Fix agent                   | An agent run to repair, opted into by explicit policy, itself fully caged and bounded (turns, budget, timeout) | A post-failure fix turn, behind the same gates as any other turn                                            |

Rung 4 is not an exception to the doctrine: the fix agent is one more consumer of the
same state machine, and its output goes through the same mechanical gates (criteria,
checks, review) as any human-triggered turn.

## Rules

1. **Recovery is a first-class transition.** Never an opportunistic try/catch. Each
   mechanical recovery has:
   - a **name** (`session_replayed`, `proxy_recreated`, `reconciled`, `reclaimed`);
   - a **persisted counter** — it survives a daemon restart, otherwise the bound lies;
   - a **journal event** in the task's `events.jsonl` (and, when task-scoped, the hub
     outbox);
   - a **test** exercising both the recovery and the exhaustion of its bound.
2. **Every transition is bounded.** A retry has a max count, a wait has a timeout, a
   loop has a ceiling. Unbounded convergence is a bug by definition.
3. **The transition table is shared.** The legal state transitions live in
   `@codesema/contract`, and both sides (runner and hub) refuse a transition that is
   not in the table. A refused transition is an explicit error, never a silently
   accepted phantom state.
4. **A state requires its proof.** A transition that claims an external fact carries
   the evidence: `mr_opened` carries the MR URL, `done` carries the merge SHA. The
   contract makes the field mandatory; a DB CHECK enforces it at rest.
5. **Silence is never success.** Every ephemeral process leaves its last words
   somewhere readable: agent stdout+stderr tails travel inside exit errors; cage and
   proxy containers log through a driver that survives `--rm` (journald when
   available); a probe follows every detached start.
6. **Escalation carries the way out.** A rung-3 report names what was tried (which
   recoveries, how many times), shows the evidence, and states the single action that
   unblocks ("reply to replay", "configure X", "re-run install"). A dead-end message
   ("task is waiting") is a doctrine violation.
7. **Client sovereignty bounds observability.** On the client's machine everything is
   local and pull-based: `events.jsonl`, journald, `codesema doctor`. The ONLY thing
   that leaves the machine is the business channel the client already consented to
   (heartbeat, outbox) — richer messages on that channel, never a separate telemetry
   agent, never a third-party SDK in the CLI.

## Healthchecks

Healthchecks are rung 1 running continuously. Each one declares its probe, its
cadence, and the rung-2 action its failure triggers — bounded like everything else.

| Component             | Probe                                                                                                              | Cadence                     | On failure (bounded)                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Egress proxy (squid)  | Docker `HEALTHCHECK` (config check / CONNECT against the allowlist) + `.State.Health` read before every caged turn | container-native + per turn | recreate, max 2; then rung 3: "isolation degraded", never a turn against a dead proxy                                                                                          |
| Runner daemon         | systemd `WatchdogSec=` + `sd_notify` on each tick; `/api/status` as the HTTP probe                                 | per tick                    | systemd restarts a frozen daemon, bounded by `StartLimitBurst`; the boot resume path re-adopts persisted tasks                                                                 |
| Runner self-diagnosis | doctor-light: agent binary runs, forge CLI authed, container runtime usable, git identity present, disk space      | periodic (minutes)          | fix what is mechanical (nothing today, candidates later); otherwise report `degraded` + reasons INSIDE the existing heartbeat — the hub shows it in `runner list` and Settings |
| Caged turn            | the semantic watchdog (frames, tool budgets, inactivity) — already the turn's healthcheck                          | continuous during a turn    | kill escalation, then the turn's own failure path                                                                                                                              |
| Hub                   | container healthchecks (already in place) + a business probe: last runner heartbeat age, ticket queue progressing  | periodic                    | alert on the hub side; the hub never reaches into a runner                                                                                                                     |

A healthcheck is itself code under the doctrine: bounded (timeout, interval), tested,
and its failure produces a **named transition**, never just a log line.

## The incident matrix

Every incident from the first real production cycle (2026-08-28), read through the
ladder. "Missing rung" is what would have caught it earliest; "mechanization" is the
bounded answer (✅ shipped, ⬜ to build).

| Incident                                                                                                  | Missing rung | Mechanization                                                                                                                                                           | Bound                                      |
| --------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| squid died at boot, silently, on every host                                                               | 1            | ✅ post-start liveness probe with crash capture (0.18.3) · ⬜ container `HEALTHCHECK` + journald logging                                                                | probe once + capture once                  |
| caged turn failed with a bare "exit code 1"                                                               | 1/3          | ✅ stdout last result frame + stderr tail inside exit errors (0.18.3, 0.18.5)                                                                                           | tails capped (400 chars / 8 KiB)           |
| `claude --resume` target vanished (recycled home volume)                                                  | 2            | ✅ drop the dead session, replay the turn once with rebuilt context (0.18.5) · ⬜ keep the home volume until a terminal state                                           | replay ×1                                  |
| no git identity on a fresh server: every commit failed                                                    | 0/2          | ✅ identity shipped end-to-end encrypted by autoconfig (0.18.4) · ✅ inline codesema signature as last resort                                                           | fallback is deterministic, no retry needed |
| heartbeats rejected ("not claimed") for 20 minutes, no self-healing                                       | 2            | ⬜ reconciliation in the daemon tick: after N consecutive rejections, re-read hub truth and converge (re-claim, adopt, or close the local task)                         | N = 3 rejections                           |
| hub believed `mr_opened` while `gh pr create` had failed; the drafter then built a ticket on that phantom | 0            | ⬜ `mr_opened` requires `mr_url` (contract + DB CHECK); `done` requires the merge SHA                                                                                   | by construction                            |
| ship refused on `waiting_for_you`, refusal visible only as a raw gh error, then the decision disappeared  | 3            | ⬜ every refusal is an event, journaled and sent up the outbox, rendered on the ticket with its way out                                                                 | one event per refusal                      |
| merge ran with no strategy; gh refuses non-interactively                                                  | 0/3          | ⬜ ask the strategy at install/config time, prefill from the repo's allowed merge methods; until set, refuse the auto-merge with a rung-3 message instead of attempting | no blind retry                             |
| settings written through the API were ignored until a restart                                             | 0            | ⬜ runner-loop settings are re-read per action (like `getChecksConfig`), or the API answers "restart required"                                                          | by construction                            |
| three bugs invisible to 3k+ unit tests (node `--env-file`, wrapped pg errors, gh non-interactive)         | 1 (in CI)    | ⬜ real-binaries CI suite: packed tarball installed and smoked under node AND bun; real postgres/squid/gh; flag-drift check against the real CLIs' `--help`             | CI-only, time-boxed                        |

## What this doctrine forbids

- An unbounded retry loop, anywhere.
- A recovery that only exists in a catch block, without a name, a counter, or a test.
- A status reported without its proof.
- A refusal or failure whose only trace is a local log line.
- A telemetry SDK inside the client-side CLI.
- Reaching a human while a bounded mechanical option remains untried.
