// Cross-company users probes use only ordinary Auth sessions. Service role is
// reserved for isolated test fixture setup (if needed) and exact-ID cleanup.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { loadCompanySession } from '../src/services/companySession.js'

const root = resolve(import.meta.dirname, '..')
const env = path => Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/)
  .map(line => /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/.exec(line)).filter(Boolean)
  .map(([, key, value]) => [key, value.trim().replace(/^["']|["']$/g, '')]))
const hr = env(resolve(root, '.env.local'))
const test = env(resolve(root, '.env.readiness.local'))
const admin = env(resolve(root, '../HR-System-Admin/.env.local'))
const service = createClient(admin.SUPABASE_URL, admin.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } })
const client = () => createClient(hr.VITE_SUPABASE_URL, hr.VITE_SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } })
const nonce = randomBytes(5).toString('hex')
const accounts = []
const cleanup = []
const failures = []
const checked = (result, label) => {
  if (result.error) throw new Error(`${label}: ${result.error.code || result.status} ${result.error.message}`)
  return result.data
}
const rowFor = (companyId, label) => ({
  id: randomUUID(), company_id: companyId,
  name: `RLS TEST ${label} ${nonce}`,
  username: `rls_${label.toLowerCase()}_${nonce}`,
  email: `rls-${label.toLowerCase()}-${nonce}@example.test`,
  employee_id: `RLS_${label}_${nonce}`,
  role: 'user', password: null
})

try {
  for (const label of ['A', 'B']) {
    const sb = client()
    const auth = checked(await sb.auth.signInWithPassword({
      email: test[`READINESS_${label}_EMAIL`], password: test[`READINESS_${label}_PASSWORD`]
    }), `Auth ${label}`)
    const session = await loadCompanySession(sb, auth.user)
    assert.equal(session.company.id, test[`READINESS_${label}_COMPANY_ID`])
    assert.ok(session.company.name.startsWith('READINESS TEST '))
    const fixture = rowFor(session.company.id, label)
    let setup = 'owner session'
    const ownInsert = await sb.from('users').insert(fixture).select('id')
    if (ownInsert.error) {
      setup = 'service role fixture only'
      checked(await service.from('users').insert(fixture), `Fixture users ${label}`)
    }
    cleanup.push(fixture)
    accounts.push({ label, sb, company: session.company, fixture, setup })
  }

  for (const attacker of accounts) {
    const target = accounts.find(account => account.label !== attacker.label)
    const crossRead = checked(await attacker.sb.from('users').select('id')
      .eq('company_id', target.company.id).eq('id', target.fixture.id), `Cross SELECT ${attacker.label}`)
    if (crossRead.length) failures.push(`${attacker.label}: SELECT`)

    const attempted = rowFor(target.company.id, `CROSS_${attacker.label}`)
    cleanup.push(attempted)
    const crossInsert = await attacker.sb.from('users').insert(attempted).select('id')
    if (!crossInsert.error && crossInsert.data?.length) failures.push(`${attacker.label}: INSERT`)

    const crossUpdate = await attacker.sb.from('users').update({ name: `CROSS_${nonce}` })
      .eq('company_id', target.company.id).eq('id', target.fixture.id).select('id')
    if (!crossUpdate.error && crossUpdate.data?.length) failures.push(`${attacker.label}: UPDATE`)

    const crossDelete = await attacker.sb.from('users').delete()
      .eq('company_id', target.company.id).eq('id', target.fixture.id).select('id')
    if (!crossDelete.error && crossDelete.data?.length) failures.push(`${attacker.label}: DELETE`)

    const ownerRow = checked(await target.sb.from('users').select('id,name')
      .eq('company_id', target.company.id).eq('id', target.fixture.id).maybeSingle(),
      `Owner fixture ${target.label}`)
    if (!ownerRow || ownerRow.name !== target.fixture.name) failures.push(`${attacker.label}: target fixture changed`)
  }
  assert.deepEqual(failures, [])
  console.log(JSON.stringify({ table: 'users', status: 'pass', directions: ['A -> B', 'B -> A'],
    operations: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    setup: accounts.map(({ label, setup }) => ({ label, setup })) }, null, 2))
} finally {
  for (const row of cleanup) {
    const result = await service.from('users').delete().eq('id', row.id).eq('company_id', row.company_id)
    if (result.error) console.error(`Không dọn được fixture ${row.id}: ${result.error.code || result.status}`)
  }
  await Promise.all(accounts.map(account => account.sb.auth.signOut()))
}
