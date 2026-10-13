import { useLayoutEffect, useRef } from 'react'

/** Keep keyboard navigation in a drawer and return to its opener when closed. */
export function useDialogFocus() {
  const ref=useRef<HTMLElement>(null)
  const opener=useRef(typeof document==='undefined'?null:document.activeElement as HTMLElement|null)
  useLayoutEffect(()=>{
    const dialog=ref.current
    if(!dialog)return
    const controls=()=>[...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]')].filter(item=>item.getClientRects().length>0)
    if(!dialog.contains(document.activeElement)){
      const items=controls(),preferred=items.find(item=>item.hasAttribute('data-dialog-initial-focus'))
      ;(preferred??items[0]??dialog).focus()
    }
    const trap=(event:KeyboardEvent)=>{
      if(event.key!=='Tab')return
      const items=controls(),first=items[0],last=items.at(-1)
      if(!first){event.preventDefault();dialog.focus();return}
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog)){event.preventDefault();last?.focus()}
      else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===dialog)){event.preventDefault();first.focus()}
    }
    dialog.addEventListener('keydown',trap)
    return()=>{dialog.removeEventListener('keydown',trap);if(opener.current?.isConnected)opener.current.focus()}
  },[])
  return ref
}
