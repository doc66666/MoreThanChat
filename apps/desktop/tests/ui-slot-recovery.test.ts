// @vitest-environment happy-dom
import {act,createElement as h} from 'react'
import {createRoot} from 'react-dom/client'
import {expect,it,vi} from 'vitest'
import {ContributionRegistry,type UiSlotContribution} from '@more-than-chat/plugin-runtime'
import {UiSlot} from '../src/renderer/src/UiSlot'

it('retries a failed slot only when its contribution changes and recovers without a full remount',async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
  const registry=new ContributionRegistry<UiSlotContribution>(),container=document.createElement('div'),root=createRoot(container)
  const broken=vi.fn(()=>{throw Error('broken widget')}),errors=vi.spyOn(console,'error').mockImplementation(()=>{})
  let dispose=registry.register('same-plugin',{id:'widget',slot:'chat.header',render:broken})
  const render=()=>act(async()=>root.render(h(UiSlot,{name:'chat.header',entries:registry.list(),context:{}})))
  try{
    await render();expect(container.textContent).toContain('插件界面加载失败')
    const calls=broken.mock.calls.length
    await render();expect(broken).toHaveBeenCalledTimes(calls)
    dispose();dispose=registry.register('same-plugin',{id:'widget',slot:'chat.header',render:()=>h('button',null,'修正版')})
    await render();expect(container.querySelectorAll('button')).toHaveLength(1);expect(container.textContent).toBe('修正版')
  }finally{await act(async()=>root.unmount());dispose();errors.mockRestore()}
})
