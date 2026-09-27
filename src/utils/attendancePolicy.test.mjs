import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateAttendanceMetrics, prorateMonthlySalary } from './attendanceCalculations.js'
import { buildAttendanceSummary, summarizeAttendanceDay } from './attendanceSummary.js'
import { buildPenaltyDetailRows } from './attendancePenalties.js'
import { buildAttendanceShiftSettingsPayload, calculateAttendanceTiming, normalizeAttendancePolicy, resolveAttendanceShift, validateAttendancePolicy } from './attendanceShift.js'

const pair = (checkIn = '07:00', checkOut = '17:00') => ({ checkIn, checkOut })
const metrics = (settings = {}, log = pair(), extra = {}) => calculateAttendanceMetrics({
  log, attendanceSettings: settings, ...extra
})
const office = { workStart: '07:00', workEnd: '17:00', lunchStart: '11:00', lunchEnd: '13:00', unpaidBreakMinutes: 120 }

test('monthly standard work units have a clear default and do not change daily work', () => {
  assert.equal(normalizeAttendancePolicy(office).monthlyStandardWorkUnits, 26)
  const configured = buildAttendanceShiftSettingsPayload({ ...office, monthlyStandardWorkUnits: 22 })
  assert.equal(configured.monthlyStandardWorkUnits, 22)
  assert.equal(normalizeAttendancePolicy(configured).monthlyStandardWorkUnits, 22)
  assert.equal(metrics(office).regularWorkdays, metrics(configured).regularWorkdays)
  assert.equal(prorateMonthlySalary(22_000_000, 22, configured), 22_000_000)
  assert.equal(prorateMonthlySalary(22_000_000, 22, office), 22_000_000 / 26 * 22)
  assert.equal(validateAttendancePolicy({ ...office, monthlyStandardWorkUnits: 0 }).isValid, false)
})

test('1. 480 paid minutes equal one work unit', () => {
  const result = metrics(office)
  assert.equal(result.paidMinutes, 480)
  assert.equal(result.regularWorkdays, 1)
})

test('2. explicit 450 minute standard is preserved', () => {
  const result = metrics({ ...office, standardWorkMinutes: 450 }, pair('07:00', '16:30'))
  assert.equal(result.paidMinutes, 450)
  assert.equal(result.standardWorkMinutes, 450)
  assert.equal(result.regularWorkdays, 1)
})

test('3. unpaid break of 120 is removed once', () => {
  const result = metrics({ ...office, lunchStart: '11:00', lunchEnd: '12:00', unpaidBreakMinutes: 120 })
  assert.equal(result.paidMinutes, 480)
  assert.equal(result.standardWorkMinutes, 480)
})

test('4. split shift gives 0.5 plus 0.5', () => {
  const splitShift = { enabled: true,
    morning: { start: '07:00', end: '11:00', workdays: 0.5 },
    afternoon: { start: '13:00', end: '17:00', workdays: 0.5 } }
  const result = metrics(office, pair(), { splitShift })
  assert.equal(result.regularWorkdays, 1)
  assert.deepEqual(result.splitShiftBreakdown.map(item => item.workdays), [0.5, 0.5])
  const weighted = normalizeAttendancePolicy({ ...office, splitShiftEnabled: true,
    workUnitCalculationMode: 'split_shift', morningWeight: 0.4, afternoonWeight: 0.6 })
  const shift = resolveAttendanceShift({ shift: 'Ca Hành chính' }, {}, weighted)
  assert.equal(metrics(weighted, pair('07:00', '11:00'), { shift }).regularWorkdays, 0.4)
})

test('5. Sale shift uses its own standard for a full work unit', () => {
  const settings = normalizeAttendancePolicy()
  const shift = resolveAttendanceShift({ ca_lam_viec: 'Ca Sáng Sale' }, {}, settings)
  const result = metrics(settings, pair('04:00', '13:30'), { shift })
  assert.equal(result.standardWorkMinutes, 540)
  assert.equal(result.paidMinutes, 540)
  assert.equal(result.regularWorkdays, 1)
})

