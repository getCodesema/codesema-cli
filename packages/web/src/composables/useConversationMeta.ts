// The conversation header's meta line, derived once and rendered as plain
// text. Everything here is identity — where the conversation happens, what
// contains it, how long it took — so nothing carries a tone: the status
// phrase, which is the only coloured part of the line, is built in the SFC
// and printed before these items.

import { G } from '../glyphs'
import { t } from '../i18n'
import type { Project, TaskRecord } from '../types'
import { isolationBadge } from './useIsolation'
import { formatDuration } from './useTaskBoard'

/** Styling hook: a name ellipsises, a duration keeps tabular figures, the
 * isolation word carries a tooltip. */
export type MetaKind = 'name' | 'iso' | 'chrono'

export type MetaItem = {
  key: string
  text: string
  hint: string | null
  kind: MetaKind
}

type MetaRecord = Pick<
  TaskRecord,
  'attachments' | 'base' | 'branch' | 'isolation' | 'wait_ms' | 'work_ms'
>

function name(key: string, text: string): MetaItem {
  return { key, text, hint: null, kind: 'name' }
}

function repoItems(
  record: MetaRecord,
  projectName: string,
  projectKind: Project['kind'],
): MetaItem[] {
  if (projectKind !== 'scratch') {
    return [
      name('project', projectName),
      name('branch', `${G.branch} ${record.branch || record.base}`),
    ]
  }
  const attachments = record.attachments ?? []
  if (attachments.length === 0) {
    return [name('no-repo', t('workspace.noRepoAttached'))]
  }
  return attachments.flatMap((attachment) => [
    name(`p-${attachment.project_id}`, attachment.name),
    name(`b-${attachment.project_id}`, `${G.branch} ${attachment.branch}`),
  ])
}

export function conversationMeta(
  record: MetaRecord,
  projectName: string,
  projectKind: Project['kind'],
): MetaItem[] {
  const isolation = isolationBadge(record)
  const items = [
    ...repoItems(record, projectName, projectKind),
    {
      key: 'isolation',
      text: `${isolation.glyph} ${t(isolation.labelKey)}`,
      hint: t(isolation.hintKey),
      kind: 'iso' as const,
    },
    {
      key: 'work',
      text: t('workspace.workTime', { t: formatDuration(record.work_ms) }),
      hint: null,
      kind: 'chrono' as const,
    },
  ]
  if (record.wait_ms > 0) {
    items.push({
      key: 'wait',
      text: t('workspace.waitTime', { t: formatDuration(record.wait_ms) }),
      hint: null,
      kind: 'chrono' as const,
    })
  }
  return items
}
