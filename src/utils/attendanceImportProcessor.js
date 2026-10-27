import { applyEmployeeToAttendanceLog, buildSourceEmployeeKey, createAttendanceEmployeeMatcher } from './attendanceMatching.js'
import { parseAttendanceTime } from './attendanceImport.js'
import { getDeocaShiftName, parseDeocaPunchSheet } from './deocaPunchImport.js'
import { applyCalculatedAttendanceTiming, calculateAttendanceTiming, resolveAttendanceShift } from './attendanceShift.js'
import { calculateAttendanceMetrics, STANDARD_WORK_MINUTES } from './attendanceCalculations.js'

// Shared by the modal and its worker so large files use the same payroll rules.
export const createAttendanceImportProcessor = ({ employees = [], attendanceSettings = {}, attendanceLogs = [], matchBranch = '' } = {}) => {
  const employeesById = new Map(employees.map(employee => [String(employee.id), employee]))
  const matchEmployee = createAttendanceEmployeeMatcher(employees, matchBranch)
  const findEmployee = (code, name) => matchEmployee(code, name).employee
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
          : matchEmployee(sourceCode, sourceName)

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

  return { calculateStats, findEmployee, buildFallbackEmployee, attachSourceIdentity, buildLog, processDeocaPunchFormat, prepareMatchingPreview }
}
