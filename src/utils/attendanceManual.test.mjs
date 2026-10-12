import test from 'node:test'
import assert from 'node:assert/strict'
import { manualWorkdayForDate, parseManualWorkdayInput, updateManualWorkdays } from './attendanceManual.js'

test('chuẩn hóa số công chỉnh tay và cho phép xóa để dùng lại tự động', () => {
  assert.deepEqual(parseManualWorkdayInput('0,5'), { valid: true, value: 0.5 })
  assert.deepEqual(parseManualWorkdayInput(''), { valid: true, value: null })
  assert.equal(parseManualWorkdayInput('1.5').valid, false)
  assert.equal(parseManualWorkdayInput('-1').valid, false)
})

test('lưu và gỡ giá trị công theo nhân viên, ngày', () => {
  const saved = updateManualWorkdays({}, 'emp-1', 2, 0.5)
  assert.deepEqual(saved, { 'emp-1': { 2: 0.5 } })
  assert.deepEqual(updateManualWorkdays(saved, 'emp-1', 2, null), {})
})

test('date-based overrides distinguish 21 August from 21 September without changing legacy day keys', () => {
  const period = { startDate: '2026-08-21', endDate: '2026-09-21' }
  let saved = updateManualWorkdays({}, 'emp-1', '2026-08-21', 0.25)
  saved = updateManualWorkdays(saved, 'emp-1', '2026-09-21', 0.75)
  assert.equal(manualWorkdayForDate(saved['emp-1'], '2026-08-21', period), 0.25)
  assert.equal(manualWorkdayForDate(saved['emp-1'], '2026-09-21', period), 0.75)
  saved = updateManualWorkdays(saved, 'emp-1', '2026-09-21', null)
  assert.deepEqual(saved, { 'emp-1': { '2026-08-21': 0.25 } })
  assert.equal(manualWorkdayForDate({ 21: 0.5 }, '2026-08-21', period), 0.5)
  assert.equal(manualWorkdayForDate({ 21: 0.5 }, '2026-09-21', period), undefined)
})

test('editing the second day 21 preserves the legacy first day; clearing the first restores automatic work', () => {
  const period = { startDate: '2026-08-21', endDate: '2026-09-21' }
  let saved = updateManualWorkdays({ 'emp-1': { 21: 0.5 } }, 'emp-1', '2026-09-21', 0.75, period)
  assert.deepEqual(saved, { 'emp-1': { 21: 0.5, '2026-09-21': 0.75 } })
  saved = updateManualWorkdays(saved, 'emp-1', '2026-08-21', null, period)
  assert.deepEqual(saved, { 'emp-1': { '2026-09-21': 0.75 } })
  assert.equal(manualWorkdayForDate(saved['emp-1'], '2026-08-21', period), undefined)
})
