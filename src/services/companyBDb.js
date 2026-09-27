import { supabase } from './supabase'
import { requireTenantCompanyId } from './tenantSession'

/**
 * Lấy thông tin công ty
 */
export async function getCompanyInfo(companyId) {
  companyId = requireTenantCompanyId(companyId)
  const { data, error } = await supabase
    .from('companies')
    .select('*')
    .eq('id', companyId)
    .single()

  if (error) {
    console.warn('getCompanyInfo error:', error.message)
    return null
  }
  return data
}

/**
 * Lấy danh sách nhân sự của công ty
 */
export async function getEmployees(companyId) {
  companyId = requireTenantCompanyId(companyId)
  const { data, error } = await supabase
    .from('nhan_su')
    .select('*')
    .eq('company_id', companyId)
    .order('ma_nhan_vien', { ascending: true })

  if (error) {
    console.error('getEmployees error:', error.message)
    return []
  }
  return data || []
}

/**
 * Thêm hoặc cập nhật nhân sự
 */
export async function upsertEmployees(employees, companyId) {
  companyId = requireTenantCompanyId(companyId)
  const rows = employees.map(emp => ({
    company_id: companyId,
    ma_nhan_vien: String(emp.ma_nhan_vien || emp.maNV || '').trim(),
    ho_ten: String(emp.ho_ten || emp.name || '').trim(),
    chuc_vu: emp.chuc_vu || emp.position || '',
    bo_phan: emp.bo_phan || emp.department || '',
    ca_lam: emp.ca_lam || emp.shift || 'Ca ngày',
    // Giữ nguyên trạng thái HR nhập; hồ sơ rỗng không được gán mặc định.
    trang_thai: String(
      emp.trang_thai ?? emp.employmentStatus ?? emp.employment_status ?? emp.status ?? ''
    ).trim(),
    updated_at: new Date().toISOString()
  }))

  const { data, error } = await supabase
    .from('nhan_su')
    .upsert(rows, { onConflict: 'company_id,ma_nhan_vien' })
    .select()

  if (error) {
    throw new Error('Không thể cập nhật nhân sự: ' + error.message)
  }
  return data
}

/**
 * Lấy dữ liệu chấm công chi tiết theo tháng (Ma trận 31 ngày)
 */
export async function getMonthlyAttendance(yearMonth, companyId) {
  companyId = requireTenantCompanyId(companyId)
  const [year, month] = yearMonth.split('-').map(Number)
  const startDate = `${yearMonth}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const endDate = `${yearMonth}-${String(lastDay).padStart(2, '0')}`

  const { data: logs, error: logsError } = await supabase
    .from('cham_cong')
    .select('*, nhan_su(id, ma_nhan_vien, ho_ten, chuc_vu, bo_phan, ca_lam)')
    .eq('company_id', companyId)
    .gte('ngay', startDate)
    .lte('ngay', endDate)
    .order('ngay', { ascending: true })

  if (logsError) {
    console.error('getMonthlyAttendance error:', logsError.message)
    return { logs: [], summaries: [] }
  }

  const { data: summaries, error: sumError } = await supabase
    .from('bang_cong_thang')
    .select('*, nhan_su(id, ma_nhan_vien, ho_ten, chuc_vu, bo_phan, ca_lam)')
    .eq('company_id', companyId)
    .eq('thang', yearMonth)

  if (sumError) {
    console.warn('getMonthlySummaries error:', sumError.message)
  }

  return {
    logs: logs || [],
    summaries: summaries || []
  }
}

/**
 * Lưu danh sách chấm công ma trận vào Supabase B
 */
export async function saveAttendanceBatch(records, companyId) {
  companyId = requireTenantCompanyId(companyId)
  if (!records || records.length === 0) return []

  // Đảm bảo có company_id
  const payload = records.map(r => ({
    ...r,
    company_id: companyId,
    updated_at: new Date().toISOString()
  }))

  // Chia batch 500 records
  const BATCH_SIZE = 500
  const results = []

  for (let i = 0; i < payload.length; i += BATCH_SIZE) {
    const batch = payload.slice(i, i + BATCH_SIZE)
    const { data, error } = await supabase
      .from('cham_cong')
      .upsert(batch, { onConflict: 'company_id,nhan_su_id,ngay' })
      .select()

    if (error) {
      throw new Error('Lỗi khi lưu bảng chấm công: ' + error.message)
    }
    if (data) results.push(...data)
  }

  return results
}

/**
 * Lưu bảng tổng hợp công tháng vào Supabase B
 */
export async function saveMonthlySummaryBatch(summaries, companyId) {
  companyId = requireTenantCompanyId(companyId)
  if (!summaries || summaries.length === 0) return []

  const payload = summaries.map(s => ({
    company_id: companyId,
    nhan_su_id: s.nhan_su_id,
    thang: s.thang,
    tong_cong: Number(s.tong_cong) || 0,
    tang_ca: Number(s.tang_ca) || 0,
    phep_su_dung: Number(s.phep_su_dung) || 0,
    cong_lam_le: Number(s.cong_lam_le) || 0,
    cong_le: Number(s.cong_le) || 0,
    so_lan_tre_som: Number(s.so_lan_tre_som) || 0,
    phut_tre_som: Number(s.phut_tre_som) || 0,
    xac_nhan: Boolean(s.xac_nhan),
    ghi_chu: s.ghi_chu || s.notes || '',
    updated_at: new Date().toISOString()
  }))

  const { data, error } = await supabase
    .from('bang_cong_thang')
    .upsert(payload, { onConflict: 'company_id,nhan_su_id,thang' })
    .select()

  if (error) {
    throw new Error('Lỗi khi lưu bảng tổng hợp tháng: ' + error.message)
  }
  return data
}
