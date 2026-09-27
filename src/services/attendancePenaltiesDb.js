import { supabase } from './supabase'
import { requireTenantCompanyId } from './tenantSession'

const isUuid = value =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  )

const mapRowFromDb = row => ({
  id: row.id,
  date: row.penalty_date ? String(row.penalty_date).slice(0, 10) : '',
  employeeId: row.employee_id || '',
  employeeCode: row.employee_code || '',
  employeeName: row.employee_name || '',
  category: row.category || '',
  content: row.content || '',
  amount: Number(row.amount || 0),
  note: row.note || '',
  source: row.source || 'manual',
  month: row.month || ''
})

const mapRowToDb = (row, month) => {
  const penaltyDate = String(row.date || '').slice(0, 10)
  const resolvedMonth =
    /^\d{4}-\d{2}$/.test(month)
      ? month
      : /^\d{4}-\d{2}-\d{2}$/.test(penaltyDate)
        ? penaltyDate.slice(0, 7)
        : month

  const payload = {
    month: resolvedMonth,
    penalty_date: /^\d{4}-\d{2}-\d{2}$/.test(penaltyDate) ? penaltyDate : null,
    employee_id: isUuid(row.employeeId) ? row.employeeId : null,
    employee_code: row.employeeCode || '',
    employee_name: row.employeeName || '',
    category: row.category || '',
    content: row.content || '',
    amount: Number(row.amount || 0),
    note: row.note || '',
    source: row.source === 'auto' ? 'auto' : 'manual',
    updated_at: new Date().toISOString()
  }

  if (isUuid(row.id)) payload.id = row.id
  return payload
}

export const listPenaltyMonths = async () => {
  const companyId = requireTenantCompanyId()
  const { data, error } = await supabase
    .from('attendance_penalties')
    .select('month')
    .eq('company_id', companyId)
    .order('month', { ascending: false })
    .limit(2000)

  if (error) throw error
  return [...new Set((data || []).map(row => row.month).filter(Boolean))]
}

export const listPenaltyEmployeesSlim = async () => {
  const companyId = requireTenantCompanyId()
  const { data, error } = await supabase
    .from('users')
    .select('id, name, employee_id, username')
    .eq('company_id', companyId)
    .order('name', { ascending: true })

  if (error) throw error
  return (data || []).map(row => ({
    id: row.id,
    name: row.name || '',
    code: row.employee_id || row.username || ''
  }))
}

export const getPenaltiesByMonth = async month => {
  const companyId = requireTenantCompanyId()
  const period = String(month || '').trim()
  if (!/^\d{4}-\d{2}$/.test(period)) return []

  const { data, error } = await supabase
    .from('attendance_penalties')
    .select('*')
    .eq('company_id', companyId)
    .eq('month', period)
    .order('penalty_date', { ascending: true })
    .order('employee_name', { ascending: true })

  if (error) throw error
  return (data || []).map(mapRowFromDb)
}

export const savePenaltiesByMonth = async (month, rows = []) => {
  const companyId = requireTenantCompanyId()
  const period = String(month || '').trim()
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw new Error('Tháng không hợp lệ')
  }

  const { data: existing, error: existingError } = await supabase
    .from('attendance_penalties')
    .select('id')
    .eq('company_id', companyId)
    .eq('month', period)
  if (existingError) throw existingError

  const nextRows = (rows || []).map(row => ({ ...mapRowToDb(row, period), company_id: companyId }))
  const keepIds = new Set(nextRows.map(row => row.id).filter(Boolean))
  const deleteIds = (existing || [])
    .map(row => row.id)
    .filter(id => !keepIds.has(id))

  if (deleteIds.length) {
    const { error: deleteError } = await supabase
      .from('attendance_penalties')
      .delete()
      .eq('company_id', companyId)
      .in('id', deleteIds)
    if (deleteError) throw deleteError
  }

  if (!nextRows.length) {
    return {
      month: period,
      generatedAt: new Date().toISOString(),
      rows: []
    }
  }

  const toUpdate = nextRows.filter(row => row.id)
  const toInsert = nextRows.filter(row => !row.id)
  const savedRows = []

  if (toUpdate.length) {
    const { data, error } = await supabase
      .from('attendance_penalties')
      .upsert(toUpdate, { onConflict: 'id' })
      .select('*')
    if (error) throw error
    savedRows.push(...(data || []))
  }

  if (toInsert.length) {
    const { data, error } = await supabase
      .from('attendance_penalties')
      .insert(toInsert)
      .select('*')
    if (error) throw error
    savedRows.push(...(data || []))
  }

  const saved = savedRows.map(mapRowFromDb).sort((left, right) => {
    const byDate = String(left.date).localeCompare(String(right.date))
    if (byDate !== 0) return byDate
    return String(left.employeeName).localeCompare(String(right.employeeName), 'vi')
  })

  return {
    month: period,
    generatedAt: new Date().toISOString(),
    rows: saved
  }
}

/** Migrate 1 tháng từ hr_records JSON (nếu còn) sang bảng attendance_penalties. */
export const migrateLegacyPenaltyMonth = async month => {
  const companyId = requireTenantCompanyId()
  const period = String(month || '').trim()
  if (!/^\d{4}-\d{2}$/.test(period)) return null

  const current = await getPenaltiesByMonth(period)
  if (current.length) return current

  const { data, error } = await supabase
    .from('hr_records')
    .select('data')
    .eq('company_id', companyId)
    .eq('id', `attendanceMonthPenalties::${period}`)
    .maybeSingle()
  if (error) throw error

  const legacyRows = data?.data?.rows
  if (!Array.isArray(legacyRows) || !legacyRows.length) return []

  const saved = await savePenaltiesByMonth(period, legacyRows)
  return saved.rows
}
