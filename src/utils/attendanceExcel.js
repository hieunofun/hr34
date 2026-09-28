import ExcelJS from 'exceljs'
import { normalizeAttendancePolicy } from './attendanceShift.js'
import { attendancePeriodDates, calendarAttendancePeriod } from './attendancePeriod.js'

const TEMPLATE_URL = '/templates/attendance-report-template.xlsx'
const SHEET_NAME = 'THÁNG 7'
const TEMPLATE_DATA_START_ROW = 7
const TEMPLATE_DATA_END_ROW = 31
const TEMPLATE_SUMMARY_START_ROW = 33
const DAY_START_COLUMN = 36 // AJ
const DAY_END_COLUMN = 66 // BN
const TEMPLATE_EMPLOYEE_ROW_COUNT =
  TEMPLATE_DATA_END_ROW - TEMPLATE_DATA_START_ROW + 1

const WEEK_LAYOUTS = [
  { label: 'AJ', count: 'AL', list: 'AM', startDay: 1, endDay: 7 },
  { label: 'AR', count: 'AT', list: 'AU', startDay: 8, endDay: 14 },
  { label: 'AY', count: 'BA', list: 'BB', startDay: 15, endDay: 21 },
  { label: 'BF', count: 'BH', list: 'BI', startDay: 22, endDay: 28 },
  { label: 'BO', count: 'BP', list: 'BQ', startDay: 29, endDay: 31 }
]

