import { spawn } from 'node:child_process'

function appleScriptString(text: string): string {
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export function notifyDesktop(title: string, body: string): void {
  const command =
    process.platform === 'darwin'
      ? {
          cmd: 'osascript',
          args: [
            '-e',
            `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`,
          ],
        }
      : process.platform === 'linux'
        ? { cmd: 'notify-send', args: ['--app-name=codesema', title, body] }
        : null
  if (!command) {
    return
  }
  try {
    spawn(command.cmd, command.args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    // Notification is best effort: the outcome is already printed on stdout.
  }
}
