import { buildAttendanceRecordKey } from '../utils/attendanceMatching.js'
import { formatAttendanceTime } from '../utils/attendanceShift.js'

const cleanLog = log => Object.fromEntries(
  Object.entries(log).filter(([key]) => key !== 'id' && !key.startsWith('_'))
)

const dayKey = log => `${String(log.employeeId || '')}|${String(log.date || '').slice(0, 10)}`
const isExcelLog = log => log?.sourceType === 'excel-import' ||
  Boolean(log?.sourceEmployeeCode || log?.sourceEmployeeName || log?.importFormat)

export const planHr34AttendanceImport = ({ incomingLogs = [], existingLogs = [], skippedSourceKeys = new Set() } = {}) => {
  const existingByDay = new Map()
  for (const log of existingLogs) {
    const key = dayKey(log)
    if (!existingByDay.has(key)) existingByDay.set(key, [])
    existingByDay.get(key).push(log)
  }

  const seenDays = new Set()
  const inserts = []
  const updates = []
  const unchanged = []
  const skipped = []
  const conflicts = []
  for (const log of incomingLogs) {
    if (skippedSourceKeys.has(log._sourceEmployeeKey)) {
      skipped.push({ log, reason: 'Đã chọn bỏ qua nhân viên' })
      continue
    }
    if (!log.employeeId || String(log.employeeId).startsWith('external:')) {
      conflicts.push({ log, reason: 'Chưa ghép với hồ sơ nhân sự HR34' })
      continue
    }
    const key = dayKey(log)
    if (!/^.+\|\d{4}-\d{2}-\d{2}$/.test(key)) {
      conflicts.push({ log, reason: 'Thiếu mã nhân sự hoặc ngày hợp lệ' })
      continue
    }
    if (seenDays.has(key)) {
      conflicts.push({ log, reason: 'File có nhiều bản ghi cho cùng nhân viên và ngày; cần kiểm tra trước khi lưu' })
      continue
    }
    seenDays.add(key)
    const candidates = existingByDay.get(key) || []
    if (candidates.length > 1) {
      conflicts.push({ log, reason: 'Database có nhiều log cùng nhân viên và ngày' })
      continue
    }
    const existing = candidates[0]
    if (existing && !isExcelLog(existing)) {
      conflicts.push({ log, reason: 'Ngày này đã có chấm công từ nguồn khác' })
      continue
    }
    const data = cleanLog({ ...(existing || {}), ...log, sourceType: 'excel-import' })
    if (!existing) {
      inserts.push({ log, data })
      continue
    }
    if (!existing.id) {
      conflicts.push({ log, reason: 'Log hiện có thiếu ID' })
      continue
    }
    const changed = buildAttendanceRecordKey(existing) !== buildAttendanceRecordKey(log) ||
      Object.entries(data).some(([field, value]) =>
        JSON.stringify(existing[field] ?? null) !== JSON.stringify(value ?? null)
      )
    if (changed) updates.push({ id: existing.id, log, data })
    else unchanged.push({ id: existing.id, log })
  }
  return { inserts, updates, unchanged, skipped, conflicts }
}

