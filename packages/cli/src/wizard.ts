// Wizard interactif : provider IA (parmi ceux détectés sur le PATH) → modèle →
// effort (si le provider le supporte) → commande agent persistée en config.
// Onboarding au premier run seulement ; `codesema config` pour modifier ensuite.

import type { CodesemaConfig } from './config.js'
import {
  globalConfigPath,
  loadConfig,
  loadGlobalConfig,
  loadRepoConfig,
  repoConfigPath,
  saveGlobalConfig,
  saveRepoConfig,
} from './config.js'
import { tryExec } from './git.js'
import { isInteractive, select, textInput } from './tui.js'
import { bold, dim } from './ui.js'

export type AgentDef = {
  id: string
  label: string
  /** Binaire sondé sur le PATH. */
  bin: string
  /** Base de la commande headless : lit le prompt sur stdin, écrit sur stdout. */
  base: string
  /** Argument final placé après les flags (ex : "-" de `codex exec -`). */
  suffix?: string
  /** Flag modèle (la valeur est ajoutée juste après). */
  modelFlag: string
  /** Modèles suggérés (saisie libre toujours possible). */
  models: string[]
  /** Construction du flag effort, si le provider le supporte. */
  effortFlag?: (value: string) => string
  efforts?: string[]
}

// Invocations headless vérifiées dans la doc officielle de chaque CLI (2026-07) :
// claude -p / codex exec - / gemini lisent le prompt sur stdin et écrivent sur stdout.
// opencode n'a pas de lecture stdin documentée → utilisable via la commande custom.
export const AGENT_DEFS: AgentDef[] = [
  {
    id: 'claude',
    label: 'Claude Code (Anthropic)',
    bin: 'claude',
    base: 'claude -p',
    modelFlag: '--model',
    models: ['fable', 'opus', 'sonnet', 'haiku'],
    effortFlag: (v) => `--effort ${v}`,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'codex',
    label: 'Codex CLI (OpenAI / ChatGPT)',
    bin: 'codex',
    base: 'codex exec',
    suffix: '-',
    modelFlag: '-m',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini'],
    effortFlag: (v) => `-c model_reasoning_effort=${v}`,
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI (Google)',
    bin: 'gemini',
    base: 'gemini',
    modelFlag: '-m',
    models: ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    // pas de flag effort CLI (seulement settings.json côté gemini)
  },
]

export function detectAgents(cwd: string): AgentDef[] {
  return AGENT_DEFS.filter((def) => tryExec(def.bin, ['--version'], cwd) !== null)
}

/** Commande headless par défaut d'un provider (sans modèle ni effort). */
export function defaultCommand(def: AgentDef): string {
  return def.suffix ? `${def.base} ${def.suffix}` : def.base
}

export type WizardResult = {
  command: string
  agentId: string
  model?: string
  effort?: string
}

export function composeCommand(def: AgentDef, model?: string, effort?: string): string {
  let command = def.base
  if (model) command += ` ${def.modelFlag} ${model}`
  if (effort && def.effortFlag) command += ` ${def.effortFlag(effort)}`
  if (def.suffix) command += ` ${def.suffix}`
  return command
}

const CLI_DEFAULT = Symbol('cli-default')
const CUSTOM = Symbol('custom')

/**
 * Sélections interactives agent → modèle → effort. `current` préremplit les
 * choix (réédition via `codesema config`). null si l'utilisateur annule.
 */
