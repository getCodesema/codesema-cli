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
import { setLanguage, t, type SupportedLanguage } from './i18n.js'
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

// Shown before any language is picked, so this stays bilingual by design.
const LANGUAGE_TITLE = 'Language / Langue?'

function defaultLanguageIndex(current?: SupportedLanguage): number {
  if (current === 'en') return 0
  if (current === 'fr') return 1
  const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ''
  return env.toLowerCase().startsWith('fr') ? 1 : 0
}

/** Language selection (ISO 639-1 codes with a catalog), null if cancelled. */
export async function pickLanguage(current?: SupportedLanguage): Promise<SupportedLanguage | null> {
  const options = [
    { label: 'English', hint: current === 'en' ? t('wizard.current') : undefined, value: 'en' as SupportedLanguage },
    { label: 'Français', hint: current === 'fr' ? t('wizard.current') : undefined, value: 'fr' as SupportedLanguage },
  ]
  return await select({ title: LANGUAGE_TITLE, options, initialIndex: defaultLanguageIndex(current) })
}

/**
 * Interactive agent -> model -> effort selection. `current` prefills the
 * choices for re-editing via `codesema config`. null if the user cancels.
 */
export async function runAgentWizard(cwd: string, current: CodesemaConfig = {}): Promise<WizardResult | null> {
  if (!isInteractive()) return null

  const detected = detectAgents(cwd)
  const missing = AGENT_DEFS.filter((d) => !detected.includes(d))
  if (missing.length) {
    console.log(`  ${dim(t('wizard.notOnPath', { bins: missing.map((d) => d.bin).join(', ') }))}`)
  }

  const agentOptions = [
    ...detected.map((def) => ({
      label: def.label,
      hint: current.agentId === def.id ? `${def.bin} · ${t('wizard.current')}` : def.bin,
      value: def as AgentDef | typeof CUSTOM,
    })),
    {
      label: t('wizard.customCommand'),
      hint: current.agentId === 'custom' ? `${t('wizard.stdinStdout')} · ${t('wizard.current')}` : t('wizard.stdinStdout'),
      value: CUSTOM as AgentDef | typeof CUSTOM,
    },
  ]
  const initialAgent = detected.findIndex((d) => d.id === current.agentId)
  const picked = await select({
    title: t('wizard.whichAgent'),
    options: agentOptions,
    initialIndex: initialAgent >= 0 ? initialAgent : 0,
  })
  if (picked === null) return null

  if (picked === CUSTOM) {
    const command = await textInput({
      title: t('wizard.fullCommandTitle'),
      placeholder: t('wizard.fullCommandPlaceholder'),
    })
    return command ? { command, agentId: 'custom' } : null
  }

  const def = picked

  const modelOptions = [
    ...def.models.map((m) => ({
      label: m,
      hint: current.model === m ? t('wizard.current') : undefined,
      value: m as string | typeof CLI_DEFAULT | typeof CUSTOM,
    })),
    { label: t('wizard.cliDefault'), hint: t('wizard.letDecide', { bin: def.bin }), value: CLI_DEFAULT as string | typeof CLI_DEFAULT | typeof CUSTOM },
    { label: t('wizard.otherOption'), hint: t('wizard.typeModelName'), value: CUSTOM as string | typeof CLI_DEFAULT | typeof CUSTOM },
  ]
  const initialModel = def.models.indexOf(current.model ?? '')
  const modelPick = await select({
    title: t('wizard.modelFor', { label: def.label }),
    options: modelOptions,
    initialIndex: initialModel >= 0 ? initialModel : 0,
  })
  if (modelPick === null) return null
  let model: string | undefined
  if (modelPick === CUSTOM) {
    model = (await textInput({ title: t('wizard.modelName') })) ?? undefined
  } else if (modelPick !== CLI_DEFAULT) {
    model = modelPick
  }

  let effort: string | undefined
  if (def.effortFlag && def.efforts?.length) {
    const effortOptions = [
      ...def.efforts.map((e) => ({
        label: e,
        hint: current.effort === e ? t('wizard.current') : undefined,
        value: e as string | typeof CLI_DEFAULT,
      })),
      { label: t('wizard.cliDefault'), hint: t('wizard.letDecide', { bin: def.bin }), value: CLI_DEFAULT as string | typeof CLI_DEFAULT },
    ]
    const initialEffort = def.efforts.indexOf(current.effort ?? '')
    const effortPick = await select({
      title: t('wizard.effort'),
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
  const language = (await pickLanguage()) ?? undefined
  if (language) setLanguage(language)
  console.log(`  ${bold(t('wizard.firstRun'))}`)
  console.log(`  ${dim(t('wizard.firstRunHint'))}`)
  console.log('')
  const result = await runAgentWizard(cwd)
  if (!result) return null
  const config = applyResult(loadGlobalConfig(), result)
  if (language) config.language = language
  const path = saveGlobalConfig(config)
  console.log(`  ${dim(t('wizard.saved', { path }))}`)
  return result.command
}

export async function configCommand(repoRoot: string | null): Promise<void> {
  if (!isInteractive()) {
    throw new Error(t('config.notInteractive'))
  }

  const current = loadConfig(repoRoot)
  if (current.agent) {
    console.log(`  ${t('config.currentAgent', { command: bold(current.agent) })}`)
    const repoOverride = repoRoot && loadRepoConfig(repoRoot).agent
    console.log(`  ${dim(t('config.fromPath', { path: repoOverride ? repoConfigPath(repoRoot) : globalConfigPath() }))}`)
    console.log('')
  }

  const result = await runAgentWizard(repoRoot ?? process.cwd(), current)
  if (!result) return

  const language = (await pickLanguage(current.language)) ?? undefined
  if (language) setLanguage(language)

  let scope: 'global' | 'repo' = 'global'
  if (repoRoot) {
    const pickedScope = await select<'global' | 'repo'>({
      title: t('config.saveWhere'),
      options: [
        { label: t('config.everywhere'), hint: t('config.everywhereHint'), value: 'global' },
        { label: t('config.thisRepo'), hint: t('config.thisRepoHint'), value: 'repo' },
      ],
    })
    if (pickedScope === null) return
    scope = pickedScope
  }

  const withResult = (config: CodesemaConfig): CodesemaConfig => {
    const next = applyResult(config, result)
    if (language) next.language = language
    return next
  }

  let path: string
  if (scope === 'repo' && repoRoot) {
    path = saveRepoConfig(repoRoot, withResult(loadRepoConfig(repoRoot)))
    // The user just chose this command, so trust it now: the approval prompt only
    // targets agent commands inherited from a cloned repo, not ones set here.
    trustRepoAgent(repoRoot, result.command)
  } else {
    path = saveGlobalConfig(withResult(loadGlobalConfig()))
  }

  console.log('')
  console.log(`  ${t('config.agentSaved', { command: bold(result.command) })}`)
  console.log(`  ${dim(t('config.savedTo', { path }))}`)
}
