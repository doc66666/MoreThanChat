export default function activate(ctx, sdk) {
  const R = sdk.React, h = R.createElement, key = 'mtc.example.memory:' + ctx.manifest.id;
  const symbols = ['☀', '☾', '★', '♫', '♠', '♥', '◆', '✿'];
  let best = exampleRead(key, null, v => Number.isInteger(v) && v >= 8);
  const shuffle = () => { const cards = [...symbols, ...symbols]; for (let i = cards.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]]; } return cards; };
  function Memory() {
    const [cards, setCards] = R.useState(shuffle), [open, setOpen] = R.useState([]), [matched, setMatched] = R.useState([]), [moves, setMoves] = R.useState(0), [record, setRecord] = R.useState(best), [problem, setProblem] = R.useState('');
    R.useEffect(() => { if (open.length === 2) { const timer = setTimeout(() => setOpen([]), 700); return () => clearTimeout(timer); } }, [open]);
    function flip(index) {
      if (open.length === 2 || open.includes(index) || matched.includes(index)) return;
      if (!open.length) { setOpen([index]); return; }
      const first = open[0], steps = moves + 1; setMoves(steps);
      if (cards[first] === cards[index]) {
        const next = [...matched, first, index]; setMatched(next); setOpen([]);
        if (next.length === cards.length && (best === null || steps < best)) {
          try { exampleSave(key, steps); best = steps; setRecord(steps); } catch { setProblem('本局已完成，但最佳纪录未能保存。'); }
        }
      } else setOpen([first, index]);
    }
    return h(R.Fragment, null,
      h('p', { role: 'status', 'data-memory-status': true }, matched.length === 16 ? '全部配对！本局用了 ' + moves + ' 步。' : '翻开两张卡片，找到相同图案。'),
      h('p', { className: 'ex-note' }, '步数 ' + moves + ' · 配对 ' + matched.length / 2 + '/8 · 最佳 ' + (record ?? '—')),
      h('div', { className: 'ex-board', style: { gridTemplateColumns: 'repeat(4,1fr)' } }, cards.map((symbol, index) => {
        const visible = open.includes(index) || matched.includes(index);
        return h('button', { key: index, 'data-memory-cell': index, 'aria-label': '卡片 ' + (index + 1) + (visible ? ' ' + symbol : ' 未翻开'), disabled: matched.includes(index) || open.includes(index) || open.length === 2,
          style: { aspectRatio: '1', padding: 0, fontSize: 30, background: visible ? 'var(--accent-soft)' : 'var(--surface-muted)', color: 'var(--accent)' }, onClick: () => flip(index) }, visible ? symbol : '·');
      })),
      h('button', { 'data-memory-reset': true, onClick: () => { setCards(shuffle()); setOpen([]); setMatched([]); setMoves(0); setProblem(''); } }, '重新洗牌'),
      h('p', { className: 'ex-note' }, '本局保留到插件停用；最佳纪录保存在本机。'),
      problem && h('p', { role: 'alert' }, problem));
  }
  examplePanel(ctx, sdk, '翻牌记忆', '翻牌', Memory);
}