test('6. overnight shift counts worked time and early leave across midnight', () => {
  const settings = { workStart: '22:00', workEnd: '06:00', lunchStart: '02:00', lunchEnd: '02:30',
    unpaidBreakMinutes: 30, standardWorkMinutes: 450, allowOvernightShift: true }
  const result = metrics(settings, pair('22:00', '06:00'))
  assert.equal(result.paidMinutes, 450)
  assert.equal(result.regularWorkdays, 1)
  assert.equal(metrics(settings, pair('22:00', '07:00')).overtimeMinutes, 60)
  assert.equal(calculateAttendanceTiming({ log: pair('22:00', '05:45'), attendanceSettings: settings }).earlyMinutes, 15)
})

test('7. five minute late grace', () => {
  const settings = { lateGraceMinutes: 5 }
  assert.equal(calculateAttendanceTiming({ log: pair('07:05', '17:00'), attendanceSettings: settings }).lateMinutes, 0)
  assert.equal(calculateAttendanceTiming({ log: pair('07:06', '17:00'), attendanceSettings: settings }).lateMinutes, 6)
})

test('8. penalty threshold comes from policy', () => {
  const categories = [{ key: 'late_under_30', label: 'Dưới ngưỡng', amount: 7 },
    { key: 'late_over_30', label: 'Từ ngưỡng', amount: 9 }]
  const rows = [{ employeeId: 'e', days: new Map([['2026-09-01', { late: true, lateMinutes: 29 }],
    ['2026-09-02', { late: true, lateMinutes: 30 }]]) }]
  assert.deepEqual(buildPenaltyDetailRows(rows, categories, 30).map(row => row.amount), [7, 9])
})

test('9. overtime minimum 30 minutes', () => {
  assert.equal(metrics({ ...office, overtimeMinMinutes: 30 }, pair('07:00', '17:29')).overtimeMinutes, 0)
  assert.equal(metrics({ ...office, overtimeMinMinutes: 30 }, pair('07:00', '17:30')).overtimeMinutes, 30)
})

test('10. overtime rounds down to 15 minute blocks', () => {
  assert.equal(metrics({ ...office, overtimeRoundingMinutes: 15 }, pair('07:00', '17:44')).overtimeMinutes, 30)
})

test('11. one required punch pair yields work', () => {
  assert.equal(metrics({ ...office, requiredPunchPairs: 1 }, pair()).regularWorkdays, 1)
})

test('12. two required pairs need both pairs', () => {
  const settings = { ...office, requiredPunchPairs: 2 }
  assert.equal(metrics(settings, pair()).regularWorkdays, 0)
  assert.equal(metrics(settings, pair(), { punchPairs: [pair('07:00', '11:00'), pair('13:00', '17:00')] }).regularWorkdays, 1)
})

test('13. missing punch can require manual review', () => {
  const result = metrics({ ...office, missingPunchPolicy: 'manual_review' }, { checkIn: '07:00' })
  assert.equal(result.regularWorkdays, 0)
  assert.equal(result.requiresManualReview, true)
})

test('14. imported hours use the configured standard', () => {
  const result = metrics({ ...office, standardWorkMinutes: 450, importPriorityMode: 'imported_hours' },
    { ...pair('07:00', '12:00'), hours: 7.5 })
  assert.equal(result.regularWorkdays, 1)
  assert.equal(metrics({ ...office, standardWorkMinutes: 450, importPriorityMode: 'imported_hours' },
    { ...pair('07:00', '12:00'), hours: 4, importedHours: 7.5 }).regularWorkdays, 1)
  const row = buildAttendanceSummary({ month: '2026-09',
    employees: [{ id: 'e' }], attendanceSettings: { ...office, standardWorkMinutes: 450, importPriorityMode: 'imported_hours' },
    attendanceLogs: [{ employeeId: 'e', date: '2026-09-01', hours: 7.5, cong: 0.5, calculationMode: 'source-value' }]
  })[0]
  assert.equal(row.workdays, 1)
  assert.equal(metrics({ ...office, importPriorityMode: 'imported_hours' },
    { ...pair('07:00', '11:00'), cong: 1, calculationMode: 'source-value' }).regularWorkdays, 0.5)
})

