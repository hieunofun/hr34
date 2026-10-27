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

const punchHeaders = [
  'Tên riêng', 'Họ', 'ID', 'Bộ phận', 'Ngày',
  'Ngày trong tuần', 'Số lần quẹt thẻ', 'Ghi'
]

test('reads employee identities from the DEOCA export with split names and ID', () => {
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ['CÔNG TY MẪU'], [], [], ['Phiếu chấm công'],
    ['Thời gian xuất: 26/10/2026'], ['Người vận hành: admin'],
    ['Khoảng thời gian: 26/09/2026 - 26/10/2026'],
    punchHeaders,
    [' NGUYEN ', ' VAN   A ', '00001', 'All Departments>HHV>Trạm A', '24/10/2026', 'Thứ Bảy', 2, '06:30;17:00'],
    [],
    ['NGUYEN', 'VAN A', '00001', 'All Departments>HHV>Trạm A', '23/10/2026', 'Thứ Sáu', 1, '06:30'],
    ['TRAN', '', 'DC002', 'Trạm B', '23/10/2026', 'Thứ Sáu', 0, '']
  ])
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1')

  const result = readEmployeeExcelRows(XLSX, workbook)
  assert.equal(result.sourceFormat, 'deoca-punch')
  assert.deepEqual(result.headers, ['ma_nhan_vien', 'ho_va_ten', 'bo_phan'])
  assert.deepEqual(result.dataRows.map(row => row.displayRow), [
    ['00001', 'NGUYEN VAN A', 'All Departments>HHV>Trạm A'],
    ['00001', 'NGUYEN VAN A', 'All Departments>HHV>Trạm A'],
    ['DC002', 'TRAN', 'Trạm B']
  ])
  assert.deepEqual(result.dataRows.map(row => row.rowNumber), [9, 11, 12])
  assert.deepEqual(result.dataRows[0].rawRow, result.dataRows[0].displayRow)
})

test('uses DEOCA header labels when columns move and preserves formatted numeric IDs', () => {
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Ghi', 'Ngày', 'ID', 'Họ', 'Bộ phận', 'Tên riêng', 'Số lần quẹt thẻ', 'Ngày trong tuần'],
    ['06:30', '23/10/2026', 23, 'THI B', 'Trạm B', 'LE', 1, 'Thứ Sáu']
  ])
  sheet.C2.z = '00000'
  XLSX.utils.book_append_sheet(workbook, sheet, 'Máy chấm công')
  const result = readEmployeeExcelRows(XLSX, workbook)
  assert.deepEqual(result.dataRows[0].displayRow, ['00023', 'LE THI B', 'Trạm B'])
})

test('prefers the detailed personnel sheet over an attendance identity sheet', () => {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    punchHeaders, ['NGUYEN', 'VAN A', 'DC01', 'Trạm A', '', '', '', '']
  ]), 'Chấm công')
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Mã nhân viên', 'Họ và tên', 'Email'], ['DC01', 'Nguyễn Văn A', 'a@example.test']
  ]), 'Nhân sự')
  const result = readEmployeeExcelRows(XLSX, workbook)
  assert.notEqual(result.sourceFormat, 'deoca-punch')
  assert.deepEqual(result.headers, ['ma_nhan_vien', 'ho_va_ten', 'email'])
  assert.equal(result.dataRows[0].displayRow[1], 'Nguyễn Văn A')
})
