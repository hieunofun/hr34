import { normalizeString } from './helpers.js'

/**
 * Cấu hình chấm công mặc định tập trung duy nhất của toàn hệ thống.
 * Không hard-code các mốc giờ này ở các function tính toán khác.
 */
export const DEFAULT_ATTENDANCE_SETTINGS = Object.freeze({
  workStart: '07:00',
  lunchStart: '11:00',
  lunchEnd: '13:00',
  workEnd: '17:00'
})

export const DEFAULT_ATTENDANCE_SHIFT = Object.freeze({
  name: 'Ca Hành chính',
  start: DEFAULT_ATTENDANCE_SETTINGS.workStart,
  end: DEFAULT_ATTENDANCE_SETTINGS.workEnd
})

export const SALE_ATTENDANCE_SHIFT = Object.freeze({
  name: 'Ca Sáng Sale',
  start: '04:00',
  end: '13:30'
})

export const DEFAULT_ATTENDANCE_POLICY = Object.freeze({
  standardWorkMinutes: 480,
  monthlyStandardWorkUnits: 26,
  standardWorkUnit: 1,
  maxWorkUnitPerDay: 1,
  requiredPunchPairs: 1,
  missingPunchPolicy: 'zero',
  lateGraceMinutes: 0,
  earlyLeaveGraceMinutes: 0,
  latePenaltyThresholdMinutes: 30,
  overtimeEnabled: true,
  overtimeStart: 'shift_end',
  overtimeMinMinutes: 0,
  overtimeRoundingMinutes: 1,
  overtimeRoundMode: 'floor',
  workUnitCalculationMode: 'proportional',
  allowOvernightShift: false,
  importPriorityMode: 'raw_punch',
  manualOverridePriority: 'highest',
  saleLatestAutoCheckIn: '06:30',
  policyVersion: 1
})

export const DEFAULT_ATTENDANCE_PENALTY_CATEGORIES = Object.freeze([
  { key: 'late_under_30', label: 'Muộn/sớm <30p', amount: 50000 },
  { key: 'late_over_30', label: 'Muộn/sớm ≥30p', amount: 100000 },
  { key: 'missing_punch', label: 'Quên chấm', amount: 50000 },
  { key: 'no_duty', label: 'Không trực nhật', amount: 50000 },
  { key: 'emergency_leave', label: 'Nghỉ đột xuất', amount: 100000 },
  { key: 'unapproved_absence', label: 'Nghỉ không phép', amount: 200000 },
  { key: 'drunk', label: 'Say xỉn', amount: 200000 },
  { key: 'other', label: 'Khác', amount: 0 }
])

const positiveNumber = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0
  ? Number(value) : fallback
const nonnegativeNumber = (value, fallback) => Number.isFinite(Number(value)) && Number(value) >= 0
  ? Number(value) : fallback
const choice = (value, allowed, fallback) => allowed.includes(value) ? value : fallback

export const ATTENDANCE_SHIFT_IDS = Object.freeze({
  ADMINISTRATIVE: 'administrative',
  SALE_MORNING: 'saleMorning'
})

const firstValue = (...values) =>
  values.find(value => value !== null && value !== undefined && String(value).trim() !== '')

export const validateAttendanceSettings = (settings = {}) => {
  const workStart = attendanceTimeToMinutes(settings?.workStart)
  const lunchStart = attendanceTimeToMinutes(settings?.lunchStart)
  const lunchEnd = attendanceTimeToMinutes(settings?.lunchEnd)
  const workEnd = attendanceTimeToMinutes(settings?.workEnd)

  if (workStart === null || lunchStart === null || lunchEnd === null || workEnd === null) {
    return {
      isValid: false,
      error: 'Vui lòng nhập đầy đủ các mốc: Giờ bắt đầu làm, Bắt đầu nghỉ trưa, Kết thúc nghỉ trưa, Kết thúc làm.'
    }
  }

  if (workStart >= lunchStart) {
    return {
      isValid: false,
      error: 'Giờ bắt đầu làm việc phải trước giờ bắt đầu nghỉ trưa.'
    }
  }

  if (lunchStart >= lunchEnd) {
    return {
      isValid: false,
      error: 'Giờ bắt đầu nghỉ trưa phải trước giờ kết thúc nghỉ trưa.'
    }
  }

  if (lunchEnd >= workEnd) {
    return {
      isValid: false,
      error: 'Giờ kết thúc nghỉ trưa phải trước giờ kết thúc làm việc.'
    }
  }

  return { isValid: true, error: '' }
}

const normalizeTime = value => {
  const text = String(value || '').trim()
  const meridiem = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP])\.?M\.?$/i)
  if (meridiem) {
    const rawHour = Number(meridiem[1])
    const minutes = Number(meridiem[2])
    if (rawHour < 1 || rawHour > 12 || minutes > 59) return ''
    const hours = (rawHour % 12) + (meridiem[3].toUpperCase() === 'P' ? 12 : 0)
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  }

  const match = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  if (!match) return ''
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return ''
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

const normalizeSessionWorkdays = (value, fallback = 0.5) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(1, Math.max(0, parsed))
}

const normalizeSplitShift = value => {
  const source = value && typeof value === 'object' ? value : {}
  const morning = source.morning && typeof source.morning === 'object' ? source.morning : {}
  const afternoon = source.afternoon && typeof source.afternoon === 'object' ? source.afternoon : {}
  return {
    enabled: source.enabled === true,
    morning: {
      start: normalizeTime(morning.start),
      end: normalizeTime(morning.end),
      workdays: normalizeSessionWorkdays(morning.workdays)
    },
    afternoon: {
      start: normalizeTime(afternoon.start),
      end: normalizeTime(afternoon.end),
      workdays: normalizeSessionWorkdays(afternoon.workdays)
    }
  }
}

