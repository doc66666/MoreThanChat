/** Hidden terminal input; never use command arguments/environment for real keys. */
export function readSecret() {
  return new Promise((resolve, reject) => {
    let buffered = ''
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdout.write('API test credential input ready (hidden)\n')
    const consume = chunk => {
      buffered += chunk.toString()
      if (buffered.includes('\u0003')) { cleanup(); reject(new Error('Cancelled')); return }
      if (!/[\r\n]/.test(buffered)) return
      const key = buffered.split(/[\r\n]/)[0].trim()
      buffered = ''
      cleanup()
      if (key) resolve(key); else reject(new Error('No credential supplied'))
    }
    const end = () => { cleanup(); reject(new Error('No credential supplied')) }
    function cleanup() {
      process.stdin.off('data', consume); process.stdin.off('end', end)
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdin.pause()
    }
    process.stdin.on('data', consume); process.stdin.once('end', end)
  })
}
