import { useEffect, useMemo, useRef, useState } from 'react'
import XLSX from 'xlsx-js-style'
import { fbGet, fbUpdate } from '../services/firebase'
import { supabase } from '../services/supabase'
import { commitAttendanceImport } from '../services/attendanceImportCommit'
import { useCompany } from '../contexts/CompanyContext'
import {
  applyEmployeeToAttendanceLog,
  buildSourceEmployeeKey,
  getCanonicalEmployeeCode,
  matchAttendanceEmployee,
  normalizeEmployeeIdentity
} from '../utils/attendanceMatching'
import {
  collectAttendancePunches,
  findAttendancePunchColumns,
  parseAttendanceDate,
  parseAttendanceTime
} from '../utils/attendanceImport'
import { findDeocaPunchHeader, getDeocaShiftName, parseDeocaPunchSheet } from '../utils/deocaPunchImport'
import {
  applyCalculatedAttendanceTiming,
  attendanceTimeToMinutes,
  buildAttendanceShiftSettingsPayload,
  calculateAttendanceTiming,
  findMissingAttendanceShifts,
  formatAttendanceTime,
  getAttendanceShiftOptions,
  normalizeAttendanceShiftName,
  normalizeAttendanceShiftSettings,
  resolveAttendanceShift,
  validateAttendancePolicy
} from '../utils/attendanceShift'
import {
  calculateAttendanceMetrics,
  STANDARD_WORK_MINUTES
} from '../utils/attendanceCalculations'
import { requireTenantCompanyId } from '../services/tenantSession'
import { useAuth } from '../contexts/AuthContext'
import { isCoreStaffUser } from '../utils/staffAccess'
import { confirmAttendancePeriod, getAttendancePeriod, listAttendancePeriods } from '../services/attendancePeriods'
import {
  countAttendancePeriodLogs,
  dateInAttendancePeriod,
  isValidAttendanceDate,
  resolveMatrixAttendanceDates,
  suggestAttendancePeriod,
  validateAttendancePeriod
} from '../utils/attendancePeriod'

const { read, utils, writeFile } = XLSX

