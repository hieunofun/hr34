import { parseAttendanceDate, parseAttendanceTime } from './attendanceImport.js'

const REQUIRED_HEADERS = {
  first_name: 'tên riêng',
  last_name: 'họ',
  employee_code: 'id',
  department_location: 'bộ phận',
  attendance_date: 'ngày',
  weekday: 'ngày trong tuần',
  punch_count: 'số lần quẹt thẻ',
  raw_punch_times: 'ghi'
}

const normalizeHeader = value => String(value ?? '')
  .normalize('NFC')
  .toLocaleLowerCase('vi')
  .replace(/\s+/g, ' ')
  .trim()

export const getDeocaShiftName = departmentLocation => {
  const segments = String(departmentLocation || '').split(/[>/]/).map(segment => segment.trim())
  const last = segments[segments.length - 1] || ''
  const match = last.match(/^Ca\s*(\d+)$/i)
  return match ? `Ca ${match[1]}` : ''
}

export const findDeocaPunchHeader = (rows = []) => {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 30); rowIndex++) {
    const headers = new Map((rows[rowIndex] || []).map((cell, index) => [normalizeHeader(cell), index]))
    if (Object.values(REQUIRED_HEADERS).every(header => headers.has(header))) {
      return {
        rowIndex,
        columns: Object.fromEntries(
          Object.entries(REQUIRED_HEADERS).map(([field, header]) => [field, headers.get(header)])
        )
      }
    }
  }
  return null
}

export const parseDeocaPunchSheet = (rows = [], header = findDeocaPunchHeader(rows)) => {
  if (!header) throw new Error('Không tìm thấy các cột của Phiếu chấm công DEOCA.')

  const { columns } = header
  const records = []
  const skipped = []

  for (let rowIndex = header.rowIndex + 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] || []
    if (row.every(cell => cell === '' || cell === null || cell === undefined)) continue

    const firstName = String(row[columns.first_name] ?? '').trim()
    const lastName = String(row[columns.last_name] ?? '').trim()
    const employeeCode = String(row[columns.employee_code] ?? '').trim()
    const attendanceDate = parseAttendanceDate(row[columns.attendance_date])
    if (!employeeCode) {
      skipped.push(`Dòng ${rowIndex + 1}: thiếu ID nhân viên.`)
      continue
    }
    if (!attendanceDate) {
      skipped.push(`Dòng ${rowIndex + 1}: ngày không hợp lệ.`)
      continue
    }

    const rawPunchTimes = String(row[columns.raw_punch_times] ?? '')
    const punches = [...new Set(
      rawPunchTimes.split(';').map(value => parseAttendanceTime(value)?.str).filter(Boolean)
    )].sort((left, right) => left.localeCompare(right))
    const rawCount = String(row[columns.punch_count] ?? '').trim()

    records.push({
      first_name: firstName,
      last_name: lastName,
      employee_code: employeeCode,
      department_location: String(row[columns.department_location] ?? '').trim(),
      attendance_date: attendanceDate,
      weekday: String(row[columns.weekday] ?? '').trim(),
      punch_count: /^\d+$/.test(rawCount) ? Number(rawCount) : null,
      raw_punch_times: rawPunchTimes,
      check_in: punches[0] ?? null,
      check_out: punches.length > 1 ? punches[punches.length - 1] : null,
      punches,
      source_row: rowIndex + 1
    })
  }

  return { records, skipped, headerRowIndex: header.rowIndex }
}