const normalizeConfiguredShift = (id, value, fallback) => {
  const source = value && typeof value === 'object' ? value : {}
  return {
    id,
    name: source.name === undefined ? fallback.name : String(source.name).trim(),
    standardCheckIn: normalizeTime(source.standardCheckIn || source.start) || fallback.start,
    standardCheckOut: normalizeTime(source.standardCheckOut || source.end) || fallback.end,
    lunchStart: normalizeTime(source.lunchStart),
    lunchEnd: normalizeTime(source.lunchEnd),
    splitShift: normalizeSplitShift(source.splitShift || source.splitSessions),
    unpaidBreakMinutes: nonnegativeNumber(source.unpaidBreakMinutes, fallback.unpaidBreakMinutes ?? 0),
    standardWorkMinutes: positiveNumber(source.standardWorkMinutes, fallback.standardWorkMinutes ?? 0),
    workUnit: positiveNumber(source.workUnit, DEFAULT_ATTENDANCE_POLICY.standardWorkUnit),
    overtimeStart: source.overtimeStart === 'shift_end'
      ? 'shift_end' : (normalizeTime(source.overtimeStart) || null),
    allowOvernightShift: source.allowOvernightShift === true
  }
}

export const normalizeAttendancePolicy = (settings = {}) => {
  const source = settings && typeof settings === 'object' ? settings : {}

  const storedShifts = (source.shifts || source.shiftDefinitions) && typeof (source.shifts || source.shiftDefinitions) === 'object'
    ? (source.shifts || source.shiftDefinitions)
    : {}
  const findStoredShift = id => Array.isArray(storedShifts)
    ? storedShifts.find(shift => shift?.id === id)
    : storedShifts[id]
  const administrativeSource = findStoredShift(ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE)

  const rawWorkStart = normalizeTime(source.workStart || source.standardCheckIn || administrativeSource?.standardCheckIn)
  const rawLunchStart = normalizeTime(source.lunchStart)
  const rawLunchEnd = normalizeTime(source.lunchEnd)
  const rawWorkEnd = normalizeTime(source.workEnd || source.standardCheckOut || administrativeSource?.standardCheckOut)

  const candidateWorkStart = rawWorkStart || DEFAULT_ATTENDANCE_SETTINGS.workStart
  const candidateLunchStart = rawLunchStart || DEFAULT_ATTENDANCE_SETTINGS.lunchStart
  const candidateLunchEnd = rawLunchEnd || DEFAULT_ATTENDANCE_SETTINGS.lunchEnd
  const candidateWorkEnd = rawWorkEnd || DEFAULT_ATTENDANCE_SETTINGS.workEnd

  const validation = validateAttendanceSettings({
    workStart: candidateWorkStart,
    lunchStart: candidateLunchStart,
    lunchEnd: candidateLunchEnd,
    workEnd: candidateWorkEnd
  })

  const overnightSchedule = source.allowOvernightShift === true &&
    attendanceTimeToMinutes(candidateWorkEnd) < attendanceTimeToMinutes(candidateWorkStart)
  const scheduleValid = validation.isValid || overnightSchedule
  const workStart = scheduleValid ? candidateWorkStart : DEFAULT_ATTENDANCE_SETTINGS.workStart
  const lunchStart = scheduleValid ? candidateLunchStart : DEFAULT_ATTENDANCE_SETTINGS.lunchStart
  const lunchEnd = scheduleValid ? candidateLunchEnd : DEFAULT_ATTENDANCE_SETTINGS.lunchEnd
  const workEnd = scheduleValid ? candidateWorkEnd : DEFAULT_ATTENDANCE_SETTINGS.workEnd

  const startMins = attendanceTimeToMinutes(workStart) ?? attendanceTimeToMinutes(DEFAULT_ATTENDANCE_SETTINGS.workStart)
  const lunchStartMins = attendanceTimeToMinutes(lunchStart) ?? attendanceTimeToMinutes(DEFAULT_ATTENDANCE_SETTINGS.lunchStart)
  const lunchEndMins = attendanceTimeToMinutes(lunchEnd) ?? attendanceTimeToMinutes(DEFAULT_ATTENDANCE_SETTINGS.lunchEnd)
  const endMins = attendanceTimeToMinutes(workEnd) ?? attendanceTimeToMinutes(DEFAULT_ATTENDANCE_SETTINGS.workEnd)

  const adjustedEnd = endMins < startMins ? endMins + 1440 : endMins
  const adjustedLunchStart = lunchStartMins < startMins ? lunchStartMins + 1440 : lunchStartMins
  const adjustedLunchEnd = lunchEndMins < startMins ? lunchEndMins + 1440 : lunchEndMins
  const lunchDuration = adjustedLunchEnd - adjustedLunchStart
  const configuredBreakMinutes = Number(source.unpaidBreakMinutes ?? source.breakMinutes ?? lunchDuration)
  const unpaidBreakMinutes = Number.isFinite(configuredBreakMinutes) && configuredBreakMinutes >= 0
    ? Math.round(configuredBreakMinutes)
    : 0
  const morningMinutes = Math.max(0, adjustedLunchStart - startMins)
  const afternoonMinutes = Math.max(0, adjustedEnd - adjustedLunchEnd)
  const scheduledMinutes = morningMinutes + afternoonMinutes
  const dynamicStandardMinutes = Math.max(0, adjustedEnd - startMins - Math.max(lunchDuration, unpaidBreakMinutes))
  const standardWorkMinutes = positiveNumber(source.standardWorkMinutes,
    dynamicStandardMinutes > 0 ? dynamicStandardMinutes : DEFAULT_ATTENDANCE_POLICY.standardWorkMinutes)

  const morningWorkdays = scheduledMinutes > 0 ? morningMinutes / scheduledMinutes : 0.5
  const afternoonWorkdays = scheduledMinutes > 0 ? afternoonMinutes / scheduledMinutes : 0.5

  // Tận dụng splitShift: tạo cấu hình 2 buổi chuẩn (sáng + chiều) tách giờ nghỉ trưa
  const defaultAdministrativeSplitShift = {
    enabled: false,
    morning: {
      start: workStart,
      end: lunchStart,
      workdays: morningWorkdays
    },
    afternoon: {
      start: lunchEnd,
      end: workEnd,
      workdays: afternoonWorkdays
    }
  }

  const administrativeSplit = administrativeSource?.splitShift || administrativeSource?.splitSessions || defaultAdministrativeSplitShift
  const legacyAdministrative = {
    name: 'Ca Hành chính',
    standardCheckIn: workStart,
    standardCheckOut: workEnd,
    ...administrativeSource,
    splitShift: {
      ...administrativeSplit,
      enabled: source.splitShiftEnabled ?? administrativeSplit.enabled,
      morning: { ...administrativeSplit.morning,
        workdays: source.morningWeight ?? administrativeSplit.morning?.workdays ?? morningWorkdays },
      afternoon: { ...administrativeSplit.afternoon,
        workdays: source.afternoonWeight ?? administrativeSplit.afternoon?.workdays ?? afternoonWorkdays }
    }
  }
  const additionalShifts = Object.fromEntries(
    (Array.isArray(storedShifts)
      ? storedShifts.filter(shift => shift?.id).map(shift => [shift.id, shift])
      : Object.entries(storedShifts))
      .filter(([id]) => !Object.values(ATTENDANCE_SHIFT_IDS).includes(id))
      .map(([id, shift]) => [id, normalizeConfiguredShift(id, shift, {
        name: String(shift?.name || id),
        start: '',
        end: ''
      })])
  )

  const overtimeSource = source.overtime && typeof source.overtime === 'object'
    ? source.overtime
    : {}
  const holidays = Array.isArray(source.holidays)
    ? source.holidays
      .map(item => {
        if (typeof item === 'string') return { date: item.slice(0, 10), name: '' }
        return {
          date: String(item?.date || item?.day || '').slice(0, 10),
          name: String(item?.name || item?.label || '').trim()
        }
      })
      .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item.date))
    : []

  const hasDeclaredShifts = Boolean(source.shifts || source.shiftDefinitions)
  const storedSaleShift = findStoredShift(ATTENDANCE_SHIFT_IDS.SALE_MORNING)
  const shifts = {
    [ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE]: normalizeConfiguredShift(
      ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE,
      { ...legacyAdministrative, standardWorkMinutes: source.standardWorkMinutes || legacyAdministrative.standardWorkMinutes,
        unpaidBreakMinutes: source.unpaidBreakMinutes ?? legacyAdministrative.unpaidBreakMinutes },
      { name: 'Ca Hành chính', start: workStart, end: workEnd,
        unpaidBreakMinutes, standardWorkMinutes }
    ),
    ...((storedSaleShift || !hasDeclaredShifts) ? {
      [ATTENDANCE_SHIFT_IDS.SALE_MORNING]: normalizeConfiguredShift(
        ATTENDANCE_SHIFT_IDS.SALE_MORNING,
        storedSaleShift,
        { ...SALE_ATTENDANCE_SHIFT, unpaidBreakMinutes: 30, standardWorkMinutes: 540 }
      )
    } : {}),
    ...additionalShifts
  }
  const shiftDefinitions = Object.fromEntries(Object.entries(shifts).map(([id, shift]) => [id, {
    ...shift,
    start: shift.standardCheckIn,
    end: shift.standardCheckOut
  }]))
  const penaltyRules = source.penaltyRules && typeof source.penaltyRules === 'object' ? source.penaltyRules : {}
  const latePenaltyThresholdMinutes = positiveNumber(source.latePenaltyThresholdMinutes ?? penaltyRules.latePenaltyThresholdMinutes,
    DEFAULT_ATTENDANCE_POLICY.latePenaltyThresholdMinutes)
  const defaultPenaltyCategories = DEFAULT_ATTENDANCE_PENALTY_CATEGORIES.map(item => ({
    ...item,
    label: item.key === 'late_under_30' ? `Muộn/sớm <${latePenaltyThresholdMinutes}p`
      : item.key === 'late_over_30' ? `Muộn/sớm ≥${latePenaltyThresholdMinutes}p` : item.label
  }))
  return {
    timezone: source.timezone || 'Asia/Ho_Chi_Minh',
    workStart,
    lunchStart,
    lunchEnd,
    workEnd,
    morningMinutes,
    afternoonMinutes,
    standardWorkMinutes,
    monthlyStandardWorkUnits: positiveNumber(source.monthlyStandardWorkUnits,
      DEFAULT_ATTENDANCE_POLICY.monthlyStandardWorkUnits),
    unpaidBreakMinutes,
    overtime: { autoCalculate: overtimeSource.autoCalculate !== false },
    standardWorkUnit: positiveNumber(source.standardWorkUnit, DEFAULT_ATTENDANCE_POLICY.standardWorkUnit),
    maxWorkUnitPerDay: positiveNumber(source.maxWorkUnitPerDay, DEFAULT_ATTENDANCE_POLICY.maxWorkUnitPerDay),
    requiredPunchPairs: Math.max(1, Math.floor(positiveNumber(source.requiredPunchPairs, DEFAULT_ATTENDANCE_POLICY.requiredPunchPairs))),
    missingPunchPolicy: choice(source.missingPunchPolicy, ['zero', 'partial', 'manual_review', 'use_first_last'], DEFAULT_ATTENDANCE_POLICY.missingPunchPolicy),
    lateGraceMinutes: nonnegativeNumber(source.lateGraceMinutes, 0),
    earlyLeaveGraceMinutes: nonnegativeNumber(source.earlyLeaveGraceMinutes, 0),
    latePenaltyThresholdMinutes,
    overtimeEnabled: source.overtimeEnabled !== false && overtimeSource.autoCalculate !== false,
    overtimeStart: source.overtimeStart || 'shift_end',
    overtimeMinMinutes: nonnegativeNumber(source.overtimeMinMinutes, 0),
    overtimeRoundingMinutes: positiveNumber(source.overtimeRoundingMinutes, 1),
    overtimeRoundMode: choice(source.overtimeRoundMode, ['floor', 'ceil', 'nearest'], 'floor'),
    workUnitCalculationMode: choice(source.workUnitCalculationMode, ['proportional', 'split_shift', 'fixed_shift', 'imported'],
      shifts.administrative.splitShift.enabled ? 'split_shift' : 'proportional'),
    splitShiftEnabled: source.splitShiftEnabled ?? shifts.administrative.splitShift.enabled,
    morningWeight: nonnegativeNumber(source.morningWeight, morningWorkdays),
    afternoonWeight: nonnegativeNumber(source.afternoonWeight, afternoonWorkdays),
    allowOvernightShift: source.allowOvernightShift === true,
    importPriorityMode: choice(source.importPriorityMode, ['raw_punch', 'imported_hours', 'imported_work_unit'], 'raw_punch'),
    manualOverridePriority: choice(source.manualOverridePriority, ['none', 'allowed', 'highest'], 'highest'),
    saleLatestAutoCheckIn: normalizeTime(source.saleLatestAutoCheckIn) || DEFAULT_ATTENDANCE_POLICY.saleLatestAutoCheckIn,
    penaltyRules: {
      latePenaltyThresholdMinutes,
      categories: penaltyRules.categories || source.penaltyCategories || defaultPenaltyCategories,
      emergencyLeaveFreeCount: nonnegativeNumber(penaltyRules.emergencyLeaveFreeCount, 2)
    },
    policyVersion: Math.max(1, Math.floor(positiveNumber(source.policyVersion, 1))),
    holidays,
    shifts,
    shiftDefinitions,
    standardCheckIn: workStart,
    standardCheckOut: workEnd
  }
}

