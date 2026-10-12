import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attendancePeriodDates,
  attendancePeriodDayCount,
  attendanceMonthForDate,
  countAttendancePeriodLogs,
  dateInAttendancePeriod,
  isValidAttendanceDate,
  resolveMatrixAttendanceDates,
  selectAttendanceImportLogs,
  suggestAttendancePeriod,
  validateAttendancePeriod
} from './attendancePeriod.js'
import { buildAttendanceSummary } from './attendanceSummary.js'
import { planAttendanceImport } from '../services/attendanceImportCommit.js'
import { usesCustomAttendancePeriod } from './attendanceCompanyPolicy.js'

const log = date => ({ employeeId: 'employee-1', date, cong: 1,
  hours: 8, calculationMode: 'source-value', sourceType: 'excel-import' })
const employee = [{ id: 'employee-1', name: 'Nhân viên A' }]

test('company 32 confirms all 32 inclusive days while other companies keep the old upload flow', () => {
  const company32 = '00000000-0000-0000-0000-000000000032'
  const filePeriod = { month: '2026-09', startDate: '2026-08-21', endDate: '2026-09-21' }
  const logs = attendancePeriodDates(filePeriod).map(log)
  const suggestion = suggestAttendancePeriod({ logs, monthHint: '2026-09', filePeriod })
  assert.equal(suggestion.source, 'file')
  assert.equal(attendancePeriodDayCount(suggestion), 32)
  assert.deepEqual(validateAttendancePeriod(suggestion, [], company32), filePeriod)
  assert.equal(usesCustomAttendancePeriod(company32), true)
  assert.equal(selectAttendanceImportLogs({ logs }, suggestion, true).length, 32)

  for (const number of [22, 23, 31, 33, 34]) {
    const companyId = `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`
    assert.equal(usesCustomAttendancePeriod(companyId), false)
    assert.equal(selectAttendanceImportLogs({ logs }, null, false).length, 32)
    assert.throws(() => validateAttendancePeriod(suggestion, [], companyId), /tối đa 31 ngày/)
  }
  assert.throws(() => validateAttendancePeriod({ ...filePeriod, endDate: '2026-09-22' }, [], company32), /tối đa 32 ngày/)
  assert.throws(() => validateAttendancePeriod(filePeriod,
    [{ month: '2026-08', startDate: '2026-07-22', endDate: '2026-08-21' }], company32), /trùng khoảng/)
})

test('period selection filters only the company 32 import; reconciliation keeps every record', () => {
  const logs = [log('2026-08-20'), log('2026-08-21'), log('2026-09-21'), log('2026-09-22')]
  const period = { startDate: '2026-08-21', endDate: '2026-09-21' }
  assert.deepEqual(selectAttendanceImportLogs({ logs }, period, true).map(item => item.date), ['2026-08-21', '2026-09-21'])
  assert.equal(selectAttendanceImportLogs({ logs }, period, false).length, 4)
  assert.equal(selectAttendanceImportLogs({ logs, isReconcileMode: true }, period, true).length, 4)
  assert.equal(selectAttendanceImportLogs({ logs }, null, true).length, 0)
})

test('32-day summary keeps both day 21 entries and applies distinct manual overrides', () => {
  const period = { month: '2026-09', startDate: '2026-08-21', endDate: '2026-09-21' }
  const row = buildAttendanceSummary({
    attendanceLogs: [log('2026-08-21'), log('2026-09-21')], employees: employee,
    month: period.month, attendancePeriod: period,
    manualWorkdays: { 'employee-1': { 21: 0.5, '2026-08-21': 0.25, '2026-09-21': 0.75, '2026-09-22': 1 } }
  })[0]
  assert.equal(row.days.get('2026-08-21').workdays, 0.25)
  assert.equal(row.days.get('2026-09-21').workdays, 0.75)
  assert.equal(row.days.has('2026-09-22'), false)
  assert.equal(row.workdays, 1)
})

test('company A calendar period counts only 01/09–30/09', () => {
  const period = validateAttendancePeriod({ month: '2026-09', startDate: '2026-09-01', endDate: '2026-09-30' })
  const logs = [log('2026-08-31'), log('2026-09-01'), log('2026-09-30'), log('2026-10-01')]
  assert.deepEqual(countAttendancePeriodLogs(logs, period), { inside: 2, outside: 2 })
  const row = buildAttendanceSummary({ attendanceLogs: logs, employees: employee, month: '2026-09', attendancePeriod: period })[0]
  assert.deepEqual([...row.days.keys()], ['2026-09-01', '2026-09-30'])
  assert.equal(row.workdays, 2)
})

