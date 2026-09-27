import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { loadCompanySession } from '../src/services/companySession.js'
import { calculateAttendanceMetrics } from '../src/utils/attendanceCalculations.js'
import { buildAttendanceShiftSettingsPayload } from '../src/utils/attendanceShift.js'

const root = resolve(import.meta.dirname, '..')
const readEnv = path => Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/)
  .map(line => /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/.exec(line))
  .filter(Boolean)
  .map(([, key, value]) => [key, value.trim().replace(/^["']|["']$/g, '')]))
const appEnv = readEnv(resolve(root, '.env.local'))
const testEnv = readEnv(resolve(root, '.env.readiness.local'))
const url = appEnv.VITE_SUPABASE_URL
const anonKey = appEnv.VITE_SUPABASE_ANON_KEY
if (!url || !anonKey) throw new Error('Thiếu cấu hình anon Supabase của ứng dụng HR.')

const clientFor = () => createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false }
})
const expectData = (result, label) => {
  if (result.error) throw new Error(`${label}: ${result.error.code || result.status} ${result.error.message}`)
  return result.data
}
const records = async (client, companyId) => expectData(await client.from('hr_records')
  .select('id,company_id,collection,data').eq('company_id', companyId).eq('collection', 'readinessProbe'), 'readinessProbe')

const accounts = await Promise.all(['A', 'B'].map(async label => {
  const expectedCompanyId = testEnv[`READINESS_${label}_COMPANY_ID`]
  const email = testEnv[`READINESS_${label}_EMAIL`]
  const password = testEnv[`READINESS_${label}_PASSWORD`]
  if (!expectedCompanyId || !email || !password) throw new Error(`Thiếu tài khoản test ${label}.`)
  const client = clientFor()
  const login = await client.auth.signInWithPassword({ email, password })
  const user = expectData(login, `Auth ${label}`)?.user
  if (!user?.id) throw new Error(`Auth ${label} không trả về user.`)
  const { profile, company } = await loadCompanySession(client, user)
  assert.equal(profile.auth_user_id, user.id)
  assert.equal(profile.company_id, expectedCompanyId)
  assert.equal(company.id, expectedCompanyId)
  assert.ok(company.name.startsWith('READINESS TEST '), 'Chỉ chạy trên công ty test riêng')
  return { label, client, user, profile, company }
}))
assert.notEqual(accounts[0].company.id, accounts[1].company.id)
const result = { authAndCompany: 'pass', companies: accounts.map(({ label, company }) => ({ label, companyId: company.id })) }

const run = async () => {
  const workMinutes = { A: 450, B: 480 }
  const monthlyUnits = { A: 22, B: 26 }
  for (const account of accounts) {
    const companyId = account.company.id
    const id = `${companyId}::attendanceSettings::default`
    const existing = expectData(await account.client.from('hr_records').select('id')
      .eq('id', id).eq('company_id', companyId).maybeSingle(), `Settings ${account.label}`)
    if (existing) continue
    const policy = buildAttendanceShiftSettingsPayload({
      workStart: '07:00', lunchStart: '11:00', lunchEnd: '13:00', workEnd: '17:00',
      standardWorkMinutes: workMinutes[account.label],
      monthlyStandardWorkUnits: monthlyUnits[account.label]
    })
    expectData(await account.client.from('hr_records').insert({
      id, company_id: companyId, collection: 'attendanceSettings', data: policy,
      updated_at: new Date().toISOString()
    }), `Lưu settings ${account.label}`)
  }

  result.settings = []
  for (const account of accounts) {
    const ownId = `${account.company.id}::attendanceSettings::default`
    const row = expectData(await account.client.from('hr_records').select('id,company_id,data')
      .eq('id', ownId).eq('company_id', account.company.id).single(), `Đọc settings ${account.label}`)
    assert.equal(row.company_id, account.company.id)
    assert.equal(row.data.standardWorkMinutes, workMinutes[account.label])
    assert.equal(row.data.monthlyStandardWorkUnits, monthlyUnits[account.label])
    const metrics = calculateAttendanceMetrics({
      log: { checkIn: '07:00', checkOut: '16:30' }, attendanceSettings: row.data
    })
    result.settings.push({ label: account.label, standardWorkMinutes: row.data.standardWorkMinutes,
      monthlyStandardWorkUnits: row.data.monthlyStandardWorkUnits, workUnit: metrics.regularWorkdays })
  }
  assert.equal(result.settings[0].workUnit, 1)
  assert.equal(result.settings[1].workUnit, 0.9375)

  const nonce = randomBytes(5).toString('hex')
  const probes = accounts.map(account => ({ ...account,
    probeId: `${account.company.id}::readinessProbe::${nonce}`, marker: `owner-${account.label}-${nonce}` }))
  const failures = []
  try {
    for (const owner of probes) {
      expectData(await owner.client.from('hr_records').insert({
        id: owner.probeId, company_id: owner.company.id,
        collection: 'readinessProbe', data: { marker: owner.marker },
        updated_at: new Date().toISOString()
      }), `Tạo HR probe ${owner.label}`)
      const own = await records(owner.client, owner.company.id)
      assert.ok(own.some(row => row.id === owner.probeId && row.data.marker === owner.marker))
    }

    for (const attacker of probes) {
      const target = probes.find(account => account.label !== attacker.label)
      const attemptedId = `${target.company.id}::readinessProbe::cross-${attacker.label}-${nonce}`
      const crossRead = await attacker.client.from('hr_records').select('id')
        .eq('company_id', target.company.id).eq('collection', 'readinessProbe')
      if (!crossRead.error && crossRead.data?.length) failures.push(`${attacker.label}: SELECT cross-company thấy dữ liệu`)
      const crossUsers = await attacker.client.from('users').select('id')
        .eq('company_id', target.company.id).eq('auth_user_id', target.user.id)
      if (!crossUsers.error && crossUsers.data?.length) failures.push(`${attacker.label}: SELECT users cross-company thấy hồ sơ`)
      const crossCompany = await attacker.client.from('companies').select('id')
        .eq('id', target.company.id)
      if (!crossCompany.error && crossCompany.data?.length) failures.push(`${attacker.label}: SELECT companies cross-company thấy công ty`)

      const crossInsert = await attacker.client.from('hr_records').insert({
        id: attemptedId, company_id: target.company.id,
        collection: 'readinessProbe', data: { marker: 'cross-insert' },
        updated_at: new Date().toISOString()
      }).select('id')
      if (!crossInsert.error && crossInsert.data?.length) failures.push(`${attacker.label}: INSERT cross-company thành công`)

      const crossUpdate = await attacker.client.from('hr_records')
        .update({ data: { marker: 'cross-update' } })
        .eq('id', target.probeId).eq('company_id', target.company.id).select('id')
      if (!crossUpdate.error && crossUpdate.data?.length) failures.push(`${attacker.label}: UPDATE cross-company thành công`)

      const crossDelete = await attacker.client.from('hr_records')
        .delete().eq('id', target.probeId).eq('company_id', target.company.id).select('id')
      if (!crossDelete.error && crossDelete.data?.length) failures.push(`${attacker.label}: DELETE cross-company thành công`)

      const ownerRow = expectData(await target.client.from('hr_records').select('id,data')
        .eq('id', target.probeId).eq('company_id', target.company.id).maybeSingle(), `Kiểm tra HR probe ${target.label}`)
      if (!ownerRow || ownerRow.data.marker !== target.marker) failures.push(`${attacker.label}: HR probe công ty khác đã thay đổi`)
      const inserted = expectData(await target.client.from('hr_records').select('id')
        .eq('id', attemptedId).eq('company_id', target.company.id).maybeSingle(), `Kiểm tra cross insert ${attacker.label}`)
      if (inserted) {
        failures.push(`${attacker.label}: bản ghi cross insert tồn tại`)
        expectData(await target.client.from('hr_records').delete()
          .eq('id', attemptedId).eq('company_id', target.company.id), `Dọn cross insert ${attacker.label}`)
      }
    }
  } finally {
    for (const owner of probes) {
      const cleanup = await owner.client.from('hr_records').delete()
        .eq('id', owner.probeId).eq('company_id', owner.company.id)
      if (cleanup.error) failures.push(`${owner.label}: không dọn được probe test`)
    }
  }
  result.rls = failures.length ? { status: 'fail', failures } : {
    status: 'pass',
    selectTables: ['hr_records', 'users', 'companies'],
    writeTable: 'hr_records',
    operations: ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
  }
  if (failures.length) throw new Error(failures.join('; '))
}

try {
  await run()
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(JSON.stringify({ ...result, error: error.message }, null, 2))
  process.exitCode = 1
} finally {
  await Promise.all(accounts.map(account => account.client.auth.signOut()))
}
