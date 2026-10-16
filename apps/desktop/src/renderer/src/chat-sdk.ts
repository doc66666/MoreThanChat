import type { ChatAccessRequest } from '@more-than-chat/protocol'
/** Generic chat read/write broker shared with assistant tools; no business automation. */
export const chatSdk=Object.freeze({
  async request(input:ChatAccessRequest):Promise<unknown>{return JSON.parse((await window.moreThanChat.accessChat(input)).dataJson)},
  subscribe(listener:(projection:unknown)=>void){return window.moreThanChat.onCentralChat(listener)},
})
