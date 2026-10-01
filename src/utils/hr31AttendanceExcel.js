import ExcelJS from 'exceljs'
import { attendancePeriodDates, calendarAttendancePeriod } from './attendancePeriod.js'
import { normalizeAttendanceShiftSettings } from './attendanceShift.js'

const TEMPLATE_URL = '/templates/hr31-attendance-template.xlsx'
const FIRST_DATA_ROW = 10
const TEMPLATE_TOTAL_ROW = 37
const FIRST_DAY_COLUMN = 18 // R
const LAST_DAY_COLUMN = 48 // AV
const LAST_COLUMN = 64 // BL
const WEEKDAYS = ['C.Nhật', 'T.Hai', 'T.Ba', 'T.Tư', 'T.Năm', 'T.Sáu', 'T.Bảy']
const COPY_MERGES = ['A3:BL4', 'A5:BL5', 'L7:O7']
const EMPLOYEE_HEADER_MERGES = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'P', 'Q',
  'AW', 'AX', 'AY', 'AZ', 'BA', 'BB', 'BC', 'BD', 'BE', 'BG', 'BH', 'BI', 'BJ', 'BK', 'BL'
]

export const isHr31CompanyCode = code => String(code || '').trim().toLowerCase() === 'hr31'

const clone = value => value == null ? value : structuredClone(value)
const asDate = value => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10)
  const text = String(value || '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text)
  return match ? `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}` : ''
}
const excelDate = value => {
  const date = asDate(value)
  return date ? new Date(`${date}T00:00:00Z`) : null
}

const copyRow = (source, target, sourceNumber, targetNumber) => {
  const from = source.getRow(sourceNumber)
  const to = target.getRow(targetNumber)
  to.height = from.height
  to.hidden = from.hidden
  to.outlineLevel = from.outlineLevel
  for (let column = 1; column <= LAST_COLUMN; column += 1) {
    const sourceCell = from.getCell(column)
    const cell = to.getCell(column)
    cell.style = clone(sourceCell.style)
    if (sourceCell.type !== ExcelJS.ValueType.Merge && sourceCell.value != null) {
      cell.value = clone(sourceCell.value)
    }
  }
}

const dayFor = (row, date) => row.days instanceof Map ? row.days.get(date) : row.days?.[date]
const codeForDay = day => {
  if (!day) return ''
  if (day.unapprovedAbsence) return 'K'
  if (Number(day.paidLeaveWorkdays) > 0) return Number(day.paidLeaveWorkdays) < 1 ? 'F/2' : 'F'
  const statuses = (day.logs || []).flatMap(log => [log.kyHieuPlus, log.kyHieu, log.status])
    .map(value => String(value || '').trim().toUpperCase()).filter(Boolean)
  for (const code of statuses) {
    if (['CT', 'L', 'RC', 'NB', 'TS', 'O', 'VO', 'P', 'CV', 'H', 'F', 'F/2', 'K', 'K/2', 'F1', 'F2', 'F3'].includes(code)) return code
    if (code === 'NP' || code === 'VẮNG' || code === 'VANG') return 'K'
    if (code === 'X' || /^X[1-3]$/.test(code)) {
      if (Number(day.workdaysExact ?? day.workdays) > 0) return 'X'
    }
  }
  if (statuses.some(code => code === 'P1' || code === 'V')) return 'F'
  if (day.isHoliday && !Number(day.workdaysExact ?? day.workdays)) return 'L'
  const workdays = Number(day.workdaysExact ?? day.workdays)
  return Number.isFinite(workdays) && workdays > 0 ? workdays : ''
}

const countCodes = codes => {
  const counts = new Map()
  let numeric = 0
  for (const code of codes) {
    if (typeof code === 'number') numeric += code
    else if (code) counts.set(code, (counts.get(code) || 0) + 1)
  }
  const count = code => counts.get(code) || 0
  const actual = numeric + count('CT') + count('X') + (count('F/2') + count('K/2')) / 2
  const leave = count('F') + count('F/2') / 2
  const holidays = count('L') + count('RC') + count('NB')
  const sickness = count('O') + count('TS')
  const unpaid = count('K') + count('VO') + count('K/2') / 2
  const rotation = count('P')
  const waiting = count('CV')
  const fCovid = count('F1') + count('F2') + count('F3')
  const contract = count('H')
  return { actual, leave, holidays, sickness, unpaid, rotation, waiting, fCovid, contract,
    total: actual + leave + holidays + rotation + waiting + fCovid }
}