function AttendanceImportModal({
  employees,
  attendanceLogs = [],
  attendanceSettings: initialAttendanceSettings = {},
  isOpen,
  onClose,
  onSave,
  onPeriodConfirmed,
  companyId,
  companyName
}) {
  const { companyId: sessionCompanyId } = useCompany()
  const { user } = useAuth()
  const activeCompanyId = requireTenantCompanyId(companyId || sessionCompanyId)
  const [file, setFile] = useState(null)
  const [referenceImage, setReferenceImage] = useState(null)
  const [loading, setLoading] = useState(false)
  const importInProgressRef = useRef(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiAvailable, setAiAvailable] = useState(null)
  const [previewData, setPreviewData] = useState(null)
  const [attendanceSettings, setAttendanceSettings] = useState(() => normalizeAttendanceShiftSettings(initialAttendanceSettings))
  const [missingShiftDrafts, setMissingShiftDrafts] = useState({})
  const [shiftNotice, setShiftNotice] = useState('')
  const [importMonth, setImportMonth] = useState(new Date().toISOString().slice(0, 7)) // YYYY-MM
  const [periodDraft, setPeriodDraft] = useState(null)
  const [periodConfirmed, setPeriodConfirmed] = useState(false)
  const [savedPeriods, setSavedPeriods] = useState([])
  const [matchBranch, setMatchBranch] = useState('HCM')

  const availableBranches = useMemo(
    () => Array.from(new Set(
      employees
        .map(employee => String(employee.chi_nhanh || employee.branch || '').trim())
        .filter(Boolean)
    )).sort((left, right) => left.localeCompare(right, 'vi')),
    [employees]
  )

  const employeesById = useMemo(
    () => new Map(employees.map(employee => [String(employee.id), employee])),
    [employees]
  )

  const employeesForMatching = useMemo(() => {
    const normalizedBranch = normalizeEmployeeIdentity(matchBranch)
    const inBranch = normalizedBranch
      ? employees.filter(employee =>
          normalizeEmployeeIdentity(employee.chi_nhanh || employee.branch || '') ===
          normalizedBranch
        )
      : employees
    return (inBranch.length ? inBranch : employees)
      .slice()
      .sort((left, right) =>
        String(left.ho_va_ten || left.name || '').localeCompare(
          String(right.ho_va_ten || right.name || ''),
          'vi'
        )
      )
  }, [employees, matchBranch])

  useEffect(() => {
    setAttendanceSettings(normalizeAttendanceShiftSettings(initialAttendanceSettings))
  }, [initialAttendanceSettings])

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false

    fetch('/api/attendance-match')
      .then(response => response.json())
      .then(payload => {
        if (!cancelled) setAiAvailable(Boolean(payload.available))
      })
      .catch(() => {
        if (!cancelled) setAiAvailable(false)
      })

    return () => {
      cancelled = true
    }
  }, [isOpen])

  const handleFileChange = (e) => {
    setFile(e.target.files[0])
    setPreviewData(null)
    setShiftNotice('')
    setPeriodDraft(null)
    setPeriodConfirmed(false)
  }

  const parseTime = parseAttendanceTime

  const calculateStats = (timeStrs, employee = {}, log = {}) => {
    if (!timeStrs || timeStrs.length === 0) return null

    const parsed = timeStrs
      .map(t => (typeof t === 'object' && t?.str ? t : parseTime(t)))
      .filter(Boolean)

    if (parsed.length === 0) return null

    // Giữ thứ tự punch từ máy: ca đêm có thể có Vào 22:00 rồi Ra 06:00,
    // không được sort theo đồng hồ vì sẽ đảo ngược ca.
    const checkInStr = parsed[0].str
    const checkOutStr = parsed.length > 1 ? parsed[parsed.length - 1].str : null
    const outTime = parsed.length > 1 ? parsed[parsed.length - 1] : null

    if (!outTime || parsed.length === 1) {
      return {
        checkIn: checkInStr,
        checkOut: null,
        hours: 0,
        status: 'Thiếu ra',
        lateMinutes: 0,
        earlyMinutes: 0,
        punches: parsed.map(p => p.str)
      }
    }

    const shift = resolveAttendanceShift(employee, log, attendanceSettings)
    const metrics = calculateAttendanceMetrics({
      checkIn: checkInStr,
      checkOut: checkOutStr,
      attendanceSettings,
      shift,
      standardMinutes: Number(attendanceSettings.standardWorkMinutes) || STANDARD_WORK_MINUTES,
      // Import Excel không tự trừ lunch cứng; nếu doanh nghiệp muốn trừ
      // khoảng nghỉ thì khai báo rõ trong Cài đặt chấm công.
      breakMinutes: Number(attendanceSettings.unpaidBreakMinutes) || 0,
      autoCalculateOvertime: attendanceSettings?.overtime?.autoCalculate !== false,
      splitShift: shift?.splitShift
    })
    const hours = metrics.hours

    const timing = calculateAttendanceTiming({
      employee,
      log,
      checkIn: checkInStr,
      checkOut: checkOutStr,
      attendanceSettings
    })
    const lateMinutes = timing.lateMinutes ?? 0
    const earlyMinutes = timing.earlyMinutes ?? 0

    let status = 'Đủ'
    const notes = []
    if (lateMinutes > 0) notes.push(`Muộn ${lateMinutes}p`)
    if (earlyMinutes > 0) notes.push(`Sớm ${earlyMinutes}p`)
    if (notes.length > 0) status = notes.join(' & ')
    if (hours <= 0) status = 'Vắng/Nghỉ'

    return {
      checkIn: checkInStr,
      checkOut: checkOutStr,
      hours,
      regularWorkdays: metrics.regularWorkdays,
      overtimeHours: metrics.overtimeHours,
      status,
      lateMinutes,
      earlyMinutes,
      punches: parsed.map(p => p.str)
    }
  }

  const findEmployee = (code, name) => {
    return matchAttendanceEmployee(code, name, employees, matchBranch).employee
  }

  const buildFallbackEmployee = (code, name, rowIndex = 0) => {
    const codeStr = String(code || '').trim()
    const nameStr = String(name || '').trim()
    const fallbackCode = codeStr || `ROW${rowIndex + 1}`
    const fallbackName = nameStr || `NV ${fallbackCode}`
    const sourceKey = buildSourceEmployeeKey(fallbackCode, fallbackName)
    return {
      id: `external:${sourceKey}`,
      employeeId: fallbackCode,
      username: fallbackCode,
      ho_va_ten: fallbackName,
      name: fallbackName,
      bo_phan: '',
      vi_tri: ''
    }
  }

  const attachSourceIdentity = (employee, code, name) => ({
    ...employee,
    _sourceEmployeeCode: String(code || '').trim(),
    _sourceEmployeeName: String(name || '').replace(/\s+/g, ' ').trim()
  })

  const parseDateValue = parseAttendanceDate

  const buildLog = (sysEmp, dateStr, stats, extra = {}) => {
    const baseDate = new Date(`${dateStr}T00:00:00`)
    const checkInStr = stats.checkIn || extra.vao || ''
    const checkOutStr = stats.checkOut || extra.ra || ''

    let checkInDate = null
    if (checkInStr) {
      const [inH, inM] = String(checkInStr).split(':')
      checkInDate = new Date(baseDate)
      checkInDate.setHours(Number(inH), Number(inM) || 0, 0, 0)
    }

    let checkOutDate = null
    if (checkOutStr) {
      const [outH, outM] = String(checkOutStr).split(':')
      checkOutDate = new Date(baseDate)
      checkOutDate.setHours(Number(outH), Number(outM) || 0, 0, 0)
    }

    const hasActualPunchPair = Boolean(checkInStr && checkOutStr && !extra.syntheticPunch)
    const resolvedShift = resolveAttendanceShift(sysEmp, extra, attendanceSettings)
    const punchPairs = stats.punchPairs || extra.punchPairs || []
    const metrics = calculateAttendanceMetrics({
      log: extra,
      checkIn: checkInStr,
      checkOut: checkOutStr,
      attendanceSettings,
      shift: resolvedShift,
      standardMinutes: Number(attendanceSettings.standardWorkMinutes) || STANDARD_WORK_MINUTES,
      breakMinutes: Number(attendanceSettings.unpaidBreakMinutes) || 0,
      autoCalculateOvertime: attendanceSettings?.overtime?.autoCalculate !== false,
      punchPairs,
      splitShift: resolvedShift?.splitShift,
      fallbackHours: Number(extra.hours ?? stats.hours ?? 0) || 0,
      fallbackWorkdays: extra.cong ?? stats.regularWorkdays
    })
    const hours = hasActualPunchPair ? metrics.hours : Number(extra.hours ?? stats.hours ?? 0) || 0
    const gioPlus = Number(extra.gioPlus ?? 0) || 0
    const timing = calculateAttendanceTiming({
      employee: sysEmp,
      log: extra,
      checkIn: checkInStr,
      checkOut: checkOutStr,
      attendanceSettings
    })
    const dayNames = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7']

    return {
      employeeId: sysEmp.id,
      employeeCode:
        extra.employeeCode ||
        sysEmp._sourceEmployeeCode ||
        sysEmp.employeeId ||
        sysEmp.username ||
        '',
      employeeName:
        extra.employeeName ||
        sysEmp._sourceEmployeeName ||
        sysEmp.ho_va_ten ||
        sysEmp.name ||
        '',
      sourceEmployeeCode:
        sysEmp._sourceEmployeeCode ||
        extra.employeeCode ||
        sysEmp.employeeId ||
        '',
      sourceEmployeeName:
        sysEmp._sourceEmployeeName ||
        extra.employeeName ||
        sysEmp.ho_va_ten ||
        sysEmp.name ||
        '',
      machineName:
        extra.machineName ||
        sysEmp._sourceEmployeeName ||
        extra.employeeName ||
        sysEmp.ho_va_ten ||
        sysEmp.name ||
        '',
      tenTheoMayChamCong:
        extra.machineName ||
        sysEmp._sourceEmployeeName ||
        extra.employeeName ||
        sysEmp.ho_va_ten ||
        sysEmp.name ||
        '',
      department: extra.department || sysEmp.bo_phan || '',
      position: extra.position || sysEmp.vi_tri || '',
      date: dateStr,
      dayOfWeek: extra.dayOfWeek || dayNames[baseDate.getDay()] || '',
      timestamp: baseDate.getTime(),
      checkIn: checkInDate ? checkInDate.toISOString() : null,
      checkOut: checkOutDate ? checkOutDate.toISOString() : null,
      vao: checkInStr,
      ra: checkOutStr,
      // Có punch thật thì luôn dùng phút thực tế; cong Excel cũ chỉ giữ cho
      // các dòng mã công không có giờ vào/ra.
      cong: Number(hasActualPunchPair
        ? metrics.regularWorkdays
        : metrics.regularWorkdays) || 0,
      hours,
      gio: hours,
      congPlus: Number(extra.congPlus ?? 0) || 0,
      gioPlus,
      lateMinutes: timing.lateMinutes ?? 0,
      earlyMinutes: timing.earlyMinutes ?? 0,
      vaoTre: timing.lateMinutes ?? 0,
      raSom: timing.earlyMinutes ?? 0,
      tc1: Number(extra.tc1 ?? 0) || 0,
      tc2: Number(extra.tc2 ?? 0) || 0,
      tc3: Number(extra.tc3 ?? 0) || 0,
      shiftName: extra.shiftName || '',
      tenCa: extra.shiftName || '',
      kyHieu: extra.kyHieu || stats.status || '',
      kyHieuPlus: extra.kyHieuPlus || '',
      // Tổng giờ cũng dựa trên số giờ thực tế vừa tính, không lấy giá trị
      // tổng đã làm tròn sẵn trong file nguồn.
      tongGio: hours + gioPlus,
      status: extra.kyHieu || stats.status || '',
      workedMinutes: metrics.workedMinutes,
      regularMinutes: metrics.regularMinutes,
      overtimeMinutes: metrics.overtimeMinutes,
      overtimeAutoDisabled: extra.overtimeAutoDisabled !== undefined
        ? Boolean(extra.overtimeAutoDisabled)
        : (hasActualPunchPair ? false : Boolean(extra.syntheticPunch)),
      syntheticPunch: Boolean(extra.syntheticPunch),
      punches: stats.punches || [],
      punchPairs,
      importFormat: extra.importFormat || ''
    }
  }

  /** Format đầy đủ theo bảng chấm công công ty */
  const processFullAttendanceFormat = (jsonData, headers, headerRowIdx) => {
    const idxOf = (...keys) => headers.findIndex(h => keys.some(k => h.includes(k)))
    const codeIdx = idxOf('mã n', 'ma n', 'mã nv', 'ma nv', 'employee')
    const nameIdx = idxOf('tên nhân', 'ten nhan', 'họ tên', 'ho ten', 'tên nv')
    const machineNameIdx = idxOf('tên theo máy', 'ten theo may', 'tên máy', 'ten may', 'tên chấm công', 'ten cham cong')
    const deptIdx = idxOf('phòng ban', 'phong ban')
    const posIdx = idxOf('chức vụ', 'chuc vu')
    const dateIdx = idxOf('ngày', 'ngay')
    const thuIdx = idxOf('thứ', 'thu')
    const punchColumns = findAttendancePunchColumns(headers)
    const congIdx = headers.findIndex(h => h === 'công' || h === 'cong')
    const gioIdx = headers.findIndex(h => h === 'giờ' || h === 'gio')
    const congPlusIdx = idxOf('công+', 'cong+')
    const gioPlusIdx = idxOf('giờ+', 'gio+')
    const tc1Idx = headers.findIndex(h => h === 'tc1')
    const tc2Idx = headers.findIndex(h => h === 'tc2')
    const tc3Idx = headers.findIndex(h => h === 'tc3')
    const caIdx = idxOf('tên ca', 'ten ca')
    const kyIdx = headers.findIndex(h => h === 'kí hiệu' || h === 'ki hieu' || h === 'ký hiệu')
    const kyPlusIdx = idxOf('kí hiệu+', 'ki hieu+', 'ký hiệu+')
    const tongIdx = idxOf('tổng giờ', 'tong gio')

    const logs = []
    const skipped = []
    const num = (v) => {
      const n = parseFloat(String(v ?? '').replace(',', '.'))
      return isNaN(n) ? 0 : n
    }

    for (let i = headerRowIdx + 1; i < jsonData.length; i++) {
      const row = jsonData[i]
      const empCode = codeIdx >= 0 ? row[codeIdx] : ''
      const empName = nameIdx >= 0 ? row[nameIdx] : ''
      const machineName = machineNameIdx >= 0 ? row[machineNameIdx] : ''
      const dateRaw = dateIdx >= 0 ? row[dateIdx] : ''
      if (!empCode && !empName) continue
      if (dateRaw === '' || dateRaw == null) {
        const hasWorkData = [...punchColumns.allIndexes, congIdx, gioIdx]
          .filter(index => Number.isInteger(index) && index >= 0)
          .some(index => row[index] !== '' && row[index] != null)
        if (hasWorkData) skipped.push(`Dòng ${i + 1}: ngày không hợp lệ (trống)`)
        continue
      }

      const sysEmp = attachSourceIdentity(
        findEmployee(empCode, empName) || buildFallbackEmployee(empCode, empName, i),
        empCode,
        empName
      )

      const dateStr = parseDateValue(dateRaw)
      if (!dateStr) {
        skipped.push(`Dòng ${i + 1}: ngày không hợp lệ (${dateRaw})`)
        continue
      }

      const rowContext = {
        department: deptIdx >= 0 ? String(row[deptIdx] || '') : '',
        position: posIdx >= 0 ? String(row[posIdx] || '') : '',
        shiftName: caIdx >= 0 ? String(row[caIdx] || '') : ''
      }

      const { checkIn: vao, checkOut: ra, punches } =
        collectAttendancePunches(row, punchColumns, parseTime)
      let stats
      if (vao && ra) {
        stats = { ...calculateStats([vao, ra], sysEmp, rowContext), punches }
      } else if (vao) {
        stats = { ...calculateStats([vao], sysEmp, rowContext), punches }
      } else if (ra) {
        stats = {
          checkIn: null,
          checkOut: ra,
          hours: 0,
          status: 'Thiếu vào',
          lateMinutes: 0,
          earlyMinutes: 0,
          punches
        }
      } else {
        stats = {
          checkIn: null,
          checkOut: null,
          hours: num(row[gioIdx]),
          status: 'Đủ',
          lateMinutes: 0,
          earlyMinutes: 0,
          punches: []
        }
      }

      logs.push(buildLog(sysEmp, dateStr, stats, {
        employeeCode: String(empCode || sysEmp.employeeId || ''),
        employeeName: String(empName || sysEmp.ho_va_ten || ''),
        machineName: String(machineName || empName || sysEmp.ho_va_ten || ''),
        department: rowContext.department,
        position: rowContext.position,
        dayOfWeek: thuIdx >= 0 ? String(row[thuIdx] || '') : '',
        vao,
        ra,
        cong: congIdx >= 0 ? num(row[congIdx]) : undefined,
        hours: gioIdx >= 0 ? num(row[gioIdx]) : undefined,
        congPlus: congPlusIdx >= 0 ? num(row[congPlusIdx]) : 0,
        gioPlus: gioPlusIdx >= 0 ? num(row[gioPlusIdx]) : 0,
        tc1: tc1Idx >= 0 ? num(row[tc1Idx]) : 0,
        tc2: tc2Idx >= 0 ? num(row[tc2Idx]) : 0,
        tc3: tc3Idx >= 0 ? num(row[tc3Idx]) : 0,
        shiftName: rowContext.shiftName,
        kyHieu: kyIdx >= 0 ? String(row[kyIdx] || '') : '',
        kyHieuPlus: kyPlusIdx >= 0 ? String(row[kyPlusIdx] || '') : '',
        tongGio: tongIdx >= 0 ? num(row[tongIdx]) : undefined
      }))
    }

    return { logs, skipped }
  }

  /** Phiếu chấm công DEOCA: tên, ID, bộ phận, ngày và các giờ trong một ô Ghi. */
  const processDeocaPunchFormat = (jsonData, header) => {
    const parsed = parseDeocaPunchSheet(jsonData, header)
    const logs = []
    const skipped = [...parsed.skipped]

    parsed.records.forEach(record => {
      if (!record.check_in) {
        skipped.push(`Dòng ${record.source_row}: không có giờ quẹt thẻ hợp lệ.`)
        return
      }

      const employeeName = `${record.first_name} ${record.last_name}`.replace(/\s+/g, ' ').trim()
      const shiftName = getDeocaShiftName(record.department_location)
      const sysEmp = attachSourceIdentity(
        findEmployee(record.employee_code, employeeName) ||
          buildFallbackEmployee(record.employee_code, employeeName, record.source_row - 1),
        record.employee_code,
        employeeName
      )
      const stats = calculateStats(
        record.check_out ? [record.check_in, record.check_out] : [record.check_in],
        sysEmp,
        { department: record.department_location, shiftName }
      )
      if (!stats) return

      logs.push({
        ...buildLog(sysEmp, record.attendance_date, {
          ...stats,
          punches: record.punches,
          punchPairs: [{ checkIn: record.check_in, checkOut: record.check_out }]
        }, {
          employeeCode: record.employee_code,
          employeeName,
          machineName: employeeName,
          department: record.department_location,
          shiftName,
          importFormat: 'deoca-punch',
          dayOfWeek: record.weekday,
          vao: record.check_in,
          ra: record.check_out
        }),
        first_name: record.first_name,
        last_name: record.last_name,
        employee_code: record.employee_code,
        department_location: record.department_location,
        attendance_date: record.attendance_date,
        weekday: record.weekday,
        punch_count: record.punch_count,
        raw_punch_times: record.raw_punch_times,
        rawVal: record.raw_punch_times,
        source_row: record.source_row
      })
    })

    return { logs, skipped }
  }

  /** Format mới: Mã NV | Tên NV | Phòng ban | Ngày | Lần 1 ... Lần 7 */
  const processPunchLogFormat = (jsonData, headers, headerRowIdx) => {
    const codeIdx = headers.findIndex(h =>
      h.includes('mã nv') || h === 'mã' || h.includes('ma nv') || h === 'code' || h === 'id nv'
    )
    const nameIdx = headers.findIndex(h =>
      h.includes('tên nv') || h.includes('ho ten') || h.includes('họ tên') || h.includes('họ và tên') || h === 'tên'
    )
    const dateIdx = headers.findIndex(h => h.includes('ngày') || h.includes('ngay') || h === 'date')

    const lanIndexes = []
    headers.forEach((h, idx) => {
      if (
        /^l[aầ]n\s*\d+$/i.test(h) ||
        h.includes('lần') ||
        /^lan\s*\d+$/i.test(h) ||
        /^(?:v[aà]o|ra)\s*\d*$/i.test(h)
      ) {
        lanIndexes.push(idx)
      }
    })

    // Fallback: any column after Ngày that looks like punch columns
    if (lanIndexes.length === 0 && dateIdx >= 0) {
      for (let i = dateIdx + 1; i < headers.length; i++) {
        const h = headers[i]
        if (!h) continue
        if (h.includes('phòng') || h.includes('bộ phận') || h.includes('ghi chú')) continue
        lanIndexes.push(i)
      }
    }

    const logs = []
    const skipped = []

    for (let i = headerRowIdx + 1; i < jsonData.length; i++) {
      const row = jsonData[i]
      if (!row || row.length === 0) continue

      const empCode = codeIdx >= 0 ? row[codeIdx] : ''
      const empName = nameIdx >= 0 ? row[nameIdx] : ''
      const dateRaw = dateIdx >= 0 ? row[dateIdx] : ''

      if (!empCode && !empName) continue

      const times = []
      lanIndexes.forEach(idx => {
        const parsed = parseTime(row[idx])
        if (parsed) times.push(parsed.str)
      })

      if (!dateRaw && dateRaw !== 0) {
        if (times.length) skipped.push(`Dòng ${i + 1}: ngày không hợp lệ (trống)`)
        continue
      }

      // Row without any punch times = skip (not absent day unless needed)
      if (times.length === 0) continue

      const dateStr = parseDateValue(dateRaw)
      if (!dateStr) {
        skipped.push(`Dòng ${i + 1}: ngày không hợp lệ (${dateRaw})`)
        continue
      }

      const sysEmp = attachSourceIdentity(
        findEmployee(empCode, empName) || buildFallbackEmployee(empCode, empName, i),
        empCode,
        empName
      )

      const stats = calculateStats(times, sysEmp)
      if (stats) {
        logs.push(buildLog(sysEmp, dateStr, stats, {
          employeeCode: String(empCode || sysEmp.employeeId || ''),
          employeeName: String(empName || sysEmp.ho_va_ten || ''),
          machineName: String(empName || sysEmp.ho_va_ten || '')
        }))
      }
    }

    return { logs, skipped }
  }

  const processMatrixFormat = (jsonData, optionsOrHeaders, headerRowIdx, yearArg, monthArg) => {
    let dateCols = []
    let nameColIdx = -1
    let codeColIdx = -1
    let posColIdx = -1
    let dataStartRow = 0
    let year = yearArg
    let month = monthArg

    if (optionsOrHeaders && typeof optionsOrHeaders === 'object' && !Array.isArray(optionsOrHeaders)) {
      dateCols = optionsOrHeaders.matrixDayCols || []
      nameColIdx = optionsOrHeaders.nameColIdx ?? -1
      codeColIdx = optionsOrHeaders.codeColIdx ?? -1
      posColIdx = optionsOrHeaders.posColIdx ?? -1
      dataStartRow = optionsOrHeaders.dataStartRow ?? (headerRowIdx + 1)
      year = optionsOrHeaders.year ?? yearArg
      month = optionsOrHeaders.month ?? monthArg
    } else {
      const headers = optionsOrHeaders || []
      nameColIdx = headers.findIndex(h =>
        String(h).includes('họ tên') || String(h).includes('tên') || String(h).includes('name')
      )
      codeColIdx = headers.findIndex(h =>
        String(h).includes('mã') || String(h).includes('code')
      )
      headers.forEach((h, idx) => {
        const valStr = String(h).trim()
        if (valStr && /^\d{1,2}$/.test(valStr)) {
          const val = Number(valStr)
          if (val >= 1 && val <= 31) dateCols.push({ day: val, idx })
        }
      })
      dataStartRow = (headerRowIdx >= 0 ? headerRowIdx : 0) + 1
      if (dataStartRow < jsonData.length) {
        const nextRow = jsonData[dataStartRow] || []
        const weekdayCount = nextRow.filter(c => /^(t[2-7]|cn|thứ\s*[2-7]|chủ\s*nhật)$/i.test(String(c || '').trim())).length
        if (weekdayCount >= 3) dataStartRow++
      }
    }

    if (!year || !month) {
      const [y, m] = importMonth.split('-').map(Number)
      year = year || y
      month = month || m
    }

    const resolvedDateCols = resolveMatrixAttendanceDates(
      dateCols,
      `${year}-${String(month).padStart(2, '0')}`
    )
    const skipped = resolvedDateCols.filter(column => !column.valid)
      .map(column => `Ngày không hợp lệ trong cột Excel: ${column.date}`)

    const policy = normalizeAttendanceShiftSettings(attendanceSettings)
    // Check if sheet contains hours worked (values >= 2.5) or standard workdays (công <= 1.0)
    let countOver2_5 = 0
    for (let r = dataStartRow; r < jsonData.length; r++) {
      const row = jsonData[r] || []
      const nameVal = nameColIdx >= 0 ? String(row[nameColIdx] || '').trim() : ''
      const codeVal = codeColIdx >= 0 ? String(row[codeColIdx] || '').trim() : ''
      if (!nameVal && !codeVal) continue
      const lowerName = nameVal.toLowerCase()
      if (lowerName.startsWith('tổng') || lowerName.startsWith('cộng') || lowerName.startsWith('bình quân')) break

      dateCols.forEach(({ idx }) => {
        const raw = String(row[idx] ?? '').replace(',', '.').trim()
        const n = parseFloat(raw)
        if (!isNaN(n) && n >= 2.5) countOver2_5++
      })
    }
    const isHourMode = countOver2_5 >= 3

    const mergedData = {}

    for (let r = dataStartRow; r < jsonData.length; r++) {
      const row = jsonData[r]
      if (!row || row.length === 0) continue

      const empName = nameColIdx >= 0 ? String(row[nameColIdx] ?? '').trim() : ''
      const empCode = codeColIdx >= 0 ? String(row[codeColIdx] ?? '').trim() : ''
      const empPos = posColIdx >= 0 ? String(row[posColIdx] ?? '').trim() : ''

      if (!empName && !empCode) continue

      const lowerName = empName.toLowerCase()
      if (lowerName.startsWith('tổng') || lowerName.startsWith('cộng') || lowerName.startsWith('bình quân')) break

      const currentSysEmp = attachSourceIdentity(
        findEmployee(empCode, empName) || buildFallbackEmployee(empCode, empName, r),
        empCode,
        empName
      )

      resolvedDateCols.forEach(({ day, idx, date, valid }) => {
        const cellContent = row[idx]
        if (cellContent === undefined || cellContent === null || String(cellContent).trim() === '') return
        if (!valid) return

        const cellStr = String(cellContent).trim()
        const extractedTimes = []
        const timeMatches = cellStr.match(/(\d{1,2}:\d{2})/g)
        if (timeMatches) extractedTimes.push(...timeMatches)

        if (extractedTimes.length === 0) {
          const parsed = parseTime(cellContent)
          if (parsed) extractedTimes.push(parsed.str)
        }

        const key = `${currentSysEmp.id}_${date}`

        if (extractedTimes.length > 0) {
          if (!mergedData[key]) {
            mergedData[key] = { emp: currentSysEmp, date, times: [], rawVal: cellStr, pos: empPos }
          }
          mergedData[key].times.push(...extractedTimes)
        } else {
          const upper = cellStr.toUpperCase()
          let cong = 0
          let hours = 0
          let status = 'Đủ'

          if (isHourMode) {
            const n = parseFloat(cellStr.replace(',', '.'))
            if (!isNaN(n)) {
              hours = Number(n)
              cong = Math.min(policy.maxWorkUnitPerDay, Math.max(0, hours * 60) / policy.standardWorkMinutes * policy.standardWorkUnit)
              status = hours > 0 ? `${hours}h` : 'Nghỉ'
            }
          } else {
            if (upper === '1' || upper === 'X' || upper === 'Đ' || upper === 'DU') {
              cong = policy.standardWorkUnit
              hours = policy.standardWorkMinutes / 60
              status = 'Đủ'
            } else if (upper === '0.5') {
              cong = policy.standardWorkUnit / 2
              hours = policy.standardWorkMinutes / 120
              status = 'Nửa ngày'
            } else if (upper.startsWith('P')) {
              const pVal = parseFloat(upper.replace('P', '')) || 1.0
              cong = pVal * policy.standardWorkUnit
              hours = pVal * policy.standardWorkMinutes / 60
              status = 'Phép'
            } else if (upper === '0' || upper === '0.00' || upper === 'KP' || upper === 'OFF') {
              cong = 0
              hours = 0
              status = 'Nghỉ'
            } else {
              const n = parseFloat(cellStr.replace(',', '.'))
              if (!isNaN(n)) {
                cong = n
                hours = Math.round(n * policy.standardWorkMinutes / 60 * 100) / 100
                status = cong >= policy.standardWorkUnit ? 'Đủ' : cong > 0 ? 'Nửa ngày' : 'Nghỉ'
              }
            }
          }

          if (!mergedData[key]) {
            mergedData[key] = {
              emp: currentSysEmp,
              date,
              times: hours > 0 ? [policy.workStart, policy.workEnd] : [],
              rawVal: cellStr,
              directCong: cong,
              directHours: hours,
              directStatus: status,
              isCodeOnly: true,
              pos: empPos
            }
          }
        }
      })
    }

    const logs = []
    Object.values(mergedData).forEach(item => {
      const { emp, date: dateStr, times } = item

      if (item.isCodeOnly) {
        const directStats = {
          checkIn: item.directHours > 0 ? policy.workStart : '',
          checkOut: item.directHours > 0 ? policy.workEnd : '',
          hours: item.directHours,
          cong: item.directCong,
          status: item.directStatus || item.rawVal,
          kyHieu: item.rawVal,
          lateMinutes: 0,
          earlyMinutes: 0
        }
        logs.push(buildLog(emp, dateStr, directStats, {
          cong: item.directCong,
          hours: item.directHours,
          position: item.pos,
          sourceEmployeeCode: emp._sourceEmployeeCode || emp.employeeCode,
          sourceEmployeeName: emp._sourceEmployeeName || emp.employeeName,
          syntheticPunch: true
        }))
        return
      }

      if (!times || times.length === 0) return
      const stats = calculateStats(times, emp)
      if (!stats) return

      logs.push(buildLog(emp, dateStr, stats, {
        position: item.pos,
        sourceEmployeeCode: emp._sourceEmployeeCode || emp.employeeCode,
        sourceEmployeeName: emp._sourceEmployeeName || emp.employeeName
      }))
    })

    return { logs, skipped }
  }

  const processListFormat = (jsonData, headers, headerRowIdx) => {
    const codeIdx = headers.findIndex(h => h.includes('mã') || h.includes('code') || h.includes('nv'))
    const nameIdx = headers.findIndex(h => h.includes('tên') || h.includes('name'))
    const dateIdx = headers.findIndex(h => h.includes('ngày') || h.includes('date'))
    const inIdx = headers.findIndex(h => h.includes('giờ vào') || h.includes('check-in') || h.includes('checkin') || h.includes('vào'))
    const outIdx = headers.findIndex(h => h.includes('giờ ra') || h.includes('check-out') || h.includes('checkout') || h.includes('ra'))
    const timeIdx = headers.findIndex(h => h.includes('giờ') || h.includes('time'))

    const logs = []
    const groupedData = {}
    const skipped = []

    for (let i = headerRowIdx + 1; i < jsonData.length; i++) {
      const row = jsonData[i]
      const empCode = codeIdx >= 0 ? row[codeIdx] : ''
      const empName = nameIdx >= 0 ? row[nameIdx] : ''
      const dateRaw = dateIdx >= 0 ? row[dateIdx] : ''
      if (!empCode && !empName) continue
      if (!dateRaw && dateRaw !== 0) {
        if ([inIdx, outIdx, timeIdx].some(index => index >= 0 && row[index] !== '' && row[index] != null)) {
          skipped.push(`Dòng ${i + 1}: ngày không hợp lệ (trống)`)
        }
        continue
      }

      const key = `${empCode}_${empName}_${dateRaw}`
      if (!groupedData[key]) groupedData[key] = { empCode, empName, dateRaw, times: [] }

      if (inIdx >= 0) {
        const t = parseTime(row[inIdx])
        if (t) groupedData[key].times.push(t.str)
      }
      if (outIdx >= 0) {
        const t = parseTime(row[outIdx])
        if (t) groupedData[key].times.push(t.str)
      }
      if (inIdx < 0 && outIdx < 0 && timeIdx >= 0) {
        const t = parseTime(row[timeIdx])
        if (t) groupedData[key].times.push(t.str)
      }
    }

    for (const key in groupedData) {
      const group = groupedData[key]
      if (group.times.length === 0) continue

      const sysEmp = attachSourceIdentity(
        findEmployee(group.empCode, group.empName) ||
          buildFallbackEmployee(group.empCode, group.empName),
        group.empCode,
        group.empName
      )

      const dateStr = parseDateValue(group.dateRaw)
      if (!dateStr) {
        skipped.push(`Ngày không hợp lệ (${group.dateRaw})`)
        continue
      }

      const stats = calculateStats(group.times, sysEmp)
      if (stats) {
        logs.push(buildLog(sysEmp, dateStr, stats, {
          employeeCode: String(group.empCode || sysEmp.employeeId || ''),
          employeeName: String(group.empName || sysEmp.ho_va_ten || ''),
          machineName: String(group.empName || sysEmp.ho_va_ten || '')
        }))
      }
    }

    return { logs, skipped }
  }

  const detectFormat = (headers) => {
    const hasDayCols = headers.filter(h => /^\d{1,2}$/.test(String(h).trim()) && Number(h) >= 1 && Number(h) <= 31).length >= 5
    if (hasDayCols) return 'matrix'

    const hasLan = headers.some(h =>
      /l[aầ]n\s*\d+/i.test(h) ||
      h.startsWith('lần') ||
      h.startsWith('lan ') ||
      /^(?:v[aà]o|ra)\s*\d+/i.test(h)
    )
    const hasNgay = headers.some(h => h.includes('ngày') || h.includes('ngay') || h === 'date')
    if (hasLan && hasNgay) return 'punch'

    const hasFull = headers.some(h => h.includes('công+') || h.includes('cong+') || h === 'tc1' || h.includes('kí hiệu') || h.includes('tổng giờ'))
    if (hasFull && hasNgay) return 'full'

    return 'list'
  }

  const prepareMatchingPreview = (
    logs,
    metadata = {},
    preserveExistingMatches = false
  ) => {
    const groups = new Map()

    // Tự động ghi nhớ các ánh xạ nhân viên đã từng được ghép trong attendanceLogs
    const previousMatchFromLogs = new Map()
    attendanceLogs.forEach(item => {
      const sCode = item.sourceEmployeeCode || item.employeeCode || ''
      const sName = item.sourceEmployeeName || item.employeeName || item.machineName || ''
      if ((sCode || sName) && item.employeeId && !String(item.employeeId).startsWith('external:')) {
        const sKey = buildSourceEmployeeKey(sCode, sName)
        const emp = employeesById.get(String(item.employeeId))
        if (emp && !previousMatchFromLogs.has(sKey)) {
          previousMatchFromLogs.set(sKey, emp)
        }
      }
    })

    logs.forEach(log => {
      const sourceCode =
        log.sourceEmployeeCode ||
        log.employeeCode ||
        ''
      const sourceName =
        log.sourceEmployeeName ||
        log.employeeName ||
        log.machineName ||
        log.tenTheoMayChamCong ||
        ''
      const sourceKey = buildSourceEmployeeKey(sourceCode, sourceName)

      if (!groups.has(sourceKey)) {
        const rememberedEmployee = previousMatchFromLogs.get(sourceKey)
        const currentEmployee = preserveExistingMatches
          ? employeesById.get(String(log.employeeId))
          : (rememberedEmployee || null)
        const smartMatch = currentEmployee
          ? {
              employee: currentEmployee,
              suggestedEmployee: currentEmployee,
              confidence: 1,
              gap: 1,
              method: rememberedEmployee ? 'Đã ghi nhớ từ lần ghép trước' : 'Đã gắn với hồ sơ Lumi',
              status: 'matched',
              candidates: [{ employee: currentEmployee, score: 1 }]
            }
          : matchAttendanceEmployee(
              sourceCode,
              sourceName,
              employees,
              matchBranch
            )

        groups.set(sourceKey, {
          key: sourceKey,
          sourceCode: String(sourceCode || '').trim(),
          sourceName: String(sourceName || '').replace(/\s+/g, ' ').trim(),
          rowCount: 0,
          selectedEmployeeId: smartMatch.employee?.id || '',
          suggestedEmployeeId: smartMatch.suggestedEmployee?.id || '',
          confidence: smartMatch.confidence,
          gap: smartMatch.gap,
          method: smartMatch.method,
          status: smartMatch.status,
          candidates: smartMatch.candidates
        })
      }

      groups.get(sourceKey).rowCount += 1
    })

    const matchGroups = Array.from(groups.values())
    const groupByKey = new Map(matchGroups.map(group => [group.key, group]))
    const matchedLogs = logs.map(log => {
      const sourceCode = log.sourceEmployeeCode || log.employeeCode || ''
      const sourceName =
        log.sourceEmployeeName ||
        log.employeeName ||
        log.machineName ||
        log.tenTheoMayChamCong ||
        ''
      const sourceKey = buildSourceEmployeeKey(sourceCode, sourceName)
      const group = groupByKey.get(sourceKey)
      const selectedEmployee = employeesById.get(String(group?.selectedEmployeeId))
      const preparedLog = {
        ...log,
        sourceEmployeeCode: sourceCode,
        sourceEmployeeName: sourceName,
        _sourceEmployeeKey: sourceKey,
        _originalEmployeeId: log.employeeId || '',
        _sourceDepartment: log.department || log.phongBan || '',
        _sourcePosition: log.position || log.chucVu || ''
      }

      return selectedEmployee
        ? applyCalculatedAttendanceTiming(
            applyEmployeeToAttendanceLog(preparedLog, selectedEmployee),
            selectedEmployee,
            attendanceSettings
          )
        : preparedLog
    })

    return {
      ...metadata,
      count: matchedLogs.length,
      uniqueEmployeeCount: matchGroups.length,
      matchGroups,
      logs: matchedLogs
    }
  }

  const handleMatchChange = (sourceKey, employeeId, method = 'Người dùng xác nhận') => {
    setPreviewData(previous => {
      if (!previous) return previous
      const isSkipped = employeeId === '__skip__'
      const selectedEmployee = employeesById.get(String(employeeId))
      const matchGroups = previous.matchGroups.map(group =>
        group.key === sourceKey
          ? {
              ...group,
              selectedEmployeeId: isSkipped ? '__skip__' : selectedEmployee?.id || '',
              confidence: selectedEmployee ? 1 : group.confidence,
              method: isSkipped
                ? 'Không có hồ sơ trong Lumi - bỏ qua'
                : selectedEmployee
                  ? method
                  : group.method,
              status: isSkipped
                ? 'skipped'
                : selectedEmployee
                  ? 'matched'
                  : group.status
            }
          : group
      )

      const logs = previous.logs.map(log => {
        if (log._sourceEmployeeKey !== sourceKey) return log
        if (selectedEmployee) {
          return applyCalculatedAttendanceTiming(
            applyEmployeeToAttendanceLog(log, selectedEmployee),
            selectedEmployee,
            attendanceSettings
          )
        }

        return {
          ...log,
          employeeId: `external:${sourceKey}`,
          employeeCode: log.sourceEmployeeCode || '',
          employeeName: log.sourceEmployeeName || '',
          department: log._sourceDepartment || '',
          position: log._sourcePosition || ''
        }
      })

      return { ...previous, matchGroups, logs }
    })
  }

  const handleReconcileExisting = () => {
    if (!attendanceLogs.length) {
      alert('Chưa có dữ liệu chấm công trong Lumi để đối soát.')
      return
    }

    setPreviewData(
      prepareMatchingPreview(
        attendanceLogs,
        {
          modeLabel: 'Đối soát dữ liệu đã có trong Lumi',
          isMatrixMode: false,
          detectedDays: [],
          skipped: [],
          isReconcileMode: true
        },
        true
      )
    )
  }

  const readFileAsDataUrl = (imageFile) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error('Không đọc được ảnh danh sách nhân sự'))
      reader.readAsDataURL(imageFile)
    })

  const handleAiMatch = async () => {
    if (!previewData?.matchGroups?.length) return
    const pendingGroups = previewData.matchGroups.filter(
      group => !group.selectedEmployeeId
    )
    if (!pendingGroups.length) {
      alert('Tất cả nhân viên đã được ghép. Không cần gọi AI.')
      return
    }
    if (!referenceImage) {
      alert('Vui lòng chọn ảnh danh sách nhân sự để AI đọc và đối sánh.')
      return
    }
    if (referenceImage.size > 3 * 1024 * 1024) {
      alert('Ảnh vượt quá 3MB. Vui lòng giảm kích thước ảnh.')
      return
    }

    setAiLoading(true)
    try {
      const imageDataUrl = await readFileAsDataUrl(referenceImage)
      const response = await fetch('/api/attendance-match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageDataUrl,
          branch: matchBranch,
          sourcePeople: pendingGroups.map(group => ({
            sourceKey: group.key,
            sourceCode: group.sourceCode,
            sourceName: group.sourceName
          })),
          employees: employees.map(employee => ({
            id: employee.id,
            employeeCode:
              employee.employeeId ||
              employee.employee_id ||
              employee.username ||
              '',
            name: employee.ho_va_ten || employee.name || '',
            branch: employee.chi_nhanh || employee.branch || '',
            department: employee.bo_phan || employee.department || ''
          }))
        })
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload.error || 'AI không xử lý được ảnh')
      }

      ;(payload.matches || []).forEach(match => {
        if (
          match?.sourceKey &&
          match?.employeeId &&
          employeesById.has(String(match.employeeId))
        ) {
          handleMatchChange(
            match.sourceKey,
            match.employeeId,
            `AI xác nhận: ${match.reason || 'khớp theo ảnh'}`
          )
        }
      })
    } catch (error) {
      alert(`Không thể dùng AI: ${error.message}`)
    } finally {
      setAiLoading(false)
    }
  }

  const handlePreview = async () => {
    if (!file) {
      alert('Vui lòng chọn file Excel')
      return
    }

    setLoading(true)
    try {
      const data = await file.arrayBuffer()
      const workbook = read(data, { type: 'array' })

      // Helper trích xuất ngày từ ô (hỗ trợ cả số nguyên 1..31, text '01'..'31', date serial Excel 46235..46265, và Date objects)
      const extractDayFromCell = (cell) => {
        if (cell === null || cell === undefined || cell === '') return null
        if (typeof cell === 'number') {
          if (cell >= 1 && cell <= 31) return { day: Math.round(cell) }
          if (cell >= 35000 && cell <= 65000) {
            const d = new Date(Math.round((cell - 25569) * 86400 * 1000))
            return { day: d.getUTCDate(), month: d.getUTCMonth() + 1, year: d.getUTCFullYear() }
          }
        }
        if (cell instanceof Date) {
          return { day: cell.getDate(), month: cell.getMonth() + 1, year: cell.getFullYear() }
        }
        const s = String(cell).trim()
        if (/^\d{1,2}$/.test(s)) {
          const num = Number(s)
          if (num >= 1 && num <= 31) return { day: num }
        }
        const dateMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?$/)
        if (dateMatch) {
          const day = Number(dateMatch[1])
          const month = Number(dateMatch[2])
          const year = dateMatch[3] ? Number(dateMatch[3]) : undefined
          if (day >= 1 && day <= 31) return { day, month, year }
        }
        const isoMatch = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/)
        if (isoMatch) {
          const year = Number(isoMatch[1])
          const month = Number(isoMatch[2])
          const day = Number(isoMatch[3])
          if (day >= 1 && day <= 31) return { day, month, year }
        }
        return null
      }

      // Chọn sheet tốt nhất: ưu tiên sheet chứa ma trận ngày hoặc nhiều dòng dữ liệu chấm công nhất
      let worksheet = workbook.Sheets[workbook.SheetNames[0]]
      let jsonData = utils.sheet_to_json(worksheet, { header: 1, raw: true, defval: '' })
      let selectedSheetName = workbook.SheetNames[0]

      if (workbook.SheetNames.length > 1) {
        let maxScore = -1
        for (const sName of workbook.SheetNames) {
          const sWs = workbook.Sheets[sName]
          const sData = utils.sheet_to_json(sWs, { header: 1, raw: true, defval: '' })
          if (!sData || sData.length === 0) continue

          let dayColsInSheet = 0
          for (let r = 0; r < Math.min(sData.length, 10); r++) {
            const count = (sData[r] || []).filter(c => extractDayFromCell(c) !== null).length
            if (count > dayColsInSheet) dayColsInSheet = count
          }

          // Ưu tiên đúng bộ header DEOCA; các sheet cũ vẫn giữ cách chọn trước đây.
          const score = findDeocaPunchHeader(sData)
            ? 20000 + sData.length
            : dayColsInSheet >= 7 ? 10000 + dayColsInSheet : sData.length
          if (score > maxScore) {
            maxScore = score
            worksheet = sWs
            jsonData = sData
            selectedSheetName = sName
          }
        }
      }

      // 1. Kiểm tra định dạng ma trận ngày (tìm hàng có nhiều cột ngày 1..31 nhất)
      let bestDayRowIdx = -1
      let bestDayCols = []

      for (let r = 0; r < Math.min(jsonData.length, 15); r++) {
        const row = jsonData[r] || []
        const cols = []
        row.forEach((cell, idx) => {
          const info = extractDayFromCell(cell)
          if (info) {
            cols.push({ day: info.day, idx, month: info.month, year: info.year })
          }
        })
        if (cols.length > bestDayCols.length) {
          bestDayRowIdx = r
          bestDayCols = cols
        }
      }

      let format = ''
      let result = { logs: [], skipped: [] }
      let detectedDays = []
      let modeLabel = 'Danh sách'
      let headerRowIdx = -1
      let headers = []

      const deocaHeader = findDeocaPunchHeader(jsonData)
      if (deocaHeader) {
        format = 'deoca-punch'
        result = processDeocaPunchFormat(jsonData, deocaHeader)
        modeLabel = 'Phiếu chấm công DEOCA'
      } else if (bestDayCols.length >= 7) {
        format = 'matrix'
        const matrixDayRowIdx = bestDayRowIdx
        const matrixDayCols = bestDayCols
        detectedDays = matrixDayCols.map(d => d.day).sort((a, b) => a - b)

        // Tự động nhận diện tháng/năm từ date serial trong hàng ngày, hoặc từ tiêu đề file/tên sheet
        let [year, month] = importMonth.split('-').map(Number)
        const lastExplicitDate = bestDayCols.filter(column => column.year && column.month).at(-1)
        if (lastExplicitDate) {
          year = lastExplicitDate.year
          month = lastExplicitDate.month
        }

        const titleSources = [
          workbook.SheetNames[0],
          ...jsonData.slice(0, 6).map(r => (r || []).join(' '))
        ]
        for (const text of titleSources) {
          const m = String(text).match(/th[aá]ng\s*(\d{1,2})(?:[\/\-\s]+(\d{4}))?/i)
          if (m) {
            const mVal = Number(m[1])
            if (mVal >= 1 && mVal <= 12) {
              month = mVal
              if (m[2]) year = Number(m[2])
              break
            }
          }
        }
        setImportMonth(`${year}-${String(month).padStart(2, '0')}`)

        // Quét tìm các cột thông tin nhân sự trên toàn bộ các hàng từ 0 đến matrixDayRowIdx + 1
        let codeColIdx = -1, nameColIdx = -1, posColIdx = -1
        for (let r = 0; r <= Math.min(jsonData.length - 1, matrixDayRowIdx + 1); r++) {
          const row = jsonData[r] || []
          row.forEach((cell, idx) => {
            const s = String(cell || '').toLowerCase().trim()
            if (codeColIdx === -1 && (s.includes('mã nv') || s.includes('mã nhân viên') || s.includes('mã n.viên') || s.includes('mã') || s.includes('code'))) codeColIdx = idx
            if (nameColIdx === -1 && (s.includes('họ và tên') || s.includes('họ tên') || s.includes('tên nhân viên') || s.includes('tên nv') || s.includes('họ va ten') || s === 'họ tên' || s.includes('tên') || s.includes('name'))) nameColIdx = idx
            if (posColIdx === -1 && (s.includes('chức vụ') || s.includes('vị trí') || s.includes('phòng ban') || s.includes('phòng') || s.includes('bộ phận'))) posColIdx = idx
          })
        }

        if (nameColIdx === -1) {
          nameColIdx = codeColIdx === 0 ? 1 : 1
        }

        // Bỏ qua dòng thứ trong tuần (T2, T3, T4... CN) hoặc dòng tiêu đề phụ
        let dataStartRow = matrixDayRowIdx + 1
        while (dataStartRow < jsonData.length) {
          const row = jsonData[dataStartRow] || []
          const weekdayCount = row.filter(c => /^(t[2-7]|cn|thứ\s*[2-7]|chủ\s*nhật)$/i.test(String(c || '').trim())).length
          const nameVal = nameColIdx >= 0 ? String(row[nameColIdx] || '').trim() : ''
          const codeVal = codeColIdx >= 0 ? String(row[codeColIdx] || '').trim() : ''
          const lowerName = nameVal.toLowerCase()

          if (
            weekdayCount >= 3 ||
            (!nameVal && !codeVal) ||
            lowerName.includes('họ tên') ||
            lowerName.includes('nhân sự') ||
            lowerName.includes('xác nhận')
          ) {
            dataStartRow++
          } else {
            break
          }
        }

        result = processMatrixFormat(jsonData, {
          matrixDayCols,
          codeColIdx,
          nameColIdx,
          posColIdx,
          dataStartRow,
          year,
          month
        })
        modeLabel = 'Bảng công (Ma trận ngày)'
      } else {
        for (let i = 0; i < Math.min(jsonData.length, 15); i++) {
          const row = jsonData[i] || []
          const lower = row.map(c => String(c || '').toLowerCase().trim())
          const rowStr = lower.join(' ')
          if (
            (rowStr.includes('mã nv') && rowStr.includes('ngày')) ||
            (rowStr.includes('ma nv') && rowStr.includes('ngay')) ||
            (rowStr.includes('họ tên') || rowStr.includes('tên nv')) ||
            (rowStr.includes('mã') && rowStr.includes('ngày')) ||
            lower.some(h => /l[aầ]n\s*\d+/i.test(h))
          ) {
            headerRowIdx = i
            headers = lower
            break
          }
        }

        if (headerRowIdx === -1) {
          throw new Error('Không tìm thấy dòng tiêu đề hợp lệ (cần Mã NV, Ngày, Lần 1...)')
        }

        format = detectFormat(headers)

        if (format === 'full') {
          result = processFullAttendanceFormat(jsonData, headers, headerRowIdx)
          modeLabel = 'Bảng chấm công đầy đủ'
        } else if (format === 'punch') {
          result = processPunchLogFormat(jsonData, headers, headerRowIdx)
          modeLabel = 'Nhật ký chấm công (Lần 1–7)'
        } else {
          result = processListFormat(jsonData, headers, headerRowIdx)
          modeLabel = 'Danh sách (Vào/Ra)'
        }
      }

      if (result.logs.length === 0) {
        const hint = result.skipped.slice(0, 5).join('\n')
        alert(`Không tìm thấy dữ liệu hợp lệ.\n${hint || 'Vui lòng kiểm tra lại file và mã NV khớp hệ thống.'}`)
        setPreviewData(null)
      } else {
        // Tự nhận diện tháng từ ngày trong mọi định dạng file (không chỉ ma trận).
        // Nhờ đó file tháng 08 không bị lưu nhầm vào tháng đang mở trên màn hình.
        const monthCounts = new Map()
        result.logs.forEach(log => {
          const date = String(log.date || log.ngay || '').slice(0, 10)
          const match = date.match(/^(\d{4})-(\d{2})-/)
          if (match) {
            const value = `${match[1]}-${match[2]}`
            monthCounts.set(value, (monthCounts.get(value) || 0) + 1)
          }
        })
        const detectedImportMonth = Array.from(monthCounts.entries())
          .sort((left, right) => right[1] - left[1])[0]?.[0] || importMonth
        const periods = await listAttendancePeriods(activeCompanyId)
        const suggestion = suggestAttendancePeriod({
          logs: result.logs,
          existing: periods,
          monthHint: importMonth || detectedImportMonth
        })
        setSavedPeriods(periods)
        setPeriodDraft(suggestion)
        setPeriodConfirmed(false)
        setImportMonth(detectedImportMonth)
        setPreviewData(
          prepareMatchingPreview(result.logs, {
            modeLabel,
            isMatrixMode: format === 'matrix',
            detectedDays,
            skipped: result.skipped,
            invalidDateRows: [
              ...result.skipped.filter(message => /ngày không hợp lệ|ngày hợp lệ/i.test(message)),
              ...result.logs.filter(log => !isValidAttendanceDate(String(log.date || '')))
                .map(log => `Ngày không hợp lệ: ${log.date}`)
            ],
            isReconcileMode: false,
            importMonth: detectedImportMonth
          })
        )
      }
    } catch (error) {
      alert('Lỗi: ' + error.message)
      console.error(error)
      setPreviewData(null)
    } finally {
      setLoading(false)
    }
  }

  const handleConfirmPeriod = async () => {
    if (!isCoreStaffUser(user)) {
      alert('Chỉ Admin, Nhân sự hoặc Quản lý của công ty này được xác nhận kỳ công.')
      return
    }
    try {
      const valid = validateAttendancePeriod(periodDraft, savedPeriods)
      const counts = countAttendancePeriodLogs(previewData.logs, valid)
      if (!counts.inside) throw new Error('Kỳ công đã chọn không chứa bản ghi nào trong file.')
      if (previewData.invalidDateRows?.length) throw new Error('File có ngày không hợp lệ; hãy sửa file trước khi nhập.')
      setLoading(true)
      const confirmed = await confirmAttendancePeriod(activeCompanyId, valid)
      setPeriodDraft(confirmed)
      setSavedPeriods(current => [...current.filter(item => item.month !== confirmed.month), confirmed])
      setPeriodConfirmed(true)
      if (onPeriodConfirmed) {
        try {
          await onPeriodConfirmed(confirmed)
        } catch (summaryError) {
          alert(`Kỳ công đã được lưu, nhưng chưa cập nhật được bảng tổng hợp: ${summaryError.message || summaryError}`)
        }
      }
    } catch (error) {
      alert(error.message || String(error))
    } finally {
      setLoading(false)
    }
  }

  const prepareLogWithPolicy = (log, employee, importPolicy) => {
    if (log.syntheticPunch) return log
    const hasRawPunch = Boolean(formatAttendanceTime(log.vao || log.checkIn) ||
      formatAttendanceTime(log.ra || log.checkOut) ||
      (Array.isArray(log.punchPairs) && log.punchPairs.length))
    const importValuesAllowed = importPolicy.importPriorityMode !== 'raw_punch' ||
      importPolicy.workUnitCalculationMode === 'imported'
    if (['source-value', 'matrix-value'].includes(log.calculationMode) &&
      (importValuesAllowed || !hasRawPunch) &&
      (importPolicy.missingPunchPolicy !== 'manual_review' || !hasRawPunch)) return log
    const shift = resolveAttendanceShift(employee, log, importPolicy)
    const metrics = calculateAttendanceMetrics({
      log,
      checkIn: log.vao || log.checkIn,
      checkOut: log.ra || log.checkOut,
      attendanceSettings: importPolicy,
      punchPairs: log.punchPairs,
      splitShift: shift?.splitShift,
      shift,
      standardMinutes: Number(importPolicy.standardWorkMinutes) || STANDARD_WORK_MINUTES,
      breakMinutes: Number(importPolicy.unpaidBreakMinutes) || 0,
      autoCalculateOvertime: importPolicy?.overtime?.autoCalculate !== false,
      fallbackHours: log.hours,
      fallbackWorkdays: log.cong
    })
    const timed = applyCalculatedAttendanceTiming(log, employee, importPolicy)
    const deocaStatus = log.importFormat === 'deoca-punch'
      ? !formatAttendanceTime(log.ra || log.checkOut)
        ? 'Thiếu ra'
        : metrics.hours <= 0
          ? 'Vắng/Nghỉ'
          : [
              timed.lateMinutes > 0 ? `Muộn ${timed.lateMinutes}p` : '',
              timed.earlyMinutes > 0 ? `Sớm ${timed.earlyMinutes}p` : ''
            ].filter(Boolean).join(' & ') || 'Đủ'
      : null
    return {
      ...timed,
      ...(deocaStatus ? { status: deocaStatus, kyHieu: deocaStatus } : {}),
      importedHours: log.importedHours ?? log.hours,
      importedWorkUnit: log.importedWorkUnit ?? log.cong,
      cong: metrics.regularWorkdays,
      hours: metrics.hours,
      gio: metrics.hours,
      tongGio: metrics.hours + (Number(log.gioPlus) || 0),
      workedMinutes: metrics.workedMinutes,
      regularMinutes: metrics.regularMinutes,
      overtimeMinutes: metrics.overtimeMinutes,
      overtimeHours: metrics.overtimeHours,
      overtimeAutoDisabled: log.overtimeAutoDisabled !== undefined
        ? Boolean(log.overtimeAutoDisabled)
        : false,
      calculationMode: metrics.calculationMode,
      splitShiftBreakdown: metrics.splitShiftBreakdown
    }
  }

  const saveMissingShifts = async (useAdministrativeHours = false) => {
    if (!previewData?.logs || loading) return
    if (!isCoreStaffUser(user)) {
      alert('Chỉ Admin, Nhân sự hoặc Quản lý của công ty này được cài đặt giờ ca.')
      return
    }
    const selectedLogs = previewData.isReconcileMode
      ? previewData.logs
      : previewData.logs.filter(log => periodDraft && dateInAttendancePeriod(log.date, periodDraft))
    const skippedSourceKeys = new Set(previewData.matchGroups
      .filter(group => group.status === 'skipped')
      .map(group => group.key))
    setLoading(true)
    setShiftNotice('')
    try {
      const storedSettings = await fbGet('hr/attendanceSettings/default', activeCompanyId)
      const currentSettings = normalizeAttendanceShiftSettings(storedSettings)
      const missingNames = findMissingAttendanceShifts(selectedLogs, currentSettings, skippedSourceKeys)
      const namesToSave = useAdministrativeHours
        ? missingNames.filter(name => ['ca 1', 'ca 2'].includes(normalizeAttendanceShiftName(name)))
        : missingNames
      let savedSettings = currentSettings
      if (useAdministrativeHours && !namesToSave.length) {
        throw new Error('Không còn Ca 1 hoặc Ca 2 cần ghép với Ca Hành chính.')
      }
      if (namesToSave.length) {
        const incomplete = !useAdministrativeHours && namesToSave.find(name => {
          const draft = missingShiftDrafts[name] || {}
          const start = attendanceTimeToMinutes(draft.start)
          const end = attendanceTimeToMinutes(draft.end)
          return start === null || end === null || start === end
        })
        if (incomplete) {
          throw new Error(`Hãy nhập giờ vào và giờ ra chuẩn, khác nhau, cho ${incomplete}.`)
        }
        const newShifts = Object.fromEntries((useAdministrativeHours ? [] : namesToSave).map((name, index) => {
          const draft = missingShiftDrafts[name]
          return [`custom_deoca_${Date.now()}_${index}`, {
            name,
            standardCheckIn: draft.start,
            standardCheckOut: draft.end,
            standardWorkMinutes: currentSettings.standardWorkMinutes,
            unpaidBreakMinutes: 0,
            allowOvernightShift: attendanceTimeToMinutes(draft.end) < attendanceTimeToMinutes(draft.start)
          }]
        }))
        const nextSettings = {
          ...currentSettings,
          policyVersion: Number(currentSettings.policyVersion || 0) + 1,
          shifts: { ...currentSettings.shifts, ...newShifts },
          deocaShiftAliases: {
            ...currentSettings.deocaShiftAliases,
            ...Object.fromEntries((useAdministrativeHours ? namesToSave : [])
              .map(name => [normalizeAttendanceShiftName(name), 'administrative']))
          }
        }
        const validation = validateAttendancePolicy(nextSettings)
        if (!validation.isValid) throw new Error(validation.error)
        await fbUpdate('hr/attendanceSettings/default', buildAttendanceShiftSettingsPayload(nextSettings), activeCompanyId)
        savedSettings = normalizeAttendanceShiftSettings(await fbGet('hr/attendanceSettings/default', activeCompanyId))
        const stillMissing = findMissingAttendanceShifts(selectedLogs, savedSettings, skippedSourceKeys)
          .filter(name => namesToSave.some(saved =>
            normalizeAttendanceShiftName(saved) === normalizeAttendanceShiftName(name)))
        if (stillMissing.length) throw new Error(`Chưa đọc lại được giờ chuẩn cho ${stillMissing.join(', ')}. Hãy thử lưu lại.`)
        const savedShifts = getAttendanceShiftOptions(savedSettings)
        const incorrect = namesToSave.find(name => {
          const shift = useAdministrativeHours
            ? savedSettings.shifts[savedSettings.deocaShiftAliases[normalizeAttendanceShiftName(name)]]
            : savedShifts.find(item =>
              normalizeAttendanceShiftName(item.name) === normalizeAttendanceShiftName(name))
          const expected = useAdministrativeHours ? currentSettings.shifts.administrative : missingShiftDrafts[name]
          return shift?.standardCheckIn !== (useAdministrativeHours ? expected.standardCheckIn : expected.start) ||
            shift?.standardCheckOut !== (useAdministrativeHours ? expected.standardCheckOut : expected.end)
        })
        if (incorrect) throw new Error(`Giờ chuẩn của ${incorrect} chưa được lưu đúng. Hãy thử lại.`)
      }
      setAttendanceSettings(savedSettings)
      setPreviewData(previous => previous ? {
        ...previous,
        logs: previous.logs.map(log => {
          if (log.importFormat !== 'deoca-punch' || skippedSourceKeys.has(log._sourceEmployeeKey)) return log
          const employee = employeesById.get(String(log.employeeId))
          return employee ? prepareLogWithPolicy(log, employee, savedSettings) : log
        })
      } : previous)
      setMissingShiftDrafts({})
      setShiftNotice(useAdministrativeHours
        ? 'Đã dùng giờ Ca Hành chính cho Ca 1/Ca 2 và tính lại bảng xem trước.'
        : 'Đã lưu giờ ca cho công ty và tính lại bảng xem trước.')
    } catch (error) {
      alert('Không lưu được giờ ca: ' + (error.message || String(error)))
    } finally {
      setLoading(false)
    }
  }

  const executeImport = async () => {
    if (!previewData?.logs || importInProgressRef.current) return
    if (!previewData.isReconcileMode && !periodConfirmed) {
      alert('Hãy xác nhận kỳ công trước khi nhập Excel.')
      return
    }
    const selectedLogs = previewData.isReconcileMode
      ? previewData.logs
      : previewData.logs.filter(log => dateInAttendancePeriod(log.date, periodDraft))
    const selectedSourceKeys = new Set(selectedLogs.map(log => log._sourceEmployeeKey))
    const unresolvedCount = previewData.matchGroups.filter(group =>
      selectedSourceKeys.has(group.key) &&
      !group.selectedEmployeeId && group.status !== 'skipped'
    ).length
    if (unresolvedCount > 0) {
      alert(`Còn ${unresolvedCount} nhân viên chưa được ghép hồ sơ của công ty hiện tại. Hãy ghép hoặc bỏ qua trước khi nhập.`)
      return
    }

    const skippedSourceKeys = new Set(previewData.matchGroups
      .filter(group => group.status === 'skipped')
      .map(group => group.key))
    importInProgressRef.current = true
    setLoading(true)
    try {
      const storedSettings = await fbGet('hr/attendanceSettings/default', activeCompanyId)
      const importPolicy = normalizeAttendanceShiftSettings(storedSettings)
      const missingShifts = findMissingAttendanceShifts(selectedLogs, importPolicy, skippedSourceKeys)
      if (missingShifts.length) {
        const savedShifts = getAttendanceShiftOptions(importPolicy)
          .map(shift => shift.name)
          .filter(Boolean)
        alert(`Chưa có giờ chuẩn cho ${missingShifts.join(', ')} trong cài đặt đã lưu của công ty này. Ca đang lưu: ${savedShifts.join(', ') || 'không có'}. Hãy kiểm tra tên ca và bấm Lưu cài đặt trong Cài đặt → Cài đặt ca trước khi nhập.`)
        return
      }
      if (!previewData.isReconcileMode) {
        const storedPeriod = await getAttendancePeriod(activeCompanyId, periodDraft.month)
        if (!storedPeriod || storedPeriod.startDate !== periodDraft.startDate ||
          storedPeriod.endDate !== periodDraft.endDate) {
          throw new Error('Kỳ công đã thay đổi. Hãy xác nhận lại kỳ trước khi nhập.')
        }
      }
      const preparedLogs = selectedLogs.map(log => {
        if (skippedSourceKeys.has(log._sourceEmployeeKey)) return log
        const employee = employeesById.get(String(log.employeeId))
        if (!employee) throw new Error(`Không tìm thấy hồ sơ nhân viên đã ghép cho bản ghi ${log.date || ''}.`)
        return prepareLogWithPolicy(log, employee, importPolicy)
      })
      const result = await commitAttendanceImport({
        supabase,
        fbGet,
        fbUpdate,
        companyId: activeCompanyId,
        incomingLogs: preparedLogs,
        skippedSourceKeys,
        reconcileMode: Boolean(previewData.isReconcileMode)
      })
      const primaryMonth = previewData.isReconcileMode
        ? (previewData.importMonth || importMonth)
        : periodDraft.month
      const affectedMonths = previewData.isReconcileMode
        ? [...new Set([...result.affectedMonths, primaryMonth])]
        : [primaryMonth]
      await onSave({ primaryMonth, affectedMonths })
      onClose()
      setFile(null)
      setReferenceImage(null)
      setPreviewData(null)
    } catch (error) {
      alert('Lỗi khi lưu dữ liệu: ' + (error.message || String(error)))
    } finally {
      importInProgressRef.current = false
      setLoading(false)
    }
  }
  const formatExportTime = value => formatAttendanceTime(value) || String(value || '')

  const downloadMatchedExcel = () => {
    if (!previewData?.logs?.length) return
    const groupByKey = new Map(
      previewData.matchGroups.map(group => [group.key, group])
    )
    const skippedSourceKeys = new Set(
      previewData.matchGroups
        .filter(group => group.status === 'skipped')
        .map(group => group.key)
    )
    const rows = previewData.logs
      .filter(log => !skippedSourceKeys.has(log._sourceEmployeeKey))
      .map((log, index) => {
      const group = groupByKey.get(log._sourceEmployeeKey)
      return {
        STT: index + 1,
        'Công ty': companyName || 'Công ty chưa khai báo',
        'Mã nguồn': log.sourceEmployeeCode || '',
        'Tên nguồn': log.sourceEmployeeName || '',
        'Mã N.Viên Lumi': log.employeeCode || '',
        'Tên nhân viên Lumi': log.employeeName || '',
        'Tên theo máy chấm công':
          log.machineName || log.tenTheoMayChamCong || '',
        'Phòng ban': log.department || '',
        'Chức vụ': log.position || '',
        'Ngày': String(log.date || '').slice(0, 10),
        'Thứ': log.dayOfWeek || '',
        'Vào': formatExportTime(log.vao || log.checkIn),
        'Ra': formatExportTime(log.ra || log.checkOut),
        'Công': log.cong ?? '',
        'Giờ': log.hours ?? log.gio ?? '',
        'Công+': log.congPlus ?? '',
        'Giờ+': log.gioPlus ?? '',
        'Vào trễ': log.lateMinutes ?? log.vaoTre ?? '',
        'Ra sớm': log.earlyMinutes ?? log.raSom ?? '',
        TC1: log.tc1 ?? '',
        TC2: log.tc2 ?? '',
        TC3: log.tc3 ?? '',
        'Tên ca': log.shiftName || log.tenCa || '',
        'Kí hiệu': log.kyHieu || log.status || '',
        'Kí hiệu+': log.kyHieuPlus || '',
        'Tổng giờ': log.tongGio ?? '',
        'Độ tin cậy': group ? `${Math.round(group.confidence * 100)}%` : '',
        'Cách đối sánh': group?.method || ''
      }
      })
    const worksheet = utils.json_to_sheet(rows)
    const workbook = utils.book_new()
    utils.book_append_sheet(workbook, worksheet, 'ChamCongDaKhop')
    writeFile(
      workbook,
      `Cham_cong_da_khop_${importMonth || new Date().toISOString().slice(0, 7)}.xlsx`
    )
  }

  const downloadNewTemplate = () => {
    const headers = [
      'Mã N.Viên', 'Tên nhân viên', 'Tên theo máy chấm công', 'Phòng ban', 'Chức vụ', 'Ngày', 'Thứ',
      'Vào', 'Ra', 'Công', 'Giờ', 'Công+', 'Giờ+', 'Vào trễ', 'Ra sớm',
      'TC1', 'TC2', 'TC3', 'Tên ca', 'Kí hiệu', 'Kí hiệu+', 'Tổng giờ'
    ]
    const sample = [
      ['NV001', 'Nguyễn Văn A', 'Nguyen Van A', 'Kế toán', 'Nhân viên', '2026-05-01', 'Thứ 6', '08:00', '17:30', 1, 8, 0, 0, 0, 0, 0, 0, 0, 'Ca full', 'X', '', 8],
      ['NV001', 'Nguyễn Văn A', 'Nguyen Van A', 'Kế toán', 'Nhân viên', '2026-05-02', 'Thứ 7', '07:55', '17:35', 1, 8, 0.5, 1, 0, 0, 0, 0, 0, 'Ca full', 'X', 'TC', 9]
    ]
    const ws = utils.aoa_to_sheet([headers, ...sample])
    const wb = utils.book_new()
    utils.book_append_sheet(wb, ws, 'ChamCong')
    writeFile(wb, 'Mau_nhap_cham_cong.xlsx')
  }

  const handleClose = () => {
    setFile(null)
    setReferenceImage(null)
    setPreviewData(null)
    setShiftNotice('')
    setPeriodDraft(null)
    setPeriodConfirmed(false)
    onClose()
  }

  if (!isOpen) return null

  const previewSelectedLogs = previewData?.isReconcileMode
    ? previewData.logs
    : (previewData?.logs || []).filter(log => periodDraft && dateInAttendancePeriod(log.date, periodDraft))
  const previewSourceKeys = new Set(previewSelectedLogs.map(log => log._sourceEmployeeKey))
  const activeMatchGroups = (previewData?.matchGroups || []).filter(group => previewSourceKeys.has(group.key))
  const skippedPreviewSourceKeys = new Set(activeMatchGroups
    .filter(group => group.status === 'skipped')
    .map(group => group.key))
  const previewMissingShifts = findMissingAttendanceShifts(
    previewSelectedLogs, attendanceSettings, skippedPreviewSourceKeys
  )
  const matchedEmployeeCount =
    activeMatchGroups.filter(
      group => group.selectedEmployeeId && group.status !== 'skipped'
    ).length || 0
  const skippedEmployeeCount =
    activeMatchGroups.filter(group => group.status === 'skipped').length || 0
  const unresolvedEmployeeCount =
    activeMatchGroups.length -
    matchedEmployeeCount -
    skippedEmployeeCount
  const previewDates = (previewData?.logs || []).map(log => String(log.date || '').slice(0, 10)).sort()
  const periodCounts = periodDraft && previewData
    ? countAttendancePeriodLogs(previewData.logs, periodDraft)
    : { inside: 0, outside: 0 }

  return (
    <div className="modal show" onClick={handleClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '1100px' }}>
        <div className="modal-header">
          <h3>
            <i className="fas fa-robot"></i>
            AI đối soát & Import chấm công
          </h3>
          <button className="modal-close" onClick={handleClose}>&times;</button>
        </div>
        <div className="modal-body">
          {!previewData ? (
            <>
              <div className="form-group">
                <label>Chi nhánh dùng để đối sánh nhân sự</label>
                <select
                  value={matchBranch}
                  onChange={(e) => setMatchBranch(e.target.value)}
                  style={{ width: '100%', padding: '10px', marginBottom: '12px' }}
                >
                  <option value="">Tất cả chi nhánh</option>
                  {availableBranches.map(branch => (
                    <option key={branch} value={branch}>{branch}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Chọn tháng chấm công (dùng cho mẫu ma trận ngày) *</label>
                <input
                  type="month"
                  value={importMonth}
                  onChange={(e) => setImportMonth(e.target.value)}
                  style={{ width: '100%', marginBottom: '15px' }}
                />
              </div>
              <div className="form-group">
                <label>1. File Excel chấm công</label>
                <input type="file" accept=".xlsx,.xls" onChange={handleFileChange} style={{ width: '100%', padding: '10px' }} />
              </div>
              <div className="form-group">
                <label>2. Ảnh danh sách nhân sự (không bắt buộc)</label>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => setReferenceImage(e.target.files?.[0] || null)}
                  disabled={aiAvailable === false}
                  style={{ width: '100%', padding: '10px' }}
                />
                  <small style={{ color: '#6b7280' }}>
                  {aiAvailable === false
                    ? 'Chưa cấu hình GROQ_API_KEY trên production. Đối sánh tên/mã trong Excel vẫn hoạt động.'
                    : 'Dùng khi cần AI đọc ảnh danh sách nhân sự để hỗ trợ các tên khó ghép.'}
                </small>
              </div>
              <div style={{ marginTop: '-10px', marginBottom: '10px' }}>
                <button
                  type="button"
                  className="btn btn-link"
                  style={{ fontSize: '0.85rem', padding: 0 }}
                  onClick={downloadNewTemplate}
                >
                  <i className="fas fa-download"></i> Tải file mẫu (đầy đủ cột chấm công)
                </button>
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  padding: '12px',
                  marginBottom: '12px',
                  border: '1px solid #f59e0b',
                  borderRadius: '6px',
                  background: '#fffbeb'
                }}
              >
                <div>
                  <strong>Dữ liệu đã có trong Lumi</strong>
                  <div style={{ fontSize: '0.85rem', color: '#6b7280' }}>
                    Đổi mã máy chấm công sang mã nhân viên chuẩn trong hồ sơ Lumi.
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-warning"
                  onClick={handleReconcileExisting}
                  disabled={!attendanceLogs.length}
                >
                  <i className="fas fa-link"></i>
                  {` Khớp mã nhân viên (${attendanceLogs.length} dòng)`}
                </button>
              </div>
              <div className="alert alert-info" style={{ marginTop: '15px', background: '#e8f5e9', padding: '10px', borderRadius: '4px' }}>
                <small>
                  <strong>Quy tắc đối sánh:</strong><br />
                  • Mã máy và mã Lumi được giữ riêng; kết quả dùng mã nhân viên chuẩn của hồ sơ Lumi.<br />
                  • Ghép được tên có dấu/không dấu, viết liền, khác hoa thường và thiếu tên đệm phổ biến.<br />
                  • Tên chắc chắn được tự ghép; tên mơ hồ bắt buộc người dùng chọn lại trước khi ghi CSDL.<br />
                  • Hệ thống giữ tên/mã nguồn để kiểm tra và chống import trùng.
                </small>
              </div>
            </>
          ) : (
            <div style={{ padding: '10px', background: '#f8f9fa', borderRadius: '4px' }}>
              <h4>Kết quả phân tích:</h4>
              <ul>
                <li><strong>Chế độ:</strong> {previewData.modeLabel}</li>
                <li><strong>Số nhân viên (không trùng):</strong> {previewData.uniqueEmployeeCount}</li>
                <li><strong>Tổng số dòng chấm công:</strong> {previewData.count}</li>
                {!previewData.isReconcileMode && <li><strong>Ngày tìm thấy trong Excel:</strong> {previewDates[0]} – {previewDates.at(-1)}</li>}
                <li style={{ color: '#15803d' }}>
                  <strong>Đã ghép với hồ sơ trong kỳ:</strong> {matchedEmployeeCount}
                </li>
                <li style={{ color: unresolvedEmployeeCount ? '#b91c1c' : '#15803d' }}>
                  <strong>Cần kiểm tra:</strong> {unresolvedEmployeeCount}
                </li>
                {skippedEmployeeCount > 0 && (
                  <li style={{ color: '#6b7280' }}>
                    <strong>Không có hồ sơ Lumi, sẽ bỏ qua:</strong> {skippedEmployeeCount}
                  </li>
                )}
                {previewData.isMatrixMode && (
                  <li>
                    <strong>Các cột ngày tìm thấy:</strong>{' '}
                    <span style={{ color: '#007bff', fontWeight: 'bold' }}>
                      {previewData.detectedDays.join(', ')}
                    </span>
                  </li>
                )}
                {previewData.skipped?.length > 0 && (
                  <li style={{ color: '#b45309' }}>
                    <strong>Bỏ qua:</strong> {previewData.skipped.length} dòng
                    <div style={{ fontSize: '0.8rem', marginTop: '4px' }}>
                      {previewData.skipped.slice(0, 5).map((s, i) => <div key={i}>{s}</div>)}
                    </div>
                  </li>
                )}
              </ul>
              {previewMissingShifts.length > 0 && (
                <section style={{ padding: 14, border: '1px solid #f59e0b', borderRadius: 8, background: '#fffbeb', marginBottom: 16 }}>
                  <h4 style={{ marginTop: 0 }}>Nhập giờ chuẩn cho ca trong file</h4>
                  <p>Các ca {previewMissingShifts.join(', ')} chưa có trong cài đặt đã lưu của {companyName || 'công ty này'}. Chọn giờ Ca Hành chính cho Ca 1/Ca 2 nếu cùng làm cả ngày, hoặc nhập giờ riêng bên dưới.</p>
                  {previewMissingShifts.some(name => ['ca 1', 'ca 2'].includes(normalizeAttendanceShiftName(name))) && (
                    <button type="button" className="btn btn-primary" disabled={loading}
                      onClick={() => saveMissingShifts(true)} style={{ marginBottom: 12 }}>
                      {loading ? 'Đang lưu...' : `Dùng giờ Ca Hành chính (${attendanceSettings.shifts.administrative.standardCheckIn}–${attendanceSettings.shifts.administrative.standardCheckOut}) cho Ca 1/Ca 2`}
                    </button>
                  )}
                  <div style={{ display: 'grid', gap: 10 }}>
                    {previewMissingShifts.map(name => (
                      <div key={name} style={{ display: 'flex', alignItems: 'end', flexWrap: 'wrap', gap: 10 }}>
                        <strong style={{ minWidth: 65, paddingBottom: 10 }}>{name}</strong>
                        <label>Giờ vào chuẩn
                          <input type="time" value={missingShiftDrafts[name]?.start || ''} disabled={loading}
                            onChange={event => setMissingShiftDrafts(current => ({ ...current,
                              [name]: { ...(current[name] || {}), start: event.target.value }
                            }))} />
                        </label>
                        <label>Giờ ra chuẩn
                          <input type="time" value={missingShiftDrafts[name]?.end || ''} disabled={loading}
                            onChange={event => setMissingShiftDrafts(current => ({ ...current,
                              [name]: { ...(current[name] || {}), end: event.target.value }
                            }))} />
                        </label>
                      </div>
                    ))}
                  </div>
                  <p style={{ fontSize: '0.85rem', marginBottom: 8 }}>Chuẩn công mặc định: {attendanceSettings.standardWorkMinutes} phút/ca, nghỉ không tính: 0 phút. Có thể chỉnh riêng trong Cài đặt ca.</p>
                  <button type="button" className="btn btn-primary" disabled={loading} onClick={() => saveMissingShifts(false)}>
                    {loading ? 'Đang lưu giờ ca...' : 'Lưu giờ ca và tính lại'}
                  </button>
                </section>
              )}
              {shiftNotice && <div className="alert alert-success" style={{ marginBottom: 16 }}>{shiftNotice}</div>}
              {!previewData.isReconcileMode && periodDraft && (
                <section style={{ padding: '14px', border: '1px solid #0f766e', borderRadius: 8, background: '#f0fdfa', marginBottom: 16 }}>
                  <h4 style={{ marginTop: 0 }}>Xác nhận kỳ công</h4>
                  <p>Kỳ đề xuất từ {periodDraft.source === 'saved' ? 'kỳ đã lưu' : periodDraft.source === 'previous' ? 'kỳ trước của công ty' : periodDraft.source === 'cross-month' ? 'dữ liệu qua hai tháng' : 'tháng dương lịch'}. Có thể sửa trước khi xác nhận.</p>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <label>Tháng/năm kỳ công<br /><input type="month" value={periodDraft.month} onChange={event => {
                      const month = event.target.value
                      if (!month) return
                      setPeriodDraft(suggestAttendancePeriod({ logs: previewData.logs, existing: savedPeriods, monthHint: month, forceMonth: true }))
                      setPeriodConfirmed(false)
                    }} /></label>
                    <label>Bắt đầu<br /><input type="date" value={periodDraft.startDate} onChange={event => {
                      setPeriodDraft(current => ({ ...current, startDate: event.target.value, source: 'manual' }))
                      setPeriodConfirmed(false)
                    }} /></label>
                    <label>Kết thúc<br /><input type="date" value={periodDraft.endDate} onChange={event => {
                      setPeriodDraft(current => ({ ...current, endDate: event.target.value, source: 'manual' }))
                      setPeriodConfirmed(false)
                    }} /></label>
                  </div>
                  <p>Trong kỳ: <strong>{periodCounts.inside}</strong> bản ghi · Ngoài kỳ: <strong>{periodCounts.outside}</strong> bản ghi. Bản ghi ngoài kỳ sẽ không được nhập lần này; ngày gốc của bản ghi trong kỳ được giữ nguyên.</p>
                  {previewData.invalidDateRows?.length > 0 && <p style={{ color: '#b91c1c' }}>Có {previewData.invalidDateRows.length} dòng ngày không hợp lệ; cần sửa file trước khi nhập.</p>}
                  <button type="button" className="btn btn-primary" onClick={handleConfirmPeriod}
                    disabled={loading || !periodCounts.inside || Boolean(previewData.invalidDateRows?.length) || !isCoreStaffUser(user)}>
                    {periodConfirmed ? 'Đã xác nhận kỳ công' : 'Xác nhận kỳ công'}
                  </button>
                </section>
              )}
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '8px',
                  marginBottom: '10px'
                }}
              >
                <button
                  type="button"
                  className="btn btn-info"
                  onClick={handleAiMatch}
                  disabled={aiLoading || !referenceImage || aiAvailable === false}
                  title={
                    aiAvailable === false
                      ? 'Production chưa cấu hình GROQ_API_KEY'
                      : referenceImage
                        ? 'Dùng AI đọc ảnh và đối sánh mã/tên'
                        : 'Chọn ảnh danh sách nhân sự trước'
                  }
                >
                  <i className={`fas ${aiLoading ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'}`}></i>
                  {aiLoading ? ' AI đang đối sánh...' : ' AI đọc ảnh & khớp mã'}
                </button>
                <button
                  type="button"
                  className="btn btn-success"
                  onClick={downloadMatchedExcel}
                  disabled={unresolvedEmployeeCount > 0}
                >
                  <i className="fas fa-file-excel"></i>
                  {' Xuất Excel đã khớp'}
                </button>
              </div>

              <div style={{ marginTop: '10px' }}>
                <strong>Bảng khớp mã máy → mã nhân viên Lumi:</strong>
              </div>
              <div
                style={{
                  maxHeight: '300px',
                  overflow: 'auto',
                  marginTop: '8px',
                  border: '1px solid #ddd',
                  borderRadius: '6px',
                  background: '#fff'
                }}
              >
                <table className="table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
                  <thead>
                    <tr style={{ background: '#eee', position: 'sticky', top: 0, zIndex: 2 }}>
                      <th style={{ padding: '6px' }}>Mã máy</th>
                      <th style={{ padding: '6px' }}>Tên từ máy/file</th>
                      <th style={{ padding: '6px' }}>Mã NV Lumi</th>
                      <th style={{ padding: '6px' }}>Hồ sơ Lumi</th>
                      <th style={{ padding: '6px' }}>Tin cậy</th>
                      <th style={{ padding: '6px' }}>Kết quả</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeMatchGroups.map(group => {
                      const suggestedEmployee = employeesById.get(String(group.suggestedEmployeeId))
                      const selectedEmployee = employeesById.get(String(group.selectedEmployeeId))
                      const statusColor = group.status === 'skipped'
                        ? '#6b7280'
                        : group.selectedEmployeeId
                          ? '#15803d'
                        : group.status === 'review'
                          ? '#b45309'
                          : '#b91c1c'
                      return (
                        <tr key={group.key} style={{ borderBottom: '1px solid #eee' }}>
                          <td style={{ padding: '6px' }}>
                            <strong>{group.sourceCode || '-'}</strong>
                            <div style={{ color: '#6b7280' }}>{group.rowCount} dòng</div>
                          </td>
                          <td style={{ padding: '6px' }}>
                            <strong>{group.sourceName || '-'}</strong>
                          </td>
                          <td style={{ padding: '6px', color: selectedEmployee ? '#15803d' : '#b91c1c' }}>
                            <strong>
                              {selectedEmployee
                                ? getCanonicalEmployeeCode(selectedEmployee) || '-'
                                : group.status === 'skipped'
                                  ? 'Bỏ qua'
                                  : 'Chưa khớp'}
                            </strong>
                          </td>
                          <td style={{ padding: '6px', minWidth: '310px' }}>
                            <select
                              value={group.selectedEmployeeId}
                              onChange={(e) => handleMatchChange(group.key, e.target.value)}
                              style={{
                                width: '100%',
                                padding: '7px',
                                borderColor: group.selectedEmployeeId ? '#86efac' : '#fca5a5'
                              }}
                            >
                              <option value="">-- Chọn nhân viên Lumi --</option>
                              <option value="__skip__">-- Không có trong Lumi (bỏ qua) --</option>
                              {employeesForMatching.map(employee => (
                                <option key={employee.id} value={employee.id}>
                                  {employee.ho_va_ten || employee.name || employee.id}
                                  {employee.employeeId || employee.username
                                    ? ` (${employee.employeeId || employee.username})`
                                    : ''}
                                </option>
                              ))}
                            </select>
                            {!group.selectedEmployeeId && suggestedEmployee && (
                              <div style={{ color: '#b45309', marginTop: '3px' }}>
                                Gợi ý: {suggestedEmployee.ho_va_ten || suggestedEmployee.name}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: '6px', whiteSpace: 'nowrap' }}>
                            {Math.round(group.confidence * 100)}%
                          </td>
                          <td style={{ padding: '6px', color: statusColor }}>
                            <strong>
                              {group.status === 'skipped'
                                ? 'Sẽ bỏ qua'
                                : group.selectedEmployeeId
                                  ? 'Đã ghép'
                                  : 'Cần chọn'}
                            </strong>
                            <div style={{ fontSize: '0.78rem' }}>{group.method}</div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: '10px' }}>
                <strong>Chi tiết chấm công sau đối sánh:</strong>
              </div>
              <div style={{ maxHeight: '260px', overflowY: 'auto', marginTop: '8px', fontSize: '0.85rem', border: '1px solid #ddd', borderRadius: '6px' }}>
                <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#eee' }}>
                      <th style={{ padding: '5px' }}>STT</th>
                      <th style={{ padding: '5px' }}>Mã NV</th>
                      <th style={{ padding: '5px' }}>Tên NV</th>
                      <th style={{ padding: '5px' }}>Tên máy chấm công</th>
                      <th style={{ padding: '5px' }}>Ngày</th>
                      <th style={{ padding: '5px' }}>Vào</th>
                      <th style={{ padding: '5px' }}>Ra</th>
                      <th style={{ padding: '5px' }}>Công</th>
                      <th style={{ padding: '5px' }}>Giờ</th>
                      <th style={{ padding: '5px' }}>Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewData.logs.slice(0, 50).map((l, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #ddd' }}>
                        <td style={{ padding: '5px', textAlign: 'center' }}>{i + 1}</td>
                        <td style={{ padding: '5px' }}>{l.employeeCode || '-'}</td>
                        <td style={{ padding: '5px' }}>{l.employeeName || employees.find(e => e.id === l.employeeId)?.ho_va_ten || l.employeeId}</td>
                        <td style={{ padding: '5px' }}>{l.machineName || l.tenTheoMayChamCong || l.employeeName || '-'}</td>
                        <td style={{ padding: '5px' }}>{l.date}</td>
                        <td style={{ padding: '5px' }}>{formatExportTime(l.vao || l.checkIn) || '-'}</td>
                        <td style={{ padding: '5px' }}>{formatExportTime(l.ra || l.checkOut) || '-'}</td>
                        <td style={{ padding: '5px', textAlign: 'center' }}>{l.cong ?? '-'}</td>
                        <td style={{ padding: '5px' }}>{l.hours}</td>
                        <td style={{ padding: '5px' }}>{l.status}</td>
                      </tr>
                    ))}
                    {previewData.logs.length > 50 && (
                      <tr>
                        <td colSpan="10" style={{ textAlign: 'center', padding: '5px' }}>
                          ...và {previewData.logs.length - 50} dòng khác
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="form-actions" style={{ marginTop: '20px', display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={handleClose}>Đóng</button>

            {!previewData ? (
              <button type="button" className="btn btn-primary" onClick={handlePreview} disabled={loading || !file}>
                {loading ? <><i className="fas fa-spinner fa-spin"></i> Đang đọc file...</> : 'Phân tích & khớp dữ liệu >'}
              </button>
            ) : (
              <>
                <button type="button" className="btn btn-secondary" onClick={() => setPreviewData(null)}>{'< Quay lại'}</button>
                <button
                  type="button"
                  className="btn btn-success"
                  onClick={executeImport}
                  disabled={loading || previewMissingShifts.length > 0 || unresolvedEmployeeCount > 0 || (!previewData.isReconcileMode && !periodConfirmed)}
                  title={
                    previewMissingShifts.length > 0
                      ? 'Hãy lưu giờ chuẩn cho các ca trong file trước khi import'
                      : unresolvedEmployeeCount > 0
                      ? 'Hãy ghép hoặc bỏ qua mọi nhân viên trước khi lưu vào công ty hiện tại'
                      : ''
                  }
                >
                  {loading
                    ? <><i className="fas fa-spinner fa-spin"></i> Đang lưu...</>
                    : <><i className="fas fa-check"></i> {previewData.isReconcileMode ? 'Cập nhật CSDL Lumi' : 'Xác nhận Import'}</>}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default AttendanceImportModal
