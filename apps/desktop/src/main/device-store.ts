import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export async function loadDeviceId(directory: string): Promise<string> {
  await mkdir(directory,{recursive:true,mode:0o700})
  const file=path.join(directory,'device-id')
  try {
    const id=await readFile(file,'utf8')
    if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('本机设备标识损坏，请恢复身份到新空间')
    return id
  } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error }
  const id=randomUUID()
  try { await writeFile(file,id,{flag:'wx',mode:0o600}); return id }
  catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error; return loadDeviceId(directory) }
}
