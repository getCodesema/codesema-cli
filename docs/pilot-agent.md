# The pilot agent (D18, open)

**Status: design note, not implemented, not scheduled.** Written on 2026-09-03 after a
reflection session. Nothing here is settled; the code does not know this agent exists.

## The idea

Today the human is the scheduler: they read the backlog, decide an issue is ready, start
a task, come back to see whether it landed in `waiting_for_you`. The runner mode already
removes that loop for hub tickets, but the local workspace still waits for a click.

The pilot is a single conversational agent that becomes the entry point of the product:
the home page of the local web UI first, later the same interlocutor on Telegram or Slack.
You ask it where things stand, you tell it what to start, it reports back. It never codes
and never replaces the deterministic machinery underneath (queue, concurrency cap, claim,
transitions, cycle labels, fix rounds). It sits on top of it as a remote control.

## Constraints that make the idea defensible

- **MCP tools only.** The pilot has no shell, no file access and no network. Its whole
  surface is a set of tools exposed by a codesema MCP server, which is the only holder of
  the local API token, the hub token and the forge credentials. Removing a power means
  removing a tool.
- **Reads are free, writes are confirmed.** Listing projects, tasks, recaps, reviews and
  issues needs no approval. Starting a task, replying to one, resuming, stopping,
  shipping and merging come back as a proposal the human confirms (a button on the web,
  an inline keyboard on Telegram), except for an explicit allowlist in the config such as
  "start a task on an issue carrying the ready label".
- **Confirmation is enforced by the host, never by the model and never by MCP tool
  annotations.** `readOnlyHint` and `destructiveHint` are untrusted hints in the MCP
  specification (2026-07-28). The documented mechanism on the Claude Agent SDK side is
  `permissionMode: "default"`, an allowlist of the read tools, and every other call
  falling into `canUseTool`. Write tools should also carry
  `_meta["anthropic/requiresUserInteraction"]` so a future allowlist cannot skip the
  prompt. `dontAsk` is out: it refuses instead of asking.
- **Trust boundary.** The pilot acts on two inputs only: a sentence from the human in the
  chat, or a signal a human put on the forge (label, assignee). The body of an issue is
  data, never an instruction. Issue content reaches the model only inside `tool_result`
  blocks, labelled with its source, and the MCP server sanitizes what it returns.
- **Short runs, no permanent session.** One message is one short agent run fed with a
  compact snapshot of the state; the conversation itself is persisted server side as one
  thread per workspace so the web and a chat channel continue the same conversation. The
  pilot keeps an append-only journal of every action it triggered and why.
- **Isolated like any other agent.** It holds no forge or API secret, only the provider
  key, sealed the same way as for the coding agents, and runs as an ephemeral turn.

## What the home page must keep

The state grid stays deterministic and instant next to the chat. The chat is for
questions, summaries and orders, not the only way to read the state: otherwise every
"where are we" costs tokens and seconds, and a chat channel would have nothing else.

## First increment worth building

The morning triage. It reads every task in `waiting_for_you`, sorts them into three
piles (restartable with a precise instruction, blocked on a question, to abandon), posts
one summary with the unblocking question for each, and acts only after a yes. Success
metric: the share of waiting tasks that restart with no intervention beyond one click.
Then "start whatever is tagged ready" within the existing concurrency cap.

Not first: a meta-agent that prioritizes the backlog on its own, a hierarchy of agents,
a new piloting UI, a wider auto-merge.

## What was verified on 2026-09-03

- The Claude Agent SDK runs an agent with MCP tools only through `tools: []`
  (`disallowedTools: ["*"]` would remove the MCP tools too). Session resume is
  documented via `resume` and `sessionStore`.
  https://code.claude.com/docs/en/agent-sdk/custom-tools
  https://code.claude.com/docs/en/agent-sdk/permissions
  https://code.claude.com/docs/en/agent-sdk/session-storage
- The MCP specification forbids token passthrough, requires servers to sanitize outputs,
  and says clients should keep a human able to refuse an invocation. Elicitation lets a
  server ask the user for input mid call but has no confirmation mode as such.
  https://modelcontextprotocol.io/specification/2026-07-28/server/tools
  https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
- Anthropic's guidance on prompt injection: third party content only in `tool_result`,
  source labelled, least privilege, tool output treated as data.
  https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks
  https://www.anthropic.com/engineering/building-effective-agents
- Market: GitHub Copilot (issue assignment, MCP tools used without approval, review moved
  to the PR), Cursor (Slack mention), Claude in Slack, Docker MCP Gateway (one proxy
  holding the credentials). None interposes a non coding pilot agent that confirms before
  each write.
  https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/extend-coding-agent-with-mcp
  https://docs.docker.com/ai/mcp-gateway/

## Open questions

- The MCP only restriction is verified for the Claude Agent SDK. Whether the pilot can
  also run on `opencode` with the same restriction is not verified.
- One shared MCP server with the hub side toolbox, or two implementations of one
  contract.
- Telegram identity: a single authorized chat id, everything else ignored; long polling
  needs no inbound network.