export const normalizeAttendanceShiftSettings = normalizeAttendancePolicy

export const validateAttendancePolicy = (settings = {}) => {
  const policy = normalizeAttendancePolicy(settings)
  const fail = error => ({ isValid: false, error })
  const time = value => attendanceTimeToMinutes(value)
  for (const field of ['workStart', 'workEnd', 'lunchStart', 'lunchEnd']) {
    if (time(settings[field] ?? policy[field]) === null) return fail(`Giờ ${field} không hợp lệ.`)
  }
  const start = time(settings.workStart ?? policy.workStart)
  const end = time(settings.workEnd ?? policy.workEnd)
  const lunchStart = time(settings.lunchStart ?? policy.lunchStart)
  const lunchEnd = time(settings.lunchEnd ?? policy.lunchEnd)
  const overnight = end <= start
  if (overnight && !settings.allowOvernightShift) return fail('Ca qua đêm phải bật Cho phép ca qua đêm.')
  const shiftEnd = overnight ? end + 1440 : end
  const lunchFrom = overnight && lunchStart < start ? lunchStart + 1440 : lunchStart
  const lunchTo = overnight && lunchEnd < start ? lunchEnd + 1440 : lunchEnd
  if (!(start < lunchFrom && lunchFrom < lunchTo && lunchTo < shiftEnd)) {
    return fail('Giờ nghỉ phải nằm trong ca và có thứ tự bắt đầu trước kết thúc.')
  }
  if (!(Number(settings.standardWorkMinutes ?? policy.standardWorkMinutes) > 0) ||
    !(Number(settings.monthlyStandardWorkUnits ?? policy.monthlyStandardWorkUnits) > 0) ||
    !(Number(settings.standardWorkUnit ?? policy.standardWorkUnit) > 0) ||
    !(Number(settings.maxWorkUnitPerDay ?? policy.maxWorkUnitPerDay) > 0)) {
    return fail('Chuẩn phút công, công chuẩn tháng, công chuẩn ngày và công tối đa phải lớn hơn 0.')
  }
  if (!Number.isInteger(Number(settings.requiredPunchPairs ?? policy.requiredPunchPairs)) || Number(settings.requiredPunchPairs ?? policy.requiredPunchPairs) < 1) {
    return fail('Số cặp chấm công phải là số nguyên từ 1 trở lên.')
  }
  const breakValue = Number(settings.unpaidBreakMinutes ?? policy.unpaidBreakMinutes)
  if (!Number.isFinite(breakValue) || breakValue < 0 || breakValue >= shiftEnd - start) {
    return fail('Số phút nghỉ không tính công phải nhỏ hơn độ dài ca.')
  }
  const morningWeight = Number(settings.morningWeight ?? policy.morningWeight)
  const afternoonWeight = Number(settings.afternoonWeight ?? policy.afternoonWeight)
  if (!Number.isFinite(morningWeight) || !Number.isFinite(afternoonWeight) || morningWeight < 0 || afternoonWeight < 0 ||
    morningWeight + afternoonWeight > Number(settings.maxWorkUnitPerDay ?? policy.maxWorkUnitPerDay) + 1e-9) {
    return fail('Trọng số sáng/chiều không hợp lệ hoặc vượt số công tối đa mỗi ngày.')
  }
  if (settings.overtimeStart && settings.overtimeStart !== 'shift_end' && time(settings.overtimeStart) === null) return fail('Giờ bắt đầu tăng ca không hợp lệ.')
  if (!Number.isFinite(Number(settings.overtimeMinMinutes ?? policy.overtimeMinMinutes)) ||
    Number(settings.overtimeMinMinutes ?? policy.overtimeMinMinutes) < 0 ||
    !(Number(settings.overtimeRoundingMinutes ?? policy.overtimeRoundingMinutes) > 0)) {
    return fail('Thời gian tối thiểu hoặc bước làm tròn tăng ca không hợp lệ.')
  }
  const freeLeaveCount = Number(settings.penaltyRules?.emergencyLeaveFreeCount ?? policy.penaltyRules.emergencyLeaveFreeCount)
  if (!Number.isInteger(freeLeaveCount) || freeLeaveCount < 0) {
    return fail('Số lần nghỉ đột xuất miễn phạt phải là số nguyên từ 0 trở lên.')
  }
  const shifts = settings.shifts || settings.shiftDefinitions || policy.shifts
  const definitions = Array.isArray(shifts) ? shifts : Object.values(shifts)
  if ((settings.workUnitCalculationMode ?? policy.workUnitCalculationMode) === 'split_shift' &&
    !Object.values(policy.shifts).some(shift => shift.splitShift?.enabled)) {
    return fail('Chế độ chia buổi cần ít nhất một ca đã bật chia buổi.')
  }
  for (const shift of definitions) {
    const shiftStart = time(shift.standardCheckIn || shift.start)
    const shiftEndTime = time(shift.standardCheckOut || shift.end)
    if (!String(shift.name || shift.id || '').trim() || shiftStart === null || shiftEndTime === null || shiftStart === shiftEndTime) {
      return fail(`Ca ${shift.name || shift.id || 'mới'} cần tên và hai giờ vào/ra hợp lệ, khác nhau.`)
    }
    if (shiftEndTime < shiftStart && !(shift.allowOvernightShift || settings.allowOvernightShift)) {
      return fail(`Ca ${shift.name || shift.id} qua đêm phải bật Cho phép ca qua đêm.`)
    }
    if (shift.standardWorkMinutes !== undefined && !(Number(shift.standardWorkMinutes) > 0)) return fail(`Chuẩn công của ca ${shift.name || shift.id} phải lớn hơn 0.`)
    if (shift.overtimeStart && shift.overtimeStart !== 'shift_end' && time(shift.overtimeStart) === null) {
      return fail(`Giờ bắt đầu tăng ca của ca ${shift.name || shift.id} không hợp lệ.`)
    }
    if (shift.workUnit !== undefined && !(Number(shift.workUnit) > 0)) return fail(`Công đủ ca ${shift.name || shift.id} phải lớn hơn 0.`)
    if (shift.unpaidBreakMinutes !== undefined && (!Number.isFinite(Number(shift.unpaidBreakMinutes)) || Number(shift.unpaidBreakMinutes) < 0)) return fail(`Phút nghỉ của ca ${shift.name || shift.id} không hợp lệ.`)
    const shiftDuration = (shiftEndTime < shiftStart ? shiftEndTime + 1440 : shiftEndTime) - shiftStart
    if (Number(shift.unpaidBreakMinutes || 0) >= shiftDuration) return fail(`Phút nghỉ của ca ${shift.name || shift.id} phải nhỏ hơn độ dài ca.`)
    if (shift.lunchStart || shift.lunchEnd) {
      const lunchStartTime = time(shift.lunchStart)
      const lunchEndTime = time(shift.lunchEnd)
      const lunchFrom = lunchStartTime !== null && shiftEndTime < shiftStart && lunchStartTime < shiftStart
        ? lunchStartTime + 1440 : lunchStartTime
      const lunchTo = lunchEndTime !== null && shiftEndTime < shiftStart && lunchEndTime < shiftStart
        ? lunchEndTime + 1440 : lunchEndTime
      if (lunchFrom === null || lunchTo === null || lunchFrom < shiftStart || lunchTo > shiftStart + shiftDuration || lunchFrom >= lunchTo) {
        return fail(`Giờ nghỉ của ca ${shift.name || shift.id} phải nằm đúng trong ca.`)
      }
    }
    const split = shift.splitShift || shift.splitSessions
    if (split?.enabled) {
      if (shiftEndTime < shiftStart) return fail(`Ca ${shift.name || shift.id} qua đêm chưa hỗ trợ chia hai buổi; hãy tắt chia buổi.`)
      const sessions = [split.morning, split.afternoon]
      if (sessions.some(session => time(session?.start) === null || time(session?.end) === null || time(session.start) >= time(session.end) || Number(session.workdays) <= 0)) {
        return fail(`Giờ hoặc trọng số chia buổi của ca ${shift.name || shift.id} không hợp lệ.`)
      }
      if (time(sessions[0].start) < shiftStart || time(sessions[1].end) > shiftEndTime ||
        time(sessions[0].end) > time(sessions[1].start) ||
        Number(sessions[0].workdays) + Number(sessions[1].workdays) > Number(settings.maxWorkUnitPerDay ?? policy.maxWorkUnitPerDay) + 1e-9) {
        return fail(`Hai buổi của ca ${shift.name || shift.id} chồng lấn hoặc vượt công tối đa.`)
      }
    }
  }
  return { isValid: true, error: '' }
}