export const buildChamCongRows = (logs, companyId, personnel = []) => {
  const byId = new Map(personnel.map(person => [String(person.id), person]))
  return logs.map(log => {
    const person = byId.get(String(log.employeeId))
    if (!person) throw new Error(`Mã ${log.sourceEmployeeCode || log.employeeCode || '?'} chưa có hồ sơ nhan_su thuộc HR34.`)
    const sourceCode = String(log.sourceEmployeeCode || log.employeeCode || '').trim()
    if (log.importFormat === 'deoca-punch' && sourceCode && person.ma_nhan_vien && sourceCode !== person.ma_nhan_vien) {
      throw new Error(`Mã nguồn ${sourceCode} không khớp hồ sơ ${person.ma_nhan_vien}.`)
    }
    const day = String(log.date || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Ngày không hợp lệ: ${log.date}`)
    const regularWorkdays = Number(log.cong ?? 0)
    if (!Number.isFinite(regularWorkdays)) throw new Error(`Công không hợp lệ ở ${sourceCode}, ${day}`)
    return {
      company_id: companyId,
      nhan_su_id: person.id,
      ngay: day,
      gia_tri_goc: String(log.raw_punch_times ?? log.rawVal ?? log.kyHieu ?? '').trim() || null,
      gio_vao: formatAttendanceTime(log.vao || log.checkIn) || null,
      gio_ra: formatAttendanceTime(log.ra || log.checkOut) || null,
      ca_lam: log.shiftName || log.tenCa || 'Ca ngày',
      tang_ca: Number(log.tc1 || 0) + Number(log.tc2 || 0) + Number(log.tc3 || 0),
      tong_cong: regularWorkdays,
      notes: log.notes || null
    }
  })
}

const readAll = async queryPage => {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await queryPage(from)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return rows
}

const attendanceFieldsMatch = (current, next) =>
  ['gia_tri_goc', 'gio_vao', 'gio_ra', 'ca_lam', 'tong_cong'].every(field =>
    ['gio_vao', 'gio_ra'].includes(field)
      ? formatAttendanceTime(current?.[field]) === formatAttendanceTime(next[field])
      : String(current?.[field] ?? '') === String(next[field] ?? '')
  )

/**
 * Preflight cả hai bảng trước khi ghi. Ghi cham_cong trước để một lần thử lại
 * sau lỗi mạng có thể hoàn thành hr_records và bảng công mà không nhân đôi.
 */
export const commitHr34AttendanceImport = async ({
  supabase, fbGet, fbUpdate, companyId, incomingLogs,
  skippedSourceKeys = new Set(), reconcileMode = false
}) => {
  const existingData = await fbGet('hr/attendanceLogs', companyId)
  const existingLogs = Array.isArray(existingData)
    ? existingData
    : Object.entries(existingData || {}).map(([id, value]) => ({ ...value, id }))
  let plan = planHr34AttendanceImport({ incomingLogs, existingLogs, skippedSourceKeys })
  if (reconcileMode) {
    const existingById = new Map(existingLogs.map(log => [String(log.id), log]))
    const updates = []
    for (const log of incomingLogs) {
      if (skippedSourceKeys.has(log._sourceEmployeeKey)) continue
      if (!log.id || String(log.employeeId || '') === String(log._originalEmployeeId || '')) continue
      const old = existingById.get(String(log.id))
      if (!old || !String(old.employeeId || '').startsWith('external:')) {
        throw new Error('Chỉ đối soát tự động được log chưa ghép hồ sơ; bản ghi đã ghép cần kiểm tra thủ công.')
      }
      if (existingLogs.some(existing => existing.id !== old.id && dayKey(existing) === dayKey(log))) {
        throw new Error('Nhân viên đích đã có log trong ngày này; không thể ghép trùng.')
      }
      updates.push({ id: old.id, log, data: cleanLog({ ...log, sourceType: 'excel-import' }) })
    }
    plan = { inserts: [], updates, unchanged: [], skipped: [], conflicts: [] }
  }
  if (plan.conflicts.length) {
    throw new Error(`${plan.conflicts.length} dòng xung đột: ${plan.conflicts[0].reason}. Chưa ghi dữ liệu.`)
  }
  const accepted = [...plan.inserts, ...plan.updates, ...plan.unchanged].map(item => item.log)
  if (!accepted.length) return { inserted: 0, updated: 0, unchanged: plan.unchanged.length, skipped: plan.skipped.length, affectedMonths: [] }

  const personnel = await readAll(from => supabase.from('nhan_su')
    .select('id,ma_nhan_vien')
    .eq('company_id', companyId)
    .order('id', { ascending: true })
    .range(from, from + 999))
  const rows = buildChamCongRows(accepted, companyId, personnel)
  const dates = rows.map(row => row.ngay).sort()
  const existingAttendance = await readAll(from => supabase.from('cham_cong')
    .select('id,nhan_su_id,ngay,gia_tri_goc,gio_vao,gio_ra,ca_lam,tong_cong')
    .eq('company_id', companyId)
    .gte('ngay', dates[0])
    .lte('ngay', dates[dates.length - 1])
    .order('id', { ascending: true })
    .range(from, from + 999))
  const incomingDays = new Set(rows.map(row => `${row.nhan_su_id}|${row.ngay}`))
  const dbByDay = new Map()
  for (const row of existingAttendance) {
    const key = `${row.nhan_su_id}|${row.ngay}`
    if (!incomingDays.has(key)) continue
    if (dbByDay.has(key)) {
      throw new Error(`Bảng cham_cong có nhiều bản ghi cho ${key}; cần xử lý trước khi import.`)
    }
    dbByDay.set(key, row)
  }
  const existingExcelDays = new Set(existingLogs.filter(isExcelLog).map(dayKey))
  const toInsert = []
  const toUpdate = []
  for (const row of rows) {
    const key = `${row.nhan_su_id}|${row.ngay}`
    const current = dbByDay.get(key)
    if (!current) {
      toInsert.push(row)
      continue
    }
    if (!existingExcelDays.has(key) && !attendanceFieldsMatch(current, row)) {
      throw new Error(`Bảng cham_cong đã có bản ghi khác cho ${row.ngay}; không ghi đè nguồn khác.`)
    }
    if (!attendanceFieldsMatch(current, row)) toUpdate.push({ id: current.id, row })
  }

  for (let index = 0; index < toInsert.length; index += 50) {
    const { error } = await supabase.from('cham_cong')
      .insert(toInsert.slice(index, index + 50))
    if (error) throw new Error(`Không ghi được bảng cham_cong: ${error.message}`)
  }
  for (const { id, row } of toUpdate) {
    const { company_id, nhan_su_id, ngay, ...patch } = row
    const { error } = await supabase.from('cham_cong').update(patch)
      .eq('id', id).eq('company_id', companyId)
    if (error) throw new Error(`Không cập nhật được bảng cham_cong: ${error.message}`)
  }

  const scopedRecordRows = [
    ...plan.inserts.map(item => ({
      id: `excel_${encodeURIComponent(dayKey(item.log))}`,
      data: item.data
    })),
    ...plan.updates.filter(item => item.id.startsWith('excel_')).map(item => ({
      id: item.id,
      data: item.data
    }))
  ].map(item => ({
    id: `${companyId}::attendanceLogs::${item.id}`,
    collection: 'attendanceLogs',
    company_id: companyId,
    data: item.data,
    updated_at: new Date().toISOString()
  }))
  for (let index = 0; index < scopedRecordRows.length; index += 50) {
    const { error } = await supabase.from('hr_records')
      .upsert(scopedRecordRows.slice(index, index + 50), { onConflict: 'id' })
    if (error) throw new Error(`Không ghi được log chấm công: ${error.message}`)
  }
  for (const item of plan.updates.filter(item => !item.id.startsWith('excel_'))) {
    await fbUpdate(`hr/attendanceLogs/${item.id}`, item.data, companyId)
  }
  return {
    inserted: plan.inserts.length,
    updated: plan.updates.length,
    unchanged: plan.unchanged.length,
    skipped: plan.skipped.length,
    affectedMonths: [...new Set(rows.map(row => row.ngay.slice(0, 7)))].sort()
  }
}
