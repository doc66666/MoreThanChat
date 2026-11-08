export default function activate(ctx, sdk) {
  const R = sdk.React, h = R.createElement, key = 'mtc.example.focus:' + ctx.manifest.id, listeners = new Set();
  let state = exampleRead(key, { duration: 25 * 60, remaining: 25 * 60, end: null }, v => v && Number.isFinite(v.duration) && v.duration >= 60 && v.duration <= 10800 && Number.isFinite(v.remaining) && v.remaining >= 0 && v.remaining <= 10800 && (v.end === null || Number.isFinite(v.end)));
  let problem = '';
  const seconds = () => state.end === null ? state.remaining : Math.max(0, Math.ceil((state.end - Date.now()) / 1000));
  function notify() { for (const listener of listeners) listener(); }
  function save(next) { state = next; try { exampleSave(key, state); problem = ''; } catch { problem = '计时仍在继续，但进度未能保存到本机。'; } notify(); }
  const tick = setInterval(() => {
    if (state.end !== null && seconds() === 0) save({ ...state, remaining: 0, end: null });
    else if (state.end !== null) notify();
  }, 500);
  ctx.effect(() => { clearInterval(tick); listeners.clear(); });
  function useTick() {
    const [, refresh] = R.useState(0);
    R.useEffect(() => { const listener = () => refresh(n => n + 1); listeners.add(listener); return () => listeners.delete(listener); }, []);
  }
  function Caption() {
    useTick(); const left = seconds();
    return '专注' + (left === 0 ? ' · 已完成' : state.end !== null ? ' ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') : '');
  }
  function Timer() {
    useTick(); const [minutes, setMinutes] = R.useState('25');
    const left = seconds(), running = state.end !== null, number = Number(minutes), valid = Number.isInteger(number) && number >= 1 && number <= 180;
    function reset(minutes) { save({ duration: minutes * 60, remaining: minutes * 60, end: null }); }
    return h(R.Fragment, null,
      h('p', null, '关掉这个面板继续聊天，计时会在后台继续。'),
      h('div', { style: { textAlign: 'center', padding: '24px 0', fontSize: 62, fontVariantNumeric: 'tabular-nums', letterSpacing: '-.04em', color: 'var(--accent)' }, 'data-focus-clock': true }, String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0')),
      h('p', { role: 'status', style: { textAlign: 'center' }, 'data-focus-status': true }, left === 0 ? '这一段完成了，起来活动一下吧。' : running ? '专注中，慢慢来。' : '准备好后，再开始。'),
      h('div', { className: 'ex-actions', style: { justifyContent: 'center' } },
        h('button', { className: 'ex-primary', 'data-focus-toggle': true, onClick: () => running ? save({ ...state, remaining: left, end: null }) : save({ ...state, remaining: left || state.duration, end: Date.now() + (left || state.duration) * 1000 }) }, running ? '暂停' : left === 0 ? '再来一段' : '开始 / 继续'),
        h('button', { onClick: () => reset(state.duration / 60), 'data-focus-reset': true }, '重置')),
      h('div', { className: 'ex-actions' }, h('button', { onClick: () => reset(25) }, '专注 25 分钟'), h('button', { onClick: () => reset(5) }, '休息 5 分钟')),
      h('form', { style: { marginTop: 18 }, onSubmit: e => { e.preventDefault(); if (valid) reset(number); } },
        h('label', null, '自定义分钟（1–180）', h('input', { type: 'number', min: 1, max: 180, value: minutes, onChange: e => setMinutes(e.target.value), 'data-focus-minutes': true })),
        h('div', { className: 'ex-actions' }, h('button', { type: 'submit', disabled: !valid }, '应用时长'))),
      problem && h('p', { role: 'alert' }, problem));
  }
  examplePanel(ctx, sdk, '专注计时', h(Caption), Timer);
}
