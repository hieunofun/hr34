import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const env = Object.fromEntries(readFileSync(resolve(root, '../HR-System-Admin/.env.local'), 'utf8')
  .split(/\r?\n/).map(line => /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/.exec(line))
  .filter(Boolean).map(([, key, value]) => [key, value.trim().replace(/^["']|["']$/g, '')]))
const entries = [
  ['SUPABASE_URL', env.SUPABASE_URL, '--no-sensitive'],
  ['SUPABASE_SERVICE_ROLE_KEY', env.SUPABASE_SERVICE_ROLE_KEY, '--sensitive']
]
for (const [key, value, visibility] of entries) {
  if (!value) throw new Error(`${key} chưa có trong env System Admin.`)
  await new Promise((resolvePromise, reject) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c',
      `npx --yes vercel@latest env add ${key} production --force ${visibility} --yes`], {
      cwd: root, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true
    })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolvePromise() : reject(new Error(`Vercel ${key}: ${code}`)))
    child.stdin.end(Buffer.from(`${value}\n`, 'utf8'))
  })
}
console.log('Đã cấu hình hai biến server Production cho project HR; không in giá trị bí mật.')
