import assert from 'node:assert/strict'
import test from 'node:test'
import { buildChamCongRows, planHr34AttendanceImport } from './hr34AttendanceImport.js'

const companyId = '00000000-0000-0000-0000-000000000034'
const sample = {
  employeeId: 'person-1',
  date: '2026-09-01',
  sourceEmployeeCode: 'DC01',
  importFormat: 'deoca-punch',
  raw_punch_times: '06:52;06:52;17:16;17:16',
  vao: '06:52',
  ra: '17:16',
  cong: 1,
  shiftName: 'Ca 1'
}

test('keeps the original punch string and never invents a checkout', () => {
  const rows = buildChamCongRows([
    sample,
    { ...sample, date: '2026-09-02', raw_punch_times: '08:23', vao: '08:23', ra: '', cong: 0 }
  ], companyId, [{ id: 'person-1', ma_nhan_vien: 'DC01' }])
  assert.equal(rows[0].gia_tri_goc, sample.raw_punch_times)
  assert.equal(rows[0].gio_vao, '06:52')
  assert.equal(rows[0].gio_ra, '17:16')
  assert.equal(rows[1].gio_vao, '08:23')
  assert.equal(rows[1].gio_ra, null)
  assert.equal(rows[0].company_id, companyId)
})

test('rejects a source code mapped to another company employee', () => {
  assert.throws(() => buildChamCongRows([sample], companyId,
    [{ id: 'person-1', ma_nhan_vien: 'OTHER' }]), /không khớp/)
})

test('plans idempotent updates by employee and date and blocks manual records', () => {
  assert.equal(planHr34AttendanceImport({ incomingLogs: [sample] }).inserts.length, 1)
  const existing = { ...sample, id: 'excel_person-1', sourceType: 'excel-import', ra: '17:00' }
  const plan = planHr34AttendanceImport({ incomingLogs: [sample], existingLogs: [existing] })
  assert.equal(plan.inserts.length, 0)
  assert.equal(plan.updates.length, 1)
  assert.equal(plan.conflicts.length, 0)
  const manual = planHr34AttendanceImport({
    incomingLogs: [sample],
    existingLogs: [{ employeeId: 'person-1', date: '2026-09-01', sourceType: 'manual', id: 'manual-1' }]
  })
  assert.match(manual.conflicts[0].reason, /nguồn khác/)
  const duplicate = planHr34AttendanceImport({ incomingLogs: [sample, sample] })
  assert.equal(duplicate.conflicts.length, 1)
})
