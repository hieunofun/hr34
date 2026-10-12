import { attendanceDateForDay, isValidAttendanceDate } from './attendancePeriod.js'

export const parseManualWorkdayInput = rawValue => {
  const text = String(rawValue ?? '').trim().replace(',', '.')
  if (!text) return { valid: true, value: null }

  const value = Number(text)
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return { valid: false, value: null, error: 'Số công phải nằm trong khoảng từ 0 đến 1.' }
  }
  return { valid: true, value: Math.round(value * 100) / 100 }
}

export const updateManualWorkdays = (current, employeeId, day, value, period = null) => {
  const employeeKey = String(employeeId || '')
  const dayKey = isValidAttendanceDate(day) ? day : String(Number(day))
  const next = { ...(current || {}) }
  const employeeDays = { ...(next[employeeKey] || {}) }
  if (isValidAttendanceDate(day) && period && attendanceDateForDay(period, Number(day.slice(8, 10))) === day) {
    delete employeeDays[String(Number(day.slice(8, 10)))]
  }

  if (value === null || value === undefined || value === '') {
    delete employeeDays[dayKey]
  } else {
    employeeDays[dayKey] = Number(value)
  }

  if (Object.keys(employeeDays).length) next[employeeKey] = employeeDays
  else delete next[employeeKey]
  return next
}

export const manualWorkdayForDate = (employeeDays = {}, date, period = null) => {
  if (Object.hasOwn(employeeDays, date)) return employeeDays[date]
  const day = Number(String(date).slice(8, 10))
  // A legacy day number belongs to its first occurrence in the period.
  if (period && attendanceDateForDay(period, day) !== date) return undefined
  return employeeDays[String(day)]
}
