import {useState} from 'react'
import {MessageSquareText,Timer,Grid2X2,Gamepad2,ArrowDownToLine,Copy,FileCode} from 'lucide-react'
import type {InstalledClientPackage} from '@more-than-chat/plugin-runtime'
import {bundledExamples, type BundledExample} from './bundled-examples'

const icons=[MessageSquareText,Timer,Grid2X2,Gamepad2,FileCode]
export function PluginExamples({packages,busy,onInstall,onCopy}:{packages:InstalledClientPackage[];busy:boolean;onInstall:(example:BundledExample)=>void;onCopy:(example:BundledExample)=>void}) {
  const [filter,setFilter]=useState('全部')
  return <section className="example-library" data-example-library aria-label="插件示例库">
    <div className="example-library-heading"><div><p className="eyebrow">从一个小功能开始</p><h3>插件示例库</h3></div><span className="example-count">{bundledExamples.length} 个示例</span></div>
    <p className="settings-note">随客户端提供，按需启用。入口在聊天顶部，可停用、卸载，也可以复制成自己的版本交给 AI 改写。</p>
    <div className="example-filters" aria-label="示例分类">{['全部','效率','游戏'].map(label=><button key={label} type="button" aria-pressed={filter===label} onClick={()=>setFilter(label)}>{label}</button>)}</div>
    <div className="example-grid">{bundledExamples.map((example,index)=>{
      if(filter!=='全部'&&example.category!==filter)return null
      const installed=packages.some(p=>p.manifest.id===example.id),Icon=icons[index]!
      return <article className="example-card" key={example.id} data-example-card={example.id}>
        <div className="example-card-heading"><span className="example-icon"><Icon size={20}/></span><span>{example.label}</span></div>
        <h4>{example.name}</h4><p>{example.description}</p><small>{example.hint}</small>
        <div className="example-card-actions"><button type="button" className="secondary-button" data-example-install disabled={busy||installed} onClick={()=>onInstall(example)}><ArrowDownToLine size={14}/>{installed?'已安装':'添加并启用'}</button>
        <button type="button" className="example-copy" data-example-copy disabled={busy} onClick={()=>onCopy(example)} title="复制源码到草稿，可让内置 AI 继续修改"><Copy size={14}/>复制为草稿</button></div>
        {installed&&<span className="ex-installed-note">启停与分享见下方已安装列表</span>}
      </article>
    })}</div>
  </section>
}