const clone = (value) => {
  if (value === null || value === undefined) return value
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

const normalizeDateText = (value) => {
  if (!value) return ''
  const raw = String(value).slice(0, 10)
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoMatch) return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`
  return String(value)
}

const contractTypeForReport = (row) => {
  if (row.contractType) return row.contractType
  const status = String(row.employmentStatus || '').toLowerCase()
  if (status.includes('chính thức')) return 'Chính Thức'
  if (status.includes('thử việc')) return 'Thử việc'
  return ''
}

const employmentStatusForReport = (row) => {
  const status = String(row.employmentStatus || '').toLowerCase()
  if (status.includes('nghỉ việc')) return 'Đã nghỉ'
  if (status.includes('tạm nghỉ')) return 'Tạm nghỉ'
  return status ? row.employmentStatus : 'Đang làm'
}

const attendanceCodeForDay = (day) => {
  if (!day) return ''
  const statuses = day.logs
    .map(log => String(log.kyHieuPlus || log.kyHieu || log.status || '').trim().toUpperCase())
    .filter(Boolean)
  const templateCode = statuses.find(status => ['X', 'X1', 'X2', 'X3', 'P1'].includes(status))
  if (templateCode) return templateCode
  if (day.paidLeaveWorkdays > 0 || statuses.includes('V')) return 'P1'
  if (day.unapprovedAbsence) return 'X'
  if (Number(day.workdays)) return Number(day.workdays)
  return ''
}

const recordSummaryMerges = (worksheet) =>
  Object.values(worksheet._merges || {})
    .map(merge => ({ ...merge.model }))
    .filter(merge => merge.top >= TEMPLATE_SUMMARY_START_ROW)

const unmergeSummary = (worksheet, merges) => {
  merges.forEach(merge => {
    worksheet.unMergeCells(merge.top, merge.left, merge.bottom, merge.right)
  })
}

const remergeSummary = (worksheet, merges, rowDelta) => {
  merges.forEach(merge => {
    worksheet.mergeCells(
      merge.top + rowDelta,
      merge.left,
      merge.bottom + rowDelta,
      merge.right
    )
  })
}

const copyEmployeeRowStyle = (worksheet, sourceRowNumber, targetRowNumber) => {
  const source = worksheet.getRow(sourceRowNumber)
  const target = worksheet.getRow(targetRowNumber)
  target.height = source.height
  target.hidden = source.hidden
  target.outlineLevel = source.outlineLevel
  for (let column = 1; column <= DAY_END_COLUMN; column += 1) {
    const sourceCell = source.getCell(column)
    const targetCell = target.getCell(column)
    targetCell.style = clone(sourceCell.style)
    if (sourceCell.dataValidation) targetCell.dataValidation = clone(sourceCell.dataValidation)
    if (sourceCell.note) targetCell.note = clone(sourceCell.note)
  }
}

const resizeEmployeeRegion = (worksheet, employeeCount) => {
  const summaryMerges = recordSummaryMerges(worksheet)
  const rowDelta = employeeCount - TEMPLATE_EMPLOYEE_ROW_COUNT
  if (!rowDelta) return TEMPLATE_SUMMARY_START_ROW

  unmergeSummary(worksheet, summaryMerges)
  if (rowDelta > 0) {
    worksheet.spliceRows(TEMPLATE_DATA_END_ROW + 1, 0, ...Array.from({ length: rowDelta }, () => []))
    for (let row = TEMPLATE_DATA_END_ROW + 1; row <= TEMPLATE_DATA_END_ROW + rowDelta; row += 1) {
      copyEmployeeRowStyle(worksheet, TEMPLATE_DATA_START_ROW, row)
    }
  } else {
    worksheet.spliceRows(TEMPLATE_DATA_START_ROW + employeeCount, -rowDelta)
  }
  remergeSummary(worksheet, summaryMerges, rowDelta)
  return TEMPLATE_SUMMARY_START_ROW + rowDelta
}

const clearEmployeeRow = (worksheet, rowNumber) => {
  for (let column = 1; column <= DAY_END_COLUMN; column += 1) {
    worksheet.getCell(rowNumber, column).value = null
  }
}

const setFormula = (cell, formula, result = 0) => {
  cell.value = { formula, result }
}

const populateEmployee = (worksheet, rowNumber, row, index, dates, policy) => {
  clearEmployeeRow(worksheet, rowNumber)
  const penaltyAmount = key => Number(policy.penaltyRules.categories.find(item => item.key === key)?.amount || 0)
  const note = row.lateCount
    ? `${row.lateCount} lần (${row.lateMinutes || 0}p)`
    : ''
  const earlyUnder30Count = Number(row.earlyUnder30Count || 0)
  const earlyOver30Count = Number(row.earlyOver30Count || 0)

  worksheet.getCell(rowNumber, 1).value = index + 1
  worksheet.getCell(rowNumber, 2).value = '' // FIELD_NOT_AVAILABLE: Xác nhận
  worksheet.getCell(rowNumber, 3).value = row.employeeName || ''
  worksheet.getCell(rowNumber, 4).value = row.department || ''
  worksheet.getCell(rowNumber, 5).value = String(row.shift || '')
  worksheet.getCell(rowNumber, 6).value = contractTypeForReport(row)
  worksheet.getCell(rowNumber, 7).value = employmentStatusForReport(row)
  worksheet.getCell(rowNumber, 8).value = normalizeDateText(row.joinDate)
  worksheet.getCell(rowNumber, 9).value = normalizeDateText(row.officialDate)
  worksheet.getCell(rowNumber, 10).value = normalizeDateText(row.lastWorkingDate)
  worksheet.getCell(rowNumber, 11).value = note
  worksheet.getCell(rowNumber, 12).value = Number(row.lateUnder30Count || 0) + earlyUnder30Count
  setFormula(worksheet.getCell(rowNumber, 13), `${penaltyAmount('late_under_30')}*L${rowNumber}`)
  worksheet.getCell(rowNumber, 14).value = Number(row.lateOver30Count || 0) + earlyOver30Count
  setFormula(worksheet.getCell(rowNumber, 15), `${penaltyAmount('late_over_30')}*N${rowNumber}`)
  worksheet.getCell(rowNumber, 16).value = Number(row.missingPunchCount || 0)
  setFormula(worksheet.getCell(rowNumber, 17), `${penaltyAmount('missing_punch')}*P${rowNumber}`)
  worksheet.getCell(rowNumber, 18).value = null // FIELD_NOT_AVAILABLE: không trực nhật
  setFormula(worksheet.getCell(rowNumber, 19), `${penaltyAmount('no_duty')}*R${rowNumber}`)
  worksheet.getCell(rowNumber, 20).value = null // FIELD_NOT_AVAILABLE: nghỉ đột xuất
  setFormula(worksheet.getCell(rowNumber, 21), `${penaltyAmount('emergency_leave')}*MAX(0,T${rowNumber}-${policy.penaltyRules.emergencyLeaveFreeCount})`)
  worksheet.getCell(rowNumber, 22).value = Number(row.unapprovedAbsenceCount || 0)
  setFormula(worksheet.getCell(rowNumber, 23), `${penaltyAmount('unapproved_absence')}*V${rowNumber}`)
  worksheet.getCell(rowNumber, 24).value = null // FIELD_NOT_AVAILABLE: say xỉn
  setFormula(worksheet.getCell(rowNumber, 25), `M${rowNumber}+O${rowNumber}+Q${rowNumber}+S${rowNumber}+U${rowNumber}+W${rowNumber}+X${rowNumber}`)
  worksheet.getCell(rowNumber, 26).value = null // FIELD_NOT_AVAILABLE: vé xe
  worksheet.getCell(rowNumber, 27).value = null // FIELD_NOT_AVAILABLE: phép năm còn lại
  worksheet.getCell(rowNumber, 28).value = Number(row.overtimeHours || 0)
  worksheet.getCell(rowNumber, 29).value = Number(row.paidLeaveWorkdays || 0)
  worksheet.getCell(rowNumber, 30).value = null // FIELD_NOT_AVAILABLE: học việc
  worksheet.getCell(rowNumber, 31).value = Number(row.probationWorkdays || 0)
  worksheet.getCell(rowNumber, 32).value = Number(row.officialWorkdays || 0)
  worksheet.getCell(rowNumber, 33).value = null // FIELD_NOT_AVAILABLE: công làm lễ
  worksheet.getCell(rowNumber, 34).value = null // FIELD_NOT_AVAILABLE: công lễ
  worksheet.getCell(rowNumber, 35).value = Number(row.workdays || 0)

  for (let day = 1; day <= 31; day += 1) {
    const cell = worksheet.getCell(rowNumber, DAY_START_COLUMN + day - 1)
    if (day > dates.length) {
      cell.value = null
      continue
    }
    const date = dates[day - 1]
    cell.value = attendanceCodeForDay(row.days?.get(date))
  }
}

const populateHeader = (worksheet, month, dates) => {
  const [year, monthNumber] = month.split('-').map(Number)
  if (!year || !monthNumber || monthNumber < 1 || monthNumber > 12) {
    throw new Error(`Tháng xuất báo cáo không hợp lệ: ${month}`)
  }
  worksheet.name = `THÁNG ${monthNumber}`
  worksheet.getCell('AJ2').value = `BẢNG CÔNG T${monthNumber}/${year}`
  worksheet.getCell('AL4').value = `${dates[0].slice(8, 10)}/${dates[0].slice(5, 7)}/${dates[0].slice(0, 4)} - ${dates.at(-1).slice(8, 10)}/${dates.at(-1).slice(5, 7)}/${dates.at(-1).slice(0, 4)}`
  for (let day = 1; day <= 31; day += 1) {
    const column = DAY_START_COLUMN + day - 1
    const date = dates[day - 1]
    const visible = Boolean(date)
    worksheet.getColumn(column).hidden = !visible
    worksheet.getCell(5, column).value = visible
      ? ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][new Date(`${date}T00:00:00`).getDay()]
      : null
    worksheet.getCell(6, column).value = visible ? `${date.slice(8, 10)}/${date.slice(5, 7)}` : null
  }
  return dates.length
}

const updateTotals = (worksheet, employeeCount) => {
  const lastRow = TEMPLATE_DATA_START_ROW + employeeCount - 1
  for (let column = 12; column <= 35; column += 1) {
    const cell = worksheet.getCell(4, column)
    if (!employeeCount) {
      cell.value = 0
      continue
    }
    const letter = worksheet.getColumn(column).letter
    setFormula(cell, `SUM(${letter}${TEMPLATE_DATA_START_ROW}:${letter}${lastRow})`)
  }
}

const eventNames = (rows, dates, startDay, endDay, predicate) => {
  const names = []
  rows.forEach(row => {
    let matched = false
    for (let day = startDay; day <= endDay; day += 1) {
      const date = dates[day - 1]
      if (predicate(row.days?.get(date))) {
        matched = true
        break
      }
    }
    if (matched) names.push(`- ${row.employeeName}${row.department ? ` (${row.department})` : ''}`)
  })
  return names
}

const populateWeeklySummary = (worksheet, rows, dates, summaryStartRow) => {
  const eventRows = [
    { offset: 1, label: 'Đi muộn', predicate: day => Boolean(day?.late) },
    { offset: 2, label: 'Kh chấm công', predicate: day => Boolean(day?.missingPunch) },
    { offset: 3, label: 'Nghỉ đột xuất', predicate: () => false },
    { offset: 4, label: 'Nghỉ kh phép', predicate: day => Boolean(day?.unapprovedAbsence) }
  ]

  WEEK_LAYOUTS.forEach((week, index) => {
    const endDay = Math.min(week.endDay, dates.length)
    worksheet.getCell(`${week.label}${summaryStartRow}`).value = `Tuần ${index + 1}\n`
    eventRows.forEach(event => {
      const targetRow = summaryStartRow + event.offset
      const names = week.startDay <= endDay
        ? eventNames(rows, dates, week.startDay, endDay, event.predicate)
        : []
      worksheet.getCell(`${week.label}${targetRow}`).value = event.label
      worksheet.getCell(`${week.count}${targetRow}`).value = names.length || null
      worksheet.getCell(`${week.list}${targetRow}`).value = names.join('\n') || null
    })
  })
}

export const buildAttendanceWorkbook = async (templateData, rows, month, attendanceSettings = {}, attendancePeriod = null) => {
  const policy = normalizeAttendancePolicy(attendanceSettings)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(templateData)
  const worksheet = workbook.getWorksheet(SHEET_NAME) || workbook.worksheets[0]
  if (!worksheet) throw new Error('Golden template không có worksheet.')

  const dates = attendancePeriodDates(attendancePeriod || calendarAttendancePeriod(month))
  populateHeader(worksheet, month, dates)
  const summaryStartRow = resizeEmployeeRegion(worksheet, rows.length)
  rows.forEach((row, index) => {
    const targetRow = TEMPLATE_DATA_START_ROW + index
    if (targetRow !== TEMPLATE_DATA_START_ROW) {
      copyEmployeeRowStyle(worksheet, TEMPLATE_DATA_START_ROW, targetRow)
    }
    populateEmployee(
      worksheet,
      targetRow,
      row,
      index,
      dates,
      policy
    )
  })
  updateTotals(worksheet, rows.length)
  populateWeeklySummary(worksheet, rows, dates, summaryStartRow)
  workbook.calcProperties.fullCalcOnLoad = true
  workbook.calcProperties.forceFullCalc = true
  return workbook
}

export const downloadAttendanceFromGoldenTemplate = async ({ rows, month, fileName, attendanceSettings = {}, attendancePeriod = null }) => {
  const response = await fetch(TEMPLATE_URL)
  if (!response.ok) {
    throw new Error(`Không tải được golden template (${response.status}).`)
  }
  const templateData = await response.arrayBuffer()
  const workbook = await buildAttendanceWorkbook(templateData, rows, month, attendanceSettings, attendancePeriod)
  const output = await workbook.xlsx.writeBuffer()
  const blob = new Blob([output], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
