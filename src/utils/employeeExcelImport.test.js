import test from 'node:test'
import assert from 'node:assert/strict'
import XLSX from 'xlsx'
import { normalizeEmployeeExcelHeader, normalizeImportedPhone, readEmployeeExcelRows } from './employeeExcelImport.js'

test('imports numbered Vietnamese headers and preserves raw Excel date serials', () => {
  const workbook = XLSX.utils.book_new()
  const staff = XLSX.utils.aoa_to_sheet([
    ['THÔNG TIN NHÂN SỰ'],
    ['Hướng dẫn nhập liệu'],
    ['', '1. STT', '3. Mã nhân viên', '2. Họ và tên*', '7. Ngày sinh'],
    ['', '', 'VFC2001', 'Nhân viên mẫu', 34518]
  ])
  staff.E4.z = 'm/d/yy'
  XLSX.utils.book_append_sheet(workbook, staff, 'Thông tin nhân sự')
  const other = XLSX.utils.aoa_to_sheet(Array.from({ length: 100 }, (_, index) => [`Dòng ${index}`]))
  XLSX.utils.book_append_sheet(workbook, other, 'Trang khác dài hơn')

  const result = readEmployeeExcelRows(XLSX, workbook)
  assert.equal(result.headers[2], 'ma_nhan_vien')
  assert.equal(result.headers[3], 'ho_va_ten')
  assert.equal(result.headers[4], 'ngay_sinh')
  assert.equal(result.dataRows.length, 1)
  assert.equal(result.dataRows[0].rowNumber, 4)
  assert.equal(result.dataRows[0].displayRow[3], 'Nhân viên mẫu')
  assert.equal(result.dataRows[0].rawRow[4], 34518)
  assert.notEqual(result.dataRows[0].displayRow[4], 34518)
})

test('rejects a workbook without an employee name column', () => {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Mã ca', 'Bộ phận'], ['01', 'Vận hành']
  ]), 'Ca làm việc')
  assert.throws(() => readEmployeeExcelRows(XLSX, workbook), /Họ và tên/)
  assert.equal(normalizeEmployeeExcelHeader('31. Ghi chú'), 'ghi_chu')
})

test('restores the leading zero lost from numeric Vietnamese mobile cells', () => {
  assert.equal(normalizeImportedPhone(912345678), '0912345678')
  assert.equal(normalizeImportedPhone('‘0912345678'), '0912345678')
  assert.equal(normalizeImportedPhone('02812345678'), '02812345678')
})
