import { describe, expect, it } from 'vitest'
import { UI_SLOTS, type ServerSnapshot } from '@more-than-chat/central-protocol'
import type { PluginDraftSummary } from '@more-than-chat/protocol'
import { slotLabels, submissionIssue } from '../src/renderer/src/group-plugin-presentation'

const draft = { id: 'game', ok: true } as PluginDraftSummary
const snapshot = {
  status: 'connected', serverId: 'server', userId: 'self',
  directory: { groups: [{ id: 'group', name: 'Group' }], plugins: [] },
} as unknown as ServerSnapshot
describe('group submission guidance', () => {
  it('covers every supported slot with a readable label', () => {
    expect(Object.keys(slotLabels).sort()).toEqual([...UI_SLOTS].sort())
    for (const slot of UI_SLOTS) expect(slotLabels[slot]).not.toBe(slot)
  })
  it('explains invalid, offline, empty and removed group states', () => {
    expect(submissionIssue({ ...draft, ok: false }, snapshot, 'group')).toContain('校验')
    expect(submissionIssue(draft, null, 'group')).toContain('连接')
    expect(submissionIssue(draft, { ...snapshot, directory: { ...snapshot.directory!, groups: [] } }, 'group')).toContain('加入群聊')
    expect(submissionIssue(draft, snapshot, 'missing')).toContain('选择')
    expect(submissionIssue(draft, snapshot, 'group')).toBeNull()
  })
  it('blocks only this author and plugin in the selected group while pending', () => {
    const withPending = structuredClone(snapshot)
    withPending.directory!.plugins = [{ groupId: 'group', submittedBy: 'self', status: 'pending', pack: { artifact: { manifest: { id: 'game' } } } }] as typeof withPending.directory.plugins
    expect(submissionIssue(draft, withPending, 'group')).toContain('重复提交')
    withPending.directory!.plugins[0]!.status = 'rejected'
    expect(submissionIssue(draft, withPending, 'group')).toBeNull()
    withPending.directory!.plugins[0]!.status = 'pending'
    withPending.directory!.plugins[0]!.submittedBy = 'someone-else'
    expect(submissionIssue(draft, withPending, 'group')).toBeNull()
  })
})
