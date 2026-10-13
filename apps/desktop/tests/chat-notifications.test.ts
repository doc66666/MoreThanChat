import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatNotifications, unreadCount, type NotificationCard, type NotificationMessage } from '../src/main/chat-notifications'

function fixture() {
  const preferences={notifications:true,preview:false,sound:false,closeToTray:false}
  const messages=new Map<string,NotificationMessage>()
  const shown:{card:NotificationCard;click:()=>void;close:ReturnType<typeof vi.fn>}[]=[]
  const open=vi.fn(),attention=vi.fn(), state={foreground:false,server:'srv-a',fail:false}
  const controller=new ChatNotifications({preferences:()=>preferences,foreground:()=>state.foreground,
    lookup:n=>state.server===n.serverId?messages.get(n.messageId)??null:null,
    show:(card,click)=>{if(state.fail)throw new Error('OS unavailable');const handle={card,click,close:vi.fn()};shown.push(handle);return handle},
    openConversation:open,attention})
  const receive=(id:string,patch:Partial<NotificationMessage>={})=>{
    const message:NotificationMessage={serverId:'srv-a',conversationId:'chat-a',messageId:id,title:'好友 A',senderName:'Alice',text:'private body '+id,own:false,read:false,retracted:false,muted:false,unavailable:false,...patch}
    messages.set(id,message);controller.receive(message);return message
  }
  return {controller,preferences,messages,shown,open,attention,state,receive}
}
describe('desktop notification policy',()=>{
  beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01'))})
  afterEach(()=>{vi.clearAllTimers();vi.useRealTimers()})
  it('coalesces bursts, defaults to private silent text and rate-limits each conversation',()=>{
    const f=fixture();f.receive('one');f.receive('two');vi.advanceTimersByTime(699);expect(f.shown).toHaveLength(0)
    vi.advanceTimersByTime(1);expect(f.shown[0]!.card).toEqual({title:'MoreThanChat',body:'你有 2 条新消息',silent:true,conversationId:'chat-a'})
    expect(JSON.stringify(f.shown[0]!.card)).not.toMatch(/Alice|private|好友/)
    f.receive('three');vi.advanceTimersByTime(3999);expect(f.shown).toHaveLength(1)
    vi.advanceTimersByTime(1);expect(f.shown).toHaveLength(2);expect(f.shown[0]!.close).toHaveBeenCalledOnce()
    f.shown[0]!.click();expect(f.open).not.toHaveBeenCalled()
    f.shown[1]!.click();expect(f.open).toHaveBeenCalledExactlyOnceWith('chat-a')
    expect(f.messages.get('three')!.read).toBe(false) // Navigation, not a read receipt.
  })
  it.each(['own','read','retracted','muted','unavailable'] as const)('does not notify %s messages or stale previews',flag=>{
    const f=fixture();f.receive('excluded',{[flag]:true});vi.advanceTimersByTime(1000);expect(f.shown).toHaveLength(0)
    const message=f.receive('pending');message[flag]=true;vi.advanceTimersByTime(1000);expect(f.shown).toHaveLength(0)
    const visible=f.receive('visible');vi.advanceTimersByTime(1000);expect(f.shown).toHaveLength(1)
    visible[flag]=true;f.controller.reconcile();expect(f.shown[0]!.close).toHaveBeenCalledOnce()
    f.shown[0]!.click();expect(f.open).not.toHaveBeenCalled()
  })
  it('suppresses focused/disabled notifications, clears on focus and rejects old-server clicks',()=>{
    const f=fixture();f.state.foreground=true;f.receive('focused');f.state.foreground=false
    f.preferences.notifications=false;f.receive('disabled');f.preferences.notifications=true
    vi.advanceTimersByTime(1000);expect(f.shown).toHaveLength(0)
    f.receive('shown');vi.advanceTimersByTime(1000);f.state.foreground=true;f.controller.reconcile()
    expect(f.shown[0]!.close).toHaveBeenCalledOnce()
    f.state.foreground=false;f.receive('another');vi.advanceTimersByTime(4000)
    f.state.server='srv-b';f.shown[1]!.click();expect(f.open).not.toHaveBeenCalled()
    f.receive('stale');vi.advanceTimersByTime(4000);expect(f.shown).toHaveLength(2)
  })
  it('sanitizes opt-in previews and formats attachments without accessing their bytes',()=>{
    const f=fixture();f.preferences.preview=true;f.preferences.sound=true
    f.receive('one',{title:'群\n\u202e聊',senderName:'A\rB',text:'',attachment:{mime:'text/plain',name:'\u2066report.txt'}})
    vi.advanceTimersByTime(700);expect(f.shown[0]!.card).toEqual({title:'群 聊',body:'A B：[文件] report.txt',silent:false,conversationId:'chat-a'})
    f.receive('two',{text:'x'.repeat(1000)});vi.advanceTimersByTime(4000);expect(f.shown[1]!.card.body.length).toBeLessThan(210)
  })
  it('bounds pending and visible notifications and discards all timers on shutdown',()=>{
    const f=fixture();for(let i=0;i<30;i++)f.receive(String(i),{conversationId:'chat-'+i})
    expect(vi.getTimerCount()).toBe(20);vi.advanceTimersByTime(700);expect(f.shown).toHaveLength(20)
    expect(f.shown.filter(n=>!n.close.mock.calls.length)).toHaveLength(5)
    f.receive('pending');f.controller.clear();expect(vi.getTimerCount()).toBe(0)
    expect(f.shown.every(n=>n.close.mock.calls.length===1)).toBe(true)
  })
  it('isolates operating-system failures from the receive path',()=>{
    const f=fixture();f.state.fail=true;f.receive('first');expect(()=>vi.advanceTimersByTime(700)).not.toThrow()
    f.state.fail=false;f.receive('next');vi.advanceTimersByTime(4000);expect(f.shown).toHaveLength(1)
  })
  it('excludes muted and unavailable relationships from the badge',()=>{
    expect(unreadCount({conversations:[{unread:2},{unread:4,muted:true},{unread:8,unavailable:true},{unread:-1}]})).toBe(2)
    expect(unreadCount(null)).toBe(0)
  })
})
