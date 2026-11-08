export default function activate(ctx, sdk) {
  const R = sdk.React, h = R.createElement, key = 'mtc.example.phrases:' + ctx.manifest.id;
  const defaults = ['收到，我稍后回复你。', '方便的话，我们约个时间聊聊？', '谢谢，已经解决了！'];
  let phrases = exampleRead(key, defaults, v => Array.isArray(v) && v.length <= 30 && v.every(s => typeof s === 'string' && s.length <= 500));
  function Phrases({ context, close }) {
    const [items, setItems] = R.useState(phrases), [text, setText] = R.useState(''), [notice, setNotice] = R.useState('');
    function save(next) {
      try { exampleSave(key, next); phrases = next; setItems(next); setNotice(''); return true; }
      catch { setNotice('未能保存，请检查本机存储空间。'); return false; }
    }
    return h(R.Fragment, null,
      h('p', null, '点击短语填入当前会话，已有内容会保留。确认后由你发送。'),
      h('div', { style: { display: 'grid', gap: 8 } }, items.map((text, index) => h('div', { key: index, style: { display: 'flex', gap: 6 } },
        h('button', { 'data-phrase-insert': index, disabled: typeof context?.setDraft !== 'function', style: { flex: 1, textAlign: 'left', overflowWrap: 'anywhere' }, onClick: () => {
          context.setDraft(previous => previous ? previous + '\n' + text : text); close();
        } }, text), h('button', { 'aria-label': '删除短语 ' + (index + 1), onClick: () => save(items.filter((_, i) => i !== index)) }, '×')))),
      !items.length && h('p', null, '还没有短语，先添加一句吧。'),
      h('form', { style: { marginTop: 18 }, onSubmit: e => { e.preventDefault(); const value = text.trim(); if (value && items.length < 30 && save([...items, value])) setText(''); } },
        h('label', null, '新短语', h('textarea', { 'data-phrase-input': true, rows: 2, maxLength: 500, value: text, onChange: e => setText(e.target.value), placeholder: '写一句你经常用到的话…' })),
        h('div', { className: 'ex-actions' }, h('button', { type: 'submit', className: 'ex-primary', disabled: !text.trim() || items.length >= 30, 'data-phrase-add': true }, '保存短语'), h('span', { className: 'ex-note' }, items.length + ' / 30'))),
      notice && h('p', { role: 'alert' }, notice));
  }
  examplePanel(ctx, sdk, '常用短语', '短语', Phrases);
}
