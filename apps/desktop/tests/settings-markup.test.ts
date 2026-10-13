import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe,expect,it,vi } from 'vitest'
import type { ModelSettingsSnapshot } from '@more-than-chat/protocol'
import { HistoryPasswordForm } from '../src/renderer/src/HistorySettings'
import { ModelSettingsPanel } from '../src/renderer/src/App'
vi.mock('../src/renderer/src/theme',()=>({useAppearance:()=>({preference:'light',resolved:'light'}),setThemePreference:vi.fn()}))
vi.mock('../src/renderer/src/plugin-host',()=>({chatNetworkService:{}}))

const props={mode:'export' as const,password:'safe-password',confirmation:'safe-password',busy:false,onPassword:vi.fn(),onConfirmation:vi.fn(),onConfirm:vi.fn(),onCancel:vi.fn()}
describe('settings form boundaries without a desktop window',()=>{
  it('history confirmation is the only submit button, cancellation is an ordinary button',()=>{
    const html=renderToStaticMarkup(createElement(HistoryPasswordForm,props))
    expect(html).toMatch(/^<form /)
    expect(html.match(/<button[^>]*data-history-action="confirm"[^>]*>/)?.[0]).toContain('type="submit"')
    expect(html.match(/<button[^>]*data-history-action="cancel"[^>]*>/)?.[0]).toContain('type="button"')
    expect(html.match(/type="submit"/g)).toHaveLength(1)
  })
  it('does not intercept ordinary Enter or invoke confirmation from a keydown handler',()=>{
    const onConfirm=vi.fn(),element=HistoryPasswordForm({...props,onConfirm})
    const event={key:'Enter',nativeEvent:{isComposing:false,keyCode:13},preventDefault:vi.fn()}
    element.props.onKeyDown(event)
    expect(event.preventDefault).not.toHaveBeenCalled();expect(onConfirm).not.toHaveBeenCalled()
    element.props.onKeyDown({...event,nativeEvent:{isComposing:true,keyCode:13}})
    element.props.onKeyDown({...event,nativeEvent:{isComposing:false,keyCode:229}})
    expect(event.preventDefault).toHaveBeenCalledTimes(2);expect(onConfirm).not.toHaveBeenCalled()
  })
  it('disables confirmation for short or mismatched passwords but leaves cancellation available',()=>{
    for(const value of [{password:'short',confirmation:'short'},{password:'safe-password',confirmation:'different-password'}]){
      const html=renderToStaticMarkup(createElement(HistoryPasswordForm,{...props,...value}))
      expect(html.match(/<button[^>]*data-history-action="confirm"[^>]*>/)?.[0]).toContain('disabled')
      expect(html.match(/<button[^>]*data-history-action="cancel"[^>]*>/)?.[0]).not.toContain('disabled')
    }
  })
  it('does not nest history controls in the AI settings form or submit on other settings buttons',()=>{
    const snapshot={baseUrl:'https://example.invalid',model:'test-model',providerMode:'mock',hasApiKey:true} as ModelSettingsSnapshot
    const html=renderToStaticMarkup(createElement(ModelSettingsPanel,{snapshot,onClose:vi.fn(),onSave:vi.fn(),onClearKey:vi.fn(),onServerSettings:vi.fn()}))
    expect(html).toContain('<aside')
    expect(html.indexOf('data-history-transfer')).toBeLessThan(html.indexOf('<form'))
    expect(html.match(/<form /g)).toHaveLength(1)
    expect(html).toContain('aria-label="AI 模型设置"')
    expect(html).not.toContain('data-confirm-clear-key')
  })
})
