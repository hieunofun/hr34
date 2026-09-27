import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AttendanceImportModal from '../components/AttendanceImportModal'
import AttendanceModal, { dayOfWeekFromDate, formatTimeHM } from '../components/AttendanceModal'
import AttendanceSettingsModal from '../components/AttendanceSettingsModal'
import DependentModal from '../components/DependentModal'
import InsuranceModal from '../components/InsuranceModal'
import PayrollDetailModal from '../components/PayrollDetailModal'
import PayslipModal from '../components/PayslipModal'
import SeedAttendanceDataButton from '../components/SeedAttendanceDataButton'
import SeedPayrollDataButton from '../components/SeedPayrollDataButton'
import TaxModal from '../components/TaxModal'
import {
  fbDelete,
  fbGet,
  fbGetAttendanceLogsByMonth,
  fbGetEmployeesDirectory,
  fbPush,
  fbUpdate
} from '../services/firebase'
import {
  buildAttendanceSummary,
  buildDailyAttendanceMap
} from '../utils/attendanceSummary'
import {
  isPaidLeaveRequest,
  listRequestLeaveDates
} from '../utils/approvalPolicy'
import { TAX_CONFIG } from '../utils/constants'
import { calculateProgressiveTax, formatMoney, normalizeString } from '../utils/helpers'
import { downloadAttendanceFromGoldenTemplate } from '../utils/attendanceExcel'
import { prorateMonthlySalary } from '../utils/attendanceCalculations'
import { normalizeAttendanceShiftSettings } from '../utils/attendanceShift'

let XLSX = null
const ensureXlsx = async () => {
  if (!XLSX) {
    const mod = await import('xlsx-js-style')
    XLSX = mod.default || mod
  }
  return XLSX
}

const buildAttendanceEmployeeFilterKey = (name, code) => {
  const normalizedCode = normalizeString(code)
  const normalizedName = normalizeString(name)

  if (normalizedCode) return `code:${normalizedCode}`
  if (normalizedName) return `name:${normalizedName}`
  return ''
}

const DAY_LABELS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']

const currentMonthValue = () => new Date().toISOString().slice(0, 7)

const buildRecentMonthOptions = (selected = '', count = 24) => {
  const months = new Set()
  const now = new Date()
  for (let index = 0; index < count; index += 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - index, 1)
    months.add(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`)
  }
  if (selected) months.add(String(selected).slice(0, 7))
  return Array.from(months).sort().reverse()
}

const normalizeEmployeeList = (empData) => {
  if (!empData) return []
  if (Array.isArray(empData)) {
    return empData.filter(item => item !== null && item !== undefined)
  }
  if (typeof empData === 'object') {
    return Object.entries(empData)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([id, value]) => ({ ...value, id }))
  }
  return []
}

const mapAttendanceLogs = (attendanceLogsData) => {
  if (!attendanceLogsData) return []
  return Object.entries(attendanceLogsData).map(([id, value]) => ({ ...value, id }))
}

const LOGS_PAGE_SIZE = 120

const contractTypeForReport = (row) => {
  if (row.contractType) return row.contractType
  const status = String(row.employmentStatus || '').toLowerCase()
  if (status.includes('chính thức')) return 'Chính thức'
  if (status.includes('thử việc')) return 'Thử việc'
  return ''
}

const employmentStatusForReport = (row) => {
  const status = String(row.employmentStatus || '').toLowerCase()
  if (status.includes('nghỉ việc')) return 'Đã nghỉ'
  if (status.includes('tạm nghỉ')) return 'Tạm nghỉ'
  return 'Đang làm'
}

const dayValueForReport = (day) => {
  if (!day) return ''
  const statuses = day.logs.map(log =>
    String(log.kyHieu || log.status || '').trim().toUpperCase()
  )
  if (
    day.workdays === 0 &&
    statuses.length > 0 &&
    statuses.every(status => status === '--' || status === '**')
  ) {
    return ''
  }
  return Number(day.workdays) || 0
}

const uniqueReportOptions = (values) => {
  const options = new Map()
  values.forEach((value) => {
    const label = String(value || '').trim()
    const key = normalizeString(label)
    if (key && !options.has(key)) options.set(key, label)
  })
  return Array.from(options.values()).sort((left, right) =>
    left.localeCompare(right, 'vi')
  )
}

const appendAttendanceValidationSheet = (workbook, rows) => {
  const lists = {
    departments: uniqueReportOptions(rows.map(row => row.department)),
    shifts: uniqueReportOptions([
      'CA FULL',
      'CA NGÀY',
      'CA ĐÊM',
      'ONLINE',
      ...rows.map(row => String(row.shift || '').toUpperCase())
    ]),
    contractTypes: uniqueReportOptions([
      'Thử việc',
      'Chính thức',
      ...rows.map(contractTypeForReport)
    ]),
    statuses: uniqueReportOptions([
      'Đang làm',
      'Tạm nghỉ',
      'Đã nghỉ',
      ...rows.map(employmentStatusForReport)
    ])
  }
  const columns = [
    ['Bộ phận', lists.departments],
    ['Ca làm', lists.shifts],
    ['Loại HĐ', lists.contractTypes],
    ['Trạng thái', lists.statuses]
  ]
  const maxLength = Math.max(...columns.map(([, values]) => values.length))
  const listRows = [
    columns.map(([header]) => header),
    ...Array.from({ length: maxLength }, (_, rowIndex) =>
      columns.map(([, values]) => values[rowIndex] || '')
    )
  ]
  const worksheet = XLSX.utils.aoa_to_sheet(listRows)
  worksheet['!cols'] = columns.map(() => ({ wch: 24 }))
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Danh mục')
  XLSX.utils.book_set_sheet_visibility(
    workbook,
    'Danh mục',
    XLSX.utils.consts.SHEET_HIDDEN
  )

  const names = [
    ['DanhSachBoPhan', 'A', lists.departments.length],
    ['DanhSachCaLam', 'B', lists.shifts.length],
    ['DanhSachLoaiHD', 'C', lists.contractTypes.length],
    ['DanhSachTrangThai', 'D', lists.statuses.length]
  ].map(([Name, column, length]) => ({
    Name,
    Ref: `'Danh mục'!$${column}$2:$${column}$${length + 1}`
  }))
  workbook.Workbook = workbook.Workbook || {}
  workbook.Workbook.Names = [
    ...(workbook.Workbook.Names || []).filter(existing =>
      !names.some(name => name.Name === existing.Name)
    ),
    ...names
  ]

  return lists
}

export const injectAttendanceDropdowns = async (xlsxData, reportMeta) => {
  const JSZipModule = await import('jszip')
  const JSZip = JSZipModule.default || JSZipModule
  const zip = await JSZip.loadAsync(xlsxData)
  const sheetPath = 'xl/worksheets/sheet1.xml'
  const sheetFile = zip.file(sheetPath)
  if (!sheetFile) throw new Error('Không tìm thấy sheet bảng công để thêm lựa chọn.')

  let sheetXml = await sheetFile.async('string')
  const firstRow = reportMeta.firstDataExcelRow
  const lastRow = reportMeta.lastDataExcelRow
  const validations = [
    ['C', 'DanhSachBoPhan', 'Chọn bộ phận'],
    ['D', 'DanhSachCaLam', 'Chọn ca làm'],
    ['E', 'DanhSachLoaiHD', 'Chọn loại hợp đồng'],
    ['F', 'DanhSachTrangThai', 'Chọn trạng thái']
  ]
  const validationXml = validations.map(([column, formula, promptTitle]) =>
    `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorStyle="stop" sqref="${column}${firstRow}:${column}${lastRow}" promptTitle="${promptTitle}" prompt="Chọn một giá trị trong danh sách." errorTitle="Giá trị không hợp lệ" error="Vui lòng chọn một giá trị trong danh sách."><formula1>${formula}</formula1></dataValidation>`
  ).join('')
  const block = `<dataValidations count="${validations.length}">${validationXml}</dataValidations>`
  sheetXml = sheetXml.replace(/<dataValidations[\s\S]*?<\/dataValidations>/, '')
  const insertBefore = /<pageMargins\b|<pageSetup\b|<headerFooter\b|<drawing\b|<legacyDrawing\b|<tableParts\b|<extLst\b|<\/worksheet>/
  if (!insertBefore.test(sheetXml)) {
    throw new Error('Không xác định được vị trí thêm danh sách lựa chọn.')
  }
  sheetXml = sheetXml.replace(insertBefore, match => `${block}${match}`)
  zip.file(sheetPath, sheetXml)
  return zip.generateAsync({ type: 'uint8array' })
}

const downloadAttendanceWorkbook = async (workbook, fileName, reportMeta) => {
  await ensureXlsx()
  const workbookData = XLSX.write(workbook, {
    type: 'array',
    bookType: 'xlsx'
  })
  const output = await injectAttendanceDropdowns(workbookData, reportMeta)
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

const applyMonthlyReportStyles = ({
  worksheet,
  rows,
  month,
  rowCount,
  columnCount,
  dayStartColumn,
  dataStartRow
}) => {
  const border = {
    top: { style: 'thin', color: { rgb: '666666' } },
    bottom: { style: 'thin', color: { rgb: '666666' } },
    left: { style: 'thin', color: { rgb: '666666' } },
    right: { style: 'thin', color: { rgb: '666666' } }
  }
  const fill = (rgb) => ({ patternType: 'solid', fgColor: { rgb } })
  const departmentColors = {
    mkt: 'F4CCCC',
    sale: 'B6D7A8',
    cskh: 'D9EAD3',
    'van don': '9FC5E8',
    'van phòng': '9FC5E8',
    'nhan su': 'D9D2E9'
  }
  const dayColors = ['B6D7A8', 'D9D2E9', 'FCE5CD', 'CFE2F3', 'FFF2CC', 'D9EAD3', 'F4CCCC']
  const [year, monthNumber] = month.split('-').map(Number)

  for (let row = 2; row < rowCount; row++) {
    for (let column = 0; column < columnCount; column++) {
      const address = XLSX.utils.encode_cell({ r: row, c: column })
      const cell = worksheet[address] || { t: 's', v: '' }
      worksheet[address] = cell
      const isDataRow = row >= dataStartRow
      const isSummaryRow = row === 2
      const isHeader = row >= 3 && row < dataStartRow
      const isDayColumn = column >= dayStartColumn
      let background = 'FFFFFF'
      let fontColor = '000000'
      let bold = isSummaryRow || isHeader
      let horizontal = column === 1 && isDataRow ? 'left' : 'center'
      let numberFormat

      if (isSummaryRow && column >= 6 && column < dayStartColumn) {
        background = 'FFF200'
      } else if (isHeader) {
        if (isDayColumn) {
          if (row === 3) background = 'D9EAD3'
          else if (row === 4) background = dayColors[(column - dayStartColumn) % dayColors.length]
          else {
            const day = column - dayStartColumn + 1
            const weekday = new Date(year, monthNumber - 1, day).getDay()
            background = weekday === 0 ? 'F4CCCC' : 'F6B26B'
          }
        } else if (column <= 5) {
          background = 'FFFFFF'
        } else if (column === 15) {
          background = 'C9DAF8'
        } else {
          background = 'FFF2CC'
        }
      } else if (isDataRow) {
        const summaryRow = rows[row - dataStartRow]
        if (column === 2) {
          const department = normalizeString(summaryRow?.department || '')
          const matchedKey = Object.keys(departmentColors).find(key => department.includes(key))
          if (matchedKey) background = departmentColors[matchedKey]
        } else if (column === 3) {
          const shift = normalizeString(summaryRow?.shift || '')
          if (shift.includes('dem')) background = 'FCE5CD'
          else if (shift.includes('online')) background = 'F4CCCC'
          else if (shift) background = 'FFF2CC'
        } else if (column === 4) {
          background = 'D9EAD3'
        } else if (column === 15) {
          background = 'D9EAF7'
          bold = true
        } else if (column === 24) {
          background = 'FFF2CC'
          bold = true
        } else if (isDayColumn) {
          const day = column - dayStartColumn + 1
          const date = `${month}-${String(day).padStart(2, '0')}`
          const daySummary = summaryRow?.days.get(date)
          const weekday = new Date(
            Number(month.slice(0, 4)),
            monthNumber - 1,
            day
          ).getDay()
          if (weekday === 0) background = 'FCE8E6'
          if (daySummary?.paidLeaveWorkdays > 0) background = 'D9EAD3'
          else if (daySummary?.unapprovedAbsence) {
            background = 'EA9999'
            fontColor = '990000'
            bold = true
          } else if (daySummary?.missingPunch) {
            background = 'FFF2CC'
            fontColor = 'B45F06'
          }
        }
      }

      if (isDataRow || isSummaryRow) {
        if ([8, 10, 12, 14, 15, 16].includes(column)) numberFormat = '#,##0'
        else if (column >= 17 || isDayColumn) numberFormat = '0.00'
        else if (column >= 6) numberFormat = '0'
      }

      cell.s = {
        border,
        alignment: {
          horizontal,
          vertical: 'center',
          wrapText: true
        },
        font: {
          name: 'Times New Roman',
          sz: isHeader ? 10 : 9,
          bold,
          color: { rgb: fontColor }
        },
        fill: fill(background),
        ...(numberFormat ? { numFmt: numberFormat } : {})
      }
    }
  }
}

export const appendAttendanceSummarySheet = (
  workbook,
  rows,
  month,
  optionRows = rows,
  attendanceSettings = {}
) => {
  const [year, monthNumber] = month.split('-').map(Number)
  const daysInMonth = new Date(year, monthNumber, 0).getDate()
  const dayStartColumn = 27
  const reportPolicy = normalizeAttendanceShiftSettings(attendanceSettings)
  const lateThreshold = reportPolicy.latePenaltyThresholdMinutes
  const staticHeaders = [
    'STT',
    'Họ tên',
    'Bộ phận',
    'Ca làm',
    'Loại HĐ',
    'Trạng thái',
    `Tổng số lần đi muộn <${lateThreshold}'`,
    `Tổng số lần đi muộn ≥${lateThreshold}'`,
    'Phạt đi muộn',
    'Tổng số lần về sớm',
    'Phạt về sớm',
    'Tổng số lần quên chấm công',
    'Phạt quên chấm công',
    'Nghỉ không phép không được duyệt',
    'Phạt nghỉ không phép',
    'Tổng phạt',
    'Vé xe',
    'Công chuẩn',
    'Giờ tăng ca',
    'Thử việc',
    'Công chính thức thực tế',
    'Ngày nghỉ có lương',
    'Công lễ chính thức',
    'Công lễ thử việc',
    'Tổng công',
    'Công làm việc online',
    'Công làm việc offline'
  ]
  const dayHeaders = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1
    return `${String(day).padStart(2, '0')}/${String(monthNumber).padStart(2, '0')}`
  })
  const dayLabels = Array.from({ length: daysInMonth }, (_, index) =>
    DAY_LABELS[new Date(year, monthNumber - 1, index + 1).getDay()]
  )
  const dataRows = rows.map((row, index) => {
    const dayValues = Array.from({ length: daysInMonth }, (_, dayIndex) => {
      const date = `${month}-${String(dayIndex + 1).padStart(2, '0')}`
      return dayValueForReport(row.days.get(date))
    })

    return [
      index + 1,
      row.employeeName,
      row.department,
      String(row.shift || '').toUpperCase(),
      contractTypeForReport(row),
      employmentStatusForReport(row),
      row.lateUnder30Count,
      row.lateOver30Count,
      0,
      row.earlyCount,
      0,
      row.missingPunchCount,
      0,
      row.unapprovedAbsenceCount,
      0,
      0,
      0,
      reportPolicy.monthlyStandardWorkUnits,
      row.overtimeHours,
      row.probationWorkdays,
      row.officialWorkdays,
      row.paidLeaveWorkdays,
      0,
      0,
      row.workdays,
      row.onlineWorkdays,
      row.offlineWorkdays,
      ...dayValues
    ]
  })
  const lastColumn = staticHeaders.length + daysInMonth - 1
  const groupHeaderRow = Array(lastColumn + 1).fill('')
  const detailHeaderRow = Array(lastColumn + 1).fill('')
  const weekdayHeaderRow = Array(lastColumn + 1).fill('')
  const separatorHeaderRow = Array(lastColumn + 1).fill('')

  staticHeaders.slice(0, 6).forEach((header, column) => {
    groupHeaderRow[column] = header
  })
  groupHeaderRow[6] = 'Phạt Nội quy'
  staticHeaders.slice(15).forEach((header, index) => {
    groupHeaderRow[index + 15] = header
  })
  groupHeaderRow[dayStartColumn] = 'Ngày :'
  staticHeaders.slice(6, 15).forEach((header, index) => {
    detailHeaderRow[index + 6] = header
  })
  dayHeaders.forEach((header, index) => {
    detailHeaderRow[dayStartColumn + index] = header
    weekdayHeaderRow[dayStartColumn + index] = dayLabels[index]
  })

  const worksheet = XLSX.utils.aoa_to_sheet([
    [],
    [],
    Array(lastColumn + 1).fill(''),
    groupHeaderRow,
    detailHeaderRow,
    weekdayHeaderRow,
    separatorHeaderRow,
    ...dataRows
  ])
  const dataStartRow = 7
  const firstDataExcelRow = dataStartRow + 1
  const lastDataExcelRow = firstDataExcelRow + rows.length - 1

  worksheet['!merges'] = [
    ...staticHeaders.slice(0, 6).map((_, column) => ({
      s: { r: 3, c: column },
      e: { r: 6, c: column }
    })),
    { s: { r: 3, c: 6 }, e: { r: 3, c: 14 } },
    ...staticHeaders.slice(6, 15).map((_, index) => ({
      s: { r: 4, c: index + 6 },
      e: { r: 6, c: index + 6 }
    })),
    ...staticHeaders.slice(15).map((_, index) => ({
      s: { r: 3, c: index + 15 },
      e: { r: 6, c: index + 15 }
    })),
    { s: { r: 3, c: dayStartColumn }, e: { r: 3, c: lastColumn } },
    ...dayHeaders.map((_, index) => ({
      s: { r: 5, c: dayStartColumn + index },
      e: { r: 6, c: dayStartColumn + index }
    }))
  ]
  worksheet['!cols'] = [
    { wch: 6 },
    { wch: 28 },
    { wch: 20 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    ...Array.from({ length: 10 }, () => ({ wch: 16 })),
    { wch: 12 },
    { wch: 12 },
    { wch: 14 },
    { wch: 12 },
    { wch: 20 },
    { wch: 18 },
    { wch: 18 },
    { wch: 16 },
    { wch: 12 },
    { wch: 20 },
    { wch: 20 },
    ...Array.from({ length: daysInMonth }, () => ({ wch: 9 }))
  ]
  worksheet['!rows'] = [
    { hpt: 10 },
    { hpt: 10 },
    { hpt: 22 },
    { hpt: 20 },
    { hpt: 52 },
    { hpt: 22 },
    { hpt: 8 },
    ...Array.from({ length: rows.length }, () => ({ hpt: 20 }))
  ]
  worksheet['!pageSetup'] = {
    orientation: 'landscape',
    fitToWidth: 1,
    fitToHeight: 0,
    paperSize: 9
  }
  worksheet['!margins'] = {
    left: 0.2,
    right: 0.2,
    top: 0.3,
    bottom: 0.3,
    header: 0.1,
    footer: 0.1
  }
  if (rows.length > 0) {
    worksheet['!autofilter'] = {
      ref: `B4:F${lastDataExcelRow}`
    }
  }

  if (rows.length > 0) {
    for (let column = 6; column < dayStartColumn; column++) {
      const address = XLSX.utils.encode_cell({ r: 2, c: column })
      const columnName = XLSX.utils.encode_col(column)
      worksheet[address] = {
        t: 'n',
        v: dataRows.reduce(
          (total, row) => total + (Number(row[column]) || 0),
          0
        ),
        f: `SUM(${columnName}${firstDataExcelRow}:${columnName}${lastDataExcelRow})`
      }
    }

    rows.forEach((row, index) => {
      const excelRow = firstDataExcelRow + index
      const penaltyCell = worksheet[XLSX.utils.encode_cell({ r: excelRow - 1, c: 15 })]
      const totalWorkdayCell = worksheet[XLSX.utils.encode_cell({ r: excelRow - 1, c: 24 })]
      penaltyCell.f = `I${excelRow}+K${excelRow}+M${excelRow}+O${excelRow}`
      totalWorkdayCell.f = `T${excelRow}+U${excelRow}+V${excelRow}+W${excelRow}+X${excelRow}`
      totalWorkdayCell.v = row.workdays
    })
  }

  applyMonthlyReportStyles({
    worksheet,
    rows,
    month,
    rowCount: dataRows.length + dataStartRow,
    columnCount: lastColumn + 1,
    dayStartColumn,
    dataStartRow
  })
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Bảng công tháng')
  appendAttendanceValidationSheet(workbook, optionRows)
  return {
    firstDataExcelRow,
    lastDataExcelRow
  }
}


