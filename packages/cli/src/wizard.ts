import type { CodesemaConfig } from './config.js'
import {
  globalConfigPath,
  loadConfig,
  loadGlobalConfig,
  loadRepoConfig,
  repoConfigPath,
  saveGlobalConfig,
  saveRepoConfig,
  trustRepoAgent,
} from './config.js'
import { tryExec } from './git.js'
import { isInteractive, select, textInput } from './tui.js'
import { bold, dim } from './ui.js'

export type AgentDef = {
  id: string
  label: string
  bin: string
  /** Base headless command: reads the prompt on stdin, writes to stdout. */
  base: string
  /** Trailing argument placed after the flags (e.g. the "-" in `codex exec -`). */
  suffix?: string
  modelFlag: string
  /** Suggested models (free text entry is always possible). */
  models: string[]
  effortFlag?: (value: string) => string
  efforts?: string[]
}

// Headless invocations verified against each CLI's official docs (2026-07):
// claude -p / codex exec - / gemini read the prompt on stdin and write to stdout.
// opencode has no documented stdin mode, so it is only usable via a custom command.
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
    // no CLI effort flag: gemini only supports it via settings.json
  },
]

export function detectAgents(cwd: string): AgentDef[] {
  return AGENT_DEFS.filter((def) => tryExec(def.bin, ['--version'], cwd) !== null)
}

/** Default headless command for a provider (no model or effort). */
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
 * Interactive agent -> model -> effort selection. `current` prefills the
 * choices for re-editing via `codesema config`. null if the user cancels.
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
 * First-run onboarding: wizard then a GLOBAL save, once, across all repos.
 * Returns the agent command, or null if cancelled or non-TTY.
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

  let path: string
  if (scope === 'repo' && repoRoot) {
    path = saveRepoConfig(repoRoot, applyResult(loadRepoConfig(repoRoot), result))
    // The user just chose this command, so trust it now: the approval prompt only
    // targets agent commands inherited from a cloned repo, not ones set here.
    trustRepoAgent(repoRoot, result.command)
  } else {
    path = saveGlobalConfig(applyResult(loadGlobalConfig(), result))
  }

  console.log('')
  console.log(`  agent command saved: ${bold(result.command)}`)
  console.log(`  ${dim(`config: ${path}`)}`)
}
