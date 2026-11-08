import {parseExecutableClientPackage, type InstalledClientPackage} from '@more-than-chat/plugin-runtime'
import catalog from '../../../../../examples/bundled/catalog.json'
import panel from '../../../../../examples/bundled/panel.mjs?raw'
import phrases from '../../../../../examples/bundled/quick-phrases.mjs?raw'
import focus from '../../../../../examples/bundled/focus-timer.mjs?raw'
import memory from '../../../../../examples/bundled/memory-pairs.mjs?raw'
import game from '../../../../../examples/bundled/tic-tac-toe.mjs?raw'
import html from '../../../../../examples/bundled/html-message.mjs?raw'

const code:Record<string,string>={'quick-phrases':phrases,'focus-timer':focus,'memory-pairs':memory,'tic-tac-toe':game,'html-message':html}
export const bundledExamples = catalog.map(item => ({...item, pack: parseExecutableClientPackage({
  manifest: {manifestVersion:1,id:item.id,version:'1.0.0',displayName:item.name,description:item.description,
    targets:['pc-ui'],engine:{moreThanChat:'^0.1.0'},permissions:['client.trusted'],services:{requires:['ui.slots',...(item.file==='tic-tac-toe'?['chat.network']:[]),...(item.file==='html-message'?['ui.surfaces']:[])]}},
  program: {kind:'executable-client',code:panel+'\n'+code[item.file]},
})}))
export type BundledExample = typeof bundledExamples[number]
export async function prepareExample(example:BundledExample):Promise<InstalledClientPackage> {
  const pack=parseExecutableClientPackage(example.pack)
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(pack)))
  return {...pack,digest:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')}
}
