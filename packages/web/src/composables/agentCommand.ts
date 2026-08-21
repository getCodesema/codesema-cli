/**
 * Reading an agent shell command back into its parts. The CLI owns composing
 * these commands (wizard.ts's composeCommand); the web side only ever needs to
 * recognise WHICH provider a command runs and which model it pins, so a picker
 * can preselect the right row instead of falling back to a raw-command option.
 */

/** The binary a command runs, path and flags stripped (`/opt/bin/claude -p` → `claude`). */
export function firstTokenBin(command: string): string {
  return command.trim().split(/\s+/)[0]?.split('/').pop() ?? ''
}

/**
 * The `-m` / `--model` / `--model=` value, or '' when the command pins no model.
 * A bare trailing `-` (codex exec's stdin marker) is not a model id.
 */
export function parseModelFlag(command: string): string {
  const tokens = command.trim().split(/\s+/)
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? ''
    if (tok === '-m' || tok === '--model') {
      const next = tokens[i + 1]
      return next && next !== '-' ? next : ''
    }
    if (tok.startsWith('--model=')) {
      return tok.slice('--model='.length)
    }
  }
  return ''
}
