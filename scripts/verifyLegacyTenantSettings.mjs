import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { loadCompanySession } from '../src/services/companySession.js'
import { normalizeAttendancePolicy, resolveAttendanceShift } from '../src/utils/attendanceShift.js'
import { calculateAttendanceMetrics } from '../src/utils/attendanceCalculations.js'
import { summarizeAttendanceDay } from '../src/utils/attendanceSummary.js'
import { normalizeAttendanceShiftSettings as old22Settings } from '../../HR-Company-22/src/utils/attendanceShift.js'
import { normalizeAttendanceShiftSettings as old23Settings } from '../../HR-Company-23/src/utils/attendanceShift.js'
import { normalizeAttendanceShiftSettings as old31Settings } from '../../HR-Company-31/src/utils/attendanceShift.js'
import { calculateAttendanceMetrics as old22Metrics } from '../../HR-Company-22/src/utils/attendanceCalculations.js'

const parseEnv = path => Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/)
  .map(line => /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/.exec(line)).filter(Boolean)
  .map(([, key, value]) => [key, value.trim().replace(/^["']|["']$/g, '')]))
const root = resolve(import.meta.dirname, '..')
const app = parseEnv(resolve(root, '.env.local'))
const accounts = parseEnv(resolve(root, '../HR-System-Admin/.env.company-admins.local'))
const idOf = number => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`
const expected = {
  22: ['08:30', '12:00', '13:00', '17:30', 'proportional'],
  23: ['08:30', '12:00', '13:00', '17:30', 'proportional'],
  31: ['07:00', '11:00', '13:00', '17:00', 'split_shift']
}
for (const number of [22, 23, 31]) {
  const client = createClient(app.VITE_SUPABASE_URL, app.VITE_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } })
  const login = await client.auth.signInWithPassword({
    email: accounts[`COMPANY_ADMIN_${number}_EMAIL`],
    password: accounts[`COMPANY_ADMIN_${number}_PASSWORD`]
  })
  if (login.error) throw new Error(`Login ${number}: ${login.error.message}`)
  const session = await loadCompanySession(client, login.data.user)
  assert.equal(session.company.id, idOf(number))
  assert.ok(session.company.name)
  assert.ok(session.company.code)
  const { data: rows, error } = await client.from('hr_records').select('id,company_id,data')
    .eq('company_id', idOf(number)).eq('collection', 'attendanceSettings')
  if (error) throw error
  assert.equal(rows.length, 1)
  assert.equal(rows[0].company_id, idOf(number))
  const policy = rows[0].data
  assert.deepEqual([policy.workStart, policy.lunchStart, policy.lunchEnd, policy.workEnd,
    policy.workUnitCalculationMode], expected[number])
  assert.equal(policy.standardWorkMinutes, 480)
  assert.equal(policy.monthlyStandardWorkUnits, 26)
  assert.equal(policy.requiredPunchPairs, 1)
  assert.equal(policy.unpaidBreakMinutes, 0)
  const legacyNormalizer = { 22: old22Settings, 23: old23Settings, 31: old31Settings }[number]
  const legacyPolicy = legacyNormalizer(policy)
  assert.equal(legacyPolicy.unpaidBreakMinutes, 0)
  assert.equal(legacyPolicy.shifts.administrative.standardCheckIn, policy.workStart)
  assert.equal(legacyPolicy.shifts.administrative.standardCheckOut, policy.workEnd)
  if (number === 31) assert.equal(legacyPolicy.shifts.administrative.splitShift.enabled, true)
  else {
    assert.equal(legacyPolicy.shifts.saleMorning.standardCheckIn, '04:00')
    assert.equal(legacyPolicy.shifts.saleMorning.standardCheckOut, '13:30')
  }
  const shift = resolveAttendanceShift({}, {}, policy)
  const metrics = calculateAttendanceMetrics({
    log: { checkIn: policy.workStart, checkOut: policy.workEnd }, attendanceSettings: policy, shift
  })
  assert.equal(metrics.regularWorkdays, 1)
  assert.equal(metrics.hours, 8)
  assert.equal(metrics.overtimeHours, 0)
  const other = number === 22 ? 23 : 22
  const cross = await client.from('hr_records').select('id').eq('company_id', idOf(other))
    .eq('collection', 'attendanceSettings')
  if (cross.error) throw cross.error
  assert.equal(cross.data.length, 0)
  const ownUsers = await client.from('users').select('id').eq('company_id', idOf(number))
  if (ownUsers.error) throw ownUsers.error
  assert.ok(ownUsers.data.length > 1)
  const ownStaff = await client.from('nhan_su').select('id').eq('company_id', idOf(number))
  if (ownStaff.error) throw ownStaff.error
  assert.ok(ownStaff.data.length > 0)
  const ownLogs = await client.from('hr_records').select('id').eq('company_id', idOf(number))
    .eq('collection', 'attendanceLogs')
  if (ownLogs.error) throw ownLogs.error
  assert.ok(ownLogs.data.length > 0)
  const crossUsers = await client.from('users').select('id').eq('company_id', idOf(other))
  if (crossUsers.error) throw crossUsers.error
  assert.equal(crossUsers.data.length, 0)
  const attendanceRows = await client.from('cham_cong').select('id', { count: 'exact', head: true })
    .eq('company_id', idOf(number))
  if (attendanceRows.error) throw attendanceRows.error
  const hrRows = await client.from('hr_records').select('id', { count: 'exact', head: true })
    .eq('company_id', idOf(number))
  if (hrRows.error) throw hrRows.error
  const summaries = await client.from('hr_records').select('data').eq('company_id', idOf(number))
    .eq('collection', 'attendanceMonthSummaries')
  if (summaries.error) throw summaries.error
  const snapshotAudit = { summaries: summaries.data.length,
    withPolicySnapshot: summaries.data.filter(row => Boolean(row.data?.policySnapshot)).length }
  const logs = await client.from('hr_records').select('data').eq('company_id', idOf(number))
    .eq('collection', 'attendanceLogs')
  if (logs.error) throw logs.error
  const allLogs = logs.data.map(row => row.data)
  const onePunch = allLogs.filter(log => Boolean(log?.checkIn || log?.vao) !== Boolean(log?.checkOut || log?.ra))
  const onePunchZero = onePunch.filter(log =>
    calculateAttendanceMetrics({ log, attendanceSettings: policy }).regularWorkdays === 0)
  const noPunchWithSource = allLogs.filter(log => !(log?.checkIn || log?.vao || log?.checkOut || log?.ra) &&
    Number(log?.cong) > 0)
  const sourcePreserved = noPunchWithSource.filter(log =>
    summarizeAttendanceDay([log], {}, policy, String(log?.date || '').slice(0, 10)).regularWorkdaysExact > 0)
  assert.equal(onePunchZero.length, onePunch.length)
  assert.equal(sourcePreserved.length, noPunchWithSource.length)
  const importAudit = { onePunch: onePunch.length, onePunchZero: onePunchZero.length,
    noPunchWithSource: noPunchWithSource.length, sourcePreserved: sourcePreserved.length }
  let saleAudit = undefined
  if (number === 22) {
    const sale = allLogs.filter(log =>
      /sale/i.test(String(log?.shiftName || log?.tenCa || '')))
    const complete = sale.filter(log => (log?.checkIn || log?.vao) && (log?.checkOut || log?.ra))
    const legacySaleCandidate = normalizeAttendancePolicy({ ...policy, shifts: {
      ...policy.shifts, saleMorning: { ...policy.shifts.saleMorning,
        standardWorkMinutes: 480, unpaidBreakMinutes: 0, overtimeStart: '12:00' }
    } })
    const changedCount = candidate => complete.filter(log => {
      const oldValue = old22Metrics({ log, standardMinutes: 480, breakMinutes: 0 })
      const newValue = calculateAttendanceMetrics({ log, attendanceSettings: candidate,
        shift: resolveAttendanceShift({}, log, candidate) })
      return Math.abs(oldValue.regularWorkdays - newValue.regularWorkdays) > 1e-8 ||
        Math.abs(oldValue.hours - newValue.hours) > 1e-8 ||
        Math.abs(oldValue.overtimeHours - newValue.overtimeHours) > 1e-8
    }).length
    saleAudit = { logs: sale.length, completePunchPairs: complete.length,
      calculationChanges: changedCount(policy),
      changesWithLegacySaleCandidate: changedCount(legacySaleCandidate),
      samples: complete.map(log => {
        const read = candidate => {
          const result = candidate ? calculateAttendanceMetrics({ log, attendanceSettings: candidate,
            shift: resolveAttendanceShift({}, log, candidate) })
            : old22Metrics({ log, standardMinutes: 480, breakMinutes: 0 })
          return { work: result.regularWorkdays, hours: result.hours, ot: result.overtimeHours }
        }
        return { in: log.checkIn || log.vao, out: log.checkOut || log.ra,
          old: read(null), current: read(policy), legacyCandidate: read(legacySaleCandidate) }
      }) }
    assert.equal(saleAudit.logs, 15)
    assert.equal(saleAudit.completePunchPairs, 2)
    assert.ok(saleAudit.samples.every(sample => sample.current.work === 1 &&
      sample.current.hours === 9 && sample.current.ot === 0),
    'Company 22 Sale: historical complete punches must display 9 hours under current policy')
  }
  console.log(JSON.stringify({ company: number, auth: 'pass', companySession: 'pass', settings: 'pass',
    branding: 'pass', hrData: 'pass', fullShiftWorkUnits: metrics.regularWorkdays,
    fullShiftHours: metrics.hours, crossTenantRead: 'blocked',
    rowCounts: { users: ownUsers.data.length, staff: ownStaff.data.length,
      attendance: attendanceRows.count, hrRecords: hrRows.count }, snapshotAudit, importAudit, saleAudit }))
  await client.auth.signOut()
}
