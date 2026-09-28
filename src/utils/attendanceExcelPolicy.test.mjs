import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildAttendanceWorkbook } from './attendanceExcel.js'

test('Excel attendance export uses the company penalty amounts', async () => {
  const fixture = await readFile(new URL('../../public/templates/attendance-report-template.xlsx', import.meta.url))
  const workbook = await buildAttendanceWorkbook(fixture, [{ employeeId: 'e', employeeName: 'A', days: new Map(),
    lateUnder30Count: 2, lateOver30Count: 1, missingPunchCount: 1 }], '2026-09', {
    penaltyRules: { emergencyLeaveFreeCount: 1, categories: [
      { key: 'late_under_30', label: 'Muộn nhẹ', amount: 12000 },
      { key: 'late_over_30', label: 'Muộn nặng', amount: 34000 },
      { key: 'missing_punch', label: 'Quên chấm', amount: 56000 },
      { key: 'emergency_leave', label: 'Nghỉ đột xuất', amount: 78000 }
    ] }
  })
  const worksheet = workbook.worksheets[0]
  assert.equal(worksheet.getCell('M7').value.formula, '12000*L7')
  assert.equal(worksheet.getCell('O7').value.formula, '34000*N7')
  assert.equal(worksheet.getCell('Q7').value.formula, '56000*P7')
  assert.equal(worksheet.getCell('U7').value.formula, '78000*MAX(0,T7-1)')
  assert.equal(worksheet.getCell('S7').value.formula, '0*R7')
})

test('Excel export shows the confirmed cross-month period and original day dates', async () => {
  const fixture = await readFile(new URL('../../public/templates/attendance-report-template.xlsx', import.meta.url))
  const period = { month: '2026-09', startDate: '2026-08-26', endDate: '2026-09-25' }
  const days = new Map([
    ['2026-08-27', { logs: [], workdays: 1 }],
    ['2026-09-24', { logs: [], workdays: 1 }]
  ])
  const workbook = await buildAttendanceWorkbook(fixture,
    [{ employeeId: 'e', employeeName: 'A', days, workdays: 2 }], '2026-09', {}, period)
  const sheet = workbook.worksheets[0]
  assert.equal(sheet.getCell('AL4').value, '26/08/2026 - 25/09/2026')
  assert.equal(sheet.getCell('AJ6').value, '26/08')
  assert.equal(sheet.getCell('AK6').value, '27/08')
  assert.equal(sheet.getCell('AO6').value, '31/08')
  assert.equal(sheet.getCell('AP6').value, '01/09')
  assert.equal(sheet.getCell('AK7').value, 1)
  assert.equal(sheet.getCell('BM7').value, 1)
})
