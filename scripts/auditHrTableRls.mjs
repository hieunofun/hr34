import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { loadCompanySession } from '../src/services/companySession.js'

const root = resolve(import.meta.dirname, '..')
const env = path => Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/)
  .map(line => /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/.exec(line)).filter(Boolean)
  .map(([, key, value]) => [key, value.trim().replace(/^["']|["']$/g, '')]))
const app = env(resolve(root, '.env.local'))
const test = env(resolve(root, '.env.readiness.local'))
const nonce = randomBytes(5).toString('hex')
const client = () => createClient(app.VITE_SUPABASE_URL, app.VITE_SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } })
const data = (response, operation) => {
  if (response.error) throw new Error(`${operation}: ${response.error.code || response.status} ${response.error.message}`)
  return response.data
}
const accounts = await Promise.all(['A', 'B'].map(async label => {
  const sb = client()
  const user = data(await sb.auth.signInWithPassword({
    email: test[`READINESS_${label}_EMAIL`], password: test[`READINESS_${label}_PASSWORD`]
  }), `Auth ${label}`).user
  const { profile, company } = await loadCompanySession(sb, user)
  assert.equal(profile.company_id, test[`READINESS_${label}_COMPANY_ID`])
  assert.ok(company.name.startsWith('READINESS TEST '))
  return { label, sb, profile, company }
}))

const fixtures = new Map()
const failures = []
const report = { tables: {} }
const checkCross = async (table, ownerRows, newRow) => {
  const tableFailures = []
  const markerField = table === 'nhan_su' ? 'ho_ten' : 'notes'
  for (const attacker of accounts) {
    const target = accounts.find(account => account.label !== attacker.label)
    const targetRow = ownerRows.get(target.label)
    const crossRead = await attacker.sb.from(table).select('id')
      .eq('company_id', target.company.id).eq('id', targetRow.id)
    if (!crossRead.error && crossRead.data?.length) tableFailures.push(`${attacker.label}: SELECT`)

    const crossInsert = await attacker.sb.from(table).insert(newRow(target)).select('id')
    if (!crossInsert.error && crossInsert.data?.length) {
      tableFailures.push(`${attacker.label}: INSERT`)
      fixtures.set(`${table}-cross-${attacker.label}`, { owner: target, table, id: crossInsert.data[0].id })
    }

    const crossUpdate = await attacker.sb.from(table).update({ [markerField]: `cross-${nonce}` })
      .eq('company_id', target.company.id).eq('id', targetRow.id).select('id')
    if (!crossUpdate.error && crossUpdate.data?.length) tableFailures.push(`${attacker.label}: UPDATE`)

    const crossDelete = await attacker.sb.from(table).delete()
      .eq('company_id', target.company.id).eq('id', targetRow.id).select('id')
    if (!crossDelete.error && crossDelete.data?.length) tableFailures.push(`${attacker.label}: DELETE`)

    const unchanged = data(await target.sb.from(table).select(`id,${markerField}`)
      .eq('company_id', target.company.id).eq('id', targetRow.id).maybeSingle(), `Kiểm tra ${table} ${target.label}`)
    if (!unchanged || unchanged[markerField] === `cross-${nonce}`) tableFailures.push(`${attacker.label}: fixture bị thay đổi`)
  }
  report.tables[table] = tableFailures.length ? { status: 'fail', failures: tableFailures } : {
    status: 'pass', operations: ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
  }
  failures.push(...tableFailures.map(failure => `${table} ${failure}`))
}

try {
  const people = new Map()
  for (const account of accounts) {
    const row = data(await account.sb.from('nhan_su').insert({
      company_id: account.company.id,
      ma_nhan_vien: `READINESS_${account.label}_${nonce}`,
      ho_ten: `Readiness ${account.label}`,
      ca_lam: 'Ca Hành chính'
    }).select('id').single(), `Tạo nhan_su ${account.label}`)
    people.set(account.label, row)
    fixtures.set(`nhan_su-${account.label}`, { owner: account, table: 'nhan_su', id: row.id })
  }
  await checkCross('nhan_su', people, target => ({
    company_id: target.company.id, ma_nhan_vien: `CROSS_${target.label}_${nonce}`,
    ho_ten: 'Cross readiness', ca_lam: 'Ca Hành chính'
  }))

  const attendance = new Map()
  for (const account of accounts) {
    const row = data(await account.sb.from('cham_cong').insert({
      company_id: account.company.id, nhan_su_id: people.get(account.label).id,
      ngay: '2099-01-01', gio_vao: '07:00', gio_ra: '16:30',
      tong_cong: 0, notes: `owner-${nonce}`
    }).select('id').single(), `Tạo cham_cong ${account.label}`)
    attendance.set(account.label, row)
    fixtures.set(`cham_cong-${account.label}`, { owner: account, table: 'cham_cong', id: row.id })
  }
  await checkCross('cham_cong', attendance, target => ({
    company_id: target.company.id, nhan_su_id: people.get(target.label).id,
    ngay: '2099-01-02', gio_vao: '07:00', gio_ra: '16:30',
    tong_cong: 0, notes: `cross-${nonce}`
  }))
} catch (error) {
  report.error = error.message
  process.exitCode = 1
} finally {
  for (const table of ['cham_cong', 'nhan_su']) {
    for (const fixture of fixtures.values()) {
      if (fixture.table !== table) continue
      const cleanup = await fixture.owner.sb.from(table).delete()
        .eq('company_id', fixture.owner.company.id).eq('id', fixture.id)
      if (cleanup.error) {
        report.cleanupError = `${table}: ${cleanup.error.code || cleanup.status}`
        process.exitCode = 1
      }
    }
  }
  await Promise.all(accounts.map(account => account.sb.auth.signOut()))
}
if (failures.length) process.exitCode = 1
console.log(JSON.stringify(report, null, 2))
