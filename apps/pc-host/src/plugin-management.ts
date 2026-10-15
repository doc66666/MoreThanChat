import type { PluginManagementRequest, PluginManagementResult } from '@more-than-chat/protocol'
import type { PluginDraftService } from './plugin-drafts'
import type { HostPluginService } from './plugin-service'
import type { InstalledStaticToolStore } from './installed-static-tools'

export type ManagePlugins = (request: PluginManagementRequest) => Promise<PluginManagementResult>
export function createPluginManagement(drafts: PluginDraftService, plugins: HostPluginService, store: InstalledStaticToolStore, client: ManagePlugins): ManagePlugins {
  return async request => {
    if (request.action === 'list') {
      const remote = await client({action:'list',target:'client'})
      if (request.target === 'client') return remote
      return {summary:'本机已安装插件；不包含其他群成员的安装情况。',plugins:[
        ...plugins.catalog().plugins.map(p=>({id:p.id,displayName:p.displayName,version:p.version,target:'host' as const,enabled:p.status==='active',removable:plugins.isStaticInstall(p.id)})),
        ...remote.plugins,
      ]}
    }
    if (request.action === 'delete-draft') {
      await drafts.delete(request.id,request.revision)
      return {summary:'草稿已移出列表并移入本机 plugin-drafts/.deleted。已安装插件和群内分享不受影响。',plugins:[]}
    }
    if (request.target === 'client') return client(request)
    await plugins.uninstallManaged(request.id,request.version,{
      disable:()=>store.setEnabled(request.id,false),
      remove:()=>store.remove(request.id,request.version),
    })
    return {summary:'本机插件已卸载，运行贡献已清理。草稿和已分发副本不受影响。',plugins:[]}
  }
}
