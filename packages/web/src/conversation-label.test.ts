import { describe, expect, test } from 'bun:test'
import { conversationLabel } from './conversation-label'

describe('conversationLabel', () => {
  test('reads the agent-named branch as words', () => {
    expect(
      conversationLabel({
        title: 'Ajoute un fichier HELLO.md à la racine',
        branch: 'codesema/task-add-hello-markdown-file',
      }),
    ).toBe('add hello markdown file')
  })

  test('drops the collision suffix', () => {
    expect(conversationLabel({ title: 'x', branch: 'codesema/task-fix-auth-2' })).toBe('fix auth')
  })

  test('falls back to the title on a user branch or an empty slug', () => {
    expect(conversationLabel({ title: 'Work on develop', branch: 'develop' })).toBe(
      'Work on develop',
    )
    expect(conversationLabel({ title: 'Untitled', branch: 'codesema/task-' })).toBe('Untitled')
  })
})