export const getAttendanceShiftOptions = settings =>
  Object.values(normalizeAttendanceShiftSettings(settings).shifts)

export const normalizeAttendanceShiftName = value => {
  const name = normalizeString(String(value || '').replace(/\s+/g, ' '))
  const numberedShift = name.match(/^ca\s*0*(\d+)$/)
  return numberedShift ? `ca ${Number(numberedShift[1])}` : name
}

export const findMissingAttendanceShifts = (logs, settings, skippedSourceKeys = new Set()) => {
  const configuredNames = new Set(getAttendanceShiftOptions(settings)
    .map(shift => normalizeAttendanceShiftName(shift.name)))
  return [...new Set((logs || [])
    .filter(log => log.importFormat === 'deoca-punch' &&
      !skippedSourceKeys.has(log._sourceEmployeeKey))
    .map(log => String(log.shiftName || '').trim().replace(/\s+/g, ' '))
    .filter(name => name && !configuredNames.has(normalizeAttendanceShiftName(name))))]
}

export const buildAttendanceShiftSettingsPayload = settings => {
  const normalized = normalizeAttendanceShiftSettings(settings)
  return {
    ...normalized,
    penaltyCategories: normalized.penaltyRules.categories,
    standardCheckIn: normalized.workStart,
    standardCheckOut: normalized.workEnd
  }
}

