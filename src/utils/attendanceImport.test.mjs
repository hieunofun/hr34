import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectAttendancePunches,
  detectMatrixAttendanceMonth,
  findAttendancePunchColumns,
  parseAttendanceDate,
  parseAttendanceTime
} from './attendanceImport.js'
import {
  countAttendancePeriodLogs,
  resolveMatrixAttendanceDates,
  suggestAttendancePeriod
} from './attendancePeriod.js'

test('finds numbered punch pairs in the August attendance export', () => {
  const headers = [
    'Mã N.Viên', 'Tên nhân viên', 'Ngày',
    'Vào 1', 'Ra 1', 'Vào 2', 'Ra 2', 'Vào 3', 'Ra 3',
    'Vào Trễ', 'Ra sớm'
  ]

  assert.deepEqual(findAttendancePunchColumns(headers), {
    checkInIndexes: [3, 5, 7],
    checkOutIndexes: [4, 6, 8],
    allIndexes: [3, 4, 5, 6, 7, 8]
  })
})

test('supports a simple Vào/Ra pair without including summary columns', () => {
  const headers = ['Mã NV', 'Vào', 'Ra', 'Vào trễ', 'Ra sớm']

  assert.deepEqual(findAttendancePunchColumns(headers), {
    checkInIndexes: [1],
    checkOutIndexes: [2],
    allIndexes: [1, 2]
  })
})

test('uses the first Vào and last actual Ra instead of an unmatched later Vào', () => {
  const columns = findAttendancePunchColumns([
    'Mã NV', 'Vào 1', 'Ra 1', 'Vào 2', 'Ra 2'
  ])
  const result = collectAttendancePunches(
    ['00001', '08:26', '17:36', '17:58', ''],
    columns
  )

  assert.deepEqual(result, {
    checkIn: '08:26',
    checkOut: '17:36',
    punches: ['08:26', '17:36', '17:58']
  })
})

test('keeps a lone Ra as checkout instead of converting it to check-in', () => {
  const columns = findAttendancePunchColumns(['Mã NV', 'Vào 1', 'Ra 1'])
  const result = collectAttendancePunches(['00001', '', '17:30'], columns)

  assert.equal(result.checkIn, '')
  assert.equal(result.checkOut, '17:30')
})

test('parses Excel serial times and AM/PM without dropping the meridiem', () => {
  assert.equal(parseAttendanceTime(0.5).str, '12:00')
  assert.equal(parseAttendanceTime('8:30 AM').str, '08:30')
  assert.equal(parseAttendanceTime('8:30 PM').str, '20:30')
  assert.equal(parseAttendanceTime('12:05 AM').str, '00:05')
})

test('prefers Vietnamese day/month order for ambiguous text dates', () => {
  assert.equal(parseAttendanceDate('01/08/2026'), '2026-08-01')
  assert.equal(parseAttendanceDate('8/27/2026'), '2026-08-27')
  assert.equal(parseAttendanceDate(46235), '2026-08-01')
})

test('F&B matrix keeps 21/08–21/09 dates when October is open in the app', () => {
  const days = [
    ...Array.from({ length: 11 }, (_, index) => index + 21),
    ...Array.from({ length: 21 }, (_, index) => index + 1)
  ]
  const columns = days.map((day, idx) => ({ day, idx }))
  const month = detectMatrixAttendanceMonth({
    columns,
    titleSources: ['Thống kê', 'Từ ngày 21/08/2026 đến ngày 21/09/2026'],
    monthHint: '2026-10'
  })
  assert.equal(month, '2026-09')
  const resolved = resolveMatrixAttendanceDates(columns, month)
  assert.equal(resolved[0].date, '2026-08-21')
  assert.equal(resolved[10].date, '2026-08-31')
  assert.equal(resolved[11].date, '2026-09-01')
  assert.equal(resolved.at(-1).date, '2026-09-21')
  assert.equal(resolved.every(column => column.valid), true)

  const logs = Array.from({ length: 54 }, () => resolved.map(column => ({ date: column.date }))).flat()
  assert.equal(logs.length, 1728)
  const period = suggestAttendancePeriod({ logs, monthHint: month })
  assert.equal(period.month, '2026-09')
  assert.deepEqual(countAttendancePeriodLogs(logs, period), { inside: 1458, outside: 270 })
})

test('matrix date headers take precedence over a conflicting sheet title', () => {
  assert.equal(detectMatrixAttendanceMonth({
    columns: [{ day: 31, month: 12, year: 2025 }, { day: 1, month: 1, year: 2026 }],
    titleSources: ['Tháng 10/2026', 'Từ ngày 21/08/2026 đến ngày 21/09/2026'],
    monthHint: '2026-10'
  }), '2026-01')
})

test('matrix date range takes precedence over month titles and handles the year boundary', () => {
  assert.equal(detectMatrixAttendanceMonth({
    titleSources: ['Tháng 10/2026', 'TỪ NGÀY  26/12/2025  ĐẾN NGÀY  25/01/2026'],
    monthHint: '2026-10'
  }), '2026-01')
})

test('matrix month detection retains month titles and the selected-month fallback', () => {
  assert.equal(detectMatrixAttendanceMonth({ titleSources: ['Tháng 08/2025'], monthHint: '2026-10' }), '2025-08')
  assert.equal(detectMatrixAttendanceMonth({ titleSources: ['Tháng 8'], monthHint: '2026-10' }), '2026-08')
  assert.equal(detectMatrixAttendanceMonth({ titleSources: ['Thống kê'], monthHint: '2026-10' }), '2026-10')
})

test('invalid or reversed title dates do not override the selected month', () => {
  for (const title of [
    'Từ ngày 21/08/2026 đến ngày 31/09/2026',
    'Từ ngày 21/09/2026 đến ngày 21/08/2026'
  ]) {
    assert.equal(detectMatrixAttendanceMonth({ titleSources: [title], monthHint: '2026-10' }), '2026-10')
  }
})
