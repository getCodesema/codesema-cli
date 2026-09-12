// Nom de rôle affiché dans le rail et l'en-tête : le projet (contexte de la
// session), jamais la commande CLI ni le titre du ticket.
import type { TaskRecord } from './types'

export type AgentRoleInput = {
  projectName: string
  /** Réservé : le record peut servir plus tard à un rôle plus fin (YAGNI). */
  record?: Pick<TaskRecord, 'title' | 'branch' | 'agent'>
}

/** Identité d'une ligne agent = rôle issu du projet. Null → le caller met "Agent". */
export function agentRoleName(input: AgentRoleInput): string | null {
  const name = input.projectName.trim()
  return name.length > 0 ? name : null
}