const shiftFromConfiguration = (shift, settings) => {
  const configured = normalizeAttendanceShiftSettings(settings).shifts[shift]
  return configured
    ? {
        name: configured.name,
        start: configured.standardCheckIn,
        end: configured.standardCheckOut,
        ...(configured.splitShift?.enabled ? { splitShift: configured.splitShift } : {})
      }
    : null
}

const configuredShiftFromName = (value, settings) => {
  const normalizedName = normalizeAttendanceShiftName(value)
  if (!normalizedName) return null
  const configured = normalizeAttendanceShiftSettings(settings).shifts

  const exact = Object.values(configured).find(shift =>
    normalizeAttendanceShiftName(shift.id) === normalizedName ||
    normalizeAttendanceShiftName(shift.name) === normalizedName
  )
  if (exact) {
    return {
      name: exact.name,
      start: exact.standardCheckIn,
      end: exact.standardCheckOut,
      ...(exact.splitShift?.enabled ? { splitShift: exact.splitShift } : {})
    }
  }

  if (/\b(sale|sales)\b/.test(normalizedName) || normalizedName.includes('kinh doanh')) {
    return shiftFromConfiguration(ATTENDANCE_SHIFT_IDS.SALE_MORNING, settings)
  }
  if (['ca hanh chinh', 'hanh chinh', 'ca full', 'ca ngay', 'ngay'].includes(normalizedName)) {
    return shiftFromConfiguration(ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE, settings)
  }
  return null
}

