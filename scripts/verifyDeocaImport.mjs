// Read-only audit of a DEOCA Excel file against the HR34 personnel directory.
// Run with SUPABASE_SERVICE_ROLE_KEY and VITE_SUPABASE_URL in the environment.
import { createClient } from '@supabase/supabase-js'
import xlsx from 'xlsx'
import { findDeocaPunchHeader, getDeocaShiftName, parseDeocaPunchSheet } from '../src/utils/deocaPunchImport.js'
import { buildChamCongRows, planHr34AttendanceImport } from '../src/services/hr34AttendanceImport.js'
import { formatAttendanceTime } from '../src/utils/attendanceShift.js'

const filePath = process.argv[2]
if (!filePath) throw new Error('Usage: node scripts/verifyDeocaImport.mjs <excel-file>')
const url = process.env.VITE_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const companyId = '00000000-0000-0000-0000-000000000034'
if (!url || !key) throw new Error('Missing Supabase read credentials')
const supabase = createClient(url, key)
const workbook = xlsx.readFile(filePath, { cellDates: true })
const sheet = workbook.SheetNames.map(name => {
  const rows = xlsx.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: '' })
  return { name, rows, header: findDeocaPunchHeader(rows) }
}).find(candidate => candidate.header)
if (!sheet) throw new Error('No worksheet contains the eight DEOCA headers')
const { records, skipped } = parseDeocaPunchSheet(sheet.rows, sheet.header)

const { data: personnel, error: personnelError } = await supabase.from('nhan_su')
  .select('id,ma_nhan_vien').eq('company_id', companyId)
  .order('id', { ascending: true })
if (personnelError) throw personnelError
const byCode = new Map(personnel.map(person => [String(person.ma_nhan_vien || '').trim(), person]))
const unmatched = [...new Set(records.filter(record => !byCode.has(record.employee_code))
  .map(record => record.employee_code))]
const logs = records.filter(record => byCode.has(record.employee_code)).map(record => ({
  employeeId: byCode.get(record.employee_code).id,
  sourceEmployeeCode: record.employee_code,
  date: record.attendance_date,
  importFormat: 'deoca-punch',
  raw_punch_times: record.raw_punch_times,
  vao: record.check_in,
  ra: record.check_out,
  shiftName: getDeocaShiftName(record.department_location),
  cong: 0
}))
const directRows = buildChamCongRows(logs, companyId, personnel)
const plan = planHr34AttendanceImport({ incomingLogs: logs })
const readAll = async queryPage => {
  const all = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await queryPage(from)
    if (error) throw error
    all.push(...(data || []))
    if (!data || data.length < 1000) return all
  }
}
const [storedLogs, storedAttendance] = await Promise.all([
  readAll(from => supabase.from('hr_records').select('id,data,updated_at')
    .eq('company_id', companyId).eq('collection', 'attendanceLogs')
    .order('id', { ascending: true }).range(from, from + 999)),
  readAll(from => supabase.from('cham_cong')
    .select('id,nhan_su_id,ngay,gia_tri_goc,gio_vao,gio_ra,ca_lam,tong_cong')
    .eq('company_id', companyId).order('id', { ascending: true }).range(from, from + 999))
])
const productionPlan = planHr34AttendanceImport({
  incomingLogs: logs,
  existingLogs: storedLogs.map(row => ({
    ...row.data,
    id: row.id.split('::').at(-1)
  }))
})
const storedByDay = new Map(storedAttendance.map(row => [`${row.nhan_su_id}|${row.ngay}`, row]))
const directMissing = directRows.filter(row => !storedByDay.has(`${row.nhan_su_id}|${row.ngay}`))
const directDifferences = directRows.flatMap(row => {
  const existing = storedByDay.get(`${row.nhan_su_id}|${row.ngay}`)
  if (!existing) return []
  const changed = [
    ...(String(existing.gia_tri_goc ?? '') !== String(row.gia_tri_goc ?? '') ? ['raw_punch_times'] : []),
    ...(formatAttendanceTime(existing.gio_vao) !== formatAttendanceTime(row.gio_vao) ? ['check_in'] : []),
    ...(formatAttendanceTime(existing.gio_ra) !== formatAttendanceTime(row.gio_ra) ? ['check_out'] : []),
    ...(row.ca_lam !== 'Ca ngày' && String(existing.ca_lam || '') !== row.ca_lam ? ['shift'] : [])
  ]
  return changed.length ? [{ code: personnel.find(person => person.id === row.nhan_su_id)?.ma_nhan_vien,
    date: row.ngay, changed }] : []
})
const [logsCount, attendanceCount, settingsResult] = await Promise.all([
  supabase.from('hr_records').select('id', { head: true, count: 'exact' })
    .eq('company_id', companyId).eq('collection', 'attendanceLogs'),
  supabase.from('cham_cong').select('id', { head: true, count: 'exact' })
    .eq('company_id', companyId),
  supabase.from('hr_records').select('data')
    .eq('company_id', companyId).eq('collection', 'attendanceSettings').limit(1)
])
for (const result of [logsCount, attendanceCount, settingsResult]) {
  if (result.error) throw result.error
}
console.log(JSON.stringify({
  sheet: sheet.name,
  readRows: records.length,
  skippedRows: skipped.length,
  uniqueEmployees: new Set(records.map(record => record.employee_code)).size,
  fullPunchPairs: records.filter(record => record.check_in && record.check_out).length,
  checkInOnly: records.filter(record => record.check_in && !record.check_out).length,
  shiftNames: Object.fromEntries([...new Set(logs.map(log => log.shiftName))]
    .map(name => [name || '(không ghi ca)', logs.filter(log => log.shiftName === name).length])),
  unmatchedCodes: unmatched,
  plannedInsertsWithEmptyHistory: plan.inserts.length,
  plannedConflictsWithEmptyHistory: plan.conflicts.length,
  directRowsReady: directRows.length,
  currentHr34LogCount: logsCount.count,
  currentHr34AttendanceCount: attendanceCount.count,
  productionPlan: {
    inserts: productionPlan.inserts.length,
    updates: productionPlan.updates.length,
    unchanged: productionPlan.unchanged.length,
    conflicts: productionPlan.conflicts.length,
    firstConflicts: productionPlan.conflicts.slice(0, 3).map(item => item.reason)
  },
  existingDirectRowsMissingFromFile: storedAttendance.length - (directRows.length - directMissing.length),
  fileRowsMissingFromDirect: directMissing.length,
  directDifferences: directDifferences.length,
  firstDirectDifferences: directDifferences.slice(0, 5),
  firstStoredAttendance: storedAttendance.slice(0, 2).map(row => ({
    date: row.ngay,
    raw: row.gia_tri_goc,
    checkIn: row.gio_vao,
    checkOut: row.gio_ra,
    shift: row.ca_lam,
    workdays: row.tong_cong
  })),
  configuredShifts: Object.values(settingsResult.data?.[0]?.data?.shifts || {})
    .map(shift => ({ name: shift.name, in: shift.standardCheckIn, out: shift.standardCheckOut })),
  samples: records.slice(0, 5).map(record => ({
    employee_code: record.employee_code,
    name: `${record.first_name} ${record.last_name}`,
    date: record.attendance_date,
    department: record.department_location,
    raw_punch_times: record.raw_punch_times,
    check_in: record.check_in,
    check_out: record.check_out
  }))
}, null, 2))