// Memoized Input Component to prevent re-renders on every keystroke
const MemoizedInput = ({ value, onSave, onFocus, placeholder, type = 'text', step, style, className }) => {
  const [localValue, setLocalValue] = useState(value || '')

  useEffect(() => {
    setLocalValue(value || '')
  }, [value])

  const handleChange = (e) => {
    const newVal = e.target.value
    setLocalValue(newVal)
  }

  // Debounce save (300ms) to update UI without clicking out
  useEffect(() => {
    const timer = setTimeout(() => {
      if (localValue !== value) {
        onSave(localValue)
      }
    }, 500) // 500ms delay

    return () => clearTimeout(timer)
  }, [localValue])

  return (
    <input
      type={type}
      step={step}
      className={className}
      style={style}
      placeholder={placeholder}
      value={localValue}
      onChange={handleChange}
      onFocus={onFocus}
    />
  )
}

function Attendance() {
  const [activeTab, setActiveTab] = useState('attendance')

  const [attendanceLogs, setAttendanceLogs] = useState([])
  const [payrolls, setPayrolls] = useState([])
  const [insuranceInfo, setInsuranceInfo] = useState([])
  const [taxInfo, setTaxInfo] = useState([])
  const [dependents, setDependents] = useState([])
  const [approvalRequests, setApprovalRequests] = useState([])
  const [employees, setEmployees] = useState([])
  const [attendanceSettings, setAttendanceSettings] = useState(() => normalizeAttendanceShiftSettings())
  const [loading, setLoading] = useState(true)

  // Modal states
  const [isAttendanceModalOpen, setIsAttendanceModalOpen] = useState(false)
  const [isImportModalOpen, setIsImportModalOpen] = useState(false)
  const [isAttendanceSettingsOpen, setIsAttendanceSettingsOpen] = useState(false)
  const [isPayrollDetailModalOpen, setIsPayrollDetailModalOpen] = useState(false)
  const [isInsuranceModalOpen, setIsInsuranceModalOpen] = useState(false)
  const [isTaxModalOpen, setIsTaxModalOpen] = useState(false)
  const [isDependentModalOpen, setIsDependentModalOpen] = useState(false)
  const [isPayslipModalOpen, setIsPayslipModalOpen] = useState(false)

  // Selected items
  const [selectedPayroll, setSelectedPayroll] = useState(null)
  const [selectedInsurance, setSelectedInsurance] = useState(null)
  const [selectedTax, setSelectedTax] = useState(null)
  const [selectedDependent, setSelectedDependent] = useState(null)
  const [selectedPayslip, setSelectedPayslip] = useState(null)
  const [selectedAttendance, setSelectedAttendance] = useState(null)

  // Read-only states
  const [isAttendanceReadOnly, setIsAttendanceReadOnly] = useState(false)
  const [isPayrollReadOnly, setIsPayrollReadOnly] = useState(false)
  const [isInsuranceReadOnly, setIsInsuranceReadOnly] = useState(false)
  const [isDependentReadOnly, setIsDependentReadOnly] = useState(false)
  const [isTaxReadOnly, setIsTaxReadOnly] = useState(false)

  // Filters
  const [filterPayrollPeriod, setFilterPayrollPeriod] = useState('')
  const [filterPayrollDept, setFilterPayrollDept] = useState('')
  const [filterPayrollStatus, setFilterPayrollStatus] = useState('')
  const [attendanceAdjustments, setAttendanceAdjustments] = useState({})
  const [manualWorkdays, setManualWorkdays] = useState({}) // New State for Manual Overrides
  const [filterAttendanceMonth, setFilterAttendanceMonth] = useState(currentMonthValue)
  const [filterAttendanceEmployee, setFilterAttendanceEmployee] = useState('')
  const [filterAttendanceEmployeeKey, setFilterAttendanceEmployeeKey] = useState('')
  const [logsLoading, setLogsLoading] = useState(false)
  const [visibleLogCount, setVisibleLogCount] = useState(LOGS_PAGE_SIZE)
  const [tabDataLoaded, setTabDataLoaded] = useState({
    payroll: false,
    insurance: false,
    tax: false,
    dependents: false,
    approvals: false
  })
  const employeesRef = useRef([])
  const attendanceSettingsRef = useRef(attendanceSettings)
  const initialLoadDoneRef = useRef(false)
  const tabDataLoadedRef = useRef(tabDataLoaded)
  const filterMonthRef = useRef(filterAttendanceMonth)

  useEffect(() => {
    employeesRef.current = employees
  }, [employees])

  useEffect(() => {
    attendanceSettingsRef.current = attendanceSettings
  }, [attendanceSettings])

  useEffect(() => {
    filterMonthRef.current = filterAttendanceMonth
  }, [filterAttendanceMonth])

  const monthOptions = useMemo(
    () => buildRecentMonthOptions(filterAttendanceMonth),
    [filterAttendanceMonth]
  )

  const employeesById = useMemo(
    () => new Map(employees.map(employee => [String(employee.id), employee])),
    [employees]
  )

  const attendanceEmployeeOptions = useMemo(() => {
    const uniqueEmployees = new Map()

    attendanceLogs.forEach(log => {
      const employee = employeesById.get(String(log.employeeId))
      const name = String(
        log.employeeName ||
        employee?.ho_va_ten ||
        employee?.name ||
        log.machineName ||
        log.tenTheoMayChamCong ||
        ''
      ).replace(/\s+/g, ' ').trim()
      const code = String(
        log.employeeCode ||
        employee?.employeeId ||
        employee?.username ||
        ''
      ).trim()
      const key = buildAttendanceEmployeeFilterKey(name, code)
      if (!key) return

      const existing = uniqueEmployees.get(key)
      if (existing) {
        existing.recordCount += 1
        if (code) existing.codes.add(code)
        return
      }

      uniqueEmployees.set(key, {
        key,
        name: name || code,
        codes: new Set(code ? [code] : []),
        recordCount: 1
      })
    })

    return Array.from(uniqueEmployees.values())
      .map(option => ({ ...option, codes: Array.from(option.codes) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'))
  }, [attendanceLogs, employeesById])

  const filteredAttendanceLogs = useMemo(
    () => attendanceLogs.filter(log => {
      const employee = employeesById.get(String(log.employeeId))
      const employeeName =
        log.employeeName ||
        employee?.ho_va_ten ||
        employee?.name ||
        log.machineName ||
        log.tenTheoMayChamCong ||
        ''
      const employeeCode =
        log.employeeCode ||
        employee?.employeeId ||
        employee?.username ||
        ''

      if (filterAttendanceEmployee) {
        const machineName = log.machineName || log.tenTheoMayChamCong || ''
        const searchTerm = normalizeString(filterAttendanceEmployee)
        const matchesSearch =
          normalizeString(employeeName).includes(searchTerm) ||
          normalizeString(machineName).includes(searchTerm) ||
          normalizeString(employeeCode || log.employeeId).includes(searchTerm)
        if (!matchesSearch) return false
      }

      if (
        filterAttendanceEmployeeKey &&
        buildAttendanceEmployeeFilterKey(employeeName, employeeCode) !==
          filterAttendanceEmployeeKey
      ) {
        return false
      }

      return true
    }),
    [
      attendanceLogs,
      employeesById,
      filterAttendanceEmployee,
      filterAttendanceEmployeeKey
    ]
  )

  const sortedFilteredAttendanceLogs = useMemo(() => {
    return filteredAttendanceLogs.slice().sort((a, b) => {
      const empA = employeesById.get(String(a.employeeId))
      const empB = employeesById.get(String(b.employeeId))
      const nameA = empA?.ho_va_ten || empA?.name || a.employeeName || a.employeeId || ''
      const nameB = empB?.ho_va_ten || empB?.name || b.employeeName || b.employeeId || ''
      if (nameA !== nameB) return nameA.localeCompare(nameB, 'vi')
      const dateA = new Date(a.date || a.timestamp).getTime()
      const dateB = new Date(b.date || b.timestamp).getTime()
      return dateA - dateB
    })
  }, [employeesById, filteredAttendanceLogs])

  const visibleAttendanceLogs = useMemo(
    () => sortedFilteredAttendanceLogs.slice(0, visibleLogCount),
    [sortedFilteredAttendanceLogs, visibleLogCount]
  )

  useEffect(() => {
    setVisibleLogCount(LOGS_PAGE_SIZE)
  }, [filterAttendanceMonth, filterAttendanceEmployee, filterAttendanceEmployeeKey])

  const needsWorkdaySummary = activeTab === 'workday_summary'

  const dailyAttendanceMap = useMemo(
    () => {
      if (!needsWorkdaySummary) return new Map()
      return buildDailyAttendanceMap(
        attendanceLogs,
        filterAttendanceMonth,
        employees,
        attendanceSettings
      )
    },
    [attendanceLogs, attendanceSettings, employees, filterAttendanceMonth, needsWorkdaySummary]
  )

  const paidLeaveStatsByEmployee = useMemo(() => {
    const stats = new Map()
    if (!needsWorkdaySummary) return stats

    approvalRequests.forEach((request) => {
      if (!isPaidLeaveRequest(request)) return
      const leaveDates = listRequestLeaveDates(request)
      const belongsToMonth = leaveDates.length
        ? leaveDates.some((date) => date.startsWith(filterAttendanceMonth))
        : String(request.createdAt || '').startsWith(filterAttendanceMonth)
      if (!belongsToMonth) return

      const employee =
        employeesById.get(String(request.requesterId)) ||
        employees.find((item) =>
          (request.requesterCode &&
            String(item.employeeId || item.username || '') ===
            String(request.requesterCode)) ||
          (request.requesterName &&
            normalizeString(item.ho_va_ten || item.name || '') ===
            normalizeString(request.requesterName))
        )
      const employeeId = String(employee?.id || request.requesterId || '')
      if (!employeeId) return

      if (!stats.has(employeeId)) {
        stats.set(employeeId, {
          employee,
          approved: 0,
          rejected: 0,
          pending: 0
        })
      }
      const row = stats.get(employeeId)
      if (request.status === 'approved') row.approved += 1
      else if (request.status === 'rejected') row.rejected += 1
      else row.pending += 1
    })

    return stats
  }, [approvalRequests, employees, employeesById, filterAttendanceMonth, needsWorkdaySummary])

  const attendanceSummary = useMemo(
    () => {
      if (!needsWorkdaySummary) return []
      const baseRows = buildAttendanceSummary({
      attendanceLogs,
      employees,
      month: filterAttendanceMonth,
      attendanceAdjustments,
      manualWorkdays,
      attendanceSettings
      })
      const rowsByEmployee = new Map(
        baseRows.map((row) => [String(row.employeeId), row])
      )

      paidLeaveStatsByEmployee.forEach((leaveStats, employeeId) => {
        const leaveStatsEmployee = leaveStats.employee || employeesById.get(employeeId)
        if (!rowsByEmployee.has(employeeId)) {
          rowsByEmployee.set(employeeId, {
            employeeId,
            employeeCode: leaveStatsEmployee?.employeeId || leaveStatsEmployee?.username || '',
            employeeName: leaveStatsEmployee?.ho_va_ten || leaveStatsEmployee?.name || '',
            department: leaveStatsEmployee?.bo_phan || leaveStatsEmployee?.department || '',
            branch: leaveStatsEmployee?.chi_nhanh || leaveStatsEmployee?.branch || '',
            attendanceDays: 0,
            workdays: 0,
            totalHours: 0,
            lateCount: 0,
            lateMinutes: 0,
            earlyCount: 0,
            earlyMinutes: 0,
            days: new Map()
          })
        }
      })

      return Array.from(rowsByEmployee.values())
        .map((row) => {
          const leaveStats = paidLeaveStatsByEmployee.get(String(row.employeeId))
          return {
            ...row,
            paidLeaveApproved: leaveStats?.approved || 0,
            paidLeaveRejected: leaveStats?.rejected || 0,
            paidLeavePending: leaveStats?.pending || 0
          }
        })
        .sort((left, right) =>
          String(left.employeeName).localeCompare(String(right.employeeName), 'vi')
        )
    },
    [
      attendanceLogs,
      employees,
      employeesById,
      filterAttendanceMonth,
      attendanceAdjustments,
      manualWorkdays,
      attendanceSettings,
      paidLeaveStatsByEmployee,
      needsWorkdaySummary
    ]
  )

  const filteredAttendanceSummary = useMemo(() => {
    const searchTerm = normalizeString(filterAttendanceEmployee)
    return attendanceSummary.filter(row =>
      (!searchTerm ||
        normalizeString(row.employeeName).includes(searchTerm) ||
        normalizeString(row.employeeCode).includes(searchTerm) ||
        normalizeString(row.department).includes(searchTerm)) &&
      (!filterAttendanceEmployeeKey ||
        buildAttendanceEmployeeFilterKey(row.employeeName, row.employeeCode) ===
          filterAttendanceEmployeeKey)
    )
  }, [attendanceSummary, filterAttendanceEmployee, filterAttendanceEmployeeKey])

  useEffect(() => {
    loadData()
  }, [])

  const loadMonthScopedData = useCallback(async (targetMonth) => {
    const month = String(targetMonth || '').trim() || currentMonthValue()
    setLogsLoading(true)
    try {
      const [attendanceLogsData, adjustments, manuals] = await Promise.all([
        fbGetAttendanceLogsByMonth(month),
        fbGet(`hr/attendanceAdjustments/${month}`),
        fbGet(`hr/manualWorkdays/${month}`)
      ])
      if (filterMonthRef.current !== month) return
      setAttendanceLogs(mapAttendanceLogs(attendanceLogsData))
      setAttendanceAdjustments(adjustments || {})
      setManualWorkdays(manuals || {})
    } catch (error) {
      console.error('Không tải được chấm công theo tháng:', error)
      if (filterMonthRef.current === month) {
        setAttendanceLogs([])
        setAttendanceAdjustments({})
        setManualWorkdays({})
      }
    } finally {
      setLogsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!initialLoadDoneRef.current) return
    if (!filterAttendanceMonth) return
    loadMonthScopedData(filterAttendanceMonth)
  }, [filterAttendanceMonth, loadMonthScopedData])

  const loadApprovals = useCallback(async () => {
    if (tabDataLoadedRef.current.approvals) return
    try {
      const approvalRequestsData = await fbGet('hr/approvalRequests')
      setApprovalRequests(
        approvalRequestsData
          ? Object.entries(approvalRequestsData).map(([id, value]) => ({
              ...value,
              id
            }))
          : []
      )
      setTabDataLoaded(prev => {
        const next = { ...prev, approvals: true }
        tabDataLoadedRef.current = next
        return next
      })
    } catch (error) {
      console.error('Không tải được đơn phép:', error)
    }
  }, [])

  const loadTabCollection = useCallback(async (tab) => {
    if (tabDataLoadedRef.current[tab]) return
    try {
      if (tab === 'payroll') {
        const payrollsData = await fbGet('hr/payrolls')
        setPayrolls(
          payrollsData
            ? Object.entries(payrollsData).map(([id, value]) => ({ ...value, id }))
            : []
        )
      } else if (tab === 'insurance') {
        const insuranceData = await fbGet('hr/insuranceInfo')
        setInsuranceInfo(
          insuranceData
            ? Object.entries(insuranceData).map(([id, value]) => ({ ...value, id }))
            : []
        )
      } else if (tab === 'tax') {
        const taxData = await fbGet('hr/taxInfo')
        setTaxInfo(
          taxData
            ? Object.entries(taxData).map(([id, value]) => ({ ...value, id }))
            : []
        )
      } else if (tab === 'dependents') {
        const dependentsData = await fbGet('hr/dependents')
        setDependents(
          dependentsData
            ? Object.entries(dependentsData).map(([id, value]) => ({ ...value, id }))
            : []
        )
      }
      setTabDataLoaded(prev => {
        const next = { ...prev, [tab]: true }
        tabDataLoadedRef.current = next
        return next
      })
    } catch (error) {
      console.error(`Không tải được dữ liệu tab ${tab}:`, error)
    }
  }, [])

  useEffect(() => {
    if (
      activeTab === 'payroll' ||
      activeTab === 'insurance' ||
      activeTab === 'tax' ||
      activeTab === 'dependents'
    ) {
      loadTabCollection(activeTab)
    }
    if (activeTab === 'workday_summary') {
      loadApprovals()
    }
  }, [activeTab, loadApprovals, loadTabCollection])

  const loadData = async () => {
    try {
      setLoading(true)
      setLogsLoading(true)
      const month = filterMonthRef.current || currentMonthValue()

      // Unlock shell quickly with directory + settings, then fill month logs.
      const [empData, storedAttendanceSettings] = await Promise.all([
        fbGetEmployeesDirectory(),
        fbGet('hr/attendanceSettings/default')
      ])

      const nextAttendanceSettings = normalizeAttendanceShiftSettings(storedAttendanceSettings)
      setAttendanceSettings(nextAttendanceSettings)
      attendanceSettingsRef.current = nextAttendanceSettings

      const empList = normalizeEmployeeList(empData)
      employeesRef.current = empList
      setEmployees(empList)
      setLoading(false)
      initialLoadDoneRef.current = true

      const [attendanceLogsData, adjustments, manuals] = await Promise.all([
        fbGetAttendanceLogsByMonth(month),
        fbGet(`hr/attendanceAdjustments/${month}`),
        fbGet(`hr/manualWorkdays/${month}`)
      ])

      if (filterMonthRef.current === month) {
        setAttendanceLogs(mapAttendanceLogs(attendanceLogsData))
        setAttendanceAdjustments(adjustments || {})
        setManualWorkdays(manuals || {})
      }

      const refreshJobs = []
      if (tabDataLoadedRef.current.payroll) {
        refreshJobs.push(
          fbGet('hr/payrolls').then(payrollsData => {
            setPayrolls(
              payrollsData
                ? Object.entries(payrollsData).map(([id, value]) => ({ ...value, id }))
                : []
            )
          })
        )
      }
      if (tabDataLoadedRef.current.insurance) {
        refreshJobs.push(
          fbGet('hr/insuranceInfo').then(insuranceData => {
            setInsuranceInfo(
              insuranceData
                ? Object.entries(insuranceData).map(([id, value]) => ({ ...value, id }))
                : []
            )
          })
        )
      }
      if (tabDataLoadedRef.current.tax) {
        refreshJobs.push(
          fbGet('hr/taxInfo').then(taxData => {
            setTaxInfo(
              taxData
                ? Object.entries(taxData).map(([id, value]) => ({ ...value, id }))
                : []
            )
          })
        )
      }
      if (tabDataLoadedRef.current.dependents) {
        refreshJobs.push(
          fbGet('hr/dependents').then(dependentsData => {
            setDependents(
              dependentsData
                ? Object.entries(dependentsData).map(([id, value]) => ({ ...value, id }))
                : []
            )
          })
        )
      }
      if (tabDataLoadedRef.current.approvals) {
        refreshJobs.push(
          fbGet('hr/approvalRequests').then(approvalRequestsData => {
            setApprovalRequests(
              approvalRequestsData
                ? Object.entries(approvalRequestsData).map(([id, value]) => ({
                    ...value,
                    id
                  }))
                : []
            )
          })
        )
      }
      if (refreshJobs.length) await Promise.all(refreshJobs)
    } catch (error) {
      console.error('Error loading attendance data:', error)
      initialLoadDoneRef.current = true
      setLoading(false)
    } finally {
      setLogsLoading(false)
    }
  }

  const handleDeleteAttendance = async (id) => {
    if (!confirm('Bạn có chắc muốn xóa bản ghi chấm công này?')) return
    try {
      await fbDelete(`hr/attendanceLogs/${id}`)
      setAttendanceLogs(prev => prev.filter(item => item.id !== id))
      alert('Đã xóa bản ghi chấm công')
    } catch (error) {
      alert('Lỗi khi xóa: ' + error.message)
    }
  }

  const handleDeleteAllAttendance = async () => {
    if (!confirm('CẢNH BÁO: Bạn có chắc chắn muốn XÓA TOÀN BỘ dữ liệu chấm công không? Hành động này không thể hoàn tác!')) return
    try {
      setLoading(true)
      await fbDelete('hr/attendanceLogs')
      setAttendanceLogs([])
      setLoading(false)
      alert('Đã xóa toàn bộ dữ liệu chấm công thành công!')
    } catch (error) {
      alert('Lỗi khi xóa dữ liệu: ' + error.message)
      setLoading(false)
    }
  }

  const handleDeleteInsurance = async (id) => {
    if (!confirm('Bạn có chắc muốn xóa thông tin BHXH này?')) return
    try {
      await fbDelete(`hr/insuranceInfo/${id}`)
      setInsuranceInfo(prev => prev.filter(item => item.id !== id))
      alert('Đã xóa thông tin BHXH')
    } catch (error) {
      alert('Lỗi khi xóa: ' + error.message)
    }
  }

  const handleDeleteTax = async (id) => {
    if (!confirm('Bạn có chắc muốn xóa thông tin thuế này?')) return
    try {
      await fbDelete(`hr/taxInfo/${id}`)
      setTaxInfo(prev => prev.filter(item => item.id !== id))
      alert('Đã xóa thông tin thuế')
    } catch (error) {
      alert('Lỗi khi xóa: ' + error.message)
    }
  }

  const handleDeleteDependent = async (id) => {
    if (!confirm('Bạn có chắc muốn xóa người phụ thuộc này?')) return
    try {
      await fbDelete(`hr/dependents/${id}`)
      setDependents(prev => prev.filter(item => item.id !== id))
      alert('Đã xóa người phụ thuộc')
    } catch (error) {
      alert('Lỗi khi xóa: ' + error.message)
    }
  }

  // Get employee name
  const getEmployeeName = (employeeId) => {
    const emp = employees.find(e => e.id === employeeId)
    return emp ? (emp.ho_va_ten || emp.name || 'N/A') : employeeId || 'N/A'
  }

  const handleDeletePayroll = async (id) => {
    if (!confirm('Bạn có chắc muốn xóa bảng lương này?')) return
    try {
      await fbDelete(`hr/payrolls/${id}`)
      setPayrolls(prev => prev.filter(item => item.id !== id))
      alert('Đã xóa bảng lương')
    } catch (error) {
      alert('Lỗi khi xóa: ' + error.message)
    }
  }

  // Filter payrolls
  const filteredPayrolls = payrolls.filter(payroll => {
    if (filterPayrollPeriod && payroll.period !== filterPayrollPeriod) return false
    if (filterPayrollDept && payroll.department !== filterPayrollDept) return false
    if (filterPayrollStatus && payroll.status !== filterPayrollStatus) return false
    return true
  })

  // Calculate total deductions
  const calculateTotalDeductions = (payroll) => {
    return (payroll.bhxh || 0) + (payroll.thueTNCN || 0) + (payroll.tamUng || 0) + (payroll.khac || 0)
  }

  // Calculate net salary
  const calculateNetSalary = (payroll) => {
    const totalIncome = (payroll.luong3P || 0) + (payroll.luongNgayCong || 0) + (payroll.thuongNong || 0)
    const totalDeductions = calculateTotalDeductions(payroll)
    return totalIncome - totalDeductions
  }

  // --- START EXCEL FUNCTIONS ---

  // 1. PAYROLL EXCEL
  const exportPayrollToExcel = async () => {
    await ensureXlsx()
    if (filteredPayrolls.length === 0) {
      alert('Không có dữ liệu bảng lương để xuất!')
      return
    }
    const data = filteredPayrolls.map((p, idx) => {
      const emp = employees.find(e => e.id === p.employeeId)
      const totalIncome = (p.luong3P || 0) + (p.luongNgayCong || 0) + (p.thuongNong || 0)
      const totalDeductions = calculateTotalDeductions(p)
      const netSalary = calculateNetSalary(p)

      return {
        'STT': idx + 1,
        'Mã NV': p.employeeId,
        'Họ tên': emp ? (emp.ho_va_ten || emp.name) : '',
        'Bộ phận': p.department,
        'Kỳ lương': p.period || '',
        'Công thực tế': p.congThucTe || 0,
        'Lương P1': p.luongP1 || 0,
        'Kết quả P3': p.ketQuaP3 || '',
        'Lương 3P': p.luong3P || 0,
        'Lương ngày công': p.luongNgayCong || 0,
        'Thưởng nóng': p.thuongNong || 0,
        'Tổng thu nhập': totalIncome,
        'BHXH': p.bhxh || 0,
        'Thuế TNCN': p.thueTNCN || 0,
        'Tạm ứng': p.tamUng || 0,
        'Khấu trừ khác': p.khac || 0,
        'Thực lĩnh': netSalary,
        'Trạng thái': p.status || ''
      }
    })
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'BangLuong')
    XLSX.writeFile(wb, `Bang_Luong_${filterPayrollPeriod || 'Tong_hop'}.xlsx`)
  }

  // Import for Payroll is tricky as it's usually calculated.
  // But we can allow importing "Thưởng nóng" or "Manual Adjustments".
  // For now, let's keep it simple: No Import for Payroll requested explicitly, 
  // but usually users want to Export Reports.
  // If user wants import, we can add later. "Tiếp sang phần chấm công nhớ logic hợp lý nhé" implies Attendance is focus.
  // But let's add Export for Insurance/Tax/Dependents as they are data tables.


  // 2. INSURANCE EXCEL
  const exportInsuranceToExcel = async () => {
    await ensureXlsx()
    if (insuranceInfo.length === 0) {
      alert('Không có dữ liệu BHXH để xuất!')
      return
    }
    const data = insuranceInfo.map((i, idx) => {
      const emp = employees.find(e => e.id === i.employeeId)
      return {
        'STT': idx + 1,
        'Mã NV': i.employeeId,
        'Họ tên': emp ? (emp.ho_va_ten || emp.name) : '',
        'Số sổ BHXH': i.soSoBHXH || '',
        'Ngày tham gia': i.ngayThamGia || '',
        'Mức lương đóng': i.mucLuongDong || 0,
        'Tỷ lệ NLĐ (%)': i.tyLeNLD || 10.5,
        'Tỷ lệ DN (%)': i.tyLeDN || 21.5,
        'Trạng thái': i.status || ''
      }
    })
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'BHXH')
    XLSX.writeFile(wb, 'Danh_sach_BHXH.xlsx')
  }

  const downloadInsuranceTemplate = async () => {
    await ensureXlsx()
    const headers = ['Mã NV', 'Số sổ BHXH', 'Ngày tham gia (YYYY-MM-DD)', 'Mức lương đóng', 'Tỷ lệ NLĐ (%)', 'Trạng thái']
    const sample = ['NV001', '123456789', '2024-01-01', 5000000, 10.5, 'Đang tham gia']
    const ws = XLSX.utils.aoa_to_sheet([headers, sample])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'MauBHXH')
    XLSX.writeFile(wb, 'Mau_import_BHXH.xlsx')
  }

  // Reuse AttendanceImport logic? No, specific fields.
  // We need a generic handle import function or specific ones. 
  // Let's make a generic helper or separate functions. Separate is safer for validation.
  const handleInsuranceImportFile = async (e) => {
    await ensureXlsx()
    const file = e.target.files[0]
    if (!file) return
    try {
      const data = await file.arrayBuffer()
      const wb = XLSX.read(data)
      const ws = wb.Sheets[wb.SheetNames[0]]
      const json = XLSX.utils.sheet_to_json(ws)

      let count = 0
      for (const row of json) {
        const empCode = row['Mã NV']
        if (!empCode) continue

        // Find existing or new? Assuming update/create based on EmpID
        const payload = {
          employeeId: empCode,
          soSoBHXH: row['Số sổ BHXH'],
          ngayThamGia: row['Ngày tham gia (YYYY-MM-DD)'],
          mucLuongDong: row['Mức lương đóng'],
          tyLeNLD: row['Tỷ lệ NLĐ (%)'],
          tyLeDN: 21.5, // Default
          status: row['Trạng thái'] || 'Đang tham gia'
        }
        await fbPush('hr/insuranceInfo', payload)
        count++
      }
      alert(`Đã import ${count} bản ghi BHXH`)
      loadData()
    } catch (err) {
      alert('Lỗi import: ' + err.message)
    }
  }


  // 3. TAX EXCEL
  const exportTaxToExcel = async () => {
    await ensureXlsx()
    if (taxInfo.length === 0) {
      alert('Không có dữ liệu thuế để xuất!')
      return
    }
    const data = taxInfo.map((t, idx) => {
      const emp = employees.find(e => e.id === t.employeeId)
      return {
        'STT': idx + 1,
        'Mã NV': t.employeeId,
        'Họ tên': emp ? (emp.ho_va_ten || emp.name) : '',
        'Mã số thuế': t.maSoThue || '',
        'Số người phụ thuộc': t.soNguoiPhuThuoc || 0,
        'Giảm trừ gia cảnh (VNĐ)': 11000000,
        'Giảm trừ phụ thuộc (VNĐ)': (t.soNguoiPhuThuoc || 0) * 4400000
      }
    })
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'ThueTNCN')
    XLSX.writeFile(wb, 'Danh_sach_Thue_TNCN.xlsx')
  }

  const downloadTaxTemplate = async () => {
    await ensureXlsx()
    const headers = ['Mã NV', 'Mã số thuế', 'Số người phụ thuộc']
    const sample = ['NV001', '8000123456', 0]
    const ws = XLSX.utils.aoa_to_sheet([headers, sample])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'MauThue')
    XLSX.writeFile(wb, 'Mau_import_Thue_TNCN.xlsx')
  }

  const handleTaxImportFile = async (e) => {
    await ensureXlsx()
    const file = e.target.files[0]
    if (!file) return
    try {
      const data = await file.arrayBuffer()
      const wb = XLSX.read(data)
      const ws = wb.Sheets[wb.SheetNames[0]]
      const json = XLSX.utils.sheet_to_json(ws)

      let count = 0
      for (const row of json) {
        const empCode = row['Mã NV']
        if (!empCode) continue

        const payload = {
          employeeId: empCode,
          maSoThue: row['Mã số thuế'],
          soNguoiPhuThuoc: row['Số người phụ thuộc'] || 0
        }
        await fbPush('hr/taxInfo', payload)
        count++
      }
      alert(`Đã import ${count} bản ghi Thuế`)
      loadData()
    } catch (err) {
      alert('Lỗi import: ' + err.message)
    }
  }

  // 4. DEPENDENTS EXCEL
  const exportDependentsToExcel = async () => {
    await ensureXlsx()
    if (dependents.length === 0) {
      alert('Không có dữ liệu người phụ thuộc để xuất!')
      return
    }
    const data = dependents.map((d, idx) => {
      const emp = employees.find(e => e.id === d.employeeId)
      return {
        'STT': idx + 1,
        'Mã NV': d.employeeId,
        'Họ tên NV': emp ? (emp.ho_va_ten || emp.name) : '',
        'Tên người phụ thuộc': d.dependentName || '',
        'Mối quan hệ': d.relationship || '',
        'Ngày sinh': d.birthDate || '',
        'Mã số thuế NPT': d.taxCode || '',
        'Trạng thái': d.status || ''
      }
    })
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'NguoiPhuThuoc')
    XLSX.writeFile(wb, 'Danh_sach_Nguoi_Phu_Thuoc.xlsx')
  }

  const downloadDependentsTemplate = async () => {
    await ensureXlsx()
    const headers = ['Mã NV', 'Tên người phụ thuộc', 'Mối quan hệ', 'Ngày sinh (YYYY-MM-DD)', 'Mã số thuế NPT']
    const sample = ['NV001', 'Nguyễn Văn B', 'Con', '2015-05-20', '']
    const ws = XLSX.utils.aoa_to_sheet([headers, sample])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'MauNguoiPhuThuoc')
    XLSX.writeFile(wb, 'Mau_import_NPT.xlsx')
  }

  const handleDependentsImportFile = async (e) => {
    await ensureXlsx()
    const file = e.target.files[0]
    if (!file) return
    try {
      const data = await file.arrayBuffer()
      const wb = XLSX.read(data)
      const ws = wb.Sheets[wb.SheetNames[0]]
      const json = XLSX.utils.sheet_to_json(ws)

      let count = 0
      for (const row of json) {
        const empCode = row['Mã NV']
        if (!empCode) continue

        const payload = {
          employeeId: empCode,
          dependentName: row['Tên người phụ thuộc'],
          relationship: row['Mối quan hệ'],
          birthDate: row['Ngày sinh (YYYY-MM-DD)'],
          taxCode: row['Mã số thuế NPT'],
          status: 'Đã xác nhận'
        }
        await fbPush('hr/dependents', payload)
        count++
      }
      alert(`Đã import ${count} người phụ thuộc`)
      loadData()
    } catch (err) {
      alert('Lỗi import: ' + err.message)
    }
  }

  const handleOpenAttendancePreview = () => {
    window.open('/bang-cong-preview', '_blank', 'noopener,noreferrer')
  }

  const buildSummaryRowsForExport = useCallback(() => {
    const baseRows = buildAttendanceSummary({
      attendanceLogs,
      employees,
      month: filterAttendanceMonth,
      attendanceAdjustments,
      manualWorkdays,
      attendanceSettings
    })
    const searchTerm = normalizeString(filterAttendanceEmployee)
    return baseRows.filter(row =>
      (!searchTerm ||
        normalizeString(row.employeeName).includes(searchTerm) ||
        normalizeString(row.employeeCode).includes(searchTerm) ||
        normalizeString(row.department).includes(searchTerm)) &&
      (!filterAttendanceEmployeeKey ||
        buildAttendanceEmployeeFilterKey(row.employeeName, row.employeeCode) ===
          filterAttendanceEmployeeKey)
    )
  }, [
    attendanceAdjustments,
    attendanceLogs,
    attendanceSettings,
    employees,
    filterAttendanceEmployee,
    filterAttendanceEmployeeKey,
    filterAttendanceMonth,
    manualWorkdays
  ])

  // Export Attendance Data to Excel
  const handleExportAttendance = async () => {
    if (!filterAttendanceMonth) {
      alert('Vui lòng chọn tháng để xuất báo cáo chấm công theo nhân sự.')
      return
    }

    try {
      const rows = needsWorkdaySummary ? filteredAttendanceSummary : buildSummaryRowsForExport()
      await downloadAttendanceFromGoldenTemplate({
        rows,
        month: filterAttendanceMonth,
        attendanceSettings,
        fileName: `BANG_CONG_${filterAttendanceMonth}.xlsx`
      })
    } catch (error) {
      console.error('Không thể xuất báo cáo theo golden template:', error)
      alert('Không thể xuất báo cáo Excel: ' + error.message)
    }
  }

  const handleExportAttendanceSummary = async () => {
    if (!filterAttendanceMonth) {
      alert('Vui lòng chọn tháng cần xuất báo cáo.')
      return
    }
    const rows = needsWorkdaySummary ? filteredAttendanceSummary : buildSummaryRowsForExport()
    if (!rows.length) {
      alert('Không có dữ liệu tổng hợp trong tháng đã chọn.')
      return
    }

    await ensureXlsx()
    const workbook = XLSX.utils.book_new()
    const reportMeta = appendAttendanceSummarySheet(
      workbook,
      rows,
      filterAttendanceMonth,
      rows,
      attendanceSettings
    )
    try {
      await downloadAttendanceWorkbook(
        workbook,
        `Bao_cao_tong_hop_cong_${filterAttendanceMonth}_CO_DANH_SACH_CHON.xlsx`,
        reportMeta
      )
    } catch (error) {
      console.error('Không thể tạo danh sách lựa chọn trong Excel:', error)
      alert('Không thể xuất báo cáo Excel: ' + error.message)
    }
  }

  // --- NEW FEATURES: Calculate Workdays & Batch Export Payslips ---

  const handleCalculateWorkdays = async () => {
    // 1. Ask for Month
    const period = prompt('Nhập kỳ lương (YYYY-MM):', new Date().toISOString().slice(0, 7))
    if (!period) return

    if (!confirm(`Bạn có chắc muốn TÍNH CÔNG cho tháng ${period}? \nDữ liệu sẽ được cập nhật vào bảng lương.`)) return

    setLoading(true)
    try {
      // 2. Tổng hợp theo nhân viên + ngày để không tính trùng khi một ngày có nhiều ca.
      const periodSummary = buildAttendanceSummary({
        attendanceLogs,
        employees,
        month: period,
        attendanceAdjustments,
        manualWorkdays,
        attendanceSettings
      })
      const empWorkdays = Object.fromEntries(
        periodSummary.map(row => [row.employeeId, row.workdays])
      )

      // 3. Update or Create Payrolls
      let updateCount = 0

      // Iterate all employees to ensure everyone gets a record for the period? 
      // Or only those with attendance? Usually all active employees.
      for (const emp of employees) {
        const empId = emp.id
        const workdays = empWorkdays[empId] || 0

        // Find existing payroll
        const existingPayroll = payrolls.find(p => p.employeeId === empId && p.period === period)

        const payload = {
          period: period,
          congThucTe: workdays,
          // Recalculate salary based on new workdays?
          // If we update workdays, we should probably update "luongNgayCong" too if "luong3P" exists.
          // Lấy công chuẩn tháng từ chính sách công ty; không đổi công thức công ngày.
          // But we don't have all data here easily unless we read deep.
          // For now, let's just update `congThucTe` and `luongNgayCong`.
          // We need to fetch `luong3P` from somewhere. 
          // If existing, use existing `luong3P`. If new, default?

          updatedAt: new Date().toISOString()
        }

        if (existingPayroll) {
          // Update
          const l3p = existingPayroll.luong3P || 0
          payload.luongNgayCong = prorateMonthlySalary(l3p, workdays, attendanceSettings)

          await fbUpdate(`hr/payrolls/${existingPayroll.id}`, payload)
        } else {
          // Create new (basic)
          // We might need to fetch Salary Grade... 
          // For simplicity, we create a basic record, user can edit details later.
          // Or we skip creating if we don't know Salary.
          // However, "Tính công" implies updating the "Công" field.
          if (workdays > 0) {
            const baseSalary = 10000000 // Placeholder or 0? 
            // Better: Init with 0 and let user fill salary info via "Seed" or Manual.
            // But if we have workdays, we should probably save it.
            payload.employeeId = empId
            payload.department = emp.bo_phan || emp.department || ''
            payload.luongP1 = 0
            payload.luong3P = 0
            payload.luongNgayCong = 0
            payload.status = 'Đang tính'
            await fbPush('hr/payrolls', payload)
          }
        }
        updateCount++
      }

      await loadData() // Reload
      alert(`Đã cập nhật công thực tế cho ${updateCount} nhân viên trong tháng ${period}.`)

    } catch (err) {
      alert('Lỗi tính công: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const saveAdjustment = async (empId, value) => {
    // Update State
    const newAdjustments = { ...attendanceAdjustments, [empId]: value }
    setAttendanceAdjustments(newAdjustments)

    // Save to Firebase
    await fbUpdate(`hr/attendanceAdjustments/${filterAttendanceMonth}`, { [empId]: value })
  }

  const saveManualWorkday = async (empId, day, value) => {
    // Update State
    const empManuals = { ...(manualWorkdays[empId] || {}) }
    empManuals[day] = value
    const newManuals = { ...manualWorkdays, [empId]: empManuals }
    setManualWorkdays(newManuals)

    // Save to Firebase
    await fbUpdate(`hr/manualWorkdays/${filterAttendanceMonth}/${empId}`, { [day]: Number(value) })
  }

  const handleBatchExportPayslips = async () => {
    await ensureXlsx()
    if (filteredPayrolls.length === 0) {
      alert('Không có bảng lương nào để xuất!')
      return
    }

    // Create Workbook
    const wb = XLSX.utils.book_new()

    filteredPayrolls.forEach(payroll => {
      const emp = employees.find(e => e.id === payroll.employeeId)
      const empName = emp ? (emp.ho_va_ten || emp.name) : payroll.employeeId
      const safeName = normalizeString(empName).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)

      const totalIncome = (payroll.luong3P || 0) + (payroll.luongNgayCong || 0) + (payroll.thuongNong || 0)
      const totalDeductions = calculateTotalDeductions(payroll)
      const netSalary = calculateNetSalary(payroll)

      // Template Data
      // Template Data based on User's Image
      const sheetData = [
        ['PHIẾU LƯƠNG NHÂN VIÊN'],
        [''],
        ['1. Thông tin chung'],
        ['Trường thông tin', 'Giá trị'],
        ['Họ tên', empName],
        ['Mã nhân sự', payroll.employeeId],
        ['Bộ phận', payroll.department || ''],
        ['Vị trí', emp ? emp.vi_tri : ''],
        ['Kỳ lương', payroll.period],
        [''],
        ['2. Thu nhập'],
        ['Khoản mục', 'Số tiền (VNĐ)'],
        ['Lương bậc P1', payroll.luongP1 || 0],
        ['Kết quả P3 (KPI)', payroll.ketQuaP3 || ''],
        ['Lương 3P', payroll.luong3P || 0],
        ['Thưởng nóng', payroll.thuongNong || 0],
        ['Tổng thu nhập', totalIncome],
        [''],
        ['3. Khấu trừ'],
        ['Khoản khấu trừ', 'Số tiền (VNĐ)'],
        ['BHXH', payroll.bhxh || 0],
        ['Thuế TNCN', payroll.thueTNCN || 0],
        ['Khấu trừ khác', (payroll.tamUng || 0) + (payroll.khac || 0)],
        ['Tổng khấu trừ', totalDeductions],
        [''],
        ['4. Thực lĩnh', netSalary]
      ]

      const ws = XLSX.utils.aoa_to_sheet(sheetData)

      // Styling and Widths
      ws['!cols'] = [
        { wch: 30 }, // Column A: Labels (Wide)
        { wch: 20 }  // Column B: Values (Medium)
      ]

      XLSX.utils.book_append_sheet(wb, ws, safeName)
    })

    XLSX.writeFile(wb, `Phieu_Luong_Hang_Loat_${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  const downloadAttendanceTemplate = async () => {
    await ensureXlsx()
    const headers = [
      'Mã N.Viên', 'Tên nhân viên', 'Tên theo máy chấm công', 'Phòng ban', 'Chức vụ', 'Ngày', 'Thứ',
      'Vào', 'Ra', 'Công', 'Giờ', 'Công+', 'Giờ+', 'Vào trễ', 'Ra sớm',
      'TC1', 'TC2', 'TC3', 'Tên ca', 'Kí hiệu', 'Kí hiệu+', 'Tổng giờ'
    ]
    const sample = [
      ['NV001', 'Nguyễn Văn A', 'Nguyen Van A', 'Kế toán', 'Nhân viên', '2026-05-01', 'Thứ 6', '08:00', '17:30', 1, 8, 0, 0, 0, 0, 0, 0, 0, 'Ca full', 'X', '', 8]
    ]
    const ws = XLSX.utils.aoa_to_sheet([headers, ...sample])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'ChamCong')
    XLSX.writeFile(wb, 'Mau_nhap_cham_cong.xlsx')
  }

  if (loading && !employees.length) {
    return <div className="loadingState">Đang tải dữ liệu...</div>
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">
          <i className="fas fa-clock"></i>
          Chấm công & Lương
        </h1>
        {activeTab === 'attendance' && (
          <>
            <button
              className="btn btn-success"
              onClick={handleOpenAttendancePreview}
              title="Mở bản xem trước giao diện bảng công"
            >
              <i className="fas fa-table"></i>
              Xem trước bảng công
            </button>
            <button
              className="btn btn-success"
              onClick={handleExportAttendance}
              title="Tải bảng công tháng theo mẫu Excel"
            >
              <i className="fas fa-file-excel"></i>
              Tải Excel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => setIsImportModalOpen(true)}
              title="Đối sánh tên/mã nhân sự rồi import dữ liệu chấm công"
            >
              <i className="fas fa-robot"></i>
              AI đối soát & Import
            </button>
            <button
              className="btn"
              onClick={() => setIsAttendanceSettingsOpen(true)}
              title="Cài đặt giờ Check-in và Check-out chuẩn"
            >
              <i className="fas fa-gear"></i>
              Cài đặt giờ
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                setSelectedAttendance(null)
                setIsAttendanceModalOpen(true)
              }}
            >
              <i className="fas fa-plus"></i>
              Thêm chấm công
            </button>
            <button
              className="btn btn-danger"
              onClick={handleDeleteAllAttendance}
              title="Xóa tất cả dữ liệu chấm công"
            >
              <i className="fas fa-trash-alt"></i>
              Xóa tất cả
            </button>
            <SeedAttendanceDataButton employees={employees} onComplete={loadData} />
            <button
              className="btn btn-info"
              onClick={downloadAttendanceTemplate}
              title="Tải file mẫu nhập liệu"
            >
              <i className="fas fa-download"></i>
              Tải mẫu
            </button>
          </>
        )}
        {activeTab === 'workday_summary' && (
          <button
            className="btn btn-success"
            onClick={handleExportAttendanceSummary}
          >
            <i className="fas fa-file-excel"></i>
            Xuất báo cáo tổng hợp
          </button>
        )}
        {activeTab === 'payroll' && (
          <>
            <button
              className="btn btn-success"
              onClick={exportPayrollToExcel}
            >
              <i className="fas fa-file-excel"></i> Xuất Excel
            </button>
            <button
              className="btn btn-primary"
              onClick={handleCalculateWorkdays}
              title="Tính số công thực tế từ dữ liệu chấm công"
            >
              <i className="fas fa-calculator"></i> Tính công
            </button>
            <button
              className="btn btn-success"
              onClick={handleBatchExportPayslips}
              title="Xuất phiếu lương hàng loạt ra Excel"
            >
              <i className="fas fa-file-invoice"></i> Xuất Phiếu Lương
            </button>
            <button
              className="btn btn-info"
              onClick={() => {
                setFilterPayrollPeriod('')
                setFilterPayrollDept('')
              }}
            >
              <i className="fas fa-filter"></i>
              Xóa bộ lọc
            </button>
            <SeedPayrollDataButton employees={employees} onComplete={loadData} />
          </>
        )}
        {activeTab === 'insurance' && (
          <>
            <button
              className="btn btn-success"
              onClick={exportInsuranceToExcel}
            >
              <i className="fas fa-file-excel"></i> Xuất Excel
            </button>
            <button
              className="btn btn-info"
              onClick={downloadInsuranceTemplate}
            >
              <i className="fas fa-download"></i> Tải mẫu
            </button>
            <label className="btn btn-primary" style={{ cursor: 'pointer', margin: 0 }}>
              <i className="fas fa-file-import"></i> Import
              <input type="file" hidden accept=".xlsx,.xls" onChange={handleInsuranceImportFile} />
            </label>
            <button
              className="btn btn-primary"
              onClick={() => {
                setSelectedInsurance(null)
                setIsInsuranceModalOpen(true)
              }}
            >
              <i className="fas fa-plus"></i>
              Thêm BHXH
            </button>
          </>
        )}
        {activeTab === 'tax' && (
          <>
            <button
              className="btn btn-success"
              onClick={exportTaxToExcel}
            >
              <i className="fas fa-file-excel"></i> Xuất Excel
            </button>
            <button
              className="btn btn-info"
              onClick={downloadTaxTemplate}
            >
              <i className="fas fa-download"></i> Tải mẫu
            </button>
            <label className="btn btn-primary" style={{ cursor: 'pointer', margin: 0 }}>
              <i className="fas fa-file-import"></i> Import
              <input type="file" hidden accept=".xlsx,.xls" onChange={handleTaxImportFile} />
            </label>
            <button
              className="btn btn-primary"
              onClick={() => {
                setSelectedTax(null)
                setIsTaxModalOpen(true)
              }}
            >
              <i className="fas fa-plus"></i>
              Thêm Thuế TNCN
            </button>
          </>
        )}
        {activeTab === 'dependents' && (
          <>
            <button
              className="btn btn-success"
              onClick={exportDependentsToExcel}
            >
              <i className="fas fa-file-excel"></i> Xuất Excel
            </button>
            <button
              className="btn btn-info"
              onClick={downloadDependentsTemplate}
            >
              <i className="fas fa-download"></i> Tải mẫu
            </button>
            <label className="btn btn-primary" style={{ cursor: 'pointer', margin: 0 }}>
              <i className="fas fa-file-import"></i> Import
              <input type="file" hidden accept=".xlsx,.xls" onChange={handleDependentsImportFile} />
            </label>
            <button
              className="btn btn-primary"
              onClick={() => {
                setSelectedDependent(null)
                setIsDependentModalOpen(true)
              }}
            >
              <i className="fas fa-plus"></i>
              Thêm người phụ thuộc
            </button>
          </>
        )}
      </div>

      <div className="tabs">
        <div
          className={`tab ${activeTab === 'attendance' ? 'active' : ''}`}
          onClick={() => setActiveTab('attendance')}
        >
          ⏰ Chấm công
        </div>
        <div
          className={`tab ${activeTab === 'workday_summary' ? 'active' : ''}`}
          onClick={() => setActiveTab('workday_summary')}
        >
          📈 Tổng hợp công
        </div>
        <div
          className={`tab ${activeTab === 'payroll' ? 'active' : ''}`}
          onClick={() => setActiveTab('payroll')}
        >
          💰 Tính lương
        </div>
        <div
          className={`tab ${activeTab === 'insurance' ? 'active' : ''}`}
          onClick={() => setActiveTab('insurance')}
        >
          🏥 BHXH
        </div>
        <div
          className={`tab ${activeTab === 'tax' ? 'active' : ''}`}
          onClick={() => setActiveTab('tax')}
        >
          📊 Thuế TNCN
        </div>
        <div
          className={`tab ${activeTab === 'dependents' ? 'active' : ''}`}
          onClick={() => setActiveTab('dependents')}
        >
          👨‍👩‍👧 Người phụ thuộc
        </div>
      </div>

      {/* Tab: Tổng hợp công */}
      {activeTab === 'workday_summary' && (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Bảng tổng hợp công</h3>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="🔍 Tìm nhân viên..."
                value={filterAttendanceEmployee}
                onChange={(e) => setFilterAttendanceEmployee(e.target.value)}
                style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ddd', minWidth: '200px' }}
              />
              <select
                value={filterAttendanceMonth}
                onChange={(e) => setFilterAttendanceMonth(e.target.value || currentMonthValue())}
                style={{ padding: '8px', borderRadius: '4px' }}
              >
                {monthOptions.map(month => (
                  <option key={month} value={month}>{month}</option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ padding: '12px 0 18px' }}>
            <h4 style={{ margin: '0 0 10px' }}>Kết quả tổng hợp cuối kỳ</h4>
            {!filterAttendanceMonth ? (
              <div className="empty-state">Vui lòng chọn tháng để xem báo cáo</div>
            ) : (
              <div style={{ overflowX: 'auto', border: '1px solid #ddd', borderRadius: '6px' }}>
                <table className="table table-bordered table-sm" style={{ minWidth: '1280px', marginBottom: 0 }}>
                  <thead>
                    <tr style={{ background: '#eef6ff' }}>
                      <th>STT</th>
                      <th>Mã NV</th>
                      <th>Họ tên</th>
                      <th>Chi nhánh</th>
                      <th>Phòng ban</th>
                      <th style={{ textAlign: 'center' }}>Ngày có dữ liệu</th>
                      <th style={{ textAlign: 'center', background: '#dcfce7' }}>Tổng công</th>
                      <th style={{ textAlign: 'center' }}>Tổng giờ</th>
                      <th style={{ textAlign: 'center', background: '#fef3c7' }}>Buổi đi muộn</th>
                      <th style={{ textAlign: 'center' }}>Phút muộn</th>
                      <th style={{ textAlign: 'center', background: '#fee2e2' }}>Buổi về sớm</th>
                      <th style={{ textAlign: 'center' }}>Phút sớm</th>
                      <th style={{ textAlign: 'center', background: '#fef3c7' }}>Quên chấm</th>
                      <th style={{ textAlign: 'center', background: '#fee2e2' }}>Nghỉ không phép</th>
                      <th style={{ textAlign: 'center', background: '#dcfce7' }}>Nghỉ phép duyệt</th>
                      <th style={{ textAlign: 'center', background: '#fef3c7' }}>Nghỉ phép chờ duyệt</th>
                      <th style={{ textAlign: 'center', background: '#fee2e2' }}>Nghỉ phép không duyệt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAttendanceSummary.length > 0 ? (
                      filteredAttendanceSummary.map((row, index) => (
                        <tr key={row.employeeId}>
                          <td>{index + 1}</td>
                          <td>{row.employeeCode || '-'}</td>
                          <td><strong>{row.employeeName || '-'}</strong></td>
                          <td>{row.branch || '-'}</td>
                          <td>{row.department || '-'}</td>
                          <td style={{ textAlign: 'center' }}>{row.attendanceDays}</td>
                          <td style={{ textAlign: 'center', fontWeight: 700, background: '#f0fdf4' }}>{row.workdays}</td>
                          <td style={{ textAlign: 'center' }}>{row.totalHours}</td>
                          <td style={{ textAlign: 'center', background: '#fffbeb' }}>{row.lateCount}</td>
                          <td style={{ textAlign: 'center' }}>{row.lateMinutes}</td>
                          <td style={{ textAlign: 'center', background: '#fef2f2' }}>{row.earlyCount}</td>
                          <td style={{ textAlign: 'center' }}>{row.earlyMinutes}</td>
                          <td style={{ textAlign: 'center', background: '#fffbeb' }}>{row.missingPunchCount}</td>
                          <td style={{ textAlign: 'center', background: '#fef2f2' }}>{row.unapprovedAbsenceCount}</td>
                          <td style={{ textAlign: 'center', background: '#f0fdf4' }}>{row.paidLeaveApproved}</td>
                          <td style={{ textAlign: 'center', background: '#fffbeb' }}>{row.paidLeavePending}</td>
                          <td style={{ textAlign: 'center', background: '#fef2f2' }}>{row.paidLeaveRejected}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan="17" className="empty-state">
                          Không có dữ liệu tổng hợp trong tháng này
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <h4 style={{ margin: '0 0 10px' }}>Chi tiết công theo ngày</h4>
          <div style={{ padding: '0', overflowX: 'scroll', overflowY: 'auto', maxHeight: 'calc(100vh - 350px)', border: '1px solid #ddd', borderRadius: '4px' }}>
            {!filterAttendanceMonth ? (
              <div className="empty-state">Vui lòng chọn tháng để xem bảng công</div>
            ) : (
              <table className="table table-bordered table-sm" style={{ fontSize: '0.85rem', minWidth: '101%' }}>
                <thead>
                  <tr style={{ background: '#f8f9fa' }}>
                    <th style={{ minWidth: '50px', position: 'sticky', top: 0, left: 0, background: '#fff', zIndex: 20 }}>STT</th>
                    <th style={{ minWidth: '150px', position: 'sticky', top: 0, left: '50px', background: '#fff', zIndex: 20 }}>Họ tên</th>
                    <th style={{ minWidth: '100px', position: 'sticky', top: 0, left: '200px', background: '#fff', zIndex: 20 }}>Có phép (Ngày)</th>
                    {(() => {
                      const [year, month] = filterAttendanceMonth.split('-').map(Number)
                      const daysInMonth = new Date(year, month, 0).getDate()
                      return Array.from({ length: daysInMonth }, (_, i) => i + 1).map(day => (
                        <th key={day} style={{ width: '40px', textAlign: 'center', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>{day}</th>
                      ))
                    })()}
                    <th style={{ width: '60px', textAlign: 'center', background: '#e8f5e9', position: 'sticky', top: 0, right: 0, zIndex: 10 }}>Tổng</th>
                  </tr>
                </thead>
                <tbody>
                  {employees
                    .filter(emp => {
                      if (!filterAttendanceEmployee) return true
                      const name = emp.ho_va_ten || emp.name || ''
                      return normalizeString(name).includes(normalizeString(filterAttendanceEmployee))
                    })
                    .map((emp, empIdx) => {
                      const [year, month] = filterAttendanceMonth.split('-').map(Number)
                      const daysInMonth = new Date(year, month, 0).getDate()
                      let totalWorkdays = 0

                      return (
                        <tr key={emp.id}>
                          <td style={{ position: 'sticky', left: 0, background: '#fff', zIndex: 15 }}>{empIdx + 1}</td>
                          <td style={{ position: 'sticky', left: '50px', background: '#fff', zIndex: 15, fontWeight: '500' }}>
                            {emp.ho_va_ten || emp.name}
                          </td>
                          <td style={{ position: 'sticky', left: '200px', background: '#fff', zIndex: 15 }}>
                            <MemoizedInput
                              value={attendanceAdjustments[emp.id] || ''}
                              onSave={(val) => saveAdjustment(emp.id, val)}
                              placeholder="VD: 1,5"
                              className="form-control form-control-sm"
                              style={{ fontSize: '0.8rem', textAlign: 'center' }}
                            />
                          </td>
                          {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(day => {
                            const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                            const daySummary = dailyAttendanceMap.get(`${emp.id}::${dateStr}`)

                            let cellContent = ''
                            let cellClass = ''
                            let val = 0

                            if (daySummary) {
                              val = Number(daySummary.workdays) || 0
                              cellContent = val.toFixed(2).replace(/\.?0+$/, '')
                              if (daySummary.isHoliday && val === 0) cellContent = 'Lễ'
                              cellClass =
                                val >= 1
                                  ? 'text-success'
                                  : val > 0
                                    ? 'text-warning'
                                    : 'text-muted'
                            }

                            // Override logic if "Has Permission"
                            const permissionDays = (attendanceAdjustments[emp.id] || '')
                              .split(',')
                              .map(d => parseInt(d.trim()))
                              .filter(n => !isNaN(n))

                            if (permissionDays.includes(day)) {
                              // Force 1 workday OR Manual Value
                              const manualVal = manualWorkdays[emp.id]?.[day]
                              val = (manualVal !== undefined && manualVal !== null) ? Number(manualVal) : 1

                              // Render Input for Manual Edit
                              cellContent = (
                                <MemoizedInput
                                  type="number"
                                  step="0.5"
                                  value={val}
                                  onFocus={(e) => e.target.select()}
                                  onSave={(val) => saveManualWorkday(emp.id, day, val)}
                                  className="form-control form-control-sm"
                                  style={{
                                    width: '45px',
                                    height: '24px',
                                    padding: '0 2px',
                                    textAlign: 'center',
                                    fontSize: '0.8rem',
                                    margin: '0 auto',
                                    background: '#fff'
                                  }}
                                />
                              )
                              // Green background (Visual cue)
                              cellClass = '' // Reset class
                            }

                            totalWorkdays += val

                            return (
                              <td
                                key={day}
                                className={cellClass}
                                style={{
                                  textAlign: 'center',
                                  border: '1px solid #dee2e6',
                                  background: permissionDays.includes(day)
                                    ? '#d4edda'
                                    : daySummary?.isHoliday ? '#fff3cd' : 'inherit',
                                  padding: permissionDays.includes(day) ? '4px' : '8px' // Adjust padding for input
                                }}
                                title={daySummary?.isHoliday
                                  ? `Ngày lễ${daySummary.holidayName ? `: ${daySummary.holidayName}` : ''} — không tự tính công`
                                  : undefined}
                              >
                                {cellContent}
                              </td>
                            )
                          })}
                          <td style={{ textAlign: 'center', fontWeight: 'bold', background: '#e8f5e9' }}>
                            {totalWorkdays}
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            )}
          </div>
          <div style={{ padding: '10px', fontSize: '0.85rem' }}>
            <strong>Chú thích:</strong> <span style={{ display: 'inline-block', width: '15px', height: '15px', background: '#d4edda', border: '1px solid #c3e6cb', verticalAlign: 'middle', marginRight: '5px' }}></span> Có phép (Được tính đủ công) <span style={{ display: 'inline-block', width: '15px', height: '15px', background: '#fff3cd', border: '1px solid #ffe69c', verticalAlign: 'middle', margin: '0 5px 0 14px' }}></span> Lễ (không tự tính công)
          </div>
        </div>
      )}

      {/* Tab 1: Chấm công */}
      {activeTab === 'attendance' && (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Bảng chấm công</h3>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="Tìm theo tên hoặc mã NV..."
                value={filterAttendanceEmployee}
                onChange={(e) => setFilterAttendanceEmployee(e.target.value)}
                style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ddd', minWidth: '250px' }}
              />
              <select
                value={filterAttendanceEmployeeKey}
                onChange={(e) => setFilterAttendanceEmployeeKey(e.target.value)}
                aria-label="Lọc theo nhân viên không trùng tên"
                title="Mỗi nhân viên chỉ xuất hiện một lần trong danh sách lọc"
                style={{ padding: '8px', borderRadius: '4px', minWidth: '230px' }}
              >
                <option value="">Tất cả nhân viên ({attendanceEmployeeOptions.length})</option>
                {attendanceEmployeeOptions.map(option => (
                  <option key={option.key} value={option.key}>
                    {option.name}
                    {option.codes.length > 0 ? ` (${option.codes.join(', ')})` : ''}
                    {` — ${option.recordCount} lượt`}
                  </option>
                ))}
              </select>
              <select
                value={filterAttendanceMonth}
                onChange={(e) => setFilterAttendanceMonth(e.target.value || currentMonthValue())}
                style={{ padding: '8px', borderRadius: '4px' }}
              >
                {monthOptions.map(month => (
                  <option key={month} value={month}>{month}</option>
                ))}
              </select>
              {logsLoading && (
                <span style={{ color: '#0d427a', fontWeight: 600 }}>Đang tải tháng...</span>
              )}
            </div>
          </div>
          <div style={{ overflowX: 'scroll', overflowY: 'auto', maxHeight: 'calc(100vh - 350px)', border: '1px solid #e0e0e0' }}>
            <table style={{ minWidth: '101%', marginBottom: 0 }}>
              <thead>
                <tr>
                  <th style={{ minWidth: '45px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>STT</th>
                  <th style={{ minWidth: '90px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Mã N.Viên</th>
                  <th style={{ minWidth: '140px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Tên nhân viên</th>
                  <th style={{ minWidth: '170px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Tên theo máy chấm công</th>
                  <th style={{ minWidth: '110px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Phòng ban</th>
                  <th style={{ minWidth: '110px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Chức vụ</th>
                  <th style={{ minWidth: '100px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Ngày</th>
                  <th style={{ minWidth: '80px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Thứ</th>
                  <th style={{ minWidth: '70px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Vào</th>
                  <th style={{ minWidth: '70px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Ra</th>
                  <th style={{ minWidth: '60px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Công</th>
                  <th style={{ minWidth: '60px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Giờ</th>
                  <th style={{ minWidth: '60px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Công+</th>
                  <th style={{ minWidth: '60px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Giờ+</th>
                  <th style={{ minWidth: '70px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Vào trễ</th>
                  <th style={{ minWidth: '70px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Ra sớm</th>
                  <th style={{ minWidth: '55px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>TC1</th>
                  <th style={{ minWidth: '55px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>TC2</th>
                  <th style={{ minWidth: '55px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>TC3</th>
                  <th style={{ minWidth: '90px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Tên ca</th>
                  <th style={{ minWidth: '70px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Kí hiệu</th>
                  <th style={{ minWidth: '70px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Kí hiệu+</th>
                  <th style={{ minWidth: '75px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Tổng giờ</th>
                  <th style={{ minWidth: '100px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {logsLoading && !visibleAttendanceLogs.length ? (
                  <tr>
                    <td colSpan="24" className="empty-state">Đang tải chấm công tháng {filterAttendanceMonth}...</td>
                  </tr>
                ) : visibleAttendanceLogs.length > 0 ? (
                  visibleAttendanceLogs
                    .map((log, idx) => {
                      const employee = employeesById.get(String(log.employeeId))
                      const empCode = log.employeeCode || employee?.employeeId || employee?.username || log.employeeId || '-'
                      const empName = log.employeeName || employee?.ho_va_ten || employee?.name || '-'
                      const machineName = log.machineName || log.tenTheoMayChamCong || empName
                      const department = log.department || log.phongBan || employee?.bo_phan || '-'
                      const position = log.position || log.chucVu || employee?.vi_tri || '-'
                      const dateStr = log.date ? String(log.date).slice(0, 10) : ''
                      const thu = log.dayOfWeek || log.thu || dayOfWeekFromDate(dateStr) || '-'
                      const checkIn = formatTimeHM(log.vao || log.checkIn) || '-'
                      const checkOut = formatTimeHM(log.ra || log.checkOut) || '-'
                      let hours = Number(log.hours ?? log.soGio ?? log.gio ?? 0)
                      if (isNaN(hours)) hours = 0
                      const gioPlus = Number(log.gioPlus ?? 0) || 0
                      const tongGio = Number(log.tongGio ?? hours + gioPlus) || 0
                      const late = Number(log.lateMinutes ?? log.vaoTre ?? 0) || 0
                      const early = Number(log.earlyMinutes ?? log.raSom ?? 0) || 0
                      return (
                        <tr key={log.id}>
                          <td>{idx + 1}</td>
                          <td>{empCode}</td>
                          <td>{empName}</td>
                          <td>{machineName || '-'}</td>
                          <td>{department}</td>
                          <td>{position}</td>
                          <td>{dateStr ? new Date(`${dateStr}T00:00:00`).toLocaleDateString('vi-VN') : '-'}</td>
                          <td>{thu}</td>
                          <td>{checkIn}</td>
                          <td>{checkOut}</td>
                          <td>{log.cong ?? '-'}</td>
                          <td>{hours ? hours.toFixed(2) : '-'}</td>
                          <td>{log.congPlus ?? '-'}</td>
                          <td>{gioPlus || '-'}</td>
                          <td style={{ color: late > 0 ? '#dc3545' : '#6c757d' }}>{late > 0 ? `${late}p` : '-'}</td>
                          <td style={{ color: early > 0 ? '#ffc107' : '#6c757d' }}>{early > 0 ? `${early}p` : '-'}</td>
                          <td>{log.tc1 ?? '-'}</td>
                          <td>{log.tc2 ?? '-'}</td>
                          <td>{log.tc3 ?? '-'}</td>
                          <td>{log.shiftName || log.tenCa || '-'}</td>
                          <td>{log.kyHieu || log.status || '-'}</td>
                          <td>{log.kyHieuPlus || '-'}</td>
                          <td><strong>{tongGio ? tongGio.toFixed(2) : '-'}</strong></td>
                          <td>
                            <div className="actions">
                              <button
                                className="view"
                                onClick={() => {
                                  setSelectedAttendance(log)
                                  setIsAttendanceReadOnly(true)
                                  setIsAttendanceModalOpen(true)
                                }}
                                title="Xem chi tiết"
                              >
                                <i className="fas fa-eye"></i>
                              </button>
                              <button
                                className="edit"
                                onClick={() => {
                                  setSelectedAttendance(log)
                                  setIsAttendanceReadOnly(false)
                                  setIsAttendanceModalOpen(true)
                                }}
                              >
                                <i className="fas fa-edit"></i>
                              </button>
                              <button
                                className="delete"
                                onClick={() => handleDeleteAttendance(log.id)}
                              >
                                <i className="fas fa-trash"></i>
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })
                ) : (
                  <tr>
                    <td colSpan="24" className="empty-state">Chưa có dữ liệu chấm công</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {sortedFilteredAttendanceLogs.length > visibleLogCount && (
            <div style={{ padding: '12px', textAlign: 'center' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setVisibleLogCount(count => count + LOGS_PAGE_SIZE)}
              >
                Xem thêm ({visibleLogCount}/{sortedFilteredAttendanceLogs.length})
              </button>
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Tính lương */}
      {activeTab === 'payroll' && (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Bảng 1: Bảng lương tổng hợp</h3>
            <div className="search-box" style={{ display: 'flex', gap: '10px' }}>
              <select
                value={filterPayrollStatus}
                onChange={(e) => setFilterPayrollStatus(e.target.value)}
                style={{ padding: '8px', borderRadius: '4px' }}
              >
                <option value="">Tất cả trạng thái</option>
                <option value="Đang tính">Đang tính</option>
                <option value="Đã chốt">Đã chốt</option>
              </select>
              <select
                value={filterPayrollPeriod}
                onChange={(e) => setFilterPayrollPeriod(e.target.value)}
                style={{ padding: '8px', borderRadius: '4px' }}
              >
                <option value="">Tất cả kỳ</option>
                {[...new Set(payrolls.map(p => p.period).filter(Boolean))].sort().map(period => (
                  <option key={period} value={period}>{period}</option>
                ))}
              </select>
              <select
                value={filterPayrollDept}
                onChange={(e) => setFilterPayrollDept(e.target.value)}
                style={{ padding: '8px', borderRadius: '4px' }}
              >
                <option value="">Tất cả bộ phận</option>
                {[...new Set(payrolls.map(p => p.department).filter(Boolean))].sort().map(dept => (
                  <option key={dept} value={dept}>{dept}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ overflowX: 'scroll', overflowY: 'auto', maxHeight: 'calc(100vh - 350px)', border: '1px solid #e0e0e0' }}>
            <table style={{ minWidth: '101%', marginBottom: 0 }}>
              <thead>
                <tr>
                  <th style={{ minWidth: '50px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>STT</th>
                  <th style={{ minWidth: '100px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Mã NV</th>
                  <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Họ tên</th>
                  <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Bộ phận</th>
                  <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Vị trí</th>
                  <th style={{ minWidth: '100px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Công thực tế</th>
                  <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Lương P1 (VNĐ)</th>
                  <th style={{ minWidth: '100px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Kết quả P3</th>
                  <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Lương 3P (VNĐ)</th>
                  <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Lương ngày công</th>
                  <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Thưởng nóng (VNĐ)</th>
                  <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Tổng thu nhập</th>
                  <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>BHXH + Thuế TNCN</th>
                  <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Khấu trừ khác</th>
                  <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Thực lĩnh</th>
                  <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Trạng thái</th>
                  <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {filteredPayrolls.length > 0 ? (
                  filteredPayrolls.map((payroll, idx) => {
                    const employee = employees.find(e => e.id === payroll.employeeId)
                    const totalIncome = (payroll.luong3P || 0) + (payroll.luongNgayCong || 0) + (payroll.thuongNong || 0)
                    const totalDeductions = calculateTotalDeductions(payroll)
                    const netSalary = calculateNetSalary(payroll)
                    const bhxhAndTax = (payroll.bhxh || 0) + (payroll.thueTNCN || 0)
                    const otherDeductions = (payroll.khac || 0) + (payroll.tamUng || 0)

                    return (
                      <tr key={payroll.id}>
                        <td>{idx + 1}</td>
                        <td>{payroll.employeeId || '-'}</td>
                        <td>{employee ? (employee.ho_va_ten || employee.name || '-') : '-'}</td>
                        <td>{payroll.department || '-'}</td>
                        <td>{employee ? (employee.vi_tri || '-') : '-'}</td>
                        <td>{payroll.congThucTe || payroll.cong || 0}</td>
                        <td>{formatMoney(payroll.luongP1 || 0)}</td>
                        <td>{payroll.ketQuaP3 || payroll.p3 || '0%'}</td>
                        <td style={{ fontWeight: 'bold', color: 'var(--primary)' }}>
                          {formatMoney(payroll.luong3P || 0)}
                        </td>
                        <td>{formatMoney(payroll.luongNgayCong || 0)}</td>
                        <td>{formatMoney(payroll.thuongNong || 0)}</td>
                        <td style={{ fontWeight: 'bold' }}>{formatMoney(totalIncome)}</td>
                        <td>{formatMoney(bhxhAndTax)}</td>
                        <td>{formatMoney(otherDeductions)}</td>
                        <td style={{ fontWeight: 'bold', color: 'var(--success)' }}>
                          {formatMoney(netSalary)}
                        </td>
                        <td>
                          <span className={`badge ${payroll.status === 'Đã chốt' ? 'badge-success' :
                            payroll.status === 'Đang tính' ? 'badge-warning' :
                              'badge-secondary'
                            }`}>
                            {payroll.status || 'Đang tính'}
                          </span>
                        </td>
                        <td>
                          <div className="actions">
                            <button
                              className="view"
                              onClick={() => {
                                setSelectedPayroll(payroll)
                                setIsPayrollReadOnly(true)
                                setIsPayrollDetailModalOpen(true)
                              }}
                            >
                              <i className="fas fa-eye"></i>
                            </button>
                            {payroll.status === 'Đang tính' && (
                              <button
                                className="edit"
                                onClick={() => {
                                  setSelectedPayroll(payroll)
                                  setIsPayrollReadOnly(false)
                                  setIsPayrollDetailModalOpen(true)
                                }}
                              >
                                <i className="fas fa-edit"></i>
                              </button>
                            )}
                            <button
                              className="view"
                              onClick={() => {
                                setSelectedPayslip(payroll)
                                setIsPayslipModalOpen(true)
                              }}
                              title="Xem phiếu lương"
                            >
                              <i className="fas fa-file-invoice-dollar"></i>
                            </button>
                            <button
                              className="delete"
                              onClick={() => handleDeletePayroll(payroll.id)}
                            >
                              <i className="fas fa-trash"></i>
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })
                ) : (
                  <tr>
                    <td colSpan="17" className="empty-state">Chưa có dữ liệu lương</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 3: BHXH */}
      {
        activeTab === 'insurance' && (
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Bảng 1: Thông tin BHXH</h3>
            </div>
            <div style={{ overflowX: 'scroll', overflowY: 'auto', maxHeight: 'calc(100vh - 350px)', border: '1px solid #e0e0e0' }}>
              <table style={{ minWidth: '101%', marginBottom: 0 }}>
                <thead>
                  <tr>
                    <th style={{ minWidth: '50px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>STT</th>
                    <th style={{ minWidth: '100px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Mã NV</th>
                    <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Họ tên</th>
                    <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Bộ phận</th>
                    <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Số sổ BHXH</th>
                    <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Ngày tham gia</th>
                    <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Mức lương đóng BHXH</th>
                    <th style={{ minWidth: '100px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Tỷ lệ NLĐ (%)</th>
                    <th style={{ minWidth: '100px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Tỷ lệ DN (%)</th>
                    <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Trạng thái</th>
                    <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {insuranceInfo.length > 0 ? (
                    insuranceInfo.map((insurance, idx) => {
                      const employee = employees.find(e => e.id === insurance.employeeId)
                      return (
                        <tr key={insurance.id}>
                          <td>{idx + 1}</td>
                          <td>{insurance.employeeId || '-'}</td>
                          <td>{employee ? (employee.ho_va_ten || employee.name || '-') : '-'}</td>
                          <td>{employee ? (employee.bo_phan || employee.department || '-') : '-'}</td>
                          <td>{insurance.soSoBHXH || insurance.soSo || '-'}</td>
                          <td>{insurance.ngayThamGia ? new Date(insurance.ngayThamGia).toLocaleDateString('vi-VN') : '-'}</td>
                          <td>{formatMoney(insurance.mucLuongDong || insurance.mucLuong || 0)}</td>
                          <td>{insurance.tyLeNLD || insurance.tyLeNhanVien || 10.5}%</td>
                          <td>{insurance.tyLeDN || insurance.tyLeDoanhNghiep || 21.5}%</td>
                          <td>
                            <span className={`badge ${insurance.status === 'Đang tham gia' ? 'badge-success' :
                              'badge-danger'
                              }`}>
                              {insurance.status || 'Đang tham gia'}
                            </span>
                          </td>
                          <td>
                            <div className="actions">
                              <button
                                className="view"
                                onClick={() => {
                                  setSelectedInsurance(insurance)
                                  setIsInsuranceReadOnly(true)
                                  setIsInsuranceModalOpen(true)
                                }}
                              >
                                <i className="fas fa-eye"></i>
                              </button>
                              <button
                                className="edit"
                                onClick={() => {
                                  setSelectedInsurance(insurance)
                                  setIsInsuranceReadOnly(false)
                                  setIsInsuranceModalOpen(true)
                                }}
                              >
                                <i className="fas fa-edit"></i>
                              </button>
                              <button
                                className="delete"
                                onClick={() => handleDeleteInsurance(insurance.id)}
                              >
                                <i className="fas fa-trash"></i>
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  ) : (
                    <tr>
                      <td colSpan="11" className="empty-state">Chưa có thông tin BHXH</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )
      }

      {/* Tab 4: Thuế TNCN */}
      {
        activeTab === 'tax' && (
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Bảng 2: Thông tin Thuế TNCN</h3>
            </div>
            <div style={{ overflowX: 'scroll', overflowY: 'auto', maxHeight: 'calc(100vh - 350px)', border: '1px solid #e0e0e0' }}>
              <table style={{ minWidth: '101%', marginBottom: 0 }}>
                <thead>
                  <tr>
                    <th style={{ minWidth: '50px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>STT</th>
                    <th style={{ minWidth: '100px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Mã NV</th>
                    <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Họ tên</th>
                    <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Mã số thuế TNCN</th>
                    <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Thu nhập tính thuế</th>
                    <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Giảm trừ bản thân</th>
                    <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Tổng giảm trừ người phụ thuộc</th>
                    <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Thu nhập chịu thuế</th>
                    <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Biểu thuế</th>
                    <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Thuế TNCN phải nộp</th>
                    <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Kỳ áp dụng</th>
                    <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {taxInfo.length > 0 ? (
                    taxInfo.map((tax, idx) => {
                      const employee = employees.find(e => e.id === tax.employeeId)

                      // 1. Calculate Deductions
                      const personalDeduction = TAX_CONFIG.PERSONAL_DEDUCTION

                      const employeeDependents = dependents.filter(d =>
                        d.employeeId === tax.employeeId &&
                        d.status === 'Đang áp dụng'
                      )
                      const dependentDeduction = employeeDependents.length * TAX_CONFIG.DEPENDENT_DEDUCTION

                      // BHXH Deduction (10.5% of Insurance Salary)
                      const empInsurance = insuranceInfo.find(i => i.employeeId === tax.employeeId && i.status === 'Đang tham gia')
                      const insuranceDeduction = empInsurance ? (Number(empInsurance.mucLuongDongBHXH || 0) * 0.105) : 0

                      // 2. Calculate Assessable Income
                      const inputIncome = Number(tax.thuNhapTinhThue || 0)
                      const assessableIncome = Math.max(0, inputIncome - personalDeduction - dependentDeduction - insuranceDeduction)

                      // 3. Calculate Tax using progressive formula
                      const taxAmount = calculateProgressiveTax(assessableIncome)

                      return (
                        <tr key={tax.id}>
                          <td>{idx + 1}</td>
                          <td>{tax.employeeId || '-'}</td>
                          <td>{employee ? (employee.ho_va_ten || employee.name || '-') : '-'}</td>
                          <td>{tax.maSoThue || tax.mst || '-'}</td>
                          <td>{formatMoney(inputIncome)}</td>
                          <td>{formatMoney(personalDeduction)}</td>
                          <td>{formatMoney(dependentDeduction)}</td>
                          <td>{formatMoney(assessableIncome)}</td>
                          <td>{tax.bieuThue || 'Lũy tiến'}</td>
                          <td style={{ fontWeight: 'bold', color: 'var(--primary)' }}>
                            {formatMoney(taxAmount)}
                          </td>
                          <td>{tax.kyApDung || tax.period || '-'}</td>
                          <td>
                            <div className="actions">
                              <button
                                className="view"
                                onClick={() => {
                                  setSelectedTax(tax)
                                  setIsTaxReadOnly(true)
                                  setIsTaxModalOpen(true)
                                }}
                              >
                                <i className="fas fa-eye"></i>
                              </button>
                              <button
                                className="edit"
                                onClick={() => {
                                  setSelectedTax(tax)
                                  setIsTaxReadOnly(false)
                                  setIsTaxModalOpen(true)
                                }}
                              >
                                <i className="fas fa-edit"></i>
                              </button>
                              <button
                                className="delete"
                                onClick={() => handleDeleteTax(tax.id)}
                              >
                                <i className="fas fa-trash"></i>
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  ) : (
                    <tr>
                      <td colSpan="12" className="empty-state">Chưa có thông tin thuế TNCN</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )
      }

      {/* Tab 5: Người phụ thuộc */}
      {
        activeTab === 'dependents' && (
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Bảng 3: Quản lý người phụ thuộc của nhân sự</h3>
            </div>
            <div style={{ overflowX: 'scroll', overflowY: 'auto', maxHeight: 'calc(100vh - 350px)', border: '1px solid #e0e0e0' }}>
              <table style={{ minWidth: '101%', marginBottom: 0 }}>
                <thead>
                  <tr>
                    <th style={{ minWidth: '50px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>STT</th>
                    <th style={{ minWidth: '100px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Mã NV</th>
                    <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Họ tên NV</th>
                    <th style={{ minWidth: '200px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Họ tên người phụ thuộc</th>
                    <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Quan hệ</th>
                    <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Ngày sinh</th>
                    <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>CCCD/CMND</th>
                    <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Thời gian giảm trừ từ</th>
                    <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Thời gian giảm trừ đến</th>
                    <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Trạng thái</th>
                    <th style={{ minWidth: '120px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {dependents.length > 0 ? (
                    dependents.map((dependent, idx) => {
                      const employee = employees.find(e => e.id === dependent.employeeId)
                      return (
                        <tr key={dependent.id}>
                          <td>{idx + 1}</td>
                          <td>{dependent.employeeId || '-'}</td>
                          <td>{employee ? (employee.ho_va_ten || employee.name || '-') : '-'}</td>
                          <td>{dependent.hoTen || dependent.name || '-'}</td>
                          <td>{dependent.quanHe || dependent.relationship || '-'}</td>
                          <td>{dependent.ngaySinh ? new Date(dependent.ngaySinh).toLocaleDateString('vi-VN') : '-'}</td>
                          <td>{dependent.cccd || dependent.cmnd || '-'}</td>
                          <td>{dependent.tuNgay ? new Date(dependent.tuNgay).toLocaleDateString('vi-VN') : '-'}</td>
                          <td>{dependent.denNgay ? new Date(dependent.denNgay).toLocaleDateString('vi-VN') : '-'}</td>
                          <td>
                            <span className={`badge ${dependent.status === 'Đang áp dụng' ? 'badge-success' :
                              'badge-danger'
                              }`}>
                              {dependent.status || 'Đang áp dụng'}
                            </span>
                          </td>
                          <td>
                            <div className="actions">
                              <button
                                className="view"
                                onClick={() => {
                                  setSelectedDependent(dependent)
                                  setIsDependentReadOnly(true)
                                  setIsDependentModalOpen(true)
                                }}
                              >
                                <i className="fas fa-eye"></i>
                              </button>
                              <button
                                className="edit"
                                onClick={() => {
                                  setSelectedDependent(dependent)
                                  setIsDependentReadOnly(false)
                                  setIsDependentModalOpen(true)
                                }}
                              >
                                <i className="fas fa-edit"></i>
                              </button>
                              <button
                                className="delete"
                                onClick={() => handleDeleteDependent(dependent.id)}
                              >
                                <i className="fas fa-trash"></i>
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  ) : (
                    <tr>
                      <td colSpan="11" className="empty-state">Chưa có người phụ thuộc</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )
      }

      {/* Modals */}
      <AttendanceImportModal
        employees={employees}
        attendanceLogs={attendanceLogs}
        attendanceSettings={attendanceSettings}
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onSave={loadData}
      />

      <AttendanceModal
        attendance={selectedAttendance}
        employees={employees}
        attendanceSettings={attendanceSettings}
        isOpen={isAttendanceModalOpen}
        onClose={() => {
          setIsAttendanceModalOpen(false)
          setSelectedAttendance(null)
          setIsAttendanceReadOnly(false)
        }}
        onSave={loadData}
        readOnly={isAttendanceReadOnly}
      />

      <AttendanceSettingsModal
        isOpen={isAttendanceSettingsOpen}
        onClose={() => setIsAttendanceSettingsOpen(false)}
        onSaved={loadData}
      />

      <PayrollDetailModal
        payroll={selectedPayroll}
        employees={employees}
        isOpen={isPayrollDetailModalOpen}
        onClose={() => {
          setIsPayrollDetailModalOpen(false)
          setSelectedPayroll(null)
          setIsPayrollReadOnly(false)
        }}
        onSave={loadData}
        readOnly={isPayrollReadOnly}
      />

      <InsuranceModal
        insurance={selectedInsurance}
        employees={employees}
        isOpen={isInsuranceModalOpen}
        onClose={() => {
          setIsInsuranceModalOpen(false)
          setSelectedInsurance(null)
          setIsInsuranceReadOnly(false)
        }}
        onSave={loadData}
        readOnly={isInsuranceReadOnly}
      />

      <TaxModal
        tax={selectedTax}
        employees={employees}
        dependents={dependents}
        isOpen={isTaxModalOpen}
        onClose={() => {
          setIsTaxModalOpen(false)
          setSelectedTax(null)
          setIsTaxReadOnly(false)
        }}
        onSave={loadData}
        readOnly={isTaxReadOnly}
      />

      <DependentModal
        dependent={selectedDependent}
        employees={employees}
        isOpen={isDependentModalOpen}
        onClose={() => {
          setIsDependentModalOpen(false)
          setSelectedDependent(null)
          setIsDependentReadOnly(false)
        }}
        onSave={loadData}
        readOnly={isDependentReadOnly}
      />

      <PayslipModal
        payroll={selectedPayslip}
        employee={selectedPayslip ? employees.find(e => e.id === selectedPayslip.employeeId) : null}
        isOpen={isPayslipModalOpen}
        onClose={() => {
          setIsPayslipModalOpen(false)
          setSelectedPayslip(null)
        }}
      />
    </div >
  )
}

export default Attendance
