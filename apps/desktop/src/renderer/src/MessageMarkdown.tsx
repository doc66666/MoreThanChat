import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { memo } from 'react'

/** Raw HTML is skipped; links open externally and images never make remote requests. */
export const MessageMarkdown = memo(function MessageMarkdown({ text }: { text: string }) {
  return <div className="message-markdown"><Markdown
    remarkPlugins={[remarkGfm]}
    skipHtml
    urlTransform={url => {
      try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : '' }
      catch { return '' }
    }}
    components={{
      a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
      img: ({ alt }) => <span className="markdown-image-placeholder">[图片：{alt || '未加载'}]</span>,
      pre: ({ children }) => <div className="message-code"><pre>{children}</pre></div>,
      table: ({ children }) => <div className="message-table"><table>{children}</table></div>,
    }}
  >{text}</Markdown></div>
})
