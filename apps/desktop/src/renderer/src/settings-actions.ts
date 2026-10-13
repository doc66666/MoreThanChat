export function backupPasswordIssue(password: string, confirmation?: string): string | null {
  if (password.length < 12 || password.length > 256 || !password.trim()) return '备份密码需要 12–256 个字符，不能全为空格。'
  if (confirmation !== undefined && password !== confirmation) return '两次输入的密码不一致。'
  return null
}

// The mutation already succeeded. A follow-up read failure must not imply rollback.
export async function refreshAfterCompletedAction<T>(read: () => Promise<T>): Promise<{ value: T | null; refreshFailed: boolean }> {
  try { return { value: await read(), refreshFailed: false } }
  catch { return { value: null, refreshFailed: true } }
}