const setFormula = (sheet, address, formula, result) => {
  sheet.getCell(address).value = { formula, result }
}

const salaryDays = (row, dates, codes) => {
  const official = asDate(row.officialDate)
  const paid = codes.map(code => typeof code === 'number' ? code
    : ['CT', 'F', 'L', 'NB', 'RC'].includes(code) ? 1
      : ['F/2', 'K/2'].includes(code) ? 0.5 : 0)
  if (official) return {
    probation: paid.reduce((sum, units, index) => sum + (dates[index] < official ? units : 0), 0),
    official: paid.reduce((sum, units, index) => sum + (dates[index] >= official ? units : 0), 0)
  }
  const contract = String(row.contractType || row.employmentStatus || '').toLowerCase()
  const total = paid.reduce((sum, units) => sum + units, 0)
  if (contract.includes('thử việc')) return { probation: total, official: 0 }
  if (contract.includes('chính thức')) return { probation: 0, official: total }
  return { probation: null, official: null }
}

const fillEmployee = (sheet, rowNumber, row, index, dates, standardWorkdays) => {
  const cell = column => sheet.getRow(rowNumber).getCell(column)
  cell(1).value = index + 1
  cell(3).value = row.employeeCode || ''
  cell(4).value = row.employeeName || ''
  cell(5).value = row.position || ''
  cell(6).value = row.department || ''
  cell(8).value = row.branch || ''
  cell(9).value = excelDate(row.joinDate)
  cell(10).value = excelDate(row.officialDate)
  cell(16).value = excelDate(row.lastWorkingDate)
  for (const column of [9, 10, 16]) cell(column).numFmt = 'dd/mm/yyyy'

  const codes = dates.map(date => codeForDay(dayFor(row, date)))
  codes.forEach((code, dayIndex) => { cell(FIRST_DAY_COLUMN + dayIndex).value = code })
  cell(49).value = standardWorkdays
  const counts = countCodes(codes)
  const range = `R${rowNumber}:AV${rowNumber}`
  const count = code => `COUNTIF(${range},"${code}")`
  setFormula(sheet, `AX${rowNumber}`, `SUM(${range})+${count('CT')}+${count('X')}+(${count('F/2')}+${count('K/2')})/2`, counts.actual)
  setFormula(sheet, `AY${rowNumber}`, `${count('F')}+${count('F/2')}/2`, counts.leave)
  setFormula(sheet, `AZ${rowNumber}`, `${count('L')}+${count('RC')}+${count('NB')}`, counts.holidays)
  setFormula(sheet, `BA${rowNumber}`, `${count('O')}+${count('TS')}`, counts.sickness)
  setFormula(sheet, `BB${rowNumber}`, `${count('K')}+${count('VO')}+${count('K/2')}/2`, counts.unpaid)
  setFormula(sheet, `BC${rowNumber}`, count('P'), counts.rotation)
  setFormula(sheet, `BD${rowNumber}`, count('CV'), counts.waiting)
  setFormula(sheet, `BE${rowNumber}`, `${count('F1')}+${count('F2')}+${count('F3')}`, counts.fCovid)
  setFormula(sheet, `BF${rowNumber}`, count('H'), counts.contract)
  setFormula(sheet, `BG${rowNumber}`, `SUM(AX${rowNumber}:BE${rowNumber})-BA${rowNumber}-BB${rowNumber}`, counts.total)
  const salary = salaryDays(row, dates, codes)
  cell(60).value = salary.probation
  cell(61).value = salary.official
  setFormula(sheet, `BL${rowNumber}`, `AX${rowNumber}+AY${rowNumber}+AZ${rowNumber}`,
    counts.actual + counts.leave + counts.holidays)
}

