// Handwritten protocol fixture, NOT a DS-generated acceptance artifact or bundled product plugin.
const ref = ref => ({ref})
const op = (op,...args) => ({op,args})
const board=ref('state.board'),players=ref('state.players'),actor=ref('actor'),turn=ref('state.turn'),winner=ref('state.winner')
const seated=op('includes',players,actor)
const join=op('and',op('lt',op('length',players),2),op('not',seated))
const play=op('and',op('eq',op('length',players),2),op('every',players,op('includes',ref('members'),ref('item'))),op('eq',op('get',players,turn),actor),op('eq',winner,null))
const move=op('and',play,op('includes',[0,1,2,3,4,5,6,7,8],ref('event.cell')),op('eq',op('get',board,ref('event.cell')),null))
const lines=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]
const at=i=>op('get',board,op('get',ref('item'),i))
const won=op('some',lines,op('and',op('ne',at(0),null),op('eq',at(0),at(1)),op('eq',at(1),at(2))))
const blank=Array(9).fill(null)
export const groupGameArtifact={
  manifest:{manifestVersion:1,id:'test.group-game',version:'0.1.0',displayName:'测试井字棋',description:'手写协议测试样本；不是 AI 产物',targets:['pc-ui'],engine:{moreThanChat:'^0.1.0'},permissions:['chat.network'],services:{requires:['chat.network']}},
  program:{
    kind:'group-state-machine',initial:{board:blank,players:[],turn:0,winner:null},
    actions:{
      join:{guard:join,updates:[{field:'players',value:op('append',players,actor)}]},
      move:{guard:move,updates:[
        {field:'board',value:op('setAt',board,ref('event.cell'),op('if',op('eq',turn,0),'X','O'))},
        {field:'winner',value:op('if',won,actor,op('if',op('every',board,op('ne',ref('item'),null)),'draw',null))},
        {field:'turn',value:op('sub',1,turn)},
      ]},
      reset:{guard:op('and',seated,op('ne',winner,null)),updates:[{field:'board',value:blank},{field:'turn',value:0},{field:'winner',value:null}]},
      leave:{guard:seated,updates:[{field:'players',value:op('filter',players,op('ne',ref('item'),actor))},{field:'board',value:blank},{field:'turn',value:0},{field:'winner',value:null}]},
    },
    view:{
      texts:[op('if',op('ne',winner,null),op('if',op('eq',winner,'draw'),'平局','本局已结束'),op('if',op('lt',op('length',players),2),'等待玩家加入',op('if',op('eq',op('get',players,turn),actor),'轮到你落子','等待另一位玩家')))],
      buttons:[{label:'加入对局',action:'join',enabled:join},{label:'再来一局',action:'reset',enabled:op('and',seated,op('ne',winner,null))},{label:'退出对局',action:'leave',enabled:seated}],
      grids:[{columns:3,cells:board,label:ref('item'),action:'move',enabled:op('and',play,op('eq',ref('item'),null))}],
    },
  },
}
