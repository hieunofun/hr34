// One-time, test-only provisioning through the System Admin backend function.
// Credentials stay in an ignored local file. This does not call the HTTP admin route.
import assert from 'node:assert/strict'
import { randomBytes, randomInt } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import adminHandler, { companiesWithCounts, createCompany, updateCompany } from '../../HR-System-Admin/api/admin.js'
import { companyIdFromNumber } from '../../HR-System-Admin/server/core.js'
import { loadCompanySession } from '../src/services/companySession.js'
import { normalizeAttendancePolicy } from '../src/utils/attendanceShift.js'
import { companyDisplayName, companyLogoSource, GENERIC_HR_LOGO } from '../src/utils/companyBrand.js'

const root = resolve(import.meta.dirname, '..')
const credentialsPath = resolve(root, '.env.company-c-readiness.local')
const readEnv = path => Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/)
  .map(line => /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/.exec(line))
  .filter(Boolean)
  .map(([, key, value]) => [key, value.trim().replace(/^["']|["']$/g, '')]))
const hrEnv = readEnv(resolve(root, '.env.local'))
const adminEnv = readEnv(resolve(root, '../HR-System-Admin/.env.local'))
assert.equal(hrEnv.VITE_SUPABASE_URL, adminEnv.SUPABASE_URL, 'Hai ứng dụng phải dùng cùng Supabase project')
assert.ok(hrEnv.VITE_SUPABASE_ANON_KEY && adminEnv.SUPABASE_SERVICE_ROLE_KEY)

const admin = createClient(adminEnv.SUPABASE_URL, adminEnv.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } })
const hr = createClient(hrEnv.VITE_SUPABASE_URL, hrEnv.VITE_SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } })
const checked = (result, label) => {
  if (result.error) throw new Error(`${label}: ${result.error.code || result.status} ${result.error.message}`)
  return result.data
}

