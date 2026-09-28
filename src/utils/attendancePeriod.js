const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export const isValidAttendanceDate = value => {
  const match = DATE_RE.exec(String(value || ''))
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.toISOString().slice(0, 10) === value
}

export const calendarAttendancePeriod = month => {
  const match = MONTH_RE.exec(String(month || ''))
  if (!match) throw new Error('Tháng kỳ công phải có dạng YYYY-MM.')
  const last = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate()
  return { month, startDate: `${month}-01`, endDate: `${month}-${String(last).padStart(2, '0')}` }
}

export const nextAttendanceDate = (date, amount = 1) => {
  if (!isValidAttendanceDate(date)) throw new Error('Ngày kỳ công không hợp lệ.')
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + amount)
  return value.toISOString().slice(0, 10)
}

export const attendancePeriodDates = period => {
  if (!period?.startDate || !period?.endDate) return []
  const dates = []
  for (let date = period.startDate; date <= period.endDate; date = nextAttendanceDate(date)) {
    dates.push(date)
    if (dates.length > 31) throw new Error('Kỳ công tối đa 31 ngày để khớp mẫu bảng công.')
  }
  return dates
}

export const validateAttendancePeriod = (period, existing = []) => {
  const month = String(period?.month || '')
  if (!MONTH_RE.test(month)) throw new Error('Tháng kỳ công phải có dạng YYYY-MM.')
  const startDate = String(period?.startDate || '')
  const endDate = String(period?.endDate || '')
  if (!isValidAttendanceDate(startDate) || !isValidAttendanceDate(endDate) || startDate > endDate) {
    throw new Error('Ngày bắt đầu hoặc kết thúc kỳ công không hợp lệ.')
  }
  if (endDate.slice(0, 7) !== month) throw new Error('Ngày kết thúc phải thuộc tháng/năm kỳ công.')
  attendancePeriodDates({ startDate, endDate })
  const overlap = existing.find(item => item.month !== month &&
    startDate <= item.endDate && endDate >= item.startDate)
  if (overlap) throw new Error(`Kỳ công trùng khoảng với tháng ${overlap.month}.`)
  return { month, startDate, endDate }
}

export const dateInAttendancePeriod = (date, period) =>
  isValidAttendanceDate(String(date || '').slice(0, 10)) &&
  String(date).slice(0, 10) >= period.startDate &&
  String(date).slice(0, 10) <= period.endDate

export const attendanceMonthForDate = (date, periods = []) => {
  const rawDate = String(date || '').slice(0, 10)
  if (!isValidAttendanceDate(rawDate)) return ''
  return periods.find(period => dateInAttendancePeriod(rawDate, period))?.month || rawDate.slice(0, 7)
}

export const attendanceDateForDay = (period, day) =>
  attendancePeriodDates(period).find(date => Number(date.slice(8, 10)) === Number(day)) || null

export const resolveMatrixAttendanceDates = (columns, monthHint) => {
  const target = calendarAttendancePeriod(monthHint)
  const previousMonth = nextAttendanceDate(target.startDate, -1).slice(0, 7)
  const wrappedAt = columns.findIndex((column, index) => index > 0 &&
    Number(column.day) < Number(columns[index - 1].day))
  const crossesMonth = wrappedAt > 0 && Number(columns[0].day) >= 20 &&
    Number(columns.at(-1).day) <= 25
  return columns.map((column, index) => {
    const inferredMonth = crossesMonth && index < wrappedAt ? previousMonth : monthHint
    const explicitMonth = Number(column.month)
    const month = explicitMonth
      ? `${column.year || (explicitMonth === Number(previousMonth.slice(5)) ? previousMonth.slice(0, 4) : monthHint.slice(0, 4))}-${String(explicitMonth).padStart(2, '0')}`
      : inferredMonth
    const date = `${month}-${String(column.day).padStart(2, '0')}`
    return { ...column, date, valid: isValidAttendanceDate(date) }
  })
}

export const countAttendancePeriodLogs = (logs, period) => ({
  inside: logs.filter(log => dateInAttendancePeriod(log.date, period)).length,
  outside: logs.filter(log => !dateInAttendancePeriod(log.date, period)).length
})

export const suggestAttendancePeriod = ({ logs = [], existing = [], monthHint = '', forceMonth = false }) => {
  const validDates = logs.map(log => String(log.date || '').slice(0, 10))
    .filter(isValidAttendanceDate).sort()
  if (!validDates.length) throw new Error('Excel không có ngày chấm công hợp lệ.')
  const monthCounts = new Map()
  validDates.forEach(date => monthCounts.set(date.slice(0, 7), (monthCounts.get(date.slice(0, 7)) || 0) + 1))
  const hintSaved = existing.find(item => item.month === monthHint)
  const hintPreviousMonth = MONTH_RE.test(monthHint)
    ? nextAttendanceDate(`${monthHint}-01`, -1).slice(0, 7)
    : ''
  const hintPrevious = existing.find(item => item.month === hintPreviousMonth)
  const hintPlausible = MONTH_RE.test(monthHint) && (forceMonth || monthCounts.has(monthHint) ||
    (hintSaved && validDates.some(date => dateInAttendancePeriod(date, hintSaved))) ||
    (hintPrevious && validDates.some(date => date > hintPrevious.endDate &&
      date <= calendarAttendancePeriod(monthHint).endDate)))
  const crossCandidates = [...monthCounts.keys()].filter(candidate => {
    const previous = nextAttendanceDate(`${candidate}-01`, -1).slice(0, 7)
    return validDates.some(date => date.slice(0, 7) === previous && Number(date.slice(8)) >= 26) &&
      validDates.some(date => date.slice(0, 7) === candidate && Number(date.slice(8)) <= 25)
  }).sort()
  const month = hintPlausible
    ? monthHint
    : (crossCandidates.at(-1) || [...monthCounts].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0][0])
  const saved = existing.find(item => item.month === month)
  if (saved) return { ...saved, source: 'saved' }

  const previousMonth = nextAttendanceDate(`${month}-01`, -1).slice(0, 7)
  const previous = existing.find(item => item.month === previousMonth)
  if (previous) {
    const startDate = nextAttendanceDate(previous.endDate)
    const endDay = Number(previous.endDate.slice(8, 10))
    const last = Number(calendarAttendancePeriod(month).endDate.slice(8, 10))
    const endDate = `${month}-${String(Math.min(endDay, last)).padStart(2, '0')}`
    if (startDate <= endDate) return { month, startDate, endDate, source: 'previous' }
  }

  // Một file cắt kỳ 26–25 có ngày ở cả cuối tháng trước lẫn đầu tháng kỳ.
  // Không lấy min/max của file làm ranh giới vì file có thể thiếu ngày.
  const prevDates = validDates.filter(date => date.slice(0, 7) === previousMonth)
  const currentDates = validDates.filter(date => date.slice(0, 7) === month)
  if (prevDates.some(date => Number(date.slice(8)) >= 26) &&
      currentDates.some(date => Number(date.slice(8)) <= 25)) {
    return { month, startDate: `${previousMonth}-26`, endDate: `${month}-25`, source: 'cross-month' }
  }
  return { ...calendarAttendancePeriod(month), source: 'calendar' }
}