test('15. imported work unit takes priority when configured', () => {
  const result = metrics({ ...office, importPriorityMode: 'imported_work_unit' },
    { ...pair('07:00', '11:00'), cong: 0.75 })
  assert.equal(result.regularWorkdays, 0.75)
})

test('legacy source-value with real punches obeys the company import priority', () => {
  const log = { vao: '07:00', ra: '17:00', cong: 0.5, hours: 4,
    importedWorkUnit: 0.5, importedHours: 4, calculationMode: 'source-value' }
  const raw = summarizeAttendanceDay([log], {}, { ...office, importPriorityMode: 'raw_punch' })
  const hours = summarizeAttendanceDay([log], {}, { ...office, importPriorityMode: 'imported_hours' })
  const units = summarizeAttendanceDay([log], {}, { ...office, importPriorityMode: 'imported_work_unit' })
  assert.equal(raw.regularWorkdaysExact, 1)
  assert.equal(raw.hoursExact, 8)
  assert.equal(hours.regularWorkdaysExact, 0.5)
  assert.equal(units.regularWorkdaysExact, 0.5)
  assert.equal(summarizeAttendanceDay([{ ...log, ra: '' }], {},
    { ...office, importPriorityMode: 'raw_punch' }).regularWorkdaysExact, 0)
})

test('manual review prevents an incomplete imported punch from retaining source work units', () => {
  const log = { vao: '07:00', ra: '', cong: 1, hours: 8,
    importedWorkUnit: 1, importedHours: 8, calculationMode: 'source-value' }
  for (const importPriorityMode of ['imported_hours', 'imported_work_unit']) {
    const settings = { ...office, importPriorityMode, missingPunchPolicy: 'manual_review' }
    assert.equal(summarizeAttendanceDay([log], {}, settings).regularWorkdaysExact, 0)
    assert.equal(metrics(settings, log).regularWorkdays, 0)
  }
})

test('manual override priority none, allowed, highest is applied in monthly summary', () => {
  const base = { month: '2026-09', employees: [{ id: 'e' }],
    attendanceLogs: [{ employeeId: 'e', date: '2026-09-01', vao: '07:00', ra: '17:00' }],
    manualWorkdays: { e: { 1: 0.5, 2: 0.5 } } }
  const read = priority => buildAttendanceSummary({ ...base,
    attendanceSettings: { ...office, manualOverridePriority: priority } })[0]
  assert.equal(read('none').workdays, 1)
  assert.equal(read('allowed').workdays, 1.5)
  assert.equal(read('highest').workdays, 1)
  assert.equal(read('highest').days.get('2026-09-01').workdaysExact, 0.5)
})

test('16. same log differs between two company policies', () => {
  const log = pair('07:00', '16:30')
  assert.equal(metrics({ ...office, standardWorkMinutes: 450 }, log).regularWorkdays, 1)
  assert.equal(metrics({ ...office, standardWorkMinutes: 480 }, log).regularWorkdays, 0.9375)
  const args = { month: '2026-09', employees: [{ id: 'e' }],
    attendanceLogs: [{ employeeId: 'e', date: '2026-09-01', vao: '07:00', ra: '16:30' }] }
  assert.equal(buildAttendanceSummary({ ...args, attendanceSettings: { ...office, standardWorkMinutes: 450 } })[0].workdays, 1)
  assert.equal(buildAttendanceSummary({ ...args, attendanceSettings: { ...office, standardWorkMinutes: 480 } })[0].workdays, 0.94)
})

test('17. monthly snapshot policy yields the original result after current policy changes', () => {
  const snapshot = { policyVersion: 1, policySnapshot: normalizeAttendancePolicy({ ...office, standardWorkMinutes: 450 }) }
  const args = { month: '2026-09', employees: [{ id: 'e', ho_va_ten: 'A' }],
    attendanceLogs: [{ employeeId: 'e', date: '2026-09-01', vao: '07:00', ra: '16:30' }] }
  const original = buildAttendanceSummary({ ...args, attendanceSettings: snapshot.policySnapshot })[0].workdays
  const changed = buildAttendanceSummary({ ...args, attendanceSettings: { ...office, standardWorkMinutes: 480 } })[0].workdays
  const replay = buildAttendanceSummary({ ...args, attendanceSettings: snapshot.policySnapshot })[0].workdays
  assert.equal(replay, original)
  assert.notEqual(changed, original)
})

