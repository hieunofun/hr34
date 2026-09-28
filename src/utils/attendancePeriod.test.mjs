import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attendancePeriodDates,
  attendanceMonthForDate,
  countAttendancePeriodLogs,
  dateInAttendancePeriod,
  isValidAttendanceDate,
  resolveMatrixAttendanceDates,
  suggestAttendancePeriod,
  validateAttendancePeriod
} from './attendancePeriod.js'
import { buildAttendanceSummary } from './attendanceSummary.js'
import { planAttendanceImport } from '../services/attendanceImportCommit.js'

const log = date => ({ employeeId: 'employee-1', date, cong: 1,
  hours: 8, calculationMode: 'source-value', sourceType: 'excel-import' })
const employee = [{ id: 'employee-1', name: 'Nhân viên A' }]

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