export const buildHr31AttendanceWorkbook = async (templateData, {
  rows, month, attendancePeriod, attendanceSettings = {}, companyName = '', companyAddress = ''
}) => {
  const dates = attendancePeriodDates(attendancePeriod || calendarAttendancePeriod(month))
  const sourceWorkbook = new ExcelJS.Workbook()
  await sourceWorkbook.xlsx.load(templateData)
  const template = sourceWorkbook.worksheets[0]
  if (!template) throw new Error('Không tìm thấy mẫu bảng công HR31.')

  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(`CC ${month.slice(5)}.${month.slice(0, 4)} Tổng`)
  for (let column = 1; column <= LAST_COLUMN; column += 1) {
    const sourceColumn = template.getColumn(column)
    const targetColumn = sheet.getColumn(column)
    targetColumn.width = sourceColumn.width
    targetColumn.hidden = sourceColumn.hidden
    targetColumn.style = clone(sourceColumn.style)
  }
  sheet.views = clone(template.views)
  sheet.pageSetup = clone(template.pageSetup)
  sheet.headerFooter = clone(template.headerFooter)

  for (let rowNumber = 1; rowNumber <= 9; rowNumber += 1) copyRow(template, sheet, rowNumber, rowNumber)
  const employeeCount = Math.max(rows.length, 1)
  for (let index = 0; index < employeeCount; index += 1) {
    copyRow(template, sheet, FIRST_DATA_ROW, FIRST_DATA_ROW + index)
  }
  const totalRow = FIRST_DATA_ROW + employeeCount
  for (let sourceRow = TEMPLATE_TOTAL_ROW; sourceRow <= 41; sourceRow += 1) {
    copyRow(template, sheet, sourceRow, totalRow + sourceRow - TEMPLATE_TOTAL_ROW)
  }

  COPY_MERGES.forEach(range => sheet.mergeCells(range))
  EMPLOYEE_HEADER_MERGES.forEach(column => sheet.mergeCells(`${column}7:${column}8`))
  sheet.mergeCells(`A${totalRow}:E${totalRow}`)
  sheet.mergeCells(`A${totalRow + 3}:D${totalRow + 3}`)

  const [year, monthNumber] = month.split('-').map(Number)
  sheet.getCell('A1').value = companyName
  sheet.getCell('A2').value = companyAddress
  sheet.getCell('A5').value = `Tháng ${monthNumber} năm ${year}`
  sheet.getCell(`AZ${totalRow + 1}`).value = `Ngày        tháng        năm ${year}`
  sheet.getCell(`A${totalRow}`).value = 'TỔNG'
  for (let index = 0; index < LAST_DAY_COLUMN - FIRST_DAY_COLUMN + 1; index += 1) {
    const column = FIRST_DAY_COLUMN + index
    const date = dates[index]
    const visible = Boolean(date)
    sheet.getColumn(column).hidden = !visible
    const headerDate = sheet.getRow(7).getCell(column)
    const headerWeekday = sheet.getRow(8).getCell(column)
    headerDate.value = visible ? new Date(`${date}T00:00:00Z`) : null
    headerDate.numFmt = 'dd/mm'
    headerWeekday.value = visible ? WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] : null
    const dayNumber = sheet.getRow(9).getCell(column)
    dayNumber.value = visible ? Number(date.slice(8, 10)) : null
    dayNumber.numFmt = '0'
    if (visible && new Date(`${date}T00:00:00Z`).getUTCDay() === 0) {
      for (let rowNumber = 7; rowNumber < totalRow; rowNumber += 1) {
        sheet.getRow(rowNumber).getCell(column).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }
      }
    }
  }

  const policy = normalizeAttendanceShiftSettings(attendanceSettings)
  rows.forEach((row, index) => fillEmployee(sheet, FIRST_DATA_ROW + index, row, index, dates,
    policy.monthlyStandardWorkUnits))
  for (let column = 49; column <= LAST_COLUMN; column += 1) {
    if ([62, 63].includes(column)) continue
    const letter = sheet.getColumn(column).letter
    setFormula(sheet, `${letter}${totalRow}`, `SUM(${letter}${FIRST_DATA_ROW}:${letter}${totalRow - 1})`,
      rows.reduce((sum, _, index) => {
        const value = sheet.getRow(FIRST_DATA_ROW + index).getCell(column).value
        return sum + (Number(value?.result ?? value) || 0)
      }, 0))
  }
  sheet.pageSetup.printArea = `A1:BL${totalRow + 4}`
  sheet.pageSetup.printTitlesRow = '7:9'
  workbook.calcProperties.fullCalcOnLoad = true
  workbook.calcProperties.forceFullCalc = true
  return workbook
}

export const downloadHr31Attendance = async options => {
  const response = await fetch(TEMPLATE_URL)
  if (!response.ok) throw new Error(`Không tải được mẫu bảng công HR31 (${response.status}).`)
  const workbook = await buildHr31AttendanceWorkbook(await response.arrayBuffer(), options)
  const output = await workbook.xlsx.writeBuffer()
  const blob = new Blob([output], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `BANG_CONG_HR31_${options.month}.xlsx`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
