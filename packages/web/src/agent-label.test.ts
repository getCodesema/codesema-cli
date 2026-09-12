import { describe, expect, test } from 'bun:test'
import { agentRoleName } from './agent-label'

describe('agentRoleName', () => {
  test('uses the project name as the role identity', () => {
    expect(
      agentRoleName({
        projectName: 'codesema-tools',
        record: { title: 'fix auth', branch: 'codesema/task-fix-auth', agent: 'claude -p' },
      }),
    ).toBe('codesema-tools')
  })

  test('never returns the ticket title or the CLI command', () => {
    const name = agentRoleName({
      projectName: 'bench',
      record: {
        title: 'Rewrite the OAuth flow entirely',
        branch: 'codesema/task-rewrite-oauth',
        agent: '/usr/bin/claude -p --dangerously-skip-permissions',
      },
    })
    expect(name).toBe('bench')
    expect(name).not.toContain('OAuth')
    expect(name).not.toContain('claude')
  })

  test('returns null when the project name is empty', () => {
    expect(agentRoleName({ projectName: '' })).toBeNull()
    expect(agentRoleName({ projectName: '   ' })).toBeNull()
  })
})