export async function runAgentWizard(cwd: string, current: CodesemaConfig = {}): Promise<WizardResult | null> {
  if (!isInteractive()) return null

  const detected = detectAgents(cwd)
  const missing = AGENT_DEFS.filter((d) => !detected.includes(d))
  if (missing.length) {
    console.log(`  ${dim(`not found on PATH: ${missing.map((d) => d.bin).join(', ')}`)}`)
  }

  const agentOptions = [
    ...detected.map((def) => ({
      label: def.label,
      hint: current.agentId === def.id ? `${def.bin} · current` : def.bin,
      value: def as AgentDef | typeof CUSTOM,
    })),
    {
      label: 'Custom command',
      hint: current.agentId === 'custom' ? 'stdin → stdout · current' : 'stdin → stdout',
      value: CUSTOM as AgentDef | typeof CUSTOM,
    },
  ]
  const initialAgent = detected.findIndex((d) => d.id === current.agentId)
  const picked = await select({
    title: 'Which AI agent runs the review?',
    options: agentOptions,
    initialIndex: initialAgent >= 0 ? initialAgent : 0,
  })
  if (picked === null) return null

  if (picked === CUSTOM) {
    const command = await textInput({
      title: 'Full agent command',
      placeholder: 'reads the prompt on stdin, prints the review JSON on stdout',
    })
    return command ? { command, agentId: 'custom' } : null
  }

  const def = picked

  const modelOptions = [
    ...def.models.map((m) => ({
      label: m,
      hint: current.model === m ? 'current' : undefined,
      value: m as string | typeof CLI_DEFAULT | typeof CUSTOM,
    })),
    { label: 'CLI default', hint: `let ${def.bin} decide`, value: CLI_DEFAULT as string | typeof CLI_DEFAULT | typeof CUSTOM },
    { label: 'Other…', hint: 'type a model name', value: CUSTOM as string | typeof CLI_DEFAULT | typeof CUSTOM },
  ]
  const initialModel = def.models.indexOf(current.model ?? '')
  const modelPick = await select({
    title: `Model for ${def.label}?`,
    options: modelOptions,
    initialIndex: initialModel >= 0 ? initialModel : 0,
  })
  if (modelPick === null) return null
  let model: string | undefined
  if (modelPick === CUSTOM) {
    model = (await textInput({ title: 'Model name' })) ?? undefined
  } else if (modelPick !== CLI_DEFAULT) {
    model = modelPick
  }

  let effort: string | undefined
  if (def.effortFlag && def.efforts?.length) {
    const effortOptions = [
      ...def.efforts.map((e) => ({
        label: e,
        hint: current.effort === e ? 'current' : undefined,
        value: e as string | typeof CLI_DEFAULT,
      })),
      { label: 'CLI default', hint: `let ${def.bin} decide`, value: CLI_DEFAULT as string | typeof CLI_DEFAULT },
    ]
    const initialEffort = def.efforts.indexOf(current.effort ?? '')
    const effortPick = await select({
      title: 'Reasoning effort?',
      options: effortOptions,
      initialIndex: initialEffort >= 0 ? initialEffort : effortOptions.length - 1,
    })
    if (effortPick === null) return null
    if (effortPick !== CLI_DEFAULT) effort = effortPick
  }

  return { command: composeCommand(def, model, effort), agentId: def.id, model, effort }
}

function applyResult(config: CodesemaConfig, result: WizardResult): CodesemaConfig {
  const next: CodesemaConfig = { ...config, agent: result.command, agentId: result.agentId }
  delete next.model
  delete next.effort
  if (result.model) next.model = result.model
  if (result.effort) next.effort = result.effort
  return next
}

/**
 * Onboarding du premier run : wizard puis sauvegarde GLOBALE (une seule fois,
 * tous repos confondus). Renvoie la commande agent, ou null si annulé/non-TTY.
 */
export async function runOnboarding(cwd: string): Promise<string | null> {
  console.log(`  ${bold('First run')} — pick the agent that will review your code.`)
  console.log(`  ${dim('Saved once, for every repo. Change it anytime with `codesema config`.')}`)
  console.log('')
  const result = await runAgentWizard(cwd)
  if (!result) return null
  const path = saveGlobalConfig(applyResult(loadGlobalConfig(), result))
  console.log(`  ${dim(`saved: ${path}`)}`)
  return result.command
}

/** `codesema config` : réédite agent/modèle/effort, scope global ou repo. */
export async function configCommand(repoRoot: string | null): Promise<void> {
  if (!isInteractive()) {
    throw new Error('`codesema config` is interactive — run it from a terminal, or edit the config file directly')
  }

  const current = loadConfig(repoRoot)
  if (current.agent) {
    console.log(`  current agent: ${bold(current.agent)}`)
    const repoOverride = repoRoot && loadRepoConfig(repoRoot).agent
    console.log(`  ${dim(`from ${repoOverride ? repoConfigPath(repoRoot) : globalConfigPath()}`)}`)
    console.log('')
  }

  const result = await runAgentWizard(repoRoot ?? process.cwd(), current)
  if (!result) return

  let scope: 'global' | 'repo' = 'global'
  if (repoRoot) {
    const pickedScope = await select<'global' | 'repo'>({
      title: 'Save where?',
      options: [
        { label: 'Everywhere', hint: 'global config, all repos', value: 'global' },
        { label: 'This repo only', hint: '.codesema/config.json, overrides global', value: 'repo' },
      ],
    })
    if (pickedScope === null) return
    scope = pickedScope
  }

  const path =
    scope === 'repo' && repoRoot
      ? saveRepoConfig(repoRoot, applyResult(loadRepoConfig(repoRoot), result))
      : saveGlobalConfig(applyResult(loadGlobalConfig(), result))

  console.log('')
  console.log(`  agent command saved: ${bold(result.command)}`)
  console.log(`  ${dim(`config: ${path}`)}`)
}
