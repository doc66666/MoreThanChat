export function HistoryNotice({ busy, error, onRetry, onLatest }: {
  busy: boolean; error: string; onRetry: () => void; onLatest: () => void
}) {
  if (busy) return <div className="history-notice" role="status">正在读取聊天记录…</div>
  if (!error) return null
  return <div className="history-notice"><p className="settings-error" role="alert">{error}</p><div><button className="secondary-button" onClick={onRetry}>重新加载</button><button className="secondary-button" onClick={onLatest}>返回最新消息</button></div></div>
}
