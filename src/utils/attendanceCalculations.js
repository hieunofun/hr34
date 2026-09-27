import {
  attendanceTimeToMinutes,
  DEFAULT_ATTENDANCE_POLICY,
  DEFAULT_ATTENDANCE_SETTINGS,
  normalizeAttendanceShiftSettings
} from './attendanceShift.js'

/**
 * Một ngày công đủ được quy đổi từ chuẩn phút làm việc theo cấu hình (mặc định 480 phút).
 * Không dùng số giờ đã làm tròn từ Excel để tính lại tổng tháng.
 */
export const STANDARD_WORK_MINUTES = DEFAULT_ATTENDANCE_POLICY.standardWorkMinutes

export const prorateMonthlySalary = (monthlySalary, workUnits, attendanceSettings = {}) => {
  const monthlyStandard = normalizeAttendanceShiftSettings(attendanceSettings).monthlyStandardWorkUnits
  const salary = Number(monthlySalary)
  const worked = Number(workUnits)
  return Number.isFinite(salary) && Number.isFinite(worked)
    ? salary / monthlyStandard * worked : 0
}

const finiteNumber = (value, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const roundDecimal = (value, digits = 2) => {
  const factor = 10 ** digits
  return Math.round((finiteNumber(value) + Number.EPSILON) * factor) / factor
}

const firstPresent = (...values) =>
  values.find(value => value !== null && value !== undefined && String(value).trim() !== '')

/**
 * Tính số phút trùng lặp giữa khoảng thời gian có mặt và khung giờ làm việc.
 */
export const calculateOverlapMinutes = (actualStart, actualEnd, shiftStart, shiftEnd) => {
  if (
    actualStart === null || actualStart === undefined ||
    actualEnd === null || actualEnd === undefined ||
    shiftStart === null || shiftStart === undefined ||
    shiftEnd === null || shiftEnd === undefined
  ) return 0

  const start = Math.max(actualStart, shiftStart)
  const end = Math.min(actualEnd, shiftEnd)
  return end > start ? end - start : 0
}

/**
 * Giờ vào sớm hơn giờ bắt đầu làm (workStart) được tự động quy về workStart.
 */
export const calculateEffectiveCheckIn = (checkIn, workStart = DEFAULT_ATTENDANCE_SETTINGS.workStart) => {
  const inMinutes = attendanceTimeToMinutes(checkIn)
  const workStartMinutes = attendanceTimeToMinutes(workStart)
  if (inMinutes === null) return null
  if (workStartMinutes === null) return checkIn
  return inMinutes < workStartMinutes ? workStart : checkIn
}

/**
 * Tính số phút làm việc công thường theo 2 khoảng:
 * - Khoảng sáng: workStart → lunchStart
 * - Khoảng chiều: lunchEnd → workEnd
 * Khoảng nghỉ trưa (lunchStart → lunchEnd) không tính công.
 */
export const calculateRegularMinutes = ({
  checkIn,
  checkOut,
  workStart = DEFAULT_ATTENDANCE_SETTINGS.workStart,
  lunchStart = DEFAULT_ATTENDANCE_SETTINGS.lunchStart,
  lunchEnd = DEFAULT_ATTENDANCE_SETTINGS.lunchEnd,
  workEnd = DEFAULT_ATTENDANCE_SETTINGS.workEnd
} = {}) => {
  const effectiveIn = calculateEffectiveCheckIn(checkIn, workStart)
  const effectiveInMinutes = attendanceTimeToMinutes(effectiveIn)
  const outMinutes = attendanceTimeToMinutes(checkOut)
  if (effectiveInMinutes === null || outMinutes === null) return 0
  if (outMinutes <= effectiveInMinutes) return 0

  const startMins = attendanceTimeToMinutes(workStart)
  const lunchStartMins = attendanceTimeToMinutes(lunchStart)
  const lunchEndMins = attendanceTimeToMinutes(lunchEnd)
  const endMins = attendanceTimeToMinutes(workEnd)

  const morningMinutes = calculateOverlapMinutes(
    effectiveInMinutes,
    outMinutes,
    startMins,
    lunchStartMins
  )

  const afternoonMinutes = calculateOverlapMinutes(
    effectiveInMinutes,
    outMinutes,
    lunchEndMins,
    endMins
  )

  return morningMinutes + afternoonMinutes
}

/**
 * Tăng ca tự động chỉ tính phần sau giờ kết thúc làm việc (workEnd).
 */
export const calculateAutomaticOvertime = ({
  checkIn,
  checkOut,
  workEnd = DEFAULT_ATTENDANCE_SETTINGS.workEnd
} = {}) => {
  const inMinutes = attendanceTimeToMinutes(checkIn)
  const outMinutes = attendanceTimeToMinutes(checkOut)
  const workEndMinutes = attendanceTimeToMinutes(workEnd)
  if (inMinutes === null || outMinutes === null || workEndMinutes === null) return 0
  if (outMinutes <= inMinutes) return 0

  const otStartMinutes = Math.max(inMinutes, workEndMinutes)
  if (outMinutes > otStartMinutes) {
    return (outMinutes - otStartMinutes) / 60
  }
  return 0
}

/**
 * Tính số phút giữa cặp Vào/Ra. Ca đêm được nối sang ngày kế tiếp thay vì
 * tạo số âm. `breakMinutes` chỉ được trừ khi được cấu hình rõ ràng; mặc định
 * dữ liệu chấm công được tính đúng theo chênh lệch Vào → Ra.
 */
export const calculateWorkedMinutes = ({
  checkIn,
  checkOut,
  breakMinutes = 0
} = {}) => {
  const inMinutes = attendanceTimeToMinutes(checkIn)
  const outMinutes = attendanceTimeToMinutes(checkOut)
  if (inMinutes === null || outMinutes === null) return null

  let elapsed = outMinutes - inMinutes
  if (elapsed < 0) elapsed += 24 * 60
  if (elapsed <= 0) return 0

  const unpaidBreak = Math.max(0, finiteNumber(breakMinutes))
  return Math.max(0, elapsed - unpaidBreak)
}

const manualOvertimeHours = log => {
  const fields = ['tc1', 'tc2', 'tc3']
  const hasManualValue = fields.some(field =>
    log && log[field] !== null && log[field] !== undefined &&
    String(log[field]).trim() !== '' && finiteNumber(log[field]) > 0
  )
  if (!hasManualValue) return { hasValue: false, hours: 0 }

  return {
    hasValue: true,
    hours: Math.max(0, fields.reduce((total, field) => total + finiteNumber(log[field]), 0))
  }
}

const punchInterval = pair => {
  const start = attendanceTimeToMinutes(pair?.checkIn)
  const rawEnd = attendanceTimeToMinutes(pair?.checkOut)
  if (start === null || rawEnd === null) return null
  const end = rawEnd < start ? rawEnd + 24 * 60 : rawEnd
  return end > start ? { start, end, minutes: end - start } : null
}

const sessionInterval = session => {
  const start = attendanceTimeToMinutes(session?.start)
  const rawEnd = attendanceTimeToMinutes(session?.end)
  if (start === null || rawEnd === null) return null
  const end = rawEnd < start ? rawEnd + 24 * 60 : rawEnd
  return end > start ? { start, end, minutes: end - start } : null
}

const coveredMinutes = (intervals, session) => {
  const clipped = intervals
    .map(interval => ({
      start: Math.max(interval.start, session.start),
      end: Math.min(interval.end, session.end)
    }))
    .filter(interval => interval.end > interval.start)
    .sort((left, right) => left.start - right.start)

  let total = 0
  let end = -Infinity
  clipped.forEach(interval => {
    total += Math.max(0, interval.end - Math.max(interval.start, end))
    end = Math.max(end, interval.end)
  })
  return total
}

const normalizePunchPairs = punchPairs => (punchPairs || [])
  .map(pair => ({
    checkIn: firstPresent(pair?.checkIn),
    checkOut: firstPresent(pair?.checkOut)
  }))
  .filter(pair => pair.checkIn || pair.checkOut)

const buildSplitSessions = splitShift => [
  { key: 'morning', label: 'Buổi sáng', ...splitShift?.morning },
  { key: 'afternoon', label: 'Buổi chiều', ...splitShift?.afternoon }
].map(session => ({
  ...session,
  interval: sessionInterval(session),
  workdays: Math.min(1, Math.max(0, finiteNumber(session.workdays, 0.5)))
}))

const calculatePartialSplitSpanWork = ({
  punchPairs = [],
  splitShift
} = {}) => {
  if (!splitShift?.enabled) return null

  const pairs = normalizePunchPairs(punchPairs)
  const hasIncompletePair = pairs.some(pair => Boolean(pair.checkIn) !== Boolean(pair.checkOut))
  if (!hasIncompletePair) return null

  const checkIn = pairs.find(pair => pair.checkIn)?.checkIn
  const checkOut = [...pairs].reverse().find(pair => pair.checkOut)?.checkOut
  if (!checkIn || !checkOut) return null

  return calculateSplitShiftWork({
    punchPairs: [{ checkIn, checkOut }],
    splitShift
  })
}

export const calculateSplitShiftWork = ({ punchPairs = [], splitShift } = {}) => {
  if (!splitShift?.enabled) return null
  const rawPairs = normalizePunchPairs(punchPairs)
  if (rawPairs.some(pair => Boolean(pair.checkIn) !== Boolean(pair.checkOut))) return null

  const sessions = buildSplitSessions(splitShift)
  if (sessions.some(session => !session.interval)) return null

  const pairs = rawPairs.map(punchInterval).filter(Boolean)
  if (!pairs.length) return null
  const breakdown = sessions.map(session => {
    const creditedMinutes = coveredMinutes(pairs, session.interval)
    return {
      key: session.key,
      label: session.label,
      minutes: creditedMinutes,
      workdays: creditedMinutes / session.interval.minutes * session.workdays
    }
  })

  return {
    workedMinutes: breakdown.reduce((total, session) => total + session.minutes, 0),
    regularWorkdays: breakdown.reduce((total, session) => total + session.workdays, 0),
    breakdown
  }
}

const minuteOnShiftDay = (value, shiftStart, overnight) => {
  const minute = attendanceTimeToMinutes(value)
  return minute !== null && overnight && minute < shiftStart ? minute + 1440 : minute
}

const roundOvertime = (minutes, policy) => {
  if (minutes < policy.overtimeMinMinutes) return 0
  const block = policy.overtimeRoundingMinutes
  return { floor: Math.floor, ceil: Math.ceil, nearest: Math.round }[policy.overtimeRoundMode](minutes / block) * block
}

const importedWorkUnit = (log, standard, shiftWorkUnit, policy) => {
  const rawWorkUnit = log.importedWorkUnit ?? log.cong ?? log.workUnit
  const workUnit = rawWorkUnit === null || rawWorkUnit === undefined || rawWorkUnit === ''
    ? NaN : Number(rawWorkUnit)
  if ((policy.importPriorityMode === 'imported_work_unit' || policy.workUnitCalculationMode === 'imported') &&
    Number.isFinite(workUnit)) return workUnit
  const rawHours = log.importedHours ?? log.hours ?? log.soGio ?? log.gio
  const hours = rawHours === null || rawHours === undefined || rawHours === '' ? NaN : Number(rawHours)
  if (policy.importPriorityMode === 'imported_hours') {
    return Number.isFinite(hours) ? hours * 60 / standard * shiftWorkUnit : null
  }
  if (['source-value', 'matrix-value'].includes(log.calculationMode) && Number.isFinite(workUnit)) return workUnit
  return null
}

/**
 * Tính Công/Giờ/Tăng ca cho một bản ghi.
 *
 * Mô hình mới:
 * - Giờ làm việc và giờ nghỉ trưa được cấu hình trong Cài đặt theo từng công ty.
 * - Giờ vào sớm hơn workStart được tự động quy về workStart (effectiveCheckIn).
 * - Giờ nghỉ trưa (lunchStart → lunchEnd) không tính công.
 * - Tăng ca tự động chỉ tính phần thời gian sau giờ kết thúc làm việc (workEnd).
 * - Ưu tiên tăng ca thủ công (TC1/TC2/TC3) nếu có.
 * - Ngày chỉ có 1 lần chấm (thiếu checkOut) giữ nguyên trạng thái thiếu (0 công), không tự suy luận checkOut.
 */
export const calculateAttendanceMetrics = ({
  log = {},
  checkIn = firstPresent(log.checkIn, log.vao),
  checkOut = firstPresent(log.checkOut, log.ra),
  attendanceSettings = {},
  standardMinutes,
  breakMinutes,
  autoCalculateOvertime = true,
  punchPairs = log.punchPairs,
  splitShift,
  shift,
  fallbackHours,
  fallbackWorkdays
} = {}) => {
  const resolvedSettings = normalizeAttendanceShiftSettings(attendanceSettings)
  const configuredShift = shift && Object.values(resolvedSettings.shiftDefinitions).find(item =>
    item.name === shift.name || (item.start === shift.start && item.end === shift.end))
  const selectedShift = shift ? { ...configuredShift, ...shift } :
    (log.shiftId && resolvedSettings.shiftDefinitions[log.shiftId]) || null
  const shiftStart = selectedShift?.start || resolvedSettings.workStart
  const shiftEnd = selectedShift?.end || resolvedSettings.workEnd
  const startMinute = attendanceTimeToMinutes(shiftStart)
  const rawEndMinute = attendanceTimeToMinutes(shiftEnd)
  const overnight = startMinute !== null && rawEndMinute !== null && rawEndMinute <= startMinute
  const overnightAllowed = resolvedSettings.allowOvernightShift || selectedShift?.allowOvernightShift === true
  const endMinute = overnight ? rawEndMinute + 1440 : rawEndMinute
  const standard = Number(selectedShift?.standardWorkMinutes) > 0 ? Number(selectedShift.standardWorkMinutes)
    : Number(standardMinutes) > 0 ? Number(standardMinutes)
      : resolvedSettings.standardWorkMinutes
  const shiftWorkUnit = Number(selectedShift?.workUnit) > 0 ? Number(selectedShift.workUnit) : resolvedSettings.standardWorkUnit
  const resolvedPunchPairs = normalizePunchPairs(punchPairs)
  if (!resolvedPunchPairs.length && (checkIn || checkOut)) resolvedPunchPairs.push({ checkIn, checkOut })
  const completePairs = resolvedPunchPairs.map(pair => {
    const start = minuteOnShiftDay(pair.checkIn, startMinute, overnight && overnightAllowed)
    const end = minuteOnShiftDay(pair.checkOut, startMinute, overnight && overnightAllowed)
    return start !== null && end !== null && end > start ? { start, end, minutes: end - start } : null
  }).filter(Boolean)
  const pairCountSatisfied = completePairs.length >= resolvedSettings.requiredPunchPairs
  const missingPolicy = resolvedSettings.missingPunchPolicy
  if (!pairCountSatisfied && missingPolicy === 'use_first_last') {
    const first = resolvedPunchPairs.find(pair => pair.checkIn)?.checkIn
    const last = [...resolvedPunchPairs].reverse().find(pair => pair.checkOut)?.checkOut
    const start = minuteOnShiftDay(first, startMinute, overnight && overnightAllowed)
    const end = minuteOnShiftDay(last, startMinute, overnight && overnightAllowed)
    if (start !== null && end !== null && end > start) completePairs.splice(0, completePairs.length, { start, end, minutes: end - start })
  }
  const usablePairs = (overnight && !overnightAllowed) || (!pairCountSatisfied && !['partial', 'use_first_last'].includes(missingPolicy))
    ? [] : completePairs
  const hasValidPair = usablePairs.length > 0

  const manual = manualOvertimeHours(log)
  const sourceHours = finiteNumber(
    firstPresent(fallbackHours, log.hours, log.soGio, log.gio),
    0
  )
  const sourceWorkUnit = importedWorkUnit(log, standard, shiftWorkUnit, resolvedSettings)
  const hasAnyPunch = resolvedPunchPairs.some(pair => pair.checkIn || pair.checkOut)

  if (!hasValidPair) {
    const allowSource = (!hasAnyPunch || resolvedSettings.importPriorityMode !== 'raw_punch' ||
      resolvedSettings.workUnitCalculationMode === 'imported') && missingPolicy !== 'manual_review'
    const sourceWorkdays = allowSource
      ? (sourceWorkUnit ?? (fallbackWorkdays !== undefined && fallbackWorkdays !== null
        ? Math.max(0, finiteNumber(fallbackWorkdays))
        : Math.max(0, sourceHours * 60) / standard * shiftWorkUnit))
      : 0
    const creditedMinutes = allowSource ? Math.max(0, sourceHours * 60) : 0
    return {
      hasPunchPair: false,
      effectiveCheckIn: null,
      checkIn: checkIn || null,
      checkOut: checkOut || null,
      workedMinutes: creditedMinutes,
      paidMinutes: creditedMinutes,
      regularMinutes: Math.min(creditedMinutes, standard),
      overtimeMinutes: manual.hasValue ? manual.hours * 60 : 0,
      hours: creditedMinutes / 60,
      regularWorkdays: Math.min(resolvedSettings.maxWorkUnitPerDay, sourceWorkdays),
      overtimeHours: manual.hasValue ? manual.hours : 0,
      overtimeSource: manual.hasValue ? 'manual' : 'none',
      standardWorkMinutes: standard,
      calculationMode: 'source-value',
      requiresManualReview: missingPolicy === 'manual_review' && hasAnyPunch
    }
  }

  const configuredSplit = !attendanceSettings?.workUnitCalculationMode ||
    resolvedSettings.workUnitCalculationMode === 'split_shift'
    ? (splitShift || selectedShift?.splitShift) : null
  const splitMetrics = configuredSplit?.enabled
    ? (calculatePartialSplitSpanWork({ punchPairs: resolvedPunchPairs, splitShift: configuredSplit }) ||
       calculateSplitShiftWork({ punchPairs: resolvedPunchPairs, splitShift: configuredSplit }))
    : null

  const effectiveCheckIn = calculateEffectiveCheckIn(checkIn, shiftStart)
  const shiftInterval = { start: startMinute, end: endMinute }
  const presenceIntervals = usablePairs.map(pair => ({
    start: Math.max(pair.start, startMinute), end: Math.min(pair.end, endMinute)
  })).filter(pair => pair.end > pair.start)
  const shiftMinutes = coveredMinutes(presenceIntervals, shiftInterval)
  const useGlobalLunch = !selectedShift || (shiftStart === resolvedSettings.workStart && shiftEnd === resolvedSettings.workEnd)
  const lunchStart = selectedShift?.lunchStart || (useGlobalLunch ? resolvedSettings.lunchStart : null)
  const lunchEnd = selectedShift?.lunchEnd || (useGlobalLunch ? resolvedSettings.lunchEnd : null)
  const lunchFrom = minuteOnShiftDay(lunchStart, startMinute, overnight && overnightAllowed)
  const lunchTo = minuteOnShiftDay(lunchEnd, startMinute, overnight && overnightAllowed)
  const lunchDuration = lunchFrom !== null && lunchTo !== null && lunchTo > lunchFrom ? lunchTo - lunchFrom : 0
  const lunchMinutes = lunchDuration ? coveredMinutes(presenceIntervals, { start: lunchFrom, end: lunchTo }) : 0
  const configuredBreak = Number(selectedShift?.unpaidBreakMinutes ?? breakMinutes ?? resolvedSettings.unpaidBreakMinutes)
  const splitGap = configuredSplit?.enabled
    ? Math.max(0, (attendanceTimeToMinutes(configuredSplit.afternoon?.start) ?? 0) -
      (attendanceTimeToMinutes(configuredSplit.morning?.end) ?? 0)) : 0
  const extraBreak = Math.max(0, configuredBreak - Math.max(lunchDuration, splitGap))
  const regularMinutes = splitMetrics ? Math.max(0, splitMetrics.workedMinutes - Math.min(extraBreak, splitMetrics.workedMinutes))
    : Math.max(0, shiftMinutes - lunchMinutes - Math.min(extraBreak, shiftMinutes - lunchMinutes))

  const automaticAllowed = autoCalculateOvertime && resolvedSettings.overtimeEnabled && !log.overtimeAutoDisabled
  const overtimeStart = resolvedSettings.overtimeStart === 'shift_end' ? endMinute
    : minuteOnShiftDay(resolvedSettings.overtimeStart, startMinute, overnight && overnightAllowed)
  const lastEnd = Math.max(...usablePairs.map(pair => pair.end))
  const autoOvertimeMinutes = automaticAllowed && overtimeStart !== null
    ? roundOvertime(Math.max(0, lastEnd - overtimeStart), resolvedSettings) : 0

  const overtimeHours = manual.hasValue
    ? manual.hours
    : autoOvertimeMinutes / 60

  const calculatedWorkdays = splitMetrics
    ? splitMetrics.regularWorkdays * (splitMetrics.workedMinutes > 0 ? regularMinutes / splitMetrics.workedMinutes : 0)
    : resolvedSettings.workUnitCalculationMode === 'fixed_shift'
      ? (regularMinutes >= standard ? shiftWorkUnit : 0)
      : regularMinutes / standard * shiftWorkUnit
  const imported = sourceWorkUnit !== null && (resolvedSettings.workUnitCalculationMode === 'imported' ||
    resolvedSettings.importPriorityMode !== 'raw_punch')
  const regularWorkdays = Math.min(resolvedSettings.maxWorkUnitPerDay, Math.max(0,
    imported ? sourceWorkUnit : calculatedWorkdays))
  const workedMinutes = regularMinutes

  return {
    hasPunchPair: true,
    effectiveCheckIn,
    checkIn,
    checkOut,
    workedMinutes,
    paidMinutes: regularMinutes,
    regularMinutes,
    overtimeMinutes: overtimeHours * 60,
    hours: regularMinutes / 60,
    regularWorkdays,
    overtimeHours,
    overtimeSource: manual.hasValue ? 'manual' : automaticAllowed ? 'automatic' : 'disabled',
    standardWorkMinutes: standard,
    calculationMode: imported ? 'source-value' : splitMetrics ? 'split-shift' : 'schedule',
    splitShiftBreakdown: splitMetrics?.breakdown || []
  }
}

export const getAttendanceHoliday = (date, attendanceSettings = {}) => {
  const dateKey = String(date || '').slice(0, 10)
  if (!dateKey) return null
  const holidays = Array.isArray(attendanceSettings?.holidays)
    ? attendanceSettings.holidays
    : []
  return holidays
    .map(item => {
      if (typeof item === 'string') return { date: item.slice(0, 10), name: '' }
      return {
        date: String(item?.date || item?.day || '').slice(0, 10),
        name: String(item?.name || item?.label || '').trim()
      }
    })
    .find(item => item.date === dateKey) || null
}

/**
 * Mô tả công thức công ngày để hiện tooltip / chú thích trên bảng ma trận.
 */
export const describeDayWorkFormula = (day = {}, {
  standardMinutes,
  displayCode = '',
  attendanceSettings = {}
} = {}) => {
  const code = String(displayCode || '').trim().toUpperCase()
  const settings = normalizeAttendanceShiftSettings(attendanceSettings)
  const standard = Math.max(1, finiteNumber(standardMinutes, settings.standardWorkMinutes))
  const checkIn = String(day.checkIn || day.vao || '').trim()
  const checkOut = String(day.checkOut || day.ra || '').trim()
  const regularMinutes = day.regularMinutes !== undefined
    ? finiteNumber(day.regularMinutes)
    : finiteNumber(day.workedMinutes, checkIn && checkOut ? calculateRegularMinutes({ checkIn, checkOut, ...settings }) : finiteNumber(day.hoursExact ?? day.hours) * 60)
  const workdays = finiteNumber(day.workdaysExact ?? day.workdays)
  const holidayLabel = day.holidayName
    ? `Ngày lễ: ${day.holidayName}`
    : (day.isHoliday ? 'Ngày lễ' : '')

  if (day.manualOverride) {
    return `Chỉnh tay: ${roundDecimal(workdays)} công`
  }

  if (code === 'P1' || code === 'P' || finiteNumber(day.paidLeaveWorkdays) > 0) {
    const leave = finiteNumber(day.paidLeaveWorkdays, workdays || 1)
    return `Phép (P1) = ${roundDecimal(leave)} công${holidayLabel ? ` · ${holidayLabel}` : ''}`
  }

  if (day.calculationMode === 'split-shift' && Array.isArray(day.splitShiftBreakdown)) {
    const sessions = day.splitShiftBreakdown.filter(session =>
      finiteNumber(session?.minutes) > 0 || finiteNumber(session?.workdays) > 0
    )
    if (sessions.length) {
      const details = sessions.map(session =>
        `${session.label || 'Buổi'} ${Math.round(finiteNumber(session.minutes))}p = ${roundDecimal(session.workdays)} công`
      )
      return `Chia 2 buổi: ${details.join(' · ')} · Tổng ${roundDecimal(workdays)} công${holidayLabel ? ` · ${holidayLabel}` : ''}`
    }
    return `Ngoài khung giờ hai buổi = 0 công${holidayLabel ? ` · ${holidayLabel}` : ''}`
  }

  if (holidayLabel && workdays <= 0 && !checkIn && !checkOut) {
    return `${holidayLabel} — không tự tính công`
  }

  if (checkIn && checkOut) {
    const cong = roundDecimal(workdays, 4)
    const unitDetail = settings.standardWorkUnit === 1 && settings.maxWorkUnitPerDay === 1
      ? '' : ` × ${settings.standardWorkUnit} (tối đa ${settings.maxWorkUnitPerDay})`
    const effectiveIn = day.effectiveCheckIn || calculateEffectiveCheckIn(checkIn, settings.workStart)
    const inPart = effectiveIn && effectiveIn !== checkIn ? `${checkIn} (quy về ${effectiveIn})→${checkOut}` : `${checkIn}→${checkOut}`
    const parts = [
      `${inPart}`,
      `Công chuẩn: ${Math.round(regularMinutes)}p ÷ ${standard}p${unitDetail} = ${roundDecimal(cong)} công`
    ]
    if (finiteNumber(day.overtimeHours) > 0) {
      parts.push(`Tăng ca: ${roundDecimal(day.overtimeHours)}h`)
    }
    if (holidayLabel) parts.push(holidayLabel)
    return parts.join(' · ')
  }

  const hours = finiteNumber(day.hoursExact ?? day.hours)
  if (hours > 0) {
    const cong = roundDecimal(workdays, 4)
    return `Giờ nguồn ${roundDecimal(hours)}h ÷ ${standard / 60}h = ${roundDecimal(cong)} công${holidayLabel ? ` · ${holidayLabel}` : ''}`
  }

  if (workdays > 0) {
    return `Công nguồn = ${roundDecimal(workdays)}${holidayLabel ? ` · ${holidayLabel}` : ''}`
  }

  return holidayLabel || ''
}
