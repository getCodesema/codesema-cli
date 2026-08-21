import type { AgentOption } from '../types'
import { firstTokenBin } from './agentCommand'
import type { CreateTaskInput } from './useTasks'

/** Dedicated picker id for a default command that is not an AGENT_DEFS entry. */
export const CURRENT_AGENT_ID = '_current'

/** Payload of a composer submit: `agent` only when it differs from the project default. */
export function taskComposerPayload(input: {
  title: string
  prompt: string
  autoShip: boolean
  agent: string
  defaultAgent?: string
}): CreateTaskInput {
  const trimmed = input.agent.trim()
  const baseline = (input.defaultAgent ?? '').trim()
  return {
    title: input.title,
    prompt: input.prompt,
    autoShip: input.autoShip,
    ...(trimmed && trimmed !== baseline ? { agent: trimmed } : {}),
  }
}

/** Options for the picker: detected first, plus a dedicated current-command row when unmatched. */
function sameAgent(command: string, agent: AgentOption): boolean {
  return agent.command === command || agent.bin === firstTokenBin(command)
}

export function pickerAgents(
  agents: readonly AgentOption[],
  currentAgent: string | undefined,
): AgentOption[] {
  const ordered = agents.toSorted((a, b) => Number(b.detected) - Number(a.detected))
  const current = (currentAgent ?? '').trim()
  if (current && !ordered.some((a) => sameAgent(current, a))) {
    return [
      {
        id: CURRENT_AGENT_ID,
        label: current,
        bin: firstTokenBin(current),
        command: current,
        detected: true,
      },
      ...ordered,
    ]
  }
  return ordered
}

export function matchAgentId(command: string | undefined, agents: readonly AgentOption[]): string {
  const current = (command ?? '').trim()
  if (!current) {
    return ''
  }
  return agents.find((a) => sameAgent(current, a))?.id ?? CURRENT_AGENT_ID
}

export function commandForAgentId(
  id: string,
  agents: readonly AgentOption[],
  currentAgent: string | undefined,
): string {
  if (id === CURRENT_AGENT_ID) {
    return (currentAgent ?? '').trim()
  }
  const opt = agents.find((a) => a.id === id)
  if (!opt) {
    return (currentAgent ?? '').trim()
  }
  const current = (currentAgent ?? '').trim()
  if (current && firstTokenBin(current) === opt.bin) {
    return current
  }
  return opt.command
}