const exactShiftFromConfiguration = (value, settings) => {
  const name = normalizeAttendanceShiftName(value)
  if (!name) return null
  const match = Object.values(normalizeAttendanceShiftSettings(settings).shifts).find(shift =>
    normalizeAttendanceShiftName(shift.id) === name || normalizeAttendanceShiftName(shift.name) === name)
  return match ? shiftFromConfiguration(match.id, settings) : null
}

const attachConfiguredSplitShift = (shift, sourceName, settings) => {
  const namedShift = configuredShiftFromName(sourceName, settings)
  const matchedShift = namedShift || Object.values(
    normalizeAttendanceShiftSettings(settings).shifts
  ).find(configured =>
    configured.standardCheckIn === shift.start &&
    configured.standardCheckOut === shift.end
  )

  return matchedShift?.splitShift?.enabled
    ? { ...shift, splitShift: matchedShift.splitShift }
    : shift
}

const rangeFromText = value => {
  const match = String(value || '').match(
    /(\d{1,2}:\d{2})\s*(?:-|–|—|đến|tới)\s*(\d{1,2}:\d{2})/i
  )
  if (!match) return null
  const start = normalizeTime(match[1])
  const end = normalizeTime(match[2])
  return start && end ? { start, end } : null
}

const employeeShiftFields = employee => [
  employee?.ca_lam_viec,
  employee?.shift,
  employee?.shiftName,
  employee?.tenCa
]

