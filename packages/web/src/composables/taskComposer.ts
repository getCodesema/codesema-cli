import type { AgentOption } from '../types'
import type { CreateTaskInput } from './useTasks'

/** Payload of a composer submit: `agent` only when a command was selected. */
export function taskComposerPayload(
  title: string,
  prompt: string,
  autoShip: boolean,
  agent: string,
): CreateTaskInput {
  return {
    title,
    prompt,
    autoShip,
    ...(agent ? { agent } : {}),
  }
}

function firstTokenBin(command: string): string {
  return command.split(/\s+/)[0]?.split('/').pop() ?? ''
}

export function matchAgentId(command: string | undefined, agents: readonly AgentOption[]): string {
  const fallback = agents.find((a) => a.detected) ?? agents[0]
  if (!fallback) {
    return ''
  }
  const current = (command ?? '').trim()
  if (!current) {
    return fallback.id
  }
  const exact = agents.find((a) => a.command === current)
  if (exact) {
    return exact.id
  }
  const bin = firstTokenBin(current)
  return agents.find((a) => a.bin === bin || a.id === bin)?.id ?? fallback.id
}

export function commandForAgentId(
  id: string,
  agents: readonly AgentOption[],
  currentAgent: string | undefined,
): string {
  const opt = agents.find((a) => a.id === id)
  if (!opt) {
    return currentAgent?.trim() ?? ''
  }
  const current = (currentAgent ?? '').trim()
  const currentBin = firstTokenBin(current)
  if (current && (currentBin === opt.bin || currentBin === opt.id)) {
    return current
  }
  return opt.command
}
