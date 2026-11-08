// Bundled into each ordinary, self-contained executable plugin. No kernel imports.
function examplePanel(ctx, sdk, title, label, Content) {
  const R = sdk.React, h = R.createElement;
  function Panel({ context }) {
    const dialog = R.useRef(null), opener = R.useRef(null);
    R.useEffect(() => () => { dialog.current?.close(); }, []);
    return h('span', { style: { display: 'inline-block', margin: '5px 0 5px 8px' } },
      h('button', { ref: opener, type: 'button', className: 'secondary-button', 'data-example-open': ctx.manifest.id, 'data-example-source': sdk.plugin?.id || ctx.manifest.id, 'data-example-scope': sdk.conversation?.kind || 'local',
        onClick: () => dialog.current?.showModal() }, label),
      h('dialog', { ref: dialog, 'data-example-dialog': ctx.manifest.id, 'data-example-source': sdk.plugin?.id || ctx.manifest.id, 'data-example-scope': sdk.conversation?.kind || 'local', 'aria-label': title,
        onClose: () => opener.current?.focus(), onClick: e => { if (e.target === dialog.current) {
          const b = e.target.getBoundingClientRect(); if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) e.target.close();
        } } },
        h('style', null, `
          [data-example-dialog]{width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 56px);padding:0;border:1px solid var(--border-strong);border-radius:18px;background:var(--surface);color:var(--text);box-shadow:var(--shadow-float);overflow:auto}
          [data-example-dialog]::backdrop{background:var(--backdrop)}
          [data-example-dialog] .ex-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:20px 22px 12px}
          [data-example-dialog] h2{margin:0;font-size:19px;letter-spacing:-.02em}
          [data-example-dialog] .ex-body{padding:4px 22px 22px}
          [data-example-dialog] p{font-size:13px;line-height:1.6;color:var(--text-secondary)}
          [data-example-dialog] button{cursor:pointer;border:1px solid var(--border);border-radius:10px;background:var(--surface-muted);color:var(--text);padding:8px 12px;transition:background .15s,transform .15s}
          [data-example-dialog] button:hover:not(:disabled){background:var(--hover)}
          [data-example-dialog] button:active:not(:disabled){transform:scale(.97)}
          [data-example-dialog] button:disabled{opacity:.5;cursor:default}
          [data-example-dialog] button:focus-visible,[data-example-dialog] input:focus-visible,[data-example-dialog] textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
          [data-example-dialog] .ex-primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
          [data-example-dialog] .ex-primary:hover:not(:disabled){background:var(--accent-hover)}
          [data-example-dialog] .ex-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
          [data-example-dialog] input,[data-example-dialog] textarea{box-sizing:border-box;min-width:0;width:100%;padding:10px;border:1px solid var(--border-strong);border-radius:10px;color:var(--text);background:var(--canvas);font:inherit}
          [data-example-dialog] label{display:grid;gap:6px;font-size:12px;color:var(--text-secondary)}
          [data-example-dialog] [role=alert]{color:var(--danger)}
          [data-example-dialog] .ex-board{display:grid;gap:8px;margin:18px auto}
          [data-example-dialog] .ex-note{font-size:12px;color:var(--muted)}
          @media(prefers-reduced-motion:reduce){[data-example-dialog] button{transition:none}}
        `),
        h('header', { className: 'ex-heading' }, h('h2', null, title), h('button', { type: 'button', 'aria-label': '关闭' + title, onClick: () => dialog.current.close() }, '×')),
        h('div', { className: 'ex-body' }, h(Content, { context, close: () => dialog.current.close() }))))
  }
  ctx.contribute(ctx.getService('ui.slots'), { id: 'launcher', slot: 'chat.header', render: context => h(Panel, { context }) });
}
function exampleRead(key, fallback, valid) {
  try { const value = JSON.parse(localStorage.getItem(key) || 'null'); return valid(value) ? value : fallback; } catch { return fallback; }
}
function exampleSave(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
