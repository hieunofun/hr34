import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useCompany } from '../contexts/CompanyContext'
import { fbDeleteAttendanceMonth, fbGet, fbGetAttendanceLogsByMonth, fbGetEmployeesDirectory, fbListCollectionIds, fbSet } from '../services/firebase'
import {
  buildAttendanceSummary,
  hydrateAttendanceSummaryRows,
  serializeAttendanceSummaryRows
} from '../utils/attendanceSummary'
import AttendanceImportModal from '../components/AttendanceImportModal'
import { dayOfWeekFromDate, formatTimeHM } from '../components/AttendanceModal'
import {
  formatAttendanceTime,
  normalizeAttendanceShiftSettings,
  resolveAttendanceShift
} from '../utils/attendanceShift'
import { parseManualWorkdayInput, updateManualWorkdays } from '../utils/attendanceManual'
import {
  describeDayWorkFormula,
  getAttendanceHoliday,
  STANDARD_WORK_MINUTES
} from '../utils/attendanceCalculations'
import { canManageAttendance } from '../utils/staffAccess'
import { getAttendancePeriod } from '../services/attendancePeriods'
import { attendanceDateForDay, attendancePeriodDates, calendarAttendancePeriod } from '../utils/attendancePeriod'
import { openAttendancePrintWindow } from '../utils/attendancePdf'
import './AttendancePreview.css'

const EXCEL_DETAIL_PAGE_SIZE = 100
const EXCEL_DETAIL_PAGE_SIZE_OPTIONS = [50, 100, 200]
const normalizeSearch = value => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim()

let XLSX = null
const ensureXlsx = async () => {
  if (!XLSX) {
    const mod = await import('xlsx-js-style')
    XLSX = mod.default || mod
  }
  return XLSX
}

function ManualWorkdayInput({ value, isManual, disabled, onSave, employeeName, date }) {
  const normalizedValue = value === null || value === undefined ? '' : String(value)
  const [draft, setDraft] = useState(normalizedValue)

  useEffect(() => {
    setDraft(normalizedValue)
  }, [normalizedValue])

  const commit = () => {
    if (draft === normalizedValue) return
    const parsed = parseManualWorkdayInput(draft)
    if (!parsed.valid) {
      alert(parsed.error)
      setDraft(normalizedValue)
      return
    }
    onSave(draft)
  }

  return (
    <input
      type="number"
      min="0"
      max="1"
      step="0.25"
      inputMode="decimal"
      className={`manual-workday-input ${isManual ? 'is-manual' : ''}`}
      value={draft}
      disabled={disabled}
      onChange={event => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setDraft(normalizedValue)
          event.currentTarget.blur()
        }
      }}
      aria-label={`Chỉnh công ${employeeName || ''} ngày ${date}`}
      title={isManual ? 'Đã chỉnh tay. Xóa giá trị để trở về tự động.' : 'Nhập 0–1 để chỉnh tay số công.'}
    />
  )
}

const enrichExcelLog = (log, employeesById) => {
  const employee = employeesById.get(String(log.employeeId || '')) || null
  const excelCode = String(
    log.sourceEmployeeCode ||
    log.maNV ||
    log.ma_nv ||
    log.excelEmployeeCode ||
    ''
  ).trim()
  // Prefer mã trong file Excel; chỉ dùng employeeCode nếu không phải UUID hệ thống.
  const storedCode = String(log.employeeCode || '').trim()
  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(storedCode)
  const employeeCode = excelCode || (!looksLikeUuid ? storedCode : '') || ''
  const employeeName =
    log.sourceEmployeeName ||
    log.employeeName ||
    employee?.ho_va_ten ||
    employee?.name ||
    ''
  const department =
    log.department ||
    log.phongBan ||
    employee?.bo_phan ||
    employee?.department ||
    ''
  const shiftFromProfile = employee?.ca_lam_viec || employee?.shift || ''
  return {
    ...log,
    displayEmployeeCode: employeeCode,
    employeeCode: employeeCode || storedCode,
    employeeName,
    department,
    phongBan: department,
    profileShift: shiftFromProfile,
    shiftName: shiftFromProfile || log.shiftName || log.tenCa || '',
    tenCa: shiftFromProfile || log.tenCa || log.shiftName || ''
  }
}

const currentMonthValue = () => new Date().toISOString().slice(0, 7)
const formatGeneratedAt = value => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('vi-VN')
}
const dateText = value => {
  const match = String(value || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return match ? `${match[3]}/${match[2]}` : value || ''
}
const weekdayText = (monthValue, day) => {
  const [year, monthNumber] = String(monthValue || '').split('-').map(Number)
  if (!year || !monthNumber) return ''
  return ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][new Date(year, monthNumber - 1, day).getDay()]
}
const dayCode = day => {
  if (!day) return ''
  const statuses = (day.logs || []).map(log => String(log.kyHieuPlus || log.kyHieu || log.status || '').trim().toUpperCase()).filter(Boolean)
  const code = statuses.find(value => ['X', 'X1', 'X2', 'X3', 'P1'].includes(value))
  if (code) return code
  if (day.paidLeaveWorkdays > 0 || statuses.includes('V')) return 'P1'
  if (day.unapprovedAbsence) return 'X'
  return Number(day.workdays) || ''
}
const dayNotes = day => {
  if (!day) return ''
  const notes = []
  if (day.isHoliday) notes.push(day.holidayName ? `Ngày lễ: ${day.holidayName}` : 'Ngày lễ')
  if (day.late) notes.push(`Muộn ${day.lateMinutes || 0}p`)
  if (day.early) notes.push(`Sớm ${day.earlyMinutes || 0}p`)
  if (day.missingPunch) notes.push('Quên chấm')
  if (day.unapprovedAbsence) notes.push('Nghỉ không phép')
  if (day.paidLeaveWorkdays > 0) notes.push(`Phép ${day.paidLeaveWorkdays}`)
  if (day.overtimeHours > 0) notes.push(`TC ${day.overtimeHours}h`)
  return notes.join(' · ')
}

const inferDepartmentFromPosition = position => {
  const value = String(position || '').trim().toLocaleLowerCase('vi')
  if (!value) return ''
  if (/nhân sự|\bhr\b|admin/.test(value)) return 'Nhân sự'
  if (/kế toán|account/.test(value)) return 'Kế toán'
  if (/social media|marketing|\bmkt\b|seo|content|designer|media/.test(value)) return 'MKT'
  if (/sale|kinh doanh/.test(value)) return 'Sale'
  if (/vận hành|kho|thu mua|xuất nhập khẩu|logistics/.test(value)) return 'Vận hành'
  return ''
}
const resolveDepartment = row => {
  const storedDepartment = String(row.department || '').trim()
  return storedDepartment || inferDepartmentFromPosition(row.position) || 'Chưa phân bộ phận'
}
const getConsecutiveDepartmentRowSpans = rows => rows.map((row, index) => {
  const department = row.displayDepartment
  if (!department) return 1
  const previousDepartment = rows[index - 1]?.displayDepartment
  if (department === previousDepartment) return 0
  let rowSpan = 1
  while (rows[index + rowSpan]?.displayDepartment === department) rowSpan += 1
  return rowSpan
})
const groupRowsByDepartment = rows => {
  const groups = new Map()
  rows.forEach(row => {
    const department = resolveDepartment(row)
    const key = department.toLocaleLowerCase('vi')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ ...row, displayDepartment: department })
  })
  return Array.from(groups.values()).flat()
}

