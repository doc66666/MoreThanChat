import { describe, expect, it } from 'vitest'
import { parseDirectory, parseGroupPluginPack, parseRelayEvent,parseMessageReference,parseMessageRetraction } from '../src'
const uid = 'usr_' + 'a'.repeat(64),
  groupId = 'grp_11111111-1111-4111-8111-111111111111',
  pluginId = 'gplugin_22222222-2222-4222-8222-222222222222'
describe('central wire boundary', () => {
  it('bounds and canonicalizes quote and withdrawal extensions without forwarding credentials',()=>{
    const messageId='33333333-3333-4333-8333-333333333333'
    const reference={messageId,senderId:uid,senderName:'A',text:'preview',apiKey:'not-an-application-field'}
    expect(parseMessageReference(reference)).not.toHaveProperty('apiKey')
    expect(()=>parseMessageReference({...reference,text:'x'.repeat(281)})).toThrow()
    expect(()=>parseMessageReference({...reference,senderId:'someone'})).toThrow()
    const retraction={messageId,clientMessageId:'client',conversationId:groupId,senderId:uid,senderName:'A',createdAt:10,retractedAt:20,targetKind:'group',targetId:groupId,targetName:'G',token:'must-not-forward'}
    expect(parseMessageRetraction(retraction)).not.toHaveProperty('token')
    expect(()=>parseMessageRetraction({...retraction,retractedAt:9})).toThrow()
    expect(parseRelayEvent({id:messageId,kind:'directory',retraction})).toMatchObject({kind:'directory',retraction:{messageId,retractedAt:20}})
  })
  it('rejects executable fields in a reviewed package and malformed peer directories', () => {
    const pack = {
      id: pluginId,
      version: 1,
      displayName: 'Test',
      kind: 'channel',
      slot: 'app.sidebar',
    }
    expect(parseGroupPluginPack(pack)).toEqual(pack)
    expect(() => parseGroupPluginPack({ ...pack, source: 'eval()' })).toThrow()
    expect(() =>
      parseDirectory({
        self: { id: uid, displayName: 'A', online: true },
        friends: [],
        requests: [],
        groups: [],
        plugins: [
          {
            groupId,
            pack: { ...pack, kind: 'tic-tac-toe' },
            digest: 'a'.repeat(64),
            submittedBy: uid,
            status: 'approved',
            revision: 0,
            state: { board: 'malformed' },
          },
        ],
      }),
    ).toThrow()
  })
  it('canonicalizes events without carrying unrecognized privileged fields', () => {
    const event = {
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'plugin',
      groupId,
      pluginId,
      channel: 'test',
      payload: { position: 1 },
      token: 'must-not-forward',
    }
    expect(parseRelayEvent(event)).not.toHaveProperty('token')
    expect(() =>
      parseRelayEvent({ ...event, groupId: 'another-server' }),
    ).toThrow()
  })
})