async function uploadTestLogo() {
  const cloud = adminEnv.VITE_CLOUDINARY_CLOUD_NAME
  const preset = adminEnv.VITE_CLOUDINARY_UPLOAD_PRESET
  if (!cloud || !preset) return { url: null, status: 'not_configured' }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/m3sAAAAASUVORK5CYII=', 'base64')
  const form = new FormData()
  form.append('file', new Blob([png], { type: 'image/png' }), 'readiness-company-c.png')
  form.append('upload_preset', preset)
  try {
    const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/image/upload`, {
      method: 'POST', body: form
    })
    const body = await response.json()
    if (!response.ok || !body.secure_url) return { url: null, status: `upload_failed_${response.status}` }
    return { url: body.secure_url, status: 'uploaded' }
  } catch (error) {
    return { url: null, status: `network_error_${error.name}` }
  }
}

let testCompany
let logoStatus = 'existing'
if (existsSync(credentialsPath)) {
  const previous = readEnv(credentialsPath)
  testCompany = {
    companyId: previous.READINESS_C_COMPANY_ID,
    email: previous.READINESS_C_EMAIL,
    password: previous.READINESS_C_PASSWORD
  }
  assert.ok(testCompany.companyId && testCompany.email && testCompany.password)
} else {
  let shortId
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = String(randomInt(900_000_000_000, 999_999_999_999))
    const existing = checked(await admin.from('companies').select('id')
      .eq('id', companyIdFromNumber(candidate)).maybeSingle(), 'Kiểm tra mã công ty test')
    if (!existing) { shortId = candidate; break }
  }
  assert.ok(shortId, 'Không tìm được mã công ty test trống')
  const nonce = randomBytes(6).toString('hex')
  const email = `hr-readiness-c-${nonce}@example.test`
  const password = randomBytes(30).toString('base64url')
  const logo = await uploadTestLogo()
  logoStatus = logo.status
  const created = await createCompany(admin, {
    shortId, name: `READINESS TEST C ${nonce}`, adminName: `Readiness Admin C ${nonce}`,
    email, password, username: `readiness_c_${nonce}`, logoUrl: logo.url
  })
  testCompany = { companyId: created.id, email, password }
  writeFileSync(credentialsPath, [
    `READINESS_C_COMPANY_ID=${created.id}`,
    `READINESS_C_EMAIL=${email}`,
    `READINESS_C_PASSWORD=${password}`
  ].join('\n') + '\n', { flag: 'wx', mode: 0o600 })
}

try {
  const auth = checked(await hr.auth.signInWithPassword({
    email: testCompany.email, password: testCompany.password
  }), 'Đăng nhập HR chung')
  const session = await loadCompanySession(hr, auth.user)
  assert.equal(session.profile.auth_user_id, auth.user.id)
  assert.equal(session.profile.company_id, testCompany.companyId)
  assert.equal(session.company.id, testCompany.companyId)
  assert.ok(session.company.name.startsWith('READINESS TEST C '))
  if (session.company.logo_url) {
    const image = await fetch(session.company.logo_url, { method: 'HEAD' })
    assert.equal(image.status, 200, 'Logo Cloudinary phải tải công khai được')
    assert.match(image.headers.get('content-type') || '', /^image\//)
  }
  const adminCompanies = await companiesWithCounts(admin)
  const adminCompany = adminCompanies.find(company => company.id === testCompany.companyId)
  assert.ok(adminCompany)
  assert.equal(adminCompany.accountCount, 1)
  assert.equal(adminCompany.profileCount, 1)
  assert.equal(adminCompany.logo_url, session.company.logo_url)
  const updated = await updateCompany(admin, {
    companyId: testCompany.companyId,
    name: session.company.name,
    logoUrl: session.company.logo_url
  })
  assert.equal(updated.logo_url, session.company.logo_url)
  let adminResponse = 'not_configured: SYSTEM_ADMIN_AUTH_IDS is empty'
  if (adminEnv.SYSTEM_ADMIN_AUTH_IDS?.trim()) {
    const previousServerEnv = {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      SYSTEM_ADMIN_AUTH_IDS: process.env.SYSTEM_ADMIN_AUTH_IDS
    }
    Object.assign(process.env, {
      SUPABASE_URL: adminEnv.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: adminEnv.SUPABASE_SERVICE_ROLE_KEY,
      SYSTEM_ADMIN_AUTH_IDS: adminEnv.SYSTEM_ADMIN_AUTH_IDS
    })
    try {
      const response = { statusCode: 200, setHeader() {}, end(body) { this.body = body } }
      await adminHandler({ method: 'GET', url: '/api/admin?resource=bootstrap',
        headers: { authorization: `Bearer ${auth.session.access_token}` } }, response)
      adminResponse = response.statusCode
      assert.equal(adminResponse, 403, 'Admin công ty C không được quyền System Admin')
    } finally {
      for (const [key, value] of Object.entries(previousServerEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }
  const settingsId = `${testCompany.companyId}::attendanceSettings::default`
  const settings = checked(await hr.from('hr_records').select('id,company_id,collection,data')
    .eq('id', settingsId).eq('company_id', testCompany.companyId).single(), 'Đọc attendanceSettings C')
  assert.equal(settings.collection, 'attendanceSettings')
  assert.equal(settings.company_id, testCompany.companyId)
  const policy = normalizeAttendancePolicy(settings.data)
  assert.equal(policy.standardWorkMinutes, 480)
  assert.equal(policy.monthlyStandardWorkUnits, 26)
  assert.ok(policy.shifts.administrative)
  assert.ok(policy.shiftDefinitions.administrative)
  const [people, punches, records] = await Promise.all([
    hr.from('nhan_su').select('company_id').eq('company_id', testCompany.companyId).limit(1),
    hr.from('cham_cong').select('company_id').eq('company_id', testCompany.companyId).limit(1),
    hr.from('hr_records').select('id,company_id').eq('company_id', testCompany.companyId).limit(10)
  ])
  checked(people, 'Đọc nhân sự C')
  checked(punches, 'Đọc chấm công C')
  checked(records, 'Đọc HR records C')
  assert.ok(records.data.every(row => row.company_id === testCompany.companyId))
  const otherCompanies = checked(await hr.from('companies').select('id')
    .neq('id', testCompany.companyId).limit(10), 'Đọc công ty khác bằng C')
  assert.equal(otherCompanies.length, 0, 'C không được thấy company khác')
  const otherUsers = checked(await hr.from('users').select('id')
    .neq('company_id', testCompany.companyId).limit(10), 'Đọc users công ty khác bằng C')
  const otherHrRecords = checked(await hr.from('hr_records').select('id')
    .neq('company_id', testCompany.companyId).limit(10), 'Đọc HR records công ty khác bằng C')
  assert.equal(otherUsers.length, 0, 'C không được thấy users công ty khác')
  assert.equal(otherHrRecords.length, 0, 'C không được thấy HR records công ty khác')
  const earlierTestEnv = readEnv(resolve(root, '.env.readiness.local'))
  const anotherHr = createClient(hrEnv.VITE_SUPABASE_URL, hrEnv.VITE_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } })
  let otherBrand
  try {
    const otherAuth = checked(await anotherHr.auth.signInWithPassword({
      email: earlierTestEnv.READINESS_A_EMAIL, password: earlierTestEnv.READINESS_A_PASSWORD
    }), 'Đăng nhập công ty test A trên HR chung')
    const otherSession = await loadCompanySession(anotherHr, otherAuth.user)
    assert.equal(otherSession.company.id, earlierTestEnv.READINESS_A_COMPANY_ID)
    assert.notEqual(otherSession.company.id, session.company.id)
    assert.notEqual(companyDisplayName(otherSession.company.name), companyDisplayName(session.company.name))
    assert.equal(companyLogoSource(otherSession.company.logo_url), GENERIC_HR_LOGO)
    assert.notEqual(companyLogoSource(session.company.logo_url), GENERIC_HR_LOGO)
    otherBrand = { companyId: otherSession.company.id,
      companyName: companyDisplayName(otherSession.company.name), logo: 'generic fallback' }
  } finally {
    await anotherHr.auth.signOut()
  }
  console.log(JSON.stringify({
    status: 'pass', companyId: testCompany.companyId,
    companyName: session.company.name, companyCode: session.company.code,
    logoStatus, logoStored: Boolean(session.company.logo_url),
    systemAdmin: { companyListed: true, accountCount: adminCompany.accountCount,
      logoUpdate: 'pass', companyCAdminApiStatus: adminResponse },
    branding: { companyA: otherBrand,
      companyC: { companyId: session.company.id,
        companyName: companyDisplayName(session.company.name), logo: 'Cloudinary URL' } },
    settings: { standardWorkMinutes: policy.standardWorkMinutes,
      monthlyStandardWorkUnits: policy.monthlyStandardWorkUnits,
      shiftIds: Object.keys(policy.shifts) },
    hr: { peopleVisible: people.data.length, punchesVisible: punches.data.length,
      recordsVisible: records.data.length, otherCompaniesVisible: otherCompanies.length,
      otherUsersVisible: otherUsers.length, otherHrRecordsVisible: otherHrRecords.length }
  }, null, 2))
} finally {
  await hr.auth.signOut()
}