const employeeIsSale = (employee, log, settings) => {
  const position = normalizeString(
    employee?.vi_tri || employee?.position || log?.position || log?.chucVu || ''
  )
  if (/xuat nhap khau|thu mua|ke toan|van hanh|admin|nhan su|\bhr\b|designer|content|media|leader/.test(position)) {
    return false
  }

  const department = normalizeString(
    employee?.bo_phan || employee?.department || log?.department || log?.phongBan || ''
  )
  const identity = normalizeString([
    employee?.bo_phan,
    employee?.department,
    employee?.vi_tri,
    employee?.position,
    ...employeeShiftFields(employee),
    log?.department,
    log?.phongBan,
    log?.position,
    log?.chucVu
  ].filter(Boolean).join(' '))

  const isSaleRole = department === 'trang' ||
    /(^|\s)(sale|sales)(\s|$)/.test(identity) ||
    identity.includes('kinh doanh')

  if (!isSaleRole) return false

  const checkIn = firstValue(log?.vao, log?.checkIn)
  if (checkIn) {
    const mins = attendanceTimeToMinutes(checkIn)
    if (mins !== null && mins >= attendanceTimeToMinutes(normalizeAttendancePolicy(settings).saleLatestAutoCheckIn)) {
      return false
    }
  }

  return true
}

export const resolveAttendanceShift = (employee = {}, log = {}, settings = {}) => {
  const logShiftId = firstValue(log.shiftId, log.shift_id)
  const explicitLogShift = exactShiftFromConfiguration(logShiftId, settings)
  if (explicitLogShift) return explicitLogShift
  // File DEOCA chỉ rõ Ca 1/Ca 2 ở cột Bộ phận; ca trên từng dòng có ưu tiên
  // hơn ca mặc định lưu trong hồ sơ nhân viên.
  if (log.importFormat === 'deoca-punch' && log.shiftName) {
    const sourceShift = configuredShiftFromName(log.shiftName, settings)
    if (sourceShift) return sourceShift
  }
  const employeeShiftId = firstValue(employee.shiftId, employee.shift_id)
  const explicitEmployeeShift = exactShiftFromConfiguration(employeeShiftId, settings)
  if (explicitEmployeeShift) return explicitEmployeeShift
  const employeeStart = normalizeTime(firstValue(
    employee.standardCheckIn,
    employee.shiftStart,
    employee.shift_start,
    employee.gio_vao_ca
  ))
  const employeeEnd = normalizeTime(firstValue(
    employee.standardCheckOut,
    employee.shiftEnd,
    employee.shift_end,
    employee.gio_ra_ca
  ))
  if (employeeStart && employeeEnd) {
    const name = firstValue(...employeeShiftFields(employee)) || 'Ca nhân viên'
    return attachConfiguredSplitShift({
      name,
      start: employeeStart,
      end: employeeEnd
    }, name, settings)
  }

  const employeeRange = employeeShiftFields(employee)
    .map(rangeFromText)
    .find(Boolean)
  if (employeeRange) {
    const name = firstValue(...employeeShiftFields(employee)) || 'Ca nhân viên'
    return attachConfiguredSplitShift({
      name,
      ...employeeRange
    }, name, settings)
  }

  const logStart = normalizeTime(firstValue(
    log.standardCheckIn,
    log.shiftStart,
    log.shift_start,
    log.gio_vao_ca
  ))
  const logEnd = normalizeTime(firstValue(
    log.standardCheckOut,
    log.shiftEnd,
    log.shift_end,
    log.gio_ra_ca
  ))
  if (logStart && logEnd) {
    const name = firstValue(log.shiftName, log.tenCa) || 'Ca chấm công'
    return attachConfiguredSplitShift({
      name,
      start: logStart,
      end: logEnd
    }, name, settings)
  }

  const logRange = [log.shiftName, log.tenCa]
    .map(rangeFromText)
    .find(Boolean)
  if (logRange) {
    const name = firstValue(log.shiftName, log.tenCa) || 'Ca chấm công'
    return attachConfiguredSplitShift({
      name,
      ...logRange
    }, name, settings)
  }

  const employeeConfiguredShift = configuredShiftFromName(
    firstValue(...employeeShiftFields(employee)),
    settings
  )
  const logConfiguredShift = configuredShiftFromName(
    firstValue(log.shiftName, log.tenCa),
    settings
  )

  // Tên ca đã khai báo trong cấu hình là lựa chọn tường minh. Chỉ dùng
  // suy luận từ vai trò khi hồ sơ còn ghi alias chung như "Ca ngày".
  const exactLogShift = exactShiftFromConfiguration(firstValue(log.shiftName, log.tenCa), settings)
  if (exactLogShift) return exactLogShift
  const exactEmployeeShift = exactShiftFromConfiguration(firstValue(...employeeShiftFields(employee)), settings)
  if (exactEmployeeShift) return exactEmployeeShift

  // Legacy fallback (deprecated): dữ liệu cũ thường gán "Ca full/Ca ngày"
  // cho mọi người. Chỉ suy luận Sale/Trang sau khi đã thử shift_id, tên ca
  // khớp cấu hình và giờ ca được gán. Hồ sơ mới nên gán ca rõ ràng.
  if (employeeIsSale(employee, log, settings) &&
    normalizeAttendanceShiftSettings(settings).shifts[ATTENDANCE_SHIFT_IDS.SALE_MORNING]) {
    return configuredShiftFromName('Ca Sáng Sale', settings)
  }
  if (employeeConfiguredShift) return employeeConfiguredShift
  if (logConfiguredShift) return logConfiguredShift

  return shiftFromConfiguration(ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE, settings) || DEFAULT_ATTENDANCE_SHIFT
}

