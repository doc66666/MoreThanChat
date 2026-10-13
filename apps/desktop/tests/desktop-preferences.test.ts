import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DesktopPreferenceStore } from '../src/main/desktop-preferences'

describe('desktop preferences durability',()=>{
  it('uses privacy-first defaults, persists concurrent patches and isolates profiles',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'mtc-desktop-settings-'))
    try{
      const settings=new DesktopPreferenceStore(root);await settings.load()
      expect(settings.get()).toEqual({notifications:true,preview:false,sound:false,closeToTray:false})
      const copy=settings.get();copy.preview=true;expect(settings.get().preview).toBe(false)
      await Promise.all([settings.update({preview:true}),settings.update({sound:true}),settings.update({closeToTray:true})]);await settings.flush()
      const restored=new DesktopPreferenceStore(root);await restored.load();expect(restored.get()).toEqual(settings.get())
      const other=new DesktopPreferenceStore(path.join(root,'another-identity'));await other.load();expect(other.get().closeToTray).toBe(false)
      expect((await readdir(root)).filter(name=>name.endsWith('.tmp'))).toEqual([])
      for(const patch of [null,[],{preview:'true'},{unknown:true}])expect(()=>settings.update(patch)).toThrow('无效')
    }finally{await rm(root,{recursive:true,force:true})}
  })
  it('preserves an invalid settings file without silently overwriting it on load',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'mtc-desktop-settings-invalid-'))
    try{
      await writeFile(path.join(root,'desktop-preferences.json'),'damaged file')
      const settings=new DesktopPreferenceStore(root);await settings.load();expect(settings.error).toContain('原文件已保留')
      expect(await readFile(path.join(root,'desktop-preferences.json'),'utf8')).toBe('damaged file')
      expect(settings.get().preview).toBe(false)
    }finally{await rm(root,{recursive:true,force:true})}
  })
  it('keeps the last settings on a failed write and can recover on the next update',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'mtc-desktop-settings-failure-'))
    try{
      const settings=new DesktopPreferenceStore(root),target=path.join(root,'desktop-preferences.json')
      await mkdir(target)
      await expect(settings.update({closeToTray:true})).rejects.toThrow()
      expect(settings.get().closeToTray).toBe(false)
      expect((await readdir(root)).filter(name=>name.endsWith('.tmp'))).toEqual([])
      await rm(target,{recursive:true});await settings.update({sound:true});await settings.flush()
      expect(settings.get()).toMatchObject({sound:true,closeToTray:false})
    }finally{await rm(root,{recursive:true,force:true})}
  })
})