test('company B gets 26/08–25/09 from its own preceding period', () => {
  const previous = { month: '2026-08', startDate: '2026-07-26', endDate: '2026-08-25' }
  const logs = [log('2026-08-27'), log('2026-09-24'), log('2026-09-26')]
  const period = suggestAttendancePeriod({ logs, existing: [previous], monthHint: '2026-09' })
  assert.deepEqual({ startDate: period.startDate, endDate: period.endDate },
    { startDate: '2026-08-26', endDate: '2026-09-25' })
  assert.deepEqual(countAttendancePeriodLogs(logs, period), { inside: 2, outside: 1 })
  assert.equal(attendancePeriodDates(period).length, 31)
  const row = buildAttendanceSummary({ attendanceLogs: logs, employees: employee, month: '2026-09', attendancePeriod: period })[0]
  assert.deepEqual([...row.days.keys()], ['2026-08-27', '2026-09-24'])
  assert.equal(row.workdays, 2)
  const companyA = suggestAttendancePeriod({ logs: [log('2026-09-01')], existing: [], monthHint: '2026-09' })
  assert.equal(companyA.startDate, '2026-09-01')
})

test('missing first and last day never shrinks the proposed period to file min/max', () => {
  const period = suggestAttendancePeriod({
    logs: [log('2026-08-28'), log('2026-09-22')], monthHint: '2026-09'
  })
  assert.equal(period.startDate, '2026-08-26')
  assert.equal(period.endDate, '2026-09-25')
  assert.equal(dateInAttendancePeriod('2026-08-26', period), true)
  assert.equal(dateInAttendancePeriod('2026-09-25', period), true)
  const sourceHeavyInAugust = suggestAttendancePeriod({
    logs: [log('2026-08-26'), log('2026-08-27'), log('2026-08-28'), log('2026-09-05')],
    monthHint: '2026-10'
  })
  assert.equal(sourceHeavyInAugust.month, '2026-09')
  assert.equal(sourceHeavyInAugust.startDate, '2026-08-26')
  const fromPreviousEvenWithoutSeptemberRows = suggestAttendancePeriod({
    logs: [log('2026-08-27')],
    existing: [{ month: '2026-08', startDate: '2026-07-26', endDate: '2026-08-25' }],
    monthHint: '2026-09'
  })
  assert.equal(fromPreviousEvenWithoutSeptemberRows.month, '2026-09')
})

test('matrix spanning two months preserves each original Excel date', () => {
  const columns = [26, 27, 28, 1, 2, 25].map((day, idx) => ({ day, idx }))
  const resolved = resolveMatrixAttendanceDates(columns, '2026-09')
  assert.deepEqual(resolved.map(column => column.date), [
    '2026-08-26', '2026-08-27', '2026-08-28',
    '2026-09-01', '2026-09-02', '2026-09-25'
  ])
  assert.equal(resolved.every(column => column.valid), true)
  assert.equal(resolveMatrixAttendanceDates([{ day: 31, month: 9, year: 2026 }], '2026-09')[0].valid, false)
})

test('multi-period file is split by confirmed range, including month selection', () => {
  const september = validateAttendancePeriod({ month: '2026-09', startDate: '2026-08-26', endDate: '2026-09-25' })
  const october = validateAttendancePeriod({ month: '2026-10', startDate: '2026-09-26', endDate: '2026-10-25' }, [september])
  const logs = [log('2026-08-27'), log('2026-09-24'), log('2026-09-26'), log('2026-10-02')]
  assert.deepEqual(countAttendancePeriodLogs(logs, september), { inside: 2, outside: 2 })
  assert.equal(attendanceMonthForDate('2026-08-27', [september, october]), '2026-09')
  assert.equal(attendanceMonthForDate('2026-09-26', [september, october]), '2026-10')
  assert.equal(attendanceMonthForDate('2026-08-27', []), '2026-08')
})

test('rejects invalid dates and overlaps, and reimport plans no duplicate insert', () => {
  assert.equal(isValidAttendanceDate('2026-02-30'), false)
  assert.throws(() => validateAttendancePeriod({ month: '2026-09', startDate: '2026-08-26', endDate: '2026-09-25' },
    [{ month: '2026-08', startDate: '2026-08-01', endDate: '2026-08-31' }]), /trùng khoảng/)
  const existing = { ...log('2026-09-01'), id: 'excel_employee-1', sourceType: 'excel-import' }
  const again = planAttendanceImport({ incomingLogs: [log('2026-09-01')], existingLogs: [existing] })
  assert.equal(again.inserts.length, 0)
  assert.equal(again.conflicts.length, 0)
  assert.equal(planAttendanceImport({ incomingLogs: [log('2026-09-01'), log('2026-09-01')] }).conflicts.length, 1)
})
