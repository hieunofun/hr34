import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import handler from '../api/employee-account.js'
import { loadCompanySession } from '../src/services/companySession.js'

const parseEnv = path => Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/)
  .map(line => /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/.exec(line)).filter(Boolean)
  .map(([, key, value]) => [key, value.trim().replace(/^["']|["']$/g, '')]))
const root = resolve(import.meta.dirname, '..')
const app = parseEnv(resolve(root, '.env.local'))
const adminEnv = parseEnv(resolve(root, '../HR-System-Admin/.env.local'))
const readiness = parseEnv(resolve(root, '.env.readiness.local'))
const accountsPath = resolve(root, '.env.employee-readiness.local')
const credentials = existsSync(accountsPath) ? parseEnv(accountsPath) : {}
process.env.SUPABASE_URL = adminEnv.SUPABASE_URL
process.env.SUPABASE_SERVICE_ROLE_KEY = adminEnv.SUPABASE_SERVICE_ROLE_KEY
const service = createClient(app.VITE_SUPABASE_URL, adminEnv.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } })
const anon = () => createClient(app.VITE_SUPABASE_URL, app.VITE_SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } })
const check = (result, label) => {
  if (result.error) throw new Error(`${label}: ${result.error.code || ''} ${result.error.message}`)
  return result.data
}
const invokeApi = async (token, body) => {
  const response = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; return this },
    status(value) { this.statusCode = value; return this }, json(value) { this.body = value; return this } }
  await handler({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body }, response)
  return response
}
const testSessions = []
for (const label of ['A', 'B']) {
  const admin = anon()
  const login = check(await admin.auth.signInWithPassword({
    email: readiness[`READINESS_${label}_EMAIL`],
    password: readiness[`READINESS_${label}_PASSWORD`]
  }), `Admin ${label} login`)
  const { profile: adminProfile, company } = await loadCompanySession(admin, login.user)
  assert.equal(adminProfile.role, 'admin')
  assert.equal(company.id, readiness[`READINESS_${label}_COMPANY_ID`])
  assert.ok(company.name.startsWith('READINESS TEST '), 'Chỉ tạo dữ liệu trong công ty test riêng')
  const employees = []
  for (const index of [1, 2]) {
    const prefix = `EMPLOYEE_${label}${index}`
    let email = credentials[`${prefix}_EMAIL`]
    let password = credentials[`${prefix}_PASSWORD`]
    let profileId = credentials[`${prefix}_PROFILE_ID`]
    if (!profileId) {
      email = `readiness.employee.${randomBytes(8).toString('hex')}@example.test`
      password = randomBytes(18).toString('base64url')
      profileId = randomUUID()
      const code = `READINESS-${label}${index}-${randomBytes(4).toString('hex')}`
      const name = `READINESS EMPLOYEE ${label}${index}`
      check(await service.from('users').insert({ id: profileId, company_id: company.id,
        name, employee_id: code, username: code, role: 'user', email, password: null }), `Tạo hồ sơ ${prefix}`)
      check(await service.from('nhan_su').insert({ company_id: company.id,
        ma_nhan_vien: code, ho_ten: name, email, ca_lam: 'Ca Hành chính' }), `Tạo nhân sự ${prefix}`)
      credentials[`${prefix}_EMAIL`] = email
      credentials[`${prefix}_PASSWORD`] = password
      credentials[`${prefix}_PROFILE_ID`] = profileId
      writeFileSync(accountsPath, Object.entries(credentials).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 })
    }
    const existing = check(await service.from('users').select('id,auth_user_id,company_id,role')
      .eq('id', profileId).eq('company_id', company.id).single(), `Hồ sơ ${prefix}`)
    if (!existing.auth_user_id) {
      const response = await invokeApi(login.session.access_token, { profileId, email, password })
      assert.equal(response.statusCode, 201, `API cấp tài khoản ${prefix}: ${JSON.stringify(response.body)}`)
      assert.equal(response.body.account.companyId, company.id)
      assert.equal(response.body.account.role, 'user')
    }
    const client = anon()
    const employeeLogin = check(await client.auth.signInWithPassword({ email, password }), `Employee ${prefix} login`)
    const session = await loadCompanySession(client, employeeLogin.user)
    assert.equal(session.profile.id, profileId)
    assert.equal(session.company.id, company.id)
    assert.equal(session.profile.role, 'user')
    assert.equal(Object.hasOwn(session.profile, 'password'), false)
    const savedProfile = check(await service.from('users').select('password')
      .eq('id', profileId).single(), `Mật khẩu hồ sơ ${prefix}`)
    assert.equal(savedProfile.password, null)
    employees.push({ index, profileId, email, client, session })
  }
  const logIds = []
  for (const employee of employees) {
    const id = `${company.id}::attendanceLogs::readiness_employee_${label}${employee.index}`
    const existing = check(await admin.from('hr_records').select('id').eq('id', id).maybeSingle(), 'Test log')
    if (!existing) check(await admin.from('hr_records').insert({ id, company_id: company.id,
      collection: 'attendanceLogs', data: { employeeId: employee.profileId,
        date: '2026-09-27', checkIn: '07:00', checkOut: '17:00', testRecord: true } }), 'Tạo test log')
    logIds.push(id)
  }
  for (const employee of employees) {
    const other = employees.find(item => item !== employee)
    const ownUser = check(await employee.client.from('users').select('id').eq('id', employee.profileId), 'Xem hồ sơ mình')
    assert.equal(ownUser.length, 1)
    const otherUser = check(await employee.client.from('users').select('id').eq('id', other.profileId), 'Xem hồ sơ người khác')
    assert.equal(otherUser.length, 0)
    const ownStaff = check(await employee.client.from('nhan_su').select('id')
      .eq('company_id', company.id).eq('ma_nhan_vien', employee.session.profile.employee_id), 'Xem nhân sự mình')
    assert.ok(ownStaff.length <= 1)
    const otherStaff = check(await employee.client.from('nhan_su').select('id')
      .eq('company_id', company.id).eq('ma_nhan_vien', other.session.profile.employee_id), 'Xem nhân sự người khác')
    assert.equal(otherStaff.length, 0)
    const ownLog = check(await employee.client.from('hr_records').select('id').eq('id', logIds[employee.index - 1]), 'Xem công mình')
    assert.equal(ownLog.length, 1)
    const otherLog = check(await employee.client.from('hr_records').select('id').eq('id', logIds[other.index - 1]), 'Xem công người khác')
    assert.equal(otherLog.length, 0)
    const update = await employee.client.from('users').update({ name: 'ILLEGAL UPDATE' })
      .eq('id', other.profileId).select('id')
    assert.ok(update.error || update.data.length === 0)
    const logUpdate = await employee.client.from('hr_records').update({ data: { hacked: true } })
      .eq('id', logIds[other.index - 1]).select('id')
    assert.ok(logUpdate.error || logUpdate.data.length === 0)
    const logDelete = await employee.client.from('hr_records').delete().eq('id', logIds[other.index - 1]).select('id')
    assert.ok(logDelete.error || logDelete.data.length === 0)
    const logInsert = await employee.client.from('hr_records').insert({
      id: `${company.id}::attendanceLogs::denied_${randomUUID()}`, company_id: company.id,
      collection: 'attendanceLogs', data: { employeeId: other.profileId }
    })
    assert.ok(logInsert.error)
    const settingsUpdate = await employee.client.from('hr_records').update({ data: { hacked: true } })
      .eq('company_id', company.id).eq('collection', 'attendanceSettings').select('id')
    assert.ok(settingsUpdate.error || settingsUpdate.data.length === 0)
  }
  const adminUsers = check(await admin.from('users').select('id').in('id', employees.map(item => item.profileId)), 'Admin xem nhân viên')
  assert.equal(adminUsers.length, 2)
  const adminLogs = check(await admin.from('hr_records').select('id').in('id', logIds), 'Admin xem bảng công')
  assert.equal(adminLogs.length, 2)
  for (const employee of employees) {
    const sameName = employee.session.profile.name
    const update = check(await admin.from('users').update({ name: sameName })
      .eq('id', employee.profileId).eq('company_id', company.id).select('id'), 'Admin cập nhật hồ sơ test')
    assert.equal(update.length, 1)
  }
  console.log(JSON.stringify({ testCompany: label, employeeAuth: 'pass', selfData: 'pass',
    sameCompanyIsolation: 'pass', settingsWriteDenied: 'pass', adminManagement: 'pass' }))
  testSessions.push({ label, company, employees, admin })
}
for (const session of testSessions) {
  for (const employee of session.employees) {
    const otherCompany = testSessions.find(item => item !== session).company.id
    const cross = check(await employee.client.from('users').select('id').eq('company_id', otherCompany), 'Cross company users')
    assert.equal(cross.length, 0)
    const settings = check(await employee.client.from('hr_records').select('id').eq('company_id', otherCompany)
      .eq('collection', 'attendanceSettings'), 'Cross company settings')
    assert.equal(settings.length, 0)
    const mismatch = check(await employee.client.from('companies').select('id').eq('id', otherCompany), 'URL company mismatch')
    assert.equal(mismatch.length, 0)
    const otherLogId = `${otherCompany}::attendanceLogs::readiness_employee_${session.label === 'A' ? 'B' : 'A'}1`
    const crossInsert = await employee.client.from('hr_records').insert({
      id: `${otherCompany}::attendanceLogs::denied_${randomUUID()}`,
      company_id: otherCompany, collection: 'attendanceLogs',
      data: { employeeId: employee.profileId }
    })
    assert.ok(crossInsert.error)
    const crossUpdate = await employee.client.from('hr_records').update({ data: { hacked: true } })
      .eq('id', otherLogId).select('id')
    assert.ok(crossUpdate.error || crossUpdate.data.length === 0)
    const crossDelete = await employee.client.from('hr_records').delete().eq('id', otherLogId).select('id')
    assert.ok(crossDelete.error || crossDelete.data.length === 0)
  }
}
const adminA = check(await testSessions[0].admin.auth.getSession(), 'Admin A session').session
const employeeA = check(await testSessions[0].employees[0].client.auth.getSession(), 'Employee A session').session
const otherProfileId = testSessions[1].employees[0].profileId
const deniedCompanyField = await invokeApi(adminA.access_token, {
  profileId: otherProfileId, email: 'invalid@example.test', password: 'examplepassword',
  companyId: testSessions[1].company.id
})
assert.equal(deniedCompanyField.statusCode, 400)
const deniedCrossProfile = await invokeApi(adminA.access_token, {
  profileId: otherProfileId, email: 'invalid@example.test', password: 'examplepassword'
})
assert.equal(deniedCrossProfile.statusCode, 409)
const deniedEmployee = await invokeApi(employeeA.access_token, {
  profileId: otherProfileId, email: 'invalid@example.test', password: 'examplepassword'
})
assert.equal(deniedEmployee.statusCode, 403)
console.log('Account API tenant mismatch and employee-admin escalation: blocked.')
console.log('Cross-company employee RLS: pass; all test data remains in READINESS TEST companies.')
