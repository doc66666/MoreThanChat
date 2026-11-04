import type { ChatAccessRequest } from '@more-than-chat/protocol'
import { appApi } from './app-api'
/** Generic chat read/write broker shared with assistant tools; no business automation. */
export const chatSdk=Object.freeze({
  async request(input:ChatAccessRequest):Promise<unknown>{return JSON.parse((await appApi.accessChat(input)).dataJson)},
  subscribe(listener:(projection:unknown)=>void){return appApi.onCentralChat(listener)},
})
