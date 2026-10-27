import assert from 'node:assert/strict'
import test from 'node:test'
import XLSX from 'xlsx'
import { createAttendanceImportWorkerHandler } from './attendanceImportWorkerHandler.js'
import { createAttendanceImportWorker } from './attendanceImportWorkerClient.js'
import { normalizeAttendanceShiftSettings } from './attendanceShift.js'

const headers = ['Tên riêng', 'Họ', 'ID', 'Bộ phận', 'Ngày', 'Ngày trong tuần', 'Số lần quẹt thẻ', 'Ghi']
const settings = normalizeAttendanceShiftSettings({
  workStart: '07:00', workEnd: '17:00', lunchStart: '11:00', lunchEnd: '13:00',
  standardWorkMinutes: 480, unpaidBreakMinutes: 120
})
const workbookBytes = rows => {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Phiếu chấm công'], [], headers, ...rows
  ]), 'Chấm công')
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })
}

test('worker pipeline preserves punches, dates, missing checkout and safe source matching', () => {
  const handle = createAttendanceImportWorkerHandler()
  const sheets = handle({ type: 'read', data: workbookBytes([
    ['NGUYEN', 'VAN AN', 'M01', 'Trạm A', '26/09/2026', 'Thứ Bảy', 4, '07:00;07:00;17:00;17:00'],
    ['NGUYEN', 'VAN AN', 'M01', 'Trạm A', '26/10/2026', 'Thứ Hai', 1, '07:00'],
    ['TRAN', 'THI LAN', 'LU01', 'Trạm B', '26/10/2026', 'Thứ Hai', 2, '07:00;17:00'],
    ['TRAN', 'THI LAN', 'M03', 'Trạm B', '31/09/2026', '', 2, '07:00;17:00'],
    ['TRAN', 'THI LAN', 'M03', 'Trạm B', '26/10/2026', '', 0, '']
  ]) })
  assert.equal(sheets[0].rows.length, 8)
  const result = handle({ type: 'deoca', sheetName: 'Chấm công', options: {
    employees: [{ id: 'person-a', employeeId: 'LU01', name: 'Nguyễn Văn An' }],
    attendanceSettings: settings
  } })
  assert.equal(result.preview.count, 3)
  assert.equal(result.preview.uniqueEmployeeCount, 2)
  assert.equal(result.skipped.length, 2)
  const [full, single, collision] = result.preview.logs
  assert.equal(full.employeeId, 'person-a')
  assert.equal(full.employeeCode, 'LU01')
  assert.equal(full.sourceEmployeeCode, 'M01')
  assert.equal(full.date, '2026-09-26')
  assert.equal(full.raw_punch_times, '07:00;07:00;17:00;17:00')
  assert.equal(full.hours, 8)
  assert.equal(full.cong, 1)
  assert.equal(single.date, '2026-10-26')
  assert.equal(single.ra, '')
  assert.equal(single.checkOut, null)
  assert.equal(single.hours, 0)
  assert.equal(single.cong, 0)
  assert.match(collision.employeeId, /^external:/)
  assert.equal(result.preview.matchGroups[1].selectedEmployeeId, '')
})

test('worker keeps remembered manual matches when preparing a new preview', () => {
  const handle = createAttendanceImportWorkerHandler()
  handle({ type: 'read', data: workbookBytes([
    ['NGUYEN', 'VAN AN', 'M01', 'Trạm A', '26/10/2026', '', 2, '07:00;17:00']
  ]) })
  const result = handle({ type: 'deoca', sheetName: 'Chấm công', options: {
    employees: [{ id: 'manual-person', employeeId: 'LU99', name: 'Hồ sơ đã xác nhận' }],
    attendanceLogs: [{ employeeId: 'manual-person', sourceEmployeeCode: 'M01', sourceEmployeeName: 'NGUYEN VAN AN' }],
    attendanceSettings: settings
  } })
  assert.equal(result.preview.logs[0].employeeId, 'manual-person')
  assert.equal(result.preview.matchGroups[0].method, 'Đã ghi nhớ từ lần ghép trước')
})

test('worker client cancels pending work and passes worker errors back to the modal', async t => {
  let instance
  class FakeWorker {
    constructor() { instance = this }
    postMessage(message) { this.message = message }
    terminate() { this.terminated = true }
  }
  const previousWorker = globalThis.Worker
  globalThis.Worker = FakeWorker
  t.after(() => {
    if (previousWorker === undefined) delete globalThis.Worker
    else globalThis.Worker = previousWorker
  })
  const client = createAttendanceImportWorker()
  const reading = client.request('read', { data: new ArrayBuffer(0) })
  instance.onmessage({ data: { id: instance.message.id, error: 'File không hợp lệ' } })
  await assert.rejects(reading, /File không hợp lệ/)
  const processing = client.request('deoca')
  client.terminate()
  await assert.rejects(processing, { name: 'AbortError' })
  assert.equal(instance.terminated, true)
})
