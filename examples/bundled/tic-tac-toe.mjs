export const freshGame = (round = 1) => ({ board: Array(9).fill(null), players: [], turn: 0, winner: null, round });
export function validGame(s) {
  return !!s && Array.isArray(s.board) && s.board.length === 9 && s.board.every(c => c === null || c === 'X' || c === 'O') &&
    Array.isArray(s.players) && s.players.length <= 2 && s.players.every(p => typeof p === 'string' && p.length > 0 && p.length <= 200) && new Set(s.players).size === s.players.length &&
    (s.turn === 0 || s.turn === 1) && Number.isSafeInteger(s.round) && s.round > 0 && (s.winner === null || s.winner === 'draw' || s.players.includes(s.winner));
}
export function gameAction(current, payload, actor) {
  if (!payload || payload.round !== current.round || typeof actor !== 'string' || !actor) return current;
  const state = structuredClone(current);
  if (payload.type === 'join' && !state.winner && !state.players.includes(actor) && state.players.length < 2) state.players.push(actor);
  if (payload.type === 'leave' && state.players.includes(actor)) return { ...freshGame(state.round + 1), players: state.players.filter(p => p !== actor) };
  if (payload.type === 'reset' && state.winner) return freshGame(state.round + 1);
  if (payload.type === 'move' && state.players.length === 2 && !state.winner && actor === state.players[state.turn] && Number.isInteger(payload.cell) && payload.cell >= 0 && payload.cell < 9 && !state.board[payload.cell]) {
    state.board[payload.cell] = state.turn === 0 ? 'X' : 'O';
    for (const [a, b, c] of [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]) {
      if (state.board[a] && state.board[a] === state.board[b] && state.board[a] === state.board[c]) state.winner = actor;
    }
    if (!state.winner && state.board.every(Boolean)) state.winner = 'draw';
    state.turn = 1 - state.turn;
  }
  return state;
}
export default async function activate(ctx, sdk) {
  const R = sdk.React, h = R.createElement, { network, conversation } = sdk, user = conversation?.userId || 'local-x', listeners = new Set();
  // The plugin owns its saves. Different servers, conversations and copies never share a board.
  const key = 'mtc.example.tictactoe:' + JSON.stringify([ctx.manifest.id, conversation?.serverId || 'local', conversation?.id || '', user]);
  const saved = exampleRead(key, null, v => v && validGame(v.state) && Number.isSafeInteger(v.sequence) && v.sequence >= 0);
  let state = saved?.state || freshGame(), sequence = saved?.sequence || 0, stopped = false, ready = false, buffered = [], problem = '', busy = false;
  const recent = [], checkpoint = sequence;
  function publish() {
    if (stopped) return;
    try { exampleSave(key, { state, sequence }); } catch { problem = '本机存档失败，本局仍可继续。'; }
    for (const listener of listeners) listener();
  }
  ctx.effect(() => { stopped = true; listeners.clear(); });
  function consume(event, historical = false) {
    if (stopped || !event.trace) return;
    const seq = event.trace.stateRevision, actor = event.trace.actorId, p = event.payload;
    if (!Number.isSafeInteger(seq) || seq < 1 || typeof actor !== 'string') return;
    if (event.channel === 'snapshot' && p?.target === user && validGame(p.state) && Number.isSafeInteger(p.sequence) && p.sequence > checkpoint && p.sequence < seq) {
      // A late join may receive new actions before a peer's snapshot. Replay those
      // actions over the snapshot instead of losing either the old board or the new moves.
      if (p.sequence < sequence && !recent.some(e => e.trace.stateRevision > p.sequence)) return;
      let next = structuredClone(p.state), nextSequence = p.sequence;
      for (const e of recent) if (e.trace.stateRevision > nextSequence) { next = gameAction(next, e.payload, e.trace.actorId); nextSequence = e.trace.stateRevision; }
      if (nextSequence >= sequence) { state = next; sequence = nextSequence; publish(); }
      return;
    }
    if (event.channel === 'hello' && !historical && actor !== user && sequence > 0) {
      void network.send('snapshot', { target: actor, state: structuredClone(state), sequence }).catch(e => { problem = e.message; publish(); }); return;
    }
    if (event.channel !== 'action' || seq <= sequence) return;
    state = gameAction(state, p, actor); sequence = seq; recent.push(event); if (recent.length > 512) recent.shift(); publish();
  }
  if (network) {
    ctx.effect(network.subscribe(event => { if (ready) consume(event); else buffered.push(event); }));
    const history = await network.history();
    for (const event of [...history, ...buffered].sort((a,b) => (a.trace?.stateRevision || 0) - (b.trace?.stateRevision || 0))) consume(event, true);
    ready = true; buffered = [];
    await network.send('hello', {});
  } else ready = true;
  async function send(type, cell) {
    if (busy || stopped) return;
    busy = true; problem = ''; publish();
    try {
      const payload = { type, round: state.round, op: crypto.randomUUID(), ...(cell === undefined ? {} : { cell }) };
      if (network) await network.send('action', payload);
      else { const actor = type === 'join' ? (state.players.includes('local-x') ? 'local-o' : 'local-x') : state.players[state.turn] || state.players[0] || user; state = gameAction(state, payload, actor); sequence++; }
    } catch (error) { problem = error.message; }
    finally { busy = false; publish(); }
  }
  function Game() {
    const [, refresh] = R.useState(0);
    R.useEffect(() => { const listener = () => refresh(n => n + 1); listeners.add(listener); return () => listeners.delete(listener); }, []);
    const name = id => id === 'local-x' ? '玩家 X' : id === 'local-o' ? '玩家 O' : conversation?.members.find(m => m.id === id)?.displayName || (id === user ? '你' : id.slice(0, 8));
    const canMove = !busy && !state.winner && state.players.length === 2 && (!network || state.players[state.turn] === user);
    const status = state.winner ? (state.winner === 'draw' ? '平局，再来一局？' : name(state.winner) + ' 获胜！') : state.players.length < 2 ? '等待玩家入座' : '轮到 ' + name(state.players[state.turn]);
    return h(R.Fragment, null,
      h('p', { className: 'ex-note' }, network ? '当前' + (conversation.kind === 'direct' ? '好友会话' : '群聊') + '共享对局 · 其他成员可观战' : '本机双人轮流操作。要联机，请在插件面板申请分享到好友或群聊。'),
      h('p', { 'data-ttt-status': true, role: 'status' }, '第 ' + state.round + ' 局 · ' + status),
      h('p', { 'data-ttt-seats': true }, 'X：' + (state.players[0] ? name(state.players[0]) : '空席') + '　O：' + (state.players[1] ? name(state.players[1]) : '空席')),
      h('div', { className: 'ex-board', style: { gridTemplateColumns: 'repeat(3,1fr)', maxWidth: 270 } }, state.board.map((mark, cell) => h('button', {
        key: cell, 'data-ttt-cell': cell, 'aria-label': '第 ' + (cell + 1) + ' 格，' + (mark || '空'), disabled: !canMove || !!mark,
        style: { aspectRatio: '1', padding: 0, fontSize: 36, color: mark === 'X' ? 'var(--accent)' : 'var(--text-secondary)' }, onClick: () => void send('move', cell)
      }, mark || '·'))),
      h('div', { className: 'ex-actions' },
        h('button', { className: 'ex-primary', 'data-ttt-join': true, disabled: busy || !!state.winner || state.players.length >= 2 || !!network && state.players.includes(user), onClick: () => void send('join') }, '加入对局'),
        h('button', { 'data-ttt-leave': true, disabled: busy || !state.players.length || !!network && !state.players.includes(user), onClick: () => void send('leave') }, '退座换人'),
        h('button', { 'data-ttt-reset': true, disabled: busy || !state.winner, onClick: () => void send('reset') }, '新一局')),
      h('p', { className: 'ex-note' }, '新一局释放所有席位；中途退座会重开棋盘，空位可由其他成员加入。'),
      problem && h('p', { role: 'alert' }, problem));
  }
  const title = network ? (conversation.kind === 'direct' ? '好友井字棋' : '群聊井字棋') : '本机井字棋';
  examplePanel(ctx, sdk, title, title, Game);
}
