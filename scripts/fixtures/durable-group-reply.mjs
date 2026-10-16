// Test-only executable plugin. The checkpoint and pending reply belong to the
// plugin, not the host or central server. Used by both transport and Electron QA.
export function durableGroupReplyCode({senderId,version=1}) {
 return `export default async function activate(ctx,sdk){
  const id=sdk.conversation.serverId+':'+sdk.conversation.id;
  const key=JSON.stringify(['qa-durable-reply',sdk.plugin.id,sdk.conversation.serverId,sdk.conversation.userId,sdk.conversation.id]);
  let alive=true,ready=false,running=false,dirty=false;
  let state=JSON.parse(localStorage.getItem(key)||'null');
  const persist=()=>{if(alive)localStorage.setItem(key,JSON.stringify(state))};
  globalThis.qaReplyRuns=(globalThis.qaReplyRuns||0)+1;
  globalThis.qaReplyErrors=globalThis.qaReplyErrors||[];
  globalThis.qaReplyLive=${version};globalThis.qaReplyReady=false;
  ctx.effect(()=>{alive=false;globalThis.qaReplyLive=0});
  async function drain(){
   dirty=true;if(!ready||running||!alive)return;running=true;
   try{
    while(alive&&dirty){
     dirty=false;
     for(;;){
      if(!alive)return;
      if(state.pending){
       const pending=state.pending;
       await globalThis.qaReplyBeforeSend?.(pending);if(!alive)return;
       await sdk.chat.request(pending.request);
       await globalThis.qaReplyAfterSend?.(pending);if(!alive)return;
       state.cursor=pending.cursor;state.pending=null;persist();
      }
      const page=await sdk.chat.request({action:'history',conversationId:id,after:state.cursor,limit:1});
      if(!alive)return;if(!page.messages.length)break;
      const m=page.messages[0];
      if(m.role==='peer'&&m.senderId===${JSON.stringify(senderId)}&&!m.retractedAt&&m.text.startsWith('ask:')){
       state.pending={cursor:page.after,source:m.id,request:{action:'send',conversationId:id,clientMessageId:'reply-'+crypto.randomUUID(),text:'v${version}:'+m.text.slice(4),...(m.attachment?{attachmentMessageId:m.id}:{})}};
       persist(); // Commit exact ID/body BEFORE send. Upgrade/restart retries this plan unchanged.
      }else{state.cursor=page.after;persist()}
     }
    }
   }catch(error){if(alive)globalThis.qaReplyErrors.push(error.message)}
   finally{running=false}
  }
  ctx.effect(sdk.chat.subscribe(()=>{void drain()}));
  if(!state){
   const baseline=await sdk.chat.request({action:'history',conversationId:id,limit:1});
   if(!alive)return;state={schema:1,cursor:baseline.after??-1,pending:null};persist();
  }
  if(!alive)return;ready=true;globalThis.qaReplyReady=true;
  void drain(); // Reconcile on every activation, even when no new projection arrives.
 }`
}