export const attendanceTimeToMinutes = value => {
  if (value === null || value === undefined || value === '') return null

  if (typeof value === 'number' && value > 0 && value < 1) {
    return Math.round(value * 24 * 60) % (24 * 60)
  }

  const direct = normalizeTime(value)
  if (direct) {
    const [hours, minutes] = direct.split(':').map(Number)
    return hours * 60 + minutes
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date)
  const hours = Number(parts.find(part => part.type === 'hour')?.value)
  const minutes = Number(parts.find(part => part.type === 'minute')?.value)
  return Number.isFinite(hours) && Number.isFinite(minutes)
    ? hours * 60 + minutes
    : null
}

export const formatAttendanceTime = value => {
  const minutes = attendanceTimeToMinutes(value)
  if (minutes === null) return ''
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

export const calculateAttendanceTiming = ({
  employee = {},
  log = {},
  checkIn,
  checkOut,
  attendanceSettings = {}
} = {}) => {
  const shift = resolveAttendanceShift(employee, log, attendanceSettings)
  const actualCheckIn = firstValue(checkIn, log.vao, log.checkIn)
  const actualCheckOut = firstValue(checkOut, log.ra, log.checkOut)
  const checkInMinutes = attendanceTimeToMinutes(actualCheckIn)
  const checkOutMinutes = attendanceTimeToMinutes(actualCheckOut)
  const shiftStartMinutes = attendanceTimeToMinutes(shift.start)
  const shiftEndMinutes = attendanceTimeToMinutes(shift.end)
  const policy = normalizeAttendancePolicy(attendanceSettings)

  // Ca đêm có giờ kết thúc nhỏ hơn giờ bắt đầu. Quy đổi mốc kết thúc và
  // giờ ra sang ngày kế tiếp trước khi tính về sớm để không sinh số âm.
  const overnightShift =
    shiftStartMinutes !== null &&
    shiftEndMinutes !== null &&
    shiftEndMinutes <= shiftStartMinutes
  const adjustedShiftEndMinutes = overnightShift
    ? shiftEndMinutes + 24 * 60
    : shiftEndMinutes
  const adjustedCheckOutMinutes =
    overnightShift && checkOutMinutes !== null && checkOutMinutes < shiftStartMinutes
      ? checkOutMinutes + 24 * 60
      : checkOutMinutes
  const adjustedCheckInMinutes =
    overnightShift && checkInMinutes !== null && checkInMinutes < shiftStartMinutes
      ? checkInMinutes + 24 * 60
      : checkInMinutes

  let effectiveStartMinutes = shiftStartMinutes
  let effectiveEndMinutes = adjustedShiftEndMinutes
  const splitShift = shift.splitShift
  if (splitShift?.enabled && !overnightShift) {
    const sessions = [splitShift.morning, splitShift.afternoon]
      .map(session => ({
        start: attendanceTimeToMinutes(session?.start),
        end: attendanceTimeToMinutes(session?.end)
      }))
    if (sessions.every(session =>
      session.start !== null && session.end !== null && session.start < session.end
    )) {
      if (checkInMinutes !== null && checkOutMinutes !== null) {
        const attended = sessions.filter(session =>
          checkInMinutes < session.end && checkOutMinutes > session.start
        )
        if (attended.length) {
          effectiveStartMinutes = attended[0].start
          effectiveEndMinutes = attended[attended.length - 1].end
        } else {
          // Chấm hoàn toàn trong khoảng nghỉ/ngoài ca không tạo phạt giả.
          effectiveStartMinutes = checkInMinutes
          effectiveEndMinutes = checkOutMinutes
        }
      } else if (checkInMinutes !== null) {
        effectiveStartMinutes =
          sessions.find(session => checkInMinutes < session.end)?.start ??
          sessions[sessions.length - 1].start
      } else if (checkOutMinutes !== null) {
        effectiveEndMinutes =
          [...sessions].reverse().find(session => checkOutMinutes > session.start)?.end ??
          sessions[0].end
      }
    }
  }

  return {
    shift,
    hasCheckIn: checkInMinutes !== null,
    hasCheckOut: checkOutMinutes !== null,
    lateMinutes: adjustedCheckInMinutes === null
      ? null
      : Math.max(0, adjustedCheckInMinutes - effectiveStartMinutes) <= policy.lateGraceMinutes
        ? 0 : Math.max(0, adjustedCheckInMinutes - effectiveStartMinutes),
    earlyMinutes: adjustedCheckOutMinutes === null
      ? null
      : Math.max(0, effectiveEndMinutes - adjustedCheckOutMinutes) <= policy.earlyLeaveGraceMinutes
        ? 0 : Math.max(0, effectiveEndMinutes - adjustedCheckOutMinutes)
  }
}

const numericValue = value => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export const applyCalculatedAttendanceTiming = (log = {}, employee = {}, attendanceSettings = {}) => {
  const timing = calculateAttendanceTiming({ employee, log, attendanceSettings })
  const lateMinutes = timing.hasCheckIn
    ? timing.lateMinutes
    : numericValue(log.lateMinutes ?? log.vaoTre)
  const earlyMinutes = timing.hasCheckOut
    ? timing.earlyMinutes
    : numericValue(log.earlyMinutes ?? log.raSom)

  return {
    ...log,
    shiftName: log.shiftName || log.tenCa || timing.shift.name,
    tenCa: log.tenCa || log.shiftName || timing.shift.name,
    lateMinutes,
    earlyMinutes,
    vaoTre: lateMinutes,
    raSom: earlyMinutes
  }
}
