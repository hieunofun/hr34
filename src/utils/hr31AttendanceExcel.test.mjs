import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import { buildHr31AttendanceWorkbook } from './hr31AttendanceExcel.js'
import { isHr31CompanyId } from './hr31Company.js'

const templateFile = new URL('../../public/templates/hr31-attendance-template.xlsx', import.meta.url)
const period = { startDate: '2026-08-26', endDate: '2026-09-25' }

test('Only the actual Hr31 company ID selects the new Excel format', () => {
  assert.equal(isHr31CompanyId('00000000-0000-0000-0000-000000000031'), true)
  assert.equal(isHr31CompanyId('00000000-0000-0000-0000-000000000034'), false)
  assert.equal(isHr31CompanyId('COMPANY_31'), false)
  assert.equal(isHr31CompanyId(null), false)
})

test('Public HR31 template contains no sample employee or company data', async () => {
  const zip = await JSZip.loadAsync(await readFile(templateFile))
  assert.equal(Object.keys(zip.files).some(name => /comments|externalLinks|vmlDrawing/i.test(name)), false)
  const xmlFiles = Object.values(zip.files).filter(file => file.name.endsWith('.xml'))
  const xml = (await Promise.all(xmlFiles.map(file => file.async('string')))).join('\n')
  assert.doesNotMatch(xml, /Nguyễn Xuân Phong|DC01821|TẬP ĐOÀN ĐÈO CẢ|32 Thạch Thị Thanh/)
})

test('HR31 export matches the 26–25 layout, codes, formulas and growing employee list', async () => {
  const template = await readFile(templateFile)
  const rows = Array.from({ length: 30 }, (_, index) => ({
    employeeCode: `NV${index + 1}`,
    employeeName: `Nhân viên ${index + 1}`,
    position: 'Kỹ thuật', department: 'Vận hành', branch: 'QNg',
    joinDate: '2026-01-01', officialDate: '2026-09-01',
    days: index === 0 ? new Map([
      ['2026-08-26', { workdays: 1, logs: [] }],
      ['2026-08-27', { paidLeaveWorkdays: 0.5, logs: [] }],
      ['2026-09-02', { logs: [{ kyHieu: 'L' }] }],
      ['2026-09-03', { unapprovedAbsence: true, logs: [{ kyHieu: 'X' }] }]
    ]) : new Map()
  }))
  const workbook = await buildHr31AttendanceWorkbook(template, {
    rows, month: '2026-09', attendancePeriod: period,
    attendanceSettings: { monthlyStandardWorkUnits: 26 },
    companyName: 'HR31', companyAddress: 'Địa chỉ công ty'
  })
  const sheet = workbook.worksheets[0]
  assert.equal(sheet.getCell('A1').value, 'HR31')
  assert.equal(sheet.getCell('A2').value, 'Địa chỉ công ty')
  assert.equal(sheet.getCell('C10').value, 'NV1')
  assert.equal(sheet.getCell('D39').value, 'Nhân viên 30')
  assert.equal(sheet.getCell('R7').value.toISOString().slice(0, 10), '2026-08-26')
  assert.equal(sheet.getCell('AV7').value.toISOString().slice(0, 10), '2026-09-25')
  assert.equal(sheet.getCell('R9').value, 26)
  assert.equal(sheet.getCell('R9').numFmt, '0')
  assert.equal(sheet.getCell('R10').value, 1)
  assert.equal(sheet.getCell('S10').value, 'F/2')
  assert.equal(sheet.getCell('Y10').value, 'L')
  assert.equal(sheet.getCell('Z10').value, 'K')
  assert.equal(sheet.getCell('AX10').value.result, 1.5)
  assert.equal(sheet.getCell('AY10').value.result, 0.5)
  assert.equal(sheet.getCell('BG10').value.result, 3)
  assert.equal(sheet.getCell('A40').value, 'TỔNG')
  assert.equal(sheet.getCell('A43').value, 'Tổng Giám đốc')
  assert.equal(sheet.pageSetup.printArea, 'A1:BL44')

  const roundTripped = new ExcelJS.Workbook()
  await roundTripped.xlsx.load(await workbook.xlsx.writeBuffer())
  assert.equal(roundTripped.worksheets[0].getCell('D39').value, 'Nhân viên 30')
  assert.equal(roundTripped.worksheets[0].getCell('BG10').value.result, 3)
})