test('invalid policy cannot be saved', () => {
  assert.equal(validateAttendancePolicy({ ...office, standardWorkMinutes: 0 }).isValid, false)
  assert.equal(validateAttendancePolicy({ ...office, requiredPunchPairs: 0 }).isValid, false)
  assert.equal(validateAttendancePolicy({ ...office, workStart: '22:00', workEnd: '06:00' }).isValid, false)
})

test('overnight company policy works through monthly aggregation', () => {
  const settings = { workStart: '22:00', workEnd: '06:00', lunchStart: '02:00', lunchEnd: '02:30',
    unpaidBreakMinutes: 30, standardWorkMinutes: 450, allowOvernightShift: true }
  assert.equal(validateAttendancePolicy(settings).isValid, true)
  const row = buildAttendanceSummary({
    month: '2026-09', attendanceSettings: settings,
    employees: [{ id: 'night', name: 'Ca đêm' }],
    attendanceLogs: [{ employeeId: 'night', date: '2026-09-01', vao: '22:00', ra: '06:00' }]
  })[0]
  assert.equal(row.workdays, 1)
  assert.equal(row.totalHours, 7.5)
})

test('fixed shift credits its configured work unit only when the full standard is met', () => {
  const settings = { ...office, workUnitCalculationMode: 'fixed_shift', standardWorkMinutes: 480,
    standardWorkUnit: 1, maxWorkUnitPerDay: 1 }
  assert.equal(metrics(settings, pair('07:00', '16:59')).regularWorkdays, 0)
  assert.equal(metrics(settings, pair()).regularWorkdays, 1)
})

test('explicit proportional mode does not use legacy split weights', () => {
  const settings = normalizeAttendancePolicy({ ...office, standardWorkMinutes: 450,
    workUnitCalculationMode: 'proportional', splitShiftEnabled: true,
    shifts: { administrative: { name: 'Ca Hành chính', start: '07:00', end: '17:00',
      splitShift: { enabled: true,
        morning: { start: '07:00', end: '11:00', workdays: 0.5 },
        afternoon: { start: '13:00', end: '17:00', workdays: 0.5 } } } } })
  const shift = resolveAttendanceShift({ shift: 'Ca Hành chính' }, {}, settings)
  assert.equal(metrics(settings, pair('07:00', '16:30'), { shift, splitShift: shift.splitShift }).regularWorkdays, 1)
})

test('configured work unit is capped by company policy', () => {
  const settings = { ...office, standardWorkUnit: 1.5, maxWorkUnitPerDay: 1.2 }
  assert.equal(metrics(settings).regularWorkdays, 1.2)
  const row = buildAttendanceSummary({ month: '2026-09', employees: [{ id: 'e' }],
    attendanceSettings: { ...settings, importPriorityMode: 'imported_work_unit' },
    attendanceLogs: [{ employeeId: 'e', date: '2026-09-01', cong: 1.5, calculationMode: 'source-value' }] })[0]
  assert.equal(row.workdays, 1.2)
})

test('overnight shift must be explicitly enabled before save', () => {
  const settings = { ...office,
    shifts: { night: { id: 'night', name: 'Đêm', start: '22:00', end: '06:00', standardWorkMinutes: 480 } } }
  assert.equal(validateAttendancePolicy(settings).isValid, false)
  assert.equal(validateAttendancePolicy({ ...settings, allowOvernightShift: true }).isValid, true)
})

test('split sessions outside their shift are rejected', () => {
  const settings = { ...office, workUnitCalculationMode: 'split_shift', splitShiftEnabled: true,
    shifts: { administrative: { name: 'Ca Hành chính', start: '07:00', end: '17:00',
      splitShift: { enabled: true,
        morning: { start: '06:00', end: '11:00', workdays: 0.5 },
        afternoon: { start: '13:00', end: '17:00', workdays: 0.5 } } } } }
  assert.equal(validateAttendancePolicy(settings).isValid, false)
})
