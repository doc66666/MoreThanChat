import { describe, expect, it } from 'vitest'
import { MAX_GROUP_MEMBERS, parseMessageReceipt, parseDirectory, parseGroupPluginPack, parseRelayEvent,parseMessageReference,parseMessageRetraction } from '../src'
const uid = 'usr_' + 'a'.repeat(64),
  groupId = 'grp_11111111-1111-4111-8111-111111111111',
  pluginId = 'gplugin_22222222-2222-4222-8222-222222222222'
describe('central wire boundary', () => {
  it('accepts expanded group receipts without weakening count ordering or the bound', () => {
    const receipt = { messageId:'33333333-3333-4333-8333-333333333333', clientMessageId:'client', acceptedAt:1,
      recipientCount:MAX_GROUP_MEMBERS-1, deliveredCount:200, readCount:100 }
    expect(parseMessageReceipt(receipt)).toEqual(receipt)
    for (const bad of [{recipientCount:MAX_GROUP_MEMBERS}, {readCount:201}, {deliveredCount:MAX_GROUP_MEMBERS}, {readCount:-1}]) {
      expect(() => parseMessageReceipt({...receipt,...bad})).toThrow()
    }
  })
  it('accepts legacy events and validates/canonicalizes optional server trace metadata', () => {
    const e={id:'33333333-3333-4333-8333-333333333333',kind:'plugin',groupId,pluginId,channel:'state',payload:{}}
    expect(parseRelayEvent(e)).not.toHaveProperty('trace')
    const trace={actorId:uid,packVersion:2,digest:'a'.repeat(64),acceptedAt:123,stateRevision:5}
    expect(parseRelayEvent({...e,trace:{...trace,token:'secret'}})).toEqual({...e,trace})
    for(const bad of [{actorId:'spoof'},{packVersion:0},{digest:'bad'},{acceptedAt:-1},{stateRevision:0.5}]) {
      expect(()=>parseRelayEvent({...e,trace:{...trace,...bad}})).toThrow(/trace/)
    }
  })
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
