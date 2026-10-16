import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { AttachmentStore } from '../src/main/attachments'

it('reads immutable message metadata independently of the latest name for the same bytes',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'mtc-attachment-refs-'))
 try{
  const files=new AttachmentStore(directory),bytes=Buffer.from('same contents')
  const first=await files.put(bytes,'first.txt','text/plain'),second=await files.put(bytes,'second.dat','application/octet-stream')
  expect(first.id).toBe(second.id)
  expect(await files.read(first.id,first)).toEqual({...first,data:bytes.toString('base64')})
  expect(await files.read(second.id,second)).toEqual({...second,data:bytes.toString('base64')})
  await expect(files.read(first.id,{...first,id:'b'.repeat(64)})).rejects.toThrow()
  await expect(files.read(first.id,{...first,size:999})).rejects.toThrow()
  // Existing messages retain enough metadata to read intact bytes even if the legacy index is damaged.
  await writeFile(path.join(directory,first.id+'.json'),'{broken')
  expect((await files.read(first.id,first)).name).toBe('first.txt')
  await writeFile(path.join(directory,first.id),Buffer.from('corrupt bytes'))
  await expect(files.read(first.id,first)).rejects.toThrow('损坏')
 }finally{await rm(directory,{recursive:true,force:true})}
})