function AttendancePreview() {
  const { user } = useAuth()
  const { company, companyId, companyCode, companyName } = useCompany()
  const isHr31 = String(companyCode || '').trim().toLowerCase() === 'hr31'
  const [month, setMonth] = useState(currentMonthValue)
  const [attendancePeriod, setAttendancePeriod] = useState(null)
  const [summaryMonths, setSummaryMonths] = useState([])
  const [rows, setRows] = useState([])
  const [loadedCompanyId, setLoadedCompanyId] = useState('')
  const [generatedAt, setGeneratedAt] = useState('')
  const [sourceLogCount, setSourceLogCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [summarizing, setSummarizing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [exportingExcel, setExportingExcel] = useState(false)
  const [error, setError] = useState('')
  const [hasSnapshot, setHasSnapshot] = useState(false)
  const [snapshotPeriod, setSnapshotPeriod] = useState(null)
  const [isImportOpen, setIsImportOpen] = useState(false)
  const [importEmployees, setImportEmployees] = useState([])
  const [importLogs, setImportLogs] = useState([])
  const [attendanceSettings, setAttendanceSettings] = useState(() => normalizeAttendanceShiftSettings())
  const [importSettings, setImportSettings] = useState(() => normalizeAttendanceShiftSettings())
  const [manualWorkdays, setManualWorkdays] = useState({})
  const [manualSavingKey, setManualSavingKey] = useState('')
  const [manualNotice, setManualNotice] = useState('')
  const [confirmations, setConfirmations] = useState({})
  const [confirmSaving, setConfirmSaving] = useState(false)
  const [detailRow, setDetailRow] = useState(null)
  const [isExcelDetailOpen, setIsExcelDetailOpen] = useState(false)
  const [excelLogs, setExcelLogs] = useState([])
  const [excelLogsLoading, setExcelLogsLoading] = useState(false)
  const [excelSearch, setExcelSearch] = useState('')
  const [excelPage, setExcelPage] = useState(1)
  const [excelPageSize, setExcelPageSize] = useState(EXCEL_DETAIL_PAGE_SIZE)
  const [detailViewMode, setDetailViewMode] = useState('matrix')
  const canEditWorkdays = canManageAttendance(user)
  const isBusy = summarizing || deleting || exportingExcel
  const activePeriod = attendancePeriod || calendarAttendancePeriod(month)
  const periodDates = useMemo(() => attendancePeriodDates(activePeriod), [activePeriod.startDate, activePeriod.endDate])

  const daysInSelectedMonth = periodDates.length

  const monthDaysHeader = useMemo(() => {
    const days = []
    const dowShort = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
    for (const dateKey of periodDates) {
      const date = new Date(`${dateKey}T00:00:00`)
      const dayStr = dateKey.slice(8, 10)
      const holiday = getAttendanceHoliday(dateKey, attendanceSettings)
      days.push({
        date: dateKey,
        day: Number(dayStr),
        dayStr,
        dow: dowShort[date.getDay()],
        isSunday: date.getDay() === 0,
        isSaturday: date.getDay() === 6,
        isHoliday: Boolean(holiday),
        holidayName: holiday?.name || ''
      })
    }
    return days
  }, [attendanceSettings, periodDates])

  const matrixHolidayLegend = useMemo(
    () => monthDaysHeader.filter(day => day.isHoliday),
    [monthDaysHeader]
  )

  const matrixRows = useMemo(() => {
    if (!rows || rows.length === 0) return []
    const term = normalizeSearch(excelSearch)
    const filtered = rows.filter(r => {
      if (!term) return true
      const code = normalizeSearch(r.displayEmployeeCode || r.employeeCode || '')
      const name = normalizeSearch(r.employeeName || '')
      const dept = normalizeSearch(r.displayDepartment || r.department || '')
      return code.includes(term) || name.includes(term) || dept.includes(term)
    })

    const standardMinutes = Number(attendanceSettings?.standardWorkMinutes) || STANDARD_WORK_MINUTES
    return filtered.map(r => {
      const dailyMap = {}
      let calcTotal = 0
      monthDaysHeader.forEach(({ day, dayStr, date: dateKey, isHoliday, holidayName }) => {
        const dayObj = r.days?.get ? r.days.get(dateKey) : (r.days?.[dateKey] || null)
        const manualWorkday = manualWorkdays[String(r.employeeId)]?.[String(day)]
        let code = ''
        if (dayObj) {
          code = String(dayCode(dayObj) || (dayObj.workdays > 0 ? dayObj.workdays : '') || '')
          if (!code && (dayObj.isHoliday || isHoliday)) code = 'Lễ'
        } else if (isHoliday) code = 'Lễ'
        if (manualWorkday !== undefined && manualWorkday !== null && manualWorkday !== '') {
          code = String(manualWorkday)
        }
        const formula = describeDayWorkFormula({
          ...(dayObj || {}),
          isHoliday: Boolean(dayObj?.isHoliday || isHoliday),
          holidayName: dayObj?.holidayName || holidayName || '',
          manualOverride: manualWorkday !== undefined && manualWorkday !== null && manualWorkday !== ''
        }, { standardMinutes, displayCode: code })
        dailyMap[dateKey] = {
          code,
          formula,
          isHoliday: Boolean(dayObj?.isHoliday || isHoliday),
          holidayName: dayObj?.holidayName || holidayName || '',
          workdays: dayObj?.workdaysExact ?? dayObj?.workdays ?? '',
          manualWorkday,
          isManual: manualWorkday !== undefined && manualWorkday !== null && manualWorkday !== ''
        }
        const num = parseFloat(code)
        if (!isNaN(num)) calcTotal += num
        else if (code === 'P1' || code === 'P') calcTotal += 1.0
      })
      return {
        employeeId: r.employeeId,
        code: r.displayEmployeeCode || r.employeeCode || '',
        name: r.employeeName || '',
        position: r.position || r.chuc_vu || r.displayDepartment || '',
        dailyMap,
        totalCong: r.workdays != null ? Number(r.workdays).toFixed(2) : (calcTotal ? calcTotal.toFixed(2) : '0.00')
      }
    })
  }, [rows, month, monthDaysHeader, excelSearch, attendanceSettings, manualWorkdays])

  const applySnapshot = useCallback((snapshot, nextMonth) => {
    if (!snapshot?.rows) {
      setRows([])
      setGeneratedAt('')
      setSourceLogCount(0)
      setHasSnapshot(false)
      setSnapshotPeriod(null)
      return []
    }
    const nextRows = groupRowsByDepartment(hydrateAttendanceSummaryRows(snapshot.rows))
    setRows(nextRows)
    setGeneratedAt(snapshot.generatedAt || '')
    setSourceLogCount(Number(snapshot.sourceLogCount || 0))
    setHasSnapshot(true)
    setSnapshotPeriod(snapshot.attendancePeriod || null)
    if (snapshot.policySnapshot) setAttendanceSettings(normalizeAttendanceShiftSettings(snapshot.policySnapshot))
    if (nextMonth) setMonth(nextMonth)
    return nextRows
  }, [])

  const loadConfirmations = useCallback(async (targetMonth) => {
    if (!targetMonth) {
      setConfirmations({})
      return
    }
    try {
      const data = await fbGet(`hr/attendanceMonthConfirmations/${targetMonth}`, companyId)
      setConfirmations(data && typeof data === 'object' ? data : {})
    } catch (requestError) {
      console.warn('Không tải được xác nhận bảng công:', requestError)
      setConfirmations({})
    }
  }, [companyId])

  const loadSummaryIndex = useCallback(async () => {
    const ids = await fbListCollectionIds('attendanceMonthSummaries', companyId)
    const months = ids.filter(value => /^\d{4}-\d{2}$/.test(value)).sort().reverse()
    setSummaryMonths(months)
    return months
  }, [companyId])

  const loadMonthSnapshot = useCallback(async (targetMonth) => {
    if (!targetMonth) return
    setLoading(true)
    setError('')
    try {
      const [snapshot, storedSettings, storedManuals, storedPeriod] = await Promise.all([
        fbGet(`hr/attendanceMonthSummaries/${targetMonth}`, companyId),
        fbGet('hr/attendanceSettings/default', companyId),
        fbGet(`hr/manualWorkdays/${targetMonth}`, companyId),
        getAttendancePeriod(companyId, targetMonth),
        loadConfirmations(targetMonth)
      ])
      setAttendancePeriod(storedPeriod)
      setAttendanceSettings(normalizeAttendanceShiftSettings(storedSettings))
      setManualWorkdays(storedManuals || {})
      applySnapshot(snapshot, targetMonth)
    } catch (requestError) {
      console.error('Không tải được bảng công đã tổng hợp:', requestError)
      setError('Không thể tải bảng công đã tổng hợp.')
      applySnapshot(null, targetMonth)
      setConfirmations({})
      setManualWorkdays({})
    } finally {
      setLoading(false)
    }
  }, [applySnapshot, companyId, loadConfirmations])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setLoadedCompanyId('')
      setError('')
      try {
        const months = await loadSummaryIndex()
        if (cancelled) return
        const current = currentMonthValue()
        const snapshots = await Promise.all(
          months.map(value => fbGet(`hr/attendanceMonthSummaries/${value}`, companyId))
        )
        const currentIndex = months.indexOf(current)
        const currentSnapshot = currentIndex >= 0 ? snapshots[currentIndex] : null
        const nonEmptyIndex = snapshots.findIndex(snapshot =>
          Number(snapshot?.sourceLogCount || 0) > 0 ||
          (snapshot?.rows || []).some(row => Number(row?.workdays || 0) > 0)
        )
        const initialIndex = currentSnapshot && (
          Number(currentSnapshot.sourceLogCount || 0) > 0 ||
          (currentSnapshot.rows || []).some(row => Number(row?.workdays || 0) > 0)
        )
          ? currentIndex
          : (nonEmptyIndex >= 0 ? nonEmptyIndex : (currentIndex >= 0 ? currentIndex : 0))
        const initialMonth = months[initialIndex] || current
        const initialSnapshot = snapshots[initialIndex] || null
        const [resolvedSnapshot, storedSettings, storedManuals, storedPeriod] = await Promise.all([
          initialSnapshot
            ? Promise.resolve(initialSnapshot)
            : fbGet(`hr/attendanceMonthSummaries/${initialMonth}`, companyId),
          fbGet('hr/attendanceSettings/default', companyId),
          fbGet(`hr/manualWorkdays/${initialMonth}`, companyId),
          getAttendancePeriod(companyId, initialMonth),
          loadConfirmations(initialMonth)
        ])
        if (cancelled) return
        setAttendanceSettings(normalizeAttendanceShiftSettings(storedSettings))
        setManualWorkdays(storedManuals || {})
        setAttendancePeriod(storedPeriod)
        setMonth(initialMonth)
        applySnapshot(resolvedSnapshot, initialMonth)
        setLoadedCompanyId(companyId)
      } catch (requestError) {
        console.error('Không tải được danh sách bảng công:', requestError)
        if (!cancelled) {
          setError('Không thể tải dữ liệu bảng công.')
          setLoadedCompanyId(companyId)
          setManualWorkdays({})
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [applySnapshot, companyId, loadConfirmations, loadSummaryIndex])

  const handleMonthChange = async (nextMonth) => {
    setMonth(nextMonth)
    setManualNotice('')
    await loadMonthSnapshot(nextMonth)
  }

  const handleOpenExcelDetail = async (requestedMonth = '') => {
    const targetMonth = typeof requestedMonth === 'string' && /^\d{4}-\d{2}$/.test(requestedMonth)
      ? requestedMonth
      : month || currentMonthValue()
    setIsExcelDetailOpen(true)
    setExcelLogsLoading(true)
    setExcelSearch('')
    setExcelPage(1)
    setExcelPageSize(EXCEL_DETAIL_PAGE_SIZE)
    try {
      const [storedPeriod, empData] = await Promise.all([
        getAttendancePeriod(companyId, targetMonth),
        fbGetEmployeesDirectory(companyId)
      ])
      const logsData = await fbGetAttendanceLogsByMonth(targetMonth, companyId,
        storedPeriod || calendarAttendancePeriod(targetMonth))
      const employeesById = new Map(
        (empData
          ? Object.entries(empData).map(([id, value]) => ({ ...value, id }))
          : []
        ).map(employee => [String(employee.id), employee])
      )
      const list = logsData
        ? Object.entries(logsData).map(([id, value]) =>
            enrichExcelLog({ ...value, id }, employeesById)
          )
        : []
      list.sort((a, b) => {
        const nameA = String(a.employeeName || a.machineName || a.tenTheoMayChamCong || '')
        const nameB = String(b.employeeName || b.machineName || b.tenTheoMayChamCong || '')
        if (nameA !== nameB) return nameA.localeCompare(nameB, 'vi')
        return String(a.date || a.timestamp || '').localeCompare(String(b.date || b.timestamp || ''))
      })
      setExcelLogs(list)
    } catch (requestError) {
      console.error('Không tải được bảng chi tiết Excel:', requestError)
      setExcelLogs([])
      alert('Không tải được bảng chi tiết từ Excel: ' + (requestError.message || requestError))
    } finally {
      setExcelLogsLoading(false)
    }
  }

  const handleDownloadExcelDetail = async () => {
    if (!filteredExcelLogs.length) {
      alert('Không có dữ liệu để tải Excel.')
      return
    }
    try {
      await ensureXlsx()
      const rows = filteredExcelLogs.map((log, index) => {
        const dateStr = log.date ? String(log.date).slice(0, 10) : ''
        const hours = Number(log.hours ?? log.soGio ?? log.gio ?? 0) || 0
        const gioPlus = Number(log.gioPlus ?? 0) || 0
        const tongGio = Number(log.tongGio ?? hours + gioPlus) || 0
        const late = Number(log.lateMinutes ?? log.vaoTre ?? 0) || 0
        const early = Number(log.earlyMinutes ?? log.raSom ?? 0) || 0
        return {
          STT: index + 1,
          'Mã NV': log.displayEmployeeCode || log.sourceEmployeeCode || log.employeeCode || '',
          'Họ tên': log.employeeName || '',
          'Công ty': companyName,
          'Tên máy CC': log.machineName || log.tenTheoMayChamCong || '',
          'Phòng ban': log.department || log.phongBan || '',
          Ngày: dateStr
            ? new Date(`${dateStr}T00:00:00`).toLocaleDateString('vi-VN')
            : '',
          Thứ: log.dayOfWeek || log.thu || dayOfWeekFromDate(dateStr) || '',
          Vào: formatTimeHM(log.vao || log.checkIn) || '',
          Ra: formatTimeHM(log.ra || log.checkOut) || '',
          Công: log.cong ?? '',
          Giờ: hours || '',
          'Công+': log.congPlus ?? '',
          'Vào trễ': late || '',
          'Ra sớm': early || '',
          TC1: log.tc1 ?? '',
          TC2: log.tc2 ?? '',
          TC3: log.tc3 ?? '',
          Ca: log.profileShift || log.shiftName || log.tenCa || '',
          KH: log.kyHieu || log.status || '',
          'KH+': log.kyHieuPlus || '',
          'Tổng giờ': tongGio || ''
        }
      })
      const worksheet = XLSX.utils.json_to_sheet(rows)
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, 'BangChiTiet')
      XLSX.writeFile(workbook, `Bang_cham_cong_chi_tiet_${month || currentMonthValue()}.xlsx`)
    } catch (requestError) {
      console.error('Không tải được Excel bảng chi tiết:', requestError)
      alert('Không tải được Excel: ' + (requestError.message || requestError))
    }
  }

  const filteredExcelLogs = useMemo(() => {
    const term = normalizeSearch(excelSearch)
    if (!term) return excelLogs
    return excelLogs.filter(log => {
      const haystack = [
        log.displayEmployeeCode,
        log.sourceEmployeeCode,
        log.employeeCode,
        log.employeeName,
        log.machineName,
        log.tenTheoMayChamCong,
        log.department,
        log.phongBan,
        log.date
      ].map(normalizeSearch).join(' ')
      return haystack.includes(term)
    })
  }, [excelLogs, excelSearch])

  const excelTotalPages = Math.max(1, Math.ceil(filteredExcelLogs.length / excelPageSize) || 1)
  const excelSafePage = Math.min(excelPage, excelTotalPages)
  const excelPageStart = filteredExcelLogs.length === 0 ? 0 : (excelSafePage - 1) * excelPageSize + 1
  const excelPageEnd = Math.min(excelSafePage * excelPageSize, filteredExcelLogs.length)

  const visibleExcelLogs = useMemo(
    () => filteredExcelLogs.slice((excelSafePage - 1) * excelPageSize, excelSafePage * excelPageSize),
    [excelPageSize, excelSafePage, filteredExcelLogs]
  )

  const handleDownloadSummaryPdf = () => {
    if (!rows.length) {
      alert('Chưa có dữ liệu bảng công tổng hợp để xuất PDF.')
      return
    }

    const headers = [
      'STT', 'Họ tên', 'Công ty', 'Bộ phận', 'Ca làm', 'Tổng công',
      'Notes', 'Tăng ca', 'Phép sử dụng', 'Công làm lễ', 'Công lễ'
    ]
    const reportRows = rows.map((row, index) => [
      index + 1,
      row.employeeName || '-',
      companyName,
      row.displayDepartment || row.department || '-',
      row.shift || '-',
      row.workdays != null && row.workdays !== '' ? Number(row.workdays).toFixed(2) : '0.00',
      row.notes || '-',
      row.overtimeHours ?? '-',
      row.paidLeaveWorkdays ?? '-',
      row.congLamLe ?? row.holidayWorkdays ?? '-',
      row.congLe ?? '-'
    ])

    openAttendancePrintWindow({
      title: `Bảng công tổng hợp tháng ${month}`,
      companyName,
      month,
      filterLabel: 'Tất cả nhân sự',
      exportedAt: new Date().toLocaleString('vi-VN'),
      headers,
      rows: reportRows,
      tableMode: 'list'
    })
  }

  const handleDownloadHr31Excel = async () => {
    if (!isHr31 || !hasSnapshot || !rows.length || isBusy || manualSavingKey || confirmSaving) return
    setExportingExcel(true)
    try {
      const { downloadHr31Attendance } = await import('../utils/hr31AttendanceExcel')
      await downloadHr31Attendance({
        rows,
        month,
        attendancePeriod: activePeriod,
        attendanceSettings,
        companyName,
        companyAddress: company?.address || company?.dia_chi || ''
      })
    } catch (requestError) {
      console.error('Không thể xuất Excel HR31:', requestError)
      alert('Không thể xuất Excel HR31: ' + (requestError.message || requestError))
    } finally {
      setExportingExcel(false)
    }
  }

  useEffect(() => {
    setExcelPage(1)
  }, [excelSearch, excelPageSize])

  useEffect(() => {
    if (excelPage > excelTotalPages) setExcelPage(excelTotalPages)
  }, [excelPage, excelTotalPages])

  const handleOpenImport = async () => {
    setImportEmployees([])
    setImportLogs([])
    try {
      const [empData, logsData, storedSettings] = await Promise.all([
        fbGetEmployeesDirectory(companyId),
        // Nạp toàn bộ log để chống tạo bản ghi trùng khi file có tháng khác
        // tháng đang chọn trên màn hình (tháng sẽ được nhận diện từ file).
        fbGet('hr/attendanceLogs', companyId),
        fbGet('hr/attendanceSettings/default', companyId)
      ])
      setImportSettings(normalizeAttendanceShiftSettings(storedSettings))
      if (empData) {
        setImportEmployees(
          Array.isArray(empData)
            ? empData
            : Object.entries(empData).map(([id, value]) => ({ ...value, id }))
        )
      }
      if (logsData) {
        setImportLogs(
          Array.isArray(logsData)
            ? logsData
            : Object.entries(logsData).map(([id, value]) => ({ ...value, id }))
        )
      }
    } catch (err) {
      console.warn('Không thể nạp trước dữ liệu nhân sự để import:', err)
      alert('Không tải được danh mục nhân viên hoặc cài đặt. Vui lòng thử mở Import lại; chưa có dữ liệu nào được ghi.')
      return
    }
    setIsImportOpen(true)
  }

  const saveMonthSummary = useCallback(async (targetMonth, { silent = false, apply = true, preservePolicy = false } = {}) => {
    if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
      throw new Error('Tháng không hợp lệ. Dùng định dạng YYYY-MM.')
    }

    const [employeeData, storedPeriod, nextAdjustments, nextManuals, storedSettings, previousSnapshot] = await Promise.all([
      fbGetEmployeesDirectory(companyId),
      getAttendancePeriod(companyId, targetMonth),
      fbGet(`hr/attendanceAdjustments/${targetMonth}`, companyId),
      fbGet(`hr/manualWorkdays/${targetMonth}`, companyId),
      fbGet('hr/attendanceSettings/default', companyId),
      preservePolicy ? fbGet(`hr/attendanceMonthSummaries/${targetMonth}`, companyId) : Promise.resolve(null)
    ])
    const effectivePeriod = storedPeriod || calendarAttendancePeriod(targetMonth)
    const logData = await fbGetAttendanceLogsByMonth(targetMonth, companyId, effectivePeriod)
    const nextAttendanceSettings = normalizeAttendanceShiftSettings(previousSnapshot?.policySnapshot || storedSettings)
    if (apply) {
      setAttendanceSettings(nextAttendanceSettings)
      setManualWorkdays(nextManuals || {})
    }
    const employeeList = employeeData
      ? Object.entries(employeeData).map(([id, value]) => ({ ...value, id }))
      : []
    const monthLogs = logData
      ? Object.entries(logData).map(([id, value]) => ({ ...value, id }))
      : []
    const summaryRows = buildAttendanceSummary({
      attendanceLogs: monthLogs,
      employees: employeeList,
      month: targetMonth,
      attendancePeriod: effectivePeriod,
      attendanceAdjustments: nextAdjustments || {},
      manualWorkdays: nextManuals || {},
      attendanceSettings: nextAttendanceSettings
    })
    const validEmpIds = new Set(employeeList.map(e => String(e.id)))
    const filteredSummaryRows = summaryRows.filter(row => validEmpIds.has(String(row.employeeId)))
    const snapshot = {
      month: targetMonth,
      attendancePeriod: effectivePeriod,
      companyId,
      companyName,
      generatedAt: new Date().toISOString(),
      policyVersion: nextAttendanceSettings.policyVersion,
      policySnapshot: nextAttendanceSettings,
      sourceLogCount: monthLogs.length,
      employeeCount: filteredSummaryRows.length,
      rows: serializeAttendanceSummaryRows(filteredSummaryRows)
    }
    await fbSet(`hr/attendanceMonthSummaries/${targetMonth}`, snapshot, companyId)
    if (apply) {
      setAttendancePeriod(storedPeriod)
      applySnapshot(snapshot, targetMonth)
    }
    setSummaryMonths(prev => {
      const next = new Set(prev)
      next.add(targetMonth)
      return Array.from(next).sort().reverse()
    })
    if (!silent) {
      alert(`Đã lưu bảng công tháng ${targetMonth} (${summaryRows.length} nhân viên).`)
    }
    return snapshot
  }, [applySnapshot, companyId, companyName])

  useEffect(() => {
    if (loadedCompanyId !== companyId || !hasSnapshot || !attendancePeriod) return
    if (snapshotPeriod?.startDate === attendancePeriod.startDate &&
      snapshotPeriod?.endDate === attendancePeriod.endDate) return
    setSummarizing(true)
    saveMonthSummary(month, { silent: true }).catch(requestError => {
      console.error('Không cập nhật được bảng công theo kỳ mới:', requestError)
      setError('Kỳ công đã thay đổi; chưa cập nhật được bảng tổng hợp. Hãy bấm Tổng hợp lại.')
    }).finally(() => setSummarizing(false))
  }, [attendancePeriod?.startDate, attendancePeriod?.endDate, companyId, hasSnapshot,
    loadedCompanyId, month, saveMonthSummary, snapshotPeriod?.startDate, snapshotPeriod?.endDate])

  const handleSaveManualWorkday = async (employeeId, day, rawValue) => {
    const parsed = parseManualWorkdayInput(rawValue)
    if (!parsed.valid) {
      alert(parsed.error)
      return
    }
    if (attendanceSettings.manualOverridePriority === 'none') {
      alert('Công ty hiện không cho phép chỉnh công tay.')
      return
    }
    const existingRow = rows.find(row => String(row.employeeId) === String(employeeId))
    const manualDate = attendanceDateForDay(activePeriod, day)
    if (!manualDate) {
      alert('Ngày không thuộc kỳ công hiện tại.')
      return
    }
    const existingDay = existingRow?.days?.get?.(manualDate)
    if (attendanceSettings.manualOverridePriority === 'allowed' && parsed.value !== null &&
      !existingDay?.manualOverride &&
      Number(existingDay?.workdaysExact ?? existingDay?.workdays ?? 0) > 0) {
      alert('Chỉ được chỉnh tay ngày chưa có công theo cấu hình công ty.')
      return
    }

    const employeeKey = String(employeeId)
    const savingKey = `${employeeKey}:${day}`
    const previous = manualWorkdays
    const next = updateManualWorkdays(previous, employeeKey, day, parsed.value)
    setManualWorkdays(next)
    setManualSavingKey(savingKey)
    setManualNotice('')
    let persisted = false

    try {
      await fbSet(
        `hr/manualWorkdays/${month}/${employeeKey}`,
        next[employeeKey] || {},
        companyId
      )
      persisted = true
      const snapshot = await saveMonthSummary(month, { silent: true, preservePolicy: true })
      const refreshedRows = groupRowsByDepartment(hydrateAttendanceSummaryRows(snapshot.rows || []))
      const refreshedDetail = refreshedRows.find(row => String(row.employeeId) === employeeKey)
      if (refreshedDetail) setDetailRow(refreshedDetail)
      setManualNotice(
        parsed.value === null
          ? 'Đã bỏ chỉnh tay và khôi phục số công tự động.'
          : `Đã lưu ${parsed.value} công cho ngày ${manualDate}.`
      )
    } catch (requestError) {
      console.error('Không lưu được số công chỉnh tay:', requestError)
      if (!persisted) setManualWorkdays(previous)
      alert(
        persisted
          ? 'Đã lưu số công nhưng chưa tổng hợp lại được bảng: ' + (requestError.message || requestError)
          : 'Không lưu được số công: ' + (requestError.message || requestError)
      )
    } finally {
      setManualSavingKey('')
    }
  }

  const handleImportComplete = async (result = '') => {
    setIsImportOpen(false)
    const primaryMonth = typeof result === 'string' ? result : result?.primaryMonth
    const targetMonth = primaryMonth || month || currentMonthValue()
    const affectedMonths = [...new Set([
      ...(Array.isArray(result?.affectedMonths) ? result.affectedMonths : []),
      targetMonth
    ])].filter(value => /^\d{4}-\d{2}$/.test(value))
    setSummarizing(true)
    setError('')
    try {
      for (const affectedMonth of affectedMonths) {
        await saveMonthSummary(affectedMonth, {
          silent: true,
          apply: affectedMonth === targetMonth
        })
      }
      await loadSummaryIndex()
      if (isExcelDetailOpen) {
        await handleOpenExcelDetail(targetMonth)
      }
      alert(`Đã đồng bộ Excel và lưu bảng công tháng ${affectedMonths.join(', ')}.`)
      return { summaryStatus: 'complete', affectedMonths }
    } catch (requestError) {
      console.error('Lưu bảng công sau import thất bại:', requestError)
      alert('Import xong nhưng chưa lưu được bảng công: ' + (requestError.message || requestError))
      await loadMonthSnapshot(targetMonth)
      return { summaryStatus: 'failed', error: requestError.message || String(requestError), affectedMonths }
    } finally {
      setSummarizing(false)
    }
  }

  const handleSummarize = async () => {
    if (isBusy) return
    const targetMonth = month || currentMonthValue()
    if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
      alert('Tháng không hợp lệ. Dùng định dạng YYYY-MM.')
      return
    }
    if (!confirm(`Tổng hợp lại bảng công tháng ${targetMonth} từ dữ liệu chấm công hiện có?`)) {
      return
    }

    setSummarizing(true)
    setError('')
    try {
      await saveMonthSummary(targetMonth)
    } catch (requestError) {
      console.error('Tổng hợp bảng công thất bại:', requestError)
      alert('Lỗi tổng hợp bảng công: ' + (requestError.message || requestError))
    } finally {
      setSummarizing(false)
    }
  }

  const handleDeleteMonth = async () => {
    if (!canEditWorkdays || isBusy || manualSavingKey || confirmSaving || excelLogsLoading) return
    const targetMonth = month
    if (!confirm(
      `Xóa toàn bộ bảng công tháng ${targetMonth} của công ty ${companyName}?\n` +
      `Kỳ công: ${activePeriod.startDate} – ${activePeriod.endDate}.\n\n` +
      'Dữ liệu chấm công, bảng tổng hợp, công chỉnh tay và dấu xác nhận của kỳ này sẽ bị xóa. Thao tác này không thể hoàn tác; bạn cần tải Excel lại để nhập dữ liệu mới.'
    )) return

    setDeleting(true)
    setError('')
    try {
      await fbDeleteAttendanceMonth(targetMonth, companyId, activePeriod)
      applySnapshot(null)
      setConfirmations({})
      setManualWorkdays({})
      setSummaryMonths(previous => previous.filter(value => value !== targetMonth))
      setDetailRow(null)
      setIsExcelDetailOpen(false)
      setExcelLogs([])
      setImportLogs([])
      setManualNotice('')
      alert(`Đã xóa bảng công và dữ liệu chấm công của kỳ ${activePeriod.startDate} – ${activePeriod.endDate}. Bạn có thể tải Excel lại.`)
    } catch (requestError) {
      console.error('Xóa bảng công thất bại:', requestError)
      alert('Không thể xóa bảng công: ' + (requestError.message || requestError))
    } finally {
      setDeleting(false)
    }
  }

  const handleToggleConfirm = async (employeeId, checked) => {
    if (deleting) return
    const targetMonth = month || currentMonthValue()
    const key = String(employeeId)
    const previous = confirmations
    const next = { ...confirmations }
    if (checked) next[key] = true
    else delete next[key]
    setConfirmations(next)
    setConfirmSaving(true)
    try {
      await fbSet(`hr/attendanceMonthConfirmations/${targetMonth}`, next, companyId)
    } catch (requestError) {
      console.error('Không lưu được xác nhận:', requestError)
      setConfirmations(previous)
      alert('Không lưu được xác nhận: ' + (requestError.message || requestError))
    } finally {
      setConfirmSaving(false)
    }
  }

  const allConfirmed = rows.length > 0 && rows.every(row => confirmations[String(row.employeeId)])

  const handleToggleConfirmAll = async (checked) => {
    if (deleting) return
    const targetMonth = month || currentMonthValue()
    const previous = confirmations
    const next = checked
      ? Object.fromEntries(rows.map(row => [String(row.employeeId), true]))
      : {}
    setConfirmations(next)
    setConfirmSaving(true)
    try {
      await fbSet(`hr/attendanceMonthConfirmations/${targetMonth}`, next, companyId)
    } catch (requestError) {
      console.error('Không lưu được xác nhận:', requestError)
      setConfirmations(previous)
      alert('Không lưu được xác nhận: ' + (requestError.message || requestError))
    } finally {
      setConfirmSaving(false)
    }
  }

  const departmentRowSpans = useMemo(() => getConsecutiveDepartmentRowSpans(rows), [rows])
  const calendar = useMemo(() => {
    return periodDates.map((date, index) => ({
      day: index + 1,
      date,
      weekday: ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][new Date(`${date}T00:00:00`).getDay()]
    }))
  }, [periodDates])
  const weeklyPeople = useMemo(() => {
    const weekRanges = [1, 8, 15, 22, 29].map((start, index) => ({
      label: `Tuần ${index + 1}`,
      start,
      end: Math.min(start + 6, calendar.length)
    }))
    const checks = [
      // Yêu cầu 8: Tạm thời vô hiệu hóa các kết luận tự suy đoán (Đi muộn, Không chấm công)
      // ['Đi muộn', day => day?.late],
      // ['Không chấm công', day => day?.missingPunch],
      ['Nghỉ không phép', day => day?.unapprovedAbsence]
    ]

    return rows
      .map(row => {
        const weeks = weekRanges.map(week => {
          const flags = checks
            .filter(([, predicate]) =>
              Array.from(
                { length: Math.max(0, week.end - week.start + 1) },
                (_, offset) => row.days.get(calendar[week.start + offset - 1]?.date)
              ).some(predicate)
            )
            .map(([label]) => label)
          return { label: week.label, flags }
        })
        const hasIssue = weeks.some(week => week.flags.length > 0)
        if (!hasIssue) return null
        return {
          employeeId: row.employeeId,
          employeeCode: row.employeeCode || '',
          employeeName: row.employeeName || '',
          weeks
        }
      })
      .filter(Boolean)
  }, [calendar, rows])
  const weekLabels = useMemo(
    () => [1, 2, 3, 4, 5].map(index => `Tuần ${index}`),
    []
  )
  const detailDays = useMemo(() => {
    if (!detailRow || !month) return []
    const fallbackShift = resolveAttendanceShift(
      {
        shift: detailRow.shift,
        ca_lam_viec: detailRow.shift,
        standardCheckIn: detailRow.standardCheckIn,
        standardCheckOut: detailRow.standardCheckOut
      },
      { shiftName: detailRow.shift, tenCa: detailRow.shift },
      attendanceSettings
    )
    const fallbackStandardIn = formatAttendanceTime(fallbackShift?.start || fallbackShift?.standardCheckIn)
    const fallbackStandardOut = formatAttendanceTime(fallbackShift?.end || fallbackShift?.standardCheckOut)

    return periodDates.map(date => {
      const day = Number(date.slice(8, 10))
      const dayData = detailRow.days?.get?.(date) || null
      const log = dayData?.logs?.[0] || {}
      const checkIn = formatAttendanceTime(
        dayData?.checkIn || log.checkIn || log.vao || ''
      )
      const checkOut = formatAttendanceTime(
        dayData?.checkOut || log.checkOut || log.ra || ''
      )
      const standardCheckIn = formatAttendanceTime(
        dayData?.standardCheckIn || fallbackStandardIn
      )
      const standardCheckOut = formatAttendanceTime(
        dayData?.standardCheckOut || fallbackStandardOut
      )
      return {
        day,
        date,
        weekday: ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][new Date(`${date}T00:00:00`).getDay()],
        code: dayCode(dayData),
        workdays: dayData?.workdays ?? '',
        manualWorkday: manualWorkdays[String(detailRow.employeeId)]?.[String(day)],
        hours: dayData?.hours || '',
        overtimeHours: dayData?.overtimeHours || '',
        checkIn,
        checkOut,
        standardCheckIn,
        standardCheckOut,
        notes: dayNotes(dayData),
        hasData: Boolean(dayData)
      }
    })
  }, [attendanceSettings, detailRow, manualWorkdays, month, periodDates])
  const detailStandardLabel = useMemo(() => {
    if (!detailDays.length) return ''
    const sample = detailDays.find(item => item.standardCheckIn && item.standardCheckOut) || detailDays[0]
    if (!sample?.standardCheckIn || !sample?.standardCheckOut) return ''
    return `${sample.standardCheckIn} - ${sample.standardCheckOut}`
  }, [detailDays])

  if (loading || loadedCompanyId !== companyId) return <div className="attendance-preview-state">Đang tải bảng công đã tổng hợp...</div>
  if (error && !hasSnapshot) return <div className="attendance-preview-state is-error">{error}</div>

  return <div className="attendance-preview-page">
    <header>
      <div>
        <h1>Bảng công {month}</h1>
        <p className="attendance-company-context">Kỳ công: <strong>{activePeriod.startDate} – {activePeriod.endDate}</strong>{!attendancePeriod ? ' (tháng dương lịch, chưa xác nhận)' : ''}</p>
        <p className="attendance-company-context">Công ty: <strong>{companyName}</strong></p>
        <p>
          {hasSnapshot
            ? `Đã lưu lúc ${formatGeneratedAt(generatedAt)}${sourceLogCount ? ` · ${sourceLogCount} bản ghi chấm công` : ''}`
            : 'Chưa có bảng công tháng này · Tải Excel để đồng bộ và lưu'}
        </p>
      </div>
      <div className="attendance-preview-actions">
        <label>
          Tháng
          <input
            type="month"
            value={month}
            onChange={event => handleMonthChange(event.target.value)}
            disabled={isBusy}
          />
        </label>
        {summaryMonths.length > 0 && (
          <label>
            Đã lưu
            <select
              value={summaryMonths.includes(month) ? month : ''}
              onChange={event => event.target.value && handleMonthChange(event.target.value)}
              disabled={isBusy}
            >
              {!summaryMonths.includes(month) && <option value="">Chọn tháng đã lưu</option>}
              {summaryMonths.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        )}
        <button
          type="button"
          className="attendance-preview-import-btn"
          onClick={handleOpenImport}
          disabled={isBusy}
        >
          Tải Excel & Lưu bảng công
        </button>
        <button
          type="button"
          className="attendance-preview-detail-btn"
          onClick={handleOpenExcelDetail}
          disabled={isBusy || excelLogsLoading}
          title="Xem bảng chấm công chi tiết đã tải từ Excel"
        >
          {excelLogsLoading ? 'Đang tải...' : 'Xem bảng chi tiết'}
        </button>
        {(hasSnapshot || canEditWorkdays) && (
          <button type="button" className="attendance-preview-summarize" onClick={handleSummarize} disabled={isBusy}>
            {summarizing ? 'Đang lưu...' : hasSnapshot ? 'Tổng hợp lại' : 'Tổng hợp bảng công'}
          </button>
        )}
        {hasSnapshot && (
          <button
            type="button"
            className="attendance-preview-pdf-btn"
            onClick={handleDownloadSummaryPdf}
            disabled={isBusy || !rows.length}
            title={`Xuất bảng công tổng hợp tháng ${month} dưới dạng PDF`}
          >
            Tải PDF
          </button>
        )}
        {isHr31 && hasSnapshot && (
          <button
            type="button"
            className="attendance-preview-excel-btn"
            onClick={handleDownloadHr31Excel}
            disabled={isBusy || !rows.length || Boolean(manualSavingKey) || confirmSaving}
            title={`Xuất bảng công đã lưu tháng ${month} theo mẫu HR31`}
          >
            {exportingExcel ? 'Đang xuất Excel...' : 'Xuất Excel HR31'}
          </button>
        )}
        {canEditWorkdays && (
          <button
            type="button"
            className="attendance-preview-delete-btn"
            onClick={handleDeleteMonth}
            disabled={isBusy || Boolean(manualSavingKey) || confirmSaving || excelLogsLoading}
            title={`Xóa toàn bộ dữ liệu bảng công kỳ ${activePeriod.startDate} – ${activePeriod.endDate}`}
          >
            <i className="fas fa-trash-alt" aria-hidden="true"></i>{' '}
            {deleting ? 'Đang xóa...' : 'Xóa bảng công'}
          </button>
        )}
      </div>
    </header>

    {!hasSnapshot ? (
      <div className="attendance-preview-empty">
        <p>Tháng {month} chưa có bảng công đã lưu.</p>
        <p>Bấm <strong>Tổng hợp bảng công</strong> để tạo bảng từ dữ liệu chấm công hiện có, hoặc <strong>Tải Excel & Lưu bảng công</strong> để tải dữ liệu mới.</p>
      </div>
    ) : (
      <>
        <div className="attendance-preview-scroll"><table className="attendance-preview-table is-compact">
          <thead>
            <tr className="groups">
              <th>STT</th>
              <th>
                <label className="attendance-confirm-cell">
                  <input
                    type="checkbox"
                    checked={allConfirmed}
                    disabled={deleting || confirmSaving || !rows.length}
                    onChange={event => handleToggleConfirmAll(event.target.checked)}
                    title="Xác nhận tất cả"
                  />
                  <span>Xác nhận</span>
                </label>
              </th>
              <th>Họ tên</th>
              <th>Công ty</th>
              <th>Bộ phận</th>
              <th>Ca làm</th>
              <th>Tổng công</th>
              <th>Notes</th>
              <th>Tăng ca</th>
              <th>Phép sử dụng</th>
              <th>Công làm lễ</th>
              <th>Công lễ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.employeeId} className={confirmations[String(row.employeeId)] ? 'is-confirmed' : ''}>
                <td>{index + 1}</td>
                <td>
                  <input
                    type="checkbox"
                    className="attendance-confirm-check"
                    checked={Boolean(confirmations[String(row.employeeId)])}
                    disabled={deleting || confirmSaving}
                    onChange={event => handleToggleConfirm(row.employeeId, event.target.checked)}
                    aria-label={`Xác nhận ${row.employeeName || ''}`}
                  />
                </td>
                <td
                  className="name is-clickable"
                  onClick={() => setDetailRow(row)}
                  title="Xem chi tiết từng ngày"
                >
                  {row.employeeName}
                </td>
                <td>{companyName}</td>
                {departmentRowSpans[index] > 0 && (
                  <td rowSpan={departmentRowSpans[index]}>{row.displayDepartment}</td>
                )}
                <td>{row.shift}</td>
                <td
                  className={canEditWorkdays ? 'is-clickable workdays-total' : ''}
                  onClick={() => canEditWorkdays && setDetailRow(row)}
                  title={canEditWorkdays ? 'Mở chi tiết để chỉnh tay số công từng ngày' : undefined}
                >
                  {row.workdays != null && row.workdays !== '' ? Number(row.workdays).toFixed(2) : ''}
                  {canEditWorkdays && <i className="fas fa-pen" aria-hidden="true"></i>}
                </td>
                <td>{row.notes || ''}</td>
                <td>{row.overtimeHours || ''}</td>
                <td>{row.paidLeaveWorkdays || ''}</td>
                <td></td>
                <td></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <section className="attendance-preview-weeks">
          <div className="attendance-preview-weeks__head">
            <h2>Tổng hợp theo tuần</h2>
            <span>{weeklyPeople.length} nhân sự có phát sinh</span>
          </div>
          <div className="attendance-preview-weeks__scroll">
            <table className="attendance-preview-weeks-table">
              <thead>
                <tr>
                  <th>STT</th>
                  <th>Mã NV</th>
                  <th>Nhân sự</th>
                  <th>Công ty</th>
                  {weekLabels.map(label => <th key={label}>{label}</th>)}
                </tr>
              </thead>
              <tbody>
                {weeklyPeople.length === 0 ? (
                  <tr>
                    <td colSpan={4 + weekLabels.length} className="weeks-empty">Không có phát sinh theo tuần</td>
                  </tr>
                ) : (
                  weeklyPeople.map((person, index) => (
                    <tr key={person.employeeId || person.employeeName}>
                      <td>{index + 1}</td>
                      <td className="employee-code">{person.employeeCode || '-'}</td>
                      <td className="name">{person.employeeName}</td>
                      <td>{companyName}</td>
                      {person.weeks.map(week => (
                        <td key={week.label} className={week.flags.length ? 'has-issue' : ''}>
                          {week.flags.length ? week.flags.join(' · ') : '—'}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
        <section className="attendance-preview-legend"><strong>Chú thích:</strong><span>X: Nghỉ theo lịch/không phép theo trạng thái</span><span>P1: Nghỉ phép năm</span><span>1 / 0.5: Công trong ngày</span><span>Lễ: Ngày lễ cấu hình, không tự tính công</span></section>
      </>
    )}
    {isImportOpen && (
      <AttendanceImportModal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        onSave={handleImportComplete}
        onPeriodConfirmed={period => saveMonthSummary(period.month, {
          silent: true,
          apply: period.month === month
        })}
        employees={importEmployees}
        attendanceLogs={importLogs}
        attendanceSettings={importSettings}
        companyId={companyId}
        companyName={companyName}
      />
    )}
    {detailRow && (
      <div className="attendance-day-detail-overlay" onClick={() => setDetailRow(null)}>
        <div className="attendance-day-detail-modal" onClick={event => event.stopPropagation()}>
          <header>
            <div>
              <h2>{detailRow.employeeName}</h2>
              <p>
                {detailRow.employeeCode ? `${detailRow.employeeCode} · ` : ''}
                {detailRow.displayDepartment || detailRow.department || ''}
                {detailRow.shift ? ` · ${detailRow.shift}` : ''}
                {` · ${companyName}`}
                {` · Tháng ${month}`}
              </p>
            </div>
            <button type="button" onClick={() => setDetailRow(null)}>Đóng</button>
          </header>
          <div className="attendance-day-detail-summary">
            <span>Tổng công: <strong>{detailRow.workdays || 0}</strong></span>
            <span>Tăng ca: <strong>{detailRow.overtimeHours || 0}</strong></span>
            <span>Phép: <strong>{detailRow.paidLeaveWorkdays || 0}</strong></span>
            <span>Muộn: <strong>{detailRow.lateCount || 0}</strong></span>
            <span>Quên chấm: <strong>{detailRow.missingPunchCount || 0}</strong></span>
            {detailStandardLabel && (
              <span className="is-standard">Giờ tiêu chuẩn: <strong>{detailStandardLabel}</strong></span>
            )}
          </div>
          {canEditWorkdays && (
            <div className="manual-workday-help">
              <strong>Kế toán/HR chỉnh công:</strong> nhập từ 0 đến 1 tại cột Công. Xóa ô rồi rời khỏi ô để dùng lại kết quả tự động.
              {manualNotice && <span>{manualNotice}</span>}
            </div>
          )}
          <div className="attendance-day-detail-scroll">
            <table>
              <thead>
                <tr>
                  <th>Ngày</th>
                  <th>Thứ</th>
                  <th>Ký hiệu</th>
                  <th>Giờ vào</th>
                  <th>Giờ ra</th>
                  <th>Tiêu chuẩn</th>
                  <th>Công</th>
                  <th>Giờ</th>
                  <th>Tăng ca</th>
                  <th>Ghi chú</th>
                </tr>
              </thead>
              <tbody>
                {detailDays.map(item => (
                  <tr key={item.date} className={item.hasData ? '' : 'is-empty'}>
                    <td>{dateText(item.date)}</td>
                    <td>{item.weekday}</td>
                    <td>{item.code || '—'}</td>
                    <td className={item.checkIn && item.standardCheckIn && item.checkIn > item.standardCheckIn ? 'is-late' : ''}>
                      {item.checkIn || '—'}
                    </td>
                    <td className={item.checkOut && item.standardCheckOut && item.checkOut < item.standardCheckOut ? 'is-early' : ''}>
                      {item.checkOut || '—'}
                    </td>
                    <td className="standard">
                      {item.standardCheckIn && item.standardCheckOut
                        ? `${item.standardCheckIn} - ${item.standardCheckOut}`
                        : '—'}
                    </td>
                    <td className={item.manualWorkday !== undefined ? 'manual-workday-cell is-manual' : 'manual-workday-cell'}>
                      {canEditWorkdays && attendanceSettings.manualOverridePriority !== 'none' ? (
                        <ManualWorkdayInput
                          value={item.manualWorkday !== undefined ? item.manualWorkday : item.workdays}
                          isManual={item.manualWorkday !== undefined}
                          disabled={deleting || manualSavingKey === `${String(detailRow.employeeId)}:${item.day}`}
                          employeeName={detailRow.employeeName}
                          date={item.date}
                          onSave={value => handleSaveManualWorkday(detailRow.employeeId, item.day, value)}
                        />
                      ) : (item.workdays !== '' ? item.workdays : '—')}
                    </td>
                    <td>{item.hours || '—'}</td>
                    <td>{item.overtimeHours || '—'}</td>
                    <td className="note">{item.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    )}
    {isExcelDetailOpen && (
      <div className="attendance-day-detail-overlay" onClick={() => setIsExcelDetailOpen(false)}>
        <div
          className="attendance-excel-detail-modal"
          onClick={event => event.stopPropagation()}
        >
          <div className="attendance-excel-detail-head">
            <div>
              <h2>Bảng chi tiết từ Excel</h2>
              <div className="attendance-detail-mode-tabs">
                <button
                  type="button"
                  className={detailViewMode === 'matrix' ? 'is-active' : ''}
                  onClick={() => setDetailViewMode('matrix')}
                >
                  Ma trận ngày (01 - 31)
                </button>
                <button
                  type="button"
                  className={detailViewMode === 'list' ? 'is-active' : ''}
                  onClick={() => setDetailViewMode('list')}
                >
                  Nhật ký theo dòng
                </button>
              </div>
              <p>
                Tháng {month}
                {detailViewMode === 'matrix'
                  ? ` · ${matrixRows.length} nhân viên`
                  : excelLogsLoading
                    ? ' · Đang tải...'
                    : ` · ${filteredExcelLogs.length}/${excelLogs.length} dòng`}
              </p>
            </div>
            <div className="attendance-excel-detail-tools">
              <input
                type="search"
                placeholder="Tìm tên, mã NV, phòng ban..."
                value={excelSearch}
                onChange={event => setExcelSearch(event.target.value)}
              />
              <button
                type="button"
                className="attendance-excel-download-btn"
                onClick={handleDownloadExcelDetail}
                disabled={excelLogsLoading || !filteredExcelLogs.length}
                title={`Tải dữ liệu chấm công tháng ${month} của ${companyName} xuống Excel`}
              >
                Tải Excel
              </button>
              <button type="button" onClick={() => setIsExcelDetailOpen(false)}>Đóng</button>
            </div>
          </div>

          {detailViewMode === 'matrix' ? (
            <div className="attendance-excel-detail-scroll attendance-matrix-scroll">
              {canEditWorkdays && (
                <div className="manual-workday-help matrix-edit-help">
                  <strong>Chỉnh công trên ma trận:</strong> bấm vào ô ngày, nhập 0–1 rồi rời ô để lưu. Xóa giá trị để dùng lại công thức tự động.
                  {manualNotice && <span>{manualNotice}</span>}
                </div>
              )}
              {matrixHolidayLegend.length > 0 && (
                <div className="matrix-holiday-legend">
                  <strong>Ngày lễ tháng này:</strong>
                  {matrixHolidayLegend.map(day => (
                    <span key={day.date}>
                      {day.date.slice(8, 10)}/{day.date.slice(5, 7)}
                      {day.holidayName ? ` · ${day.holidayName}` : ''}
                    </span>
                  ))}
                </div>
              )}
              <table className="attendance-matrix-table">
                <thead>
                  <tr className="matrix-group-row">
                    <th rowSpan="2" className="col-stt">STT</th>
                    <th rowSpan="2" className="col-code">Mã nhân viên</th>
                    <th rowSpan="2" className="col-name">Họ và tên</th>
                    <th rowSpan="2" className="col-company">Công ty</th>
                    <th rowSpan="2" className="col-pos">Chức vụ</th>
                    <th colSpan={monthDaysHeader.length} className="matrix-month-title">
                      Ngày trong tháng
                    </th>
                    <th rowSpan="2" className="col-total">Tổng công</th>
                  </tr>
                  <tr className="matrix-days-row">
                    {monthDaysHeader.map(d => (
                      <th
                        key={d.date}
                        className={`day-col ${d.isSunday ? 'is-sunday' : ''} ${d.isSaturday ? 'is-saturday' : ''} ${d.isHoliday ? 'is-holiday' : ''}`}
                        title={d.isHoliday ? (d.holidayName ? `Ngày lễ: ${d.holidayName}` : 'Ngày lễ') : undefined}
                      >
                        <div className="day-number">{d.dayStr}/{d.date.slice(5, 7)}</div>
                        <div className="day-dow">{d.isHoliday ? 'Lễ' : d.dow}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrixRows.length === 0 ? (
                    <tr>
                      <td colSpan={monthDaysHeader.length + 6} className="empty">
                        Chưa có dữ liệu bảng công cho tháng {month}.
                      </td>
                    </tr>
                  ) : (
                    matrixRows.map((emp, idx) => (
                      <tr key={emp.employeeId || emp.code || idx}>
                        <td className="col-stt">{idx + 1}</td>
                        <td className="col-code font-bold">{emp.code || '-'}</td>
                        <td className="col-name font-semibold">{emp.name || '-'}</td>
                        <td className="col-company">{companyName}</td>
                        <td className="col-pos">{emp.position || '-'}</td>
                        {monthDaysHeader.map(d => {
                          const cell = emp.dailyMap[d.date] || {}
                          const val = cell.code || ''
                          const isOff = val === '0' || (d.isSunday && !val)
                          const isHoliday = Boolean(cell.isHoliday || d.isHoliday)
                          return (
                            <td
                              key={d.date}
                              className={`matrix-cell ${isOff ? 'is-off' : ''} ${val === '1' ? 'is-work' : ''} ${isHoliday ? 'is-holiday' : ''} ${cell.isManual ? 'is-manual' : ''} ${canEditWorkdays && attendanceSettings.manualOverridePriority !== 'none' ? 'is-editable' : ''}`}
                              title={cell.formula || (isHoliday ? (cell.holidayName || d.holidayName || 'Ngày lễ') : undefined)}
                            >
                              {canEditWorkdays && attendanceSettings.manualOverridePriority !== 'none' ? (
                                <ManualWorkdayInput
                                  value={cell.isManual ? cell.manualWorkday : (cell.workdays !== '' ? cell.workdays : val)}
                                  isManual={cell.isManual}
                                  disabled={deleting || manualSavingKey === `${String(emp.employeeId)}:${d.day}`}
                                  employeeName={emp.name}
                                  date={d.date}
                                  onSave={value => handleSaveManualWorkday(emp.employeeId, d.day, value)}
                                />
                              ) : (
                                <>
                                  <span className="matrix-cell-value">{val}</span>
                                  {cell.formula && <span className="matrix-cell-formula">{cell.formula}</span>}
                                </>
                              )}
                            </td>
                          )
                        })}
                        <td className="col-total font-bold">{emp.totalCong}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              <div className="matrix-formula-legend">
                <strong>Công thức công ngày:</strong>
                <span>Có Vào/Ra → phút tính công ÷ {Number(attendanceSettings?.standardWorkMinutes) || STANDARD_WORK_MINUTES} × {attendanceSettings?.standardWorkUnit || 1} (tối đa {attendanceSettings?.maxWorkUnitPerDay || 1} công/ngày; ca chia buổi áp dụng trọng số riêng)</span>
                <span>P1 = phép 1 công</span>
                <span>Di chuột lên ô để xem cách tính chi tiết</span>
              </div>
            </div>
          ) : (
            <>
              <div className="attendance-excel-detail-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>STT</th>
                      <th>Mã NV</th>
                      <th>Họ tên</th>
                      <th>Công ty</th>
                      <th>Tên máy CC</th>
                      <th>Phòng ban</th>
                      <th>Ngày</th>
                      <th>Thứ</th>
                      <th>Vào</th>
                      <th>Ra</th>
                      <th>Công</th>
                      <th>Giờ</th>
                      <th>Công+</th>
                      <th>Vào trễ</th>
                      <th>Ra sớm</th>
                      <th>TC1</th>
                      <th>TC2</th>
                      <th>TC3</th>
                      <th>Ca</th>
                      <th>KH</th>
                      <th>KH+</th>
                      <th>Tổng giờ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {excelLogsLoading ? (
                      <tr>
                        <td colSpan="22" className="empty">Đang tải bảng chi tiết...</td>
                      </tr>
                    ) : visibleExcelLogs.length === 0 ? (
                      <tr>
                        <td colSpan="22" className="empty">
                          Chưa có dữ liệu Excel cho tháng này. Hãy dùng “Tải Excel & Lưu bảng công”.
                        </td>
                      </tr>
                    ) : (
                      visibleExcelLogs.map((log, index) => {
                        const dateStr = log.date ? String(log.date).slice(0, 10) : ''
                        const hours = Number(log.hours ?? log.soGio ?? log.gio ?? 0) || 0
                        const gioPlus = Number(log.gioPlus ?? 0) || 0
                        const tongGio = Number(log.tongGio ?? hours + gioPlus) || 0
                        const late = Number(log.lateMinutes ?? log.vaoTre ?? 0) || 0
                        const early = Number(log.earlyMinutes ?? log.raSom ?? 0) || 0
                        return (
                          <tr key={log.id || `${log.employeeId}-${dateStr}-${index}`}>
                            <td>{excelPageStart + index}</td>
                            <td>{log.displayEmployeeCode || log.sourceEmployeeCode || log.employeeCode || '-'}</td>
                            <td>{log.employeeName || '-'}</td>
                            <td>{companyName}</td>
                            <td>{log.machineName || log.tenTheoMayChamCong || '-'}</td>
                            <td>{log.department || log.phongBan || '-'}</td>
                            <td>
                              {dateStr
                                ? new Date(`${dateStr}T00:00:00`).toLocaleDateString('vi-VN')
                                : '-'}
                            </td>
                            <td>{log.dayOfWeek || log.thu || dayOfWeekFromDate(dateStr) || '-'}</td>
                            <td>{formatTimeHM(log.vao || log.checkIn) || '-'}</td>
                            <td>{formatTimeHM(log.ra || log.checkOut) || '-'}</td>
                            <td>{log.cong ?? '-'}</td>
                            <td>{hours ? hours.toFixed(2) : '-'}</td>
                            <td>{log.congPlus ?? '-'}</td>
                            <td className={late > 0 ? 'is-late' : ''}>{late > 0 ? `${late}p` : '-'}</td>
                            <td className={early > 0 ? 'is-early' : ''}>{early > 0 ? `${early}p` : '-'}</td>
                            <td>{log.tc1 ?? '-'}</td>
                            <td>{log.tc2 ?? '-'}</td>
                            <td>{log.tc3 ?? '-'}</td>
                            <td>{log.profileShift || log.shiftName || log.tenCa || '-'}</td>
                            <td>{log.kyHieu || log.status || '-'}</td>
                            <td>{log.kyHieuPlus || '-'}</td>
                            <td><strong>{tongGio ? tongGio.toFixed(2) : '-'}</strong></td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
              {filteredExcelLogs.length > 0 && (
                <div className="attendance-excel-detail-pager">
                  <div className="attendance-excel-detail-pager__info">
                    Hiển thị {excelPageStart}–{excelPageEnd} / {filteredExcelLogs.length} dòng
                  </div>
                  <div className="attendance-excel-detail-pager__controls">
                    <label>
                      Mỗi trang
                      <select
                        value={excelPageSize}
                        onChange={event => setExcelPageSize(Number(event.target.value) || EXCEL_DETAIL_PAGE_SIZE)}
                      >
                        {EXCEL_DETAIL_PAGE_SIZE_OPTIONS.map(size => (
                          <option key={size} value={size}>{size}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={excelSafePage <= 1}
                      onClick={() => setExcelPage(1)}
                    >
                      «
                    </button>
                    <button
                      type="button"
                      disabled={excelSafePage <= 1}
                      onClick={() => setExcelPage(page => Math.max(1, page - 1))}
                    >
                      Trước
                    </button>
                    <span className="attendance-excel-detail-pager__page">
                      Trang {excelSafePage}/{excelTotalPages}
                    </span>
                    <button
                      type="button"
                      disabled={excelSafePage >= excelTotalPages}
                      onClick={() => setExcelPage(page => Math.min(excelTotalPages, page + 1))}
                    >
                      Sau
                    </button>
                    <button
                      type="button"
                      disabled={excelSafePage >= excelTotalPages}
                      onClick={() => setExcelPage(excelTotalPages)}
                    >
                      »
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    )}
  </div>
}

export default AttendancePreview
