import { createClient } from '@supabase/supabase-js'
import { randomBytes, randomInt } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createAccount } from '../../HR-System-Admin/api/admin.js'
import { companyIdFromNumber } from '../../HR-System-Admin/server/core.js'

const projectRoot = resolve(import.meta.dirname, '..')
const envPath = resolve(projectRoot, '.env.readiness.local')
if (existsSync(envPath)) throw new Error('Đã có file tài khoản test; không tạo thêm.')

const readEnv = path => Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/)
  .map(line => /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/.exec(line))
  .filter(Boolean)
  .map(([, key, value]) => [key, value.trim().replace(/^["']|["']$/g, '')]))

const appEnv = readEnv(resolve(projectRoot, '.env.local'))
const adminEnv = readEnv(resolve(projectRoot, '../HR-System-Admin/.env.local'))
if (!appEnv.VITE_SUPABASE_URL || appEnv.VITE_SUPABASE_URL !== (adminEnv.SUPABASE_URL || adminEnv.VITE_SUPABASE_URL)) {
  throw new Error('System Admin và ứng dụng HR không trỏ tới cùng Supabase project.')
}
if (!adminEnv.SUPABASE_SERVICE_ROLE_KEY) throw new Error('System Admin chưa có khóa cấp tài khoản.')

// Service role chỉ cấp dữ liệu test. Bài kiểm tra RLS dùng anon key và hai phiên Auth riêng.
const admin = createClient(appEnv.VITE_SUPABASE_URL, adminEnv.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } })
const nonce = randomBytes(5).toString('hex')
const accounts = []
for (const label of ['A', 'B']) {
  let shortId, companyId
  for (let attempt = 0; attempt < 10; attempt += 1) {
    shortId = String(randomInt(900_000_000_000, 999_999_999_999))
    companyId = companyIdFromNumber(shortId)
    const { data, error } = await admin.from('companies').select('id').eq('id', companyId).maybeSingle()
    if (error) throw error
    if (!data) break
    companyId = null
  }
  if (!companyId) throw new Error('Không tìm được mã công ty test trống.')

  const email = `hr-readiness-${label.toLowerCase()}-${nonce}@example.test`
  const password = randomBytes(30).toString('base64url')
  const { error: companyError } = await admin.from('companies').insert({
    id: companyId,
    code: `COMPANY_${shortId}`,
    name: `READINESS TEST ${label} ${nonce}`
  })
  if (companyError) throw companyError
  try {
    await createAccount(admin, {
      companyId, email, password, name: `Readiness Test ${label}`,
      employeeId: `READINESS_${label}_${nonce}`,
      username: `readiness_${label.toLowerCase()}_${nonce}`,
      role: 'admin'
    })
  } catch (error) {
    const { error: cleanupError } = await admin.from('companies').delete().eq('id', companyId)
    if (cleanupError) throw new Error(`Không cấp được tài khoản và không dọn được công ty test ${companyId}: ${error.message}; ${cleanupError.message}`)
    throw error
  }
  accounts.push({ label, companyId, email, password })
  writeFileSync(envPath, accounts.flatMap(account => [
    `READINESS_${account.label}_COMPANY_ID=${account.companyId}`,
    `READINESS_${account.label}_EMAIL=${account.email}`,
    `READINESS_${account.label}_PASSWORD=${account.password}`
  ]).join('\n') + '\n', { flag: accounts.length === 1 ? 'wx' : 'w', mode: 0o600 })
  console.log(`Đã tạo công ty test ${label}: ${companyId}`)
}
console.log('Thông tin đăng nhập nằm trong .env.readiness.local (đã gitignore).')
