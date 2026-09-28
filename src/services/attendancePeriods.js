import { supabase } from './supabase.js'
import { requireTenantCompanyId } from './tenantSession.js'
import { validateAttendancePeriod } from '../utils/attendancePeriod.js'

const mapRow = row => ({
  month: row.month_key,
  startDate: row.start_date,
  endDate: row.end_date,
  companyId: row.company_id
})

export async function listAttendancePeriods(companyId) {
  const tenantId = requireTenantCompanyId(companyId)
  const { data, error } = await supabase.from('attendance_periods')
    .select('company_id,month_key,start_date,end_date')
    .eq('company_id', tenantId)
    .order('month_key', { ascending: false })
  if (error) throw new Error(`Không tải được kỳ công. Cần chạy migration attendance_periods: ${error.message}`)
  return (data || []).map(mapRow)
}

export async function confirmAttendancePeriod(companyId, period) {
  const tenantId = requireTenantCompanyId(companyId)
  const existing = await listAttendancePeriods(tenantId)
  const valid = validateAttendancePeriod(period, existing)
  const { data, error } = await supabase.from('attendance_periods').upsert({
    company_id: tenantId,
    month_key: valid.month,
    start_date: valid.startDate,
    end_date: valid.endDate
  }, { onConflict: 'company_id,month_key' }).select('company_id,month_key,start_date,end_date').single()
  if (error) throw new Error(`Không xác nhận được kỳ công: ${error.message}`)
  return mapRow(data)
}

export async function getAttendancePeriod(companyId, month) {
  const periods = await listAttendancePeriods(companyId)
  return periods.find(period => period.month === month) || null
}
