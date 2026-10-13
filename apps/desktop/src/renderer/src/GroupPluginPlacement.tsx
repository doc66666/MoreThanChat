import { useRef, useState, type ReactNode } from 'react'

/** Layout chrome belongs to the host, never to a downloaded plugin. Collapsing
 * hides a view; it does not change consent, dispose it, or reset shared state. */
export function GroupPluginPlacement({ slot, count, children }: { slot: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(slot === 'app.overlay')
  const summary = useRef<HTMLElement>(null)
  if (!count) return null
  if (slot !== 'app.rail' && slot !== 'app.overlay') return <>{children}</>
  function collapse() { setOpen(false); summary.current?.focus() }
  return <details className="group-plugin-placement" data-plugin-placement={slot} open={open}
    onToggle={event => setOpen(event.currentTarget.open)}
    onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); collapse() } }}>
    <summary ref={summary} title={`本群插件（${count}）`} aria-label={`本群插件（${count}），展开或收起`}>群插件 <span>{count}</span></summary>
    <div className="group-plugin-placement-panel" role="region" aria-label="本群插件面板">
      <div className="group-plugin-placement-heading"><span>本群插件</span><button type="button" className="secondary-button" onClick={collapse}>收起面板</button></div>
      {children}
    </div>
  </details>
}
