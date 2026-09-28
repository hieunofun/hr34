const normalizeHeader = value => String(value || '').toLowerCase().trim()

export const parseAttendanceTime = (timeRaw) => {
  if (timeRaw === null || timeRaw === undefined || timeRaw === '') return null

  if (typeof timeRaw === 'number') {
    const fraction = timeRaw > 1 ? timeRaw % 1 : timeRaw
    if (fraction <= 0 || fraction >= 1) return null
    const totalMinutes = Math.round(fraction * 24 * 60) % (24 * 60)
    const h = Math.floor(totalMinutes / 60)
    const m = totalMinutes % 60
    return { h, m, val: h + m / 60, str: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` }
  }

  const value = String(timeRaw).trim()
  if (!value || value === '-' || value === '------') return null

  const meridiem = value.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP])\.?M\.?$/i)
  if (meridiem) {
    const rawHour = Number(meridiem[1])
    const m = Number(meridiem[2])
    if (rawHour < 1 || rawHour > 12 || m > 59) return null
    const h = (rawHour % 12) + (meridiem[3].toUpperCase() === 'P' ? 12 : 0)
    return { h, m, val: h + m / 60, str: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` }
  }

  const clock = value.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  if (clock) {
    const h = Number(clock[1])
    const m = Number(clock[2])
    if (h > 23 || m > 59) return null
    return { h, m, val: h + m / 60, str: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` }
  }

  const numeric = Number(value.replace(',', '.'))
  return Number.isFinite(numeric) && numeric > 0 && numeric < 1
    ? parseAttendanceTime(numeric)
    : null
}

export const parseAttendanceDate = (dateRaw) => {
  if (dateRaw === null || dateRaw === undefined || dateRaw === '') return null

  if (typeof dateRaw === 'number') {
    const date = new Date(Math.round((dateRaw - 25569) * 86400 * 1000))
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
  }

  const value = String(dateRaw).trim()
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    const date = value.slice(0, 10)
    const parsed = new Date(`${date}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null
  }

  const match = value.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/)
  if (match) {
    const first = Number(match[1])
    const second = Number(match[2])
    const year = Number(match[3])
    const month = first > 12 ? second : second > 12 ? first : second
    const day = first > 12 ? first : second > 12 ? second : first
    const date = new Date(Date.UTC(year, month - 1, day))
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) return null
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}

/**
 * Locate only real punch columns (Vào/Ra, Vào 1/Ra 1, ...).
 * Summary columns such as "Vào trễ" and "Ra sớm" must not be treated as punches.
 */
export const findAttendancePunchColumns = (headers = []) =>
  headers.reduce((columns, header, index) => {
    const normalized = normalizeHeader(header)
    if (/^(?:vào|vao)\s*\d*$/.test(normalized)) {
      columns.checkInIndexes.push(index)
      columns.allIndexes.push(index)
    } else if (/^ra\s*\d*$/.test(normalized)) {
      columns.checkOutIndexes.push(index)
      columns.allIndexes.push(index)
    }
    return columns
  }, { checkInIndexes: [], checkOutIndexes: [], allIndexes: [] })

export const collectAttendancePunches = (
  row = [],
  columns = { checkInIndexes: [], checkOutIndexes: [], allIndexes: [] },
  parseValue = value => value
) => {
  const parsedAt = index => {
    const parsed = parseValue(row[index])
    return typeof parsed === 'string' ? parsed : parsed?.str || ''
  }
  const checkIns = columns.checkInIndexes.map(parsedAt).filter(Boolean)
  const checkOuts = columns.checkOutIndexes.map(parsedAt).filter(Boolean)
  const punches = columns.allIndexes.map(parsedAt).filter(Boolean)

  return {
    checkIn: checkIns[0] || '',
    checkOut: checkOuts[checkOuts.length - 1] || '',
    punches
  }
}
