// HTML is message data. This renderer never executes JavaScript from a message.
export function messageDocument(html, colors) {
  // Template contents stay inert while parsing, including image and iframe URLs.
  const template = document.createElement('template');
  template.innerHTML = html;
  const doc = template.content;
  for (const node of doc.querySelectorAll('script,iframe,object,embed,link,meta,base,form,input,button,textarea,select,template')) node.remove();
  for (const node of doc.querySelectorAll('*')) for (const attr of [...node.attributes]) {
    if (!['style','class','title','colspan','rowspan','width','height','alt','role','aria-label'].includes(attr.name) && !(node.tagName === 'IMG' && attr.name === 'src' && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(attr.value))) node.removeAttribute(attr.name);
  }
  return '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; form-action \'none\'; base-uri \'none\'"><style>body{margin:0;padding:12px;font:14px/1.65 system-ui,sans-serif;overflow-wrap:anywhere;color:'+colors.text+';background:'+colors.background+'}*{box-sizing:border-box}img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}td,th{padding:6px;border:1px solid '+colors.border+'}pre{white-space:pre-wrap}h1,h2,h3{line-height:1.3}</style></head><body>'+template.innerHTML+'</body></html>';
}
// Drafts belong to this example, under the current identity's local storage.
// Retain an uncertain send ID across reloads, but start a new intent after success.
export function cardDraftStore(storage, key) {
  const initial = () => ({ summary: '', body: '', attempt: null });
  const read = () => {
    try {
      const value = JSON.parse(storage.getItem(key) || 'null');
      if (!value || typeof value.summary !== 'string' || value.summary.length > 2000 || typeof value.body !== 'string' || value.body.length > 100000) return null;
      return { summary: value.summary, body: value.body, attempt: value.attempt && typeof value.attempt.id === 'string' && typeof value.attempt.signature === 'string' ? value.attempt : null };
    } catch { return null; }
  };
  let draft = read() || initial();
  const save = () => { try { storage.setItem(key, JSON.stringify(draft)); return true; } catch { return false; } };
  return {
    get: () => draft,
    edit(patch) { draft = { ...draft, ...patch, attempt: null }; return save(); },
    begin(conversationId, newId = () => crypto.randomUUID()) {
      const request = { action: 'send', conversationId, text: draft.summary.trim(), content: { format: 'html', version: 1, body: draft.body } };
      const signature = JSON.stringify(request);
      if (draft.attempt?.signature !== signature) draft = { ...draft, attempt: { signature, id: newId() } };
      save();
      return { ...request, clientMessageId: draft.attempt.id };
    },
    complete(id) {
      // An old request must not erase a newer editor's draft after hot replacement.
      const latest = read();
      if (draft.attempt?.id !== id || (latest && latest.attempt?.id !== id)) return false;
      draft = initial();
      try { storage.removeItem(key); } catch { save(); }
      return true;
    },
  };
}
export default function activate(ctx, sdk) {
  const R = sdk.React, h = R.createElement;
  function Html({ body, title = 'HTML 消息' }) {
    const [theme, setTheme] = R.useState(document.documentElement.dataset.theme);
    R.useEffect(() => { const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme)); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); return () => observer.disconnect(); }, []);
    const source = R.useMemo(() => { const css = getComputedStyle(document.documentElement); return messageDocument(body, { text: css.getPropertyValue('--text'), background: css.getPropertyValue('--surface'), border: css.getPropertyValue('--border') }); }, [body, theme]);
    return h('iframe', { title, sandbox: '', srcDoc: source, className: 'message-html', 'data-html-message': true, style: { width: '100%', minWidth: 230, height: 240, border: 0, borderRadius: 8 } });
  }
  ctx.contribute(ctx.getService('ui.surfaces'), { id: 'html-body', surface: 'message.body.html', render: ({ context, defaultView }) => context.message.content?.version === 1 ? h(Html, { body: context.message.content.body }) : defaultView });
  function Compose({ context, close }) {
    const key = JSON.stringify([sdk.plugin?.id || ctx.manifest.id, sdk.conversation?.id || 'local', context?.conversation?.serverId, context?.conversation?.id]);
    return h(Editor, { key, draftKey: 'mtc.html-draft.v1:' + key, context, close });
  }
  function Editor({ draftKey, context, close }) {
    const store = R.useMemo(() => cardDraftStore(localStorage, draftKey), [draftKey]);
    const [draft, setDraft] = R.useState(() => store.get()), [busy, setBusy] = R.useState(false), [notice, setNotice] = R.useState('');
    const inFlight = R.useRef(false), mounted = R.useRef(true);
    R.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const { summary, body } = draft;
    const [preview, setPreview] = R.useState(body);
    R.useEffect(() => { const timer = setTimeout(() => setPreview(body), 150); return () => clearTimeout(timer); }, [body]);
    const conversation = context?.conversation, available = conversation?.serverId && ['direct','group'].includes(conversation.kind) && !conversation.unavailable;
    const edit = patch => { const saved = store.edit(patch); setDraft(store.get()); setNotice(saved ? '' : '未能保存到本机，关闭客户端后可能丢失草稿。'); };
    const send = async () => {
      if (inFlight.current || !available || !summary.trim() || !body.trim()) return;
      inFlight.current = true; setBusy(true); setNotice('');
      const request = store.begin(conversation.id);
      try {
        await sdk.chat.request(request);
        if (store.complete(request.clientMessageId) && mounted.current) { setDraft(store.get()); close(); }
      } catch (error) { if (mounted.current) setNotice(error instanceof Error ? error.message : String(error)); }
      finally { inFlight.current = false; if (mounted.current) setBusy(false); }
    };
    return h(R.Fragment, null,
      h('style', null, `dialog[data-example-source="${sdk.plugin?.id || ctx.manifest.id}"]{width:min(780px,calc(100vw - 32px))}.html-card-editor{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px}.html-card-editor textarea{font:12px/1.7 Consolas,monospace;resize:vertical}.html-card-preview{min-width:0;border:1px solid var(--border);border-radius:10px;padding:8px}.html-card-preview iframe{min-width:0!important}.html-card-editor small{display:block;margin-top:8px;color:var(--muted)}@media(max-width:700px){.html-card-editor{grid-template-columns:minmax(0,1fr)}}`),
      h('p', null, available ? '发送到「'+conversation.title+'」。对方启用本示例后显示卡片，否则显示文字摘要。' : '请先打开好友或群聊，再发送卡片。'),
      h('div', { className: 'html-card-editor', onKeyDown: e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent?.isComposing) { e.preventDefault(); void send(); } } },
        h('div', null,
          h('label', null, '文字摘要', h('input', { value: summary, disabled: busy, maxLength: 2000, placeholder: '没有安装渲染插件的人会看到这段文字', 'data-html-summary': true, onChange: e => edit({ summary: e.target.value }) })),
          h('label', { style: { marginTop: 12 } }, 'HTML 正文', h('textarea', { value: body, disabled: busy, maxLength: 100000, rows: 9, placeholder: '<h2>标题</h2>\n<p>写一张自己的卡片。</p>', 'data-html-source': true, onChange: e => edit({ body: e.target.value }) })),
          h('small', null, '草稿按会话保存在本机 · Ctrl / ⌘ + Enter 发送')),
        h('div', { className: 'html-card-preview' }, h('p', null, '实时预览'), h(Html, { body: preview, title: '发送预览' }))),
      h('p', { className: 'ex-note' }, '预览 · 支持 HTML 排版、内联样式与内嵌图片。交互逻辑写在渲染插件里，消息正文只承载内容。'),
      h('div', { className: 'ex-actions' }, h('button', { className: 'ex-primary', 'data-html-send': true, disabled: busy || !available || !summary.trim() || !body.trim(), onClick: send }, busy ? '正在加入队列…' : '发送卡片')),
      notice && h('p', { role: 'alert' }, notice));
  }
  const label = sdk.conversation?.kind === 'group' ? '群聊卡片' : sdk.conversation?.kind === 'direct' ? '好友卡片' : '写卡片';
  examplePanel(ctx, sdk, 'HTML 消息卡片', label, Compose);
}
