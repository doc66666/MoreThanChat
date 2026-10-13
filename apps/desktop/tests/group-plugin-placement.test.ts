import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { UI_SLOTS, parseGroupPluginPack } from '@more-than-chat/central-protocol'
import { GroupPluginPlacement } from '../src/renderer/src/GroupPluginPlacement'
import { GroupDraftSubmission } from '../src/renderer/src/GroupDraftSubmission'
import { groupGameArtifact } from '../../../scripts/fixtures/group-game.mjs'
import type { PluginDraftSummary } from '@more-than-chat/protocol'

it.each(UI_SLOTS)('retains declarative content in the approved %s placement', slot => {
  const pack = parseGroupPluginPack({ id:'gplugin_00000000-0000-4000-8000-000000000001', version:1, displayName:'Placement', kind:'declarative', slot, artifact:groupGameArtifact })
  expect(pack.slot).toBe(slot)
  const markup = renderToStaticMarkup(createElement(GroupPluginPlacement, { slot, count:1, children:createElement('section', { 'data-group-plugin-gate':pack.id }, 'Pending consent') }))
  expect(markup).toContain('Pending consent')
  if (slot === 'app.rail' || slot === 'app.overlay') {
    expect(markup).toContain('<summary')
    expect(markup).toContain('收起面板')
    expect(markup.includes('open=""')).toBe(slot === 'app.overlay')
  } else expect(markup).not.toContain('<details')
})
it('does not create empty panel chrome', () => {
  expect(renderToStaticMarkup(createElement(GroupPluginPlacement, { slot:'app.overlay', count:0, children:null }))).toBe('')
})
it('lets authors choose all placements at submission without granting arbitrary UI code', () => {
  const markup = renderToStaticMarkup(createElement(GroupDraftSubmission, { draft:{id:'test.group-game',ok:true} as PluginDraftSummary, snapshot:null }))
  for (const slot of UI_SLOTS) expect(markup).toContain(`value="${slot}"`)
  expect(markup).toContain('不执行任意 JavaScript')
  expect(markup).toContain('不能覆盖内核和授权控件')
})
