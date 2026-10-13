// Real OS encryption acceptance helper. Only accepts the test harness's temporary profiles.
const { app, safeStorage } = require('electron')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { mkdir, writeFile, readFile } = require('node:fs/promises')
const { ClientIdentity } = require('../dist-main/identity-store.js')
const { restoreProfile, selectProfile, activeProfile } = require('../dist-main/identity-profiles.js')
const [source, target, mode] = process.argv.slice(2)
for (const value of [source,target]) {
  const relative=path.relative(os.tmpdir(),path.resolve(value||'.'))
  assert(/^mtc-central-ui-[^\\/]+[\\/][ac]$/.test(relative),'Only isolated acceptance profiles are allowed')
}
app.setPath('userData',mode==='export'?source:target)
app.whenReady().then(async()=>{
  const cipher={available:()=>safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text'),encrypt:s=>safeStorage.encryptString(s),decrypt:b=>safeStorage.decryptString(b)}
  const password='test-fixture-only-portable-identity'
  if(mode==='export'){
    const original=await ClientIdentity.load(path.join(source,'host-private'),cipher)
    const backup=await original.backup(password)
    assert(!backup.includes('PRIVATE KEY'))
    await mkdir(target,{recursive:true})
    await writeFile(path.join(target,'transfer.mtcidentity'),backup,{flag:'wx',mode:0o600})
    app.exit(0);return
  }
  assert.equal(mode,'import')
  const backup=await readFile(path.join(target,'transfer.mtcidentity'),'utf8')
  const original=await ClientIdentity.fromBackup(backup,password)
  const id=await restoreProfile(target,backup,password,cipher)
  await selectProfile(target,id)
  assert.equal(activeProfile(target),id)
  const restored=await ClientIdentity.load(path.join(target,'identities',id,'host-private'),cipher)
  assert.equal(restored.userId,original.userId)
  console.log('Real system encryption backup/import passed')
  app.exit(0)
}).catch(()=>{console.error('Identity fixture verification failed');app.exit(1)})
