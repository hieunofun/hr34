import { supabase } from './supabase'
import { requireTenantCompanyId } from './tenantSession'
import { mapAppToUser, mapUserToApp } from '../utils/helpers'

/**
 * Supabase-backed storage with the same API as the old Firebase helpers.
 * All former `hr/*` collections live in `public.hr_records`.
 * `employees` maps to `public.users`.
 */

const genId = () =>
  `-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 11)}`

const rowId = (collection, id) => `${collection}::${id}`
const requireCompanyId = requireTenantCompanyId
const scopedRowPrefix = (collection, companyId) =>
  `${requireCompanyId(companyId)}::${collection}::`
const scopedRowId = (collection, id, companyId) =>
  `${scopedRowPrefix(collection, companyId)}${id}`
const isScopedRecord = (row, collection, companyId) =>
  row.id.startsWith(scopedRowPrefix(collection, companyId))
const logicalRecordId = (id, collection, companyId) => {
  const selectedPrefix = scopedRowPrefix(collection, companyId)
  if (companyId && id.startsWith(selectedPrefix)) return id.slice(selectedPrefix.length)
  const legacyPrefix = `${collection}::`
  return id.startsWith(legacyPrefix) ? id.slice(legacyPrefix.length) : id
}

function normalizePath(path = '') {
  return String(path || '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

function parsePath(path) {
  const parts = normalizePath(path).split('/').filter(Boolean)
  if (!parts.length) return { kind: 'empty' }

  if (parts[0] === 'employees') {
    return { kind: 'employees', id: parts[1] || null }
  }

  if (parts[0] === 'hr') {
    if (parts.length === 1) return { kind: 'hr_root' }
    const collection = parts[1]
    if (parts.length === 2) return { kind: 'collection', collection }

    // hr/manualWorkdays/{month} loads all per-employee overrides in that month.
    if (collection === 'manualWorkdays' && parts.length === 3) {
      return {
        kind: 'manual_workdays_month',
        collection,
        month: parts[2]
      }
    }

    // hr/manualWorkdays/{month}/{empId}
    if (collection === 'manualWorkdays' && parts.length >= 4) {
      return {
        kind: 'record',
        collection: 'manualWorkdays',
        id: `${parts[2]}__${parts[3]}`
      }
    }

    // hr/{collection}/{id...}
    return {
      kind: 'record',
      collection,
      id: parts.slice(2).join('__')
    }
  }

  if (parts.length === 1) return { kind: 'collection', collection: parts[0] }
  return { kind: 'record', collection: parts[0], id: parts.slice(1).join('__') }
}

async function readCollectionRows(collection, companyId) {
  // Supabase/PostgREST mặc định max 1000 dòng/request — phải phân trang + order ổn định.
  const tenantId = requireCompanyId(companyId)
  const pageSize = 1000
  const rows = []

  let expectedCount = null
  let fetchedCount = 0
  for (let from = 0; ; from += pageSize) {
    const { data, error, count } = await supabase
      .from('hr_records')
      .select('id, data', from === 0 ? { count: 'exact' } : undefined)
      .eq('company_id', tenantId)
      .eq('collection', collection)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1)

    if (error) throw error
    if (from === 0 && typeof count === 'number') expectedCount = count
    fetchedCount += data?.length || 0
    rows.push(...(data || []))
    if (!data || data.length < pageSize) break
  }
  if (typeof expectedCount === 'number' && fetchedCount < expectedCount) {
    console.warn(
      `[listCollection:${collection}] thiếu dữ liệu: lấy ${fetchedCount}/${expectedCount}`
    )
  }

  return rows.sort((left, right) =>
    Number(isScopedRecord(left, collection, tenantId)) -
    Number(isScopedRecord(right, collection, tenantId))
  )
}

async function listCollection(collection, companyId) {
  const rows = await readCollectionRows(collection, companyId)
  const out = {}
  rows.forEach(row => { out[logicalRecordId(row.id, collection, companyId)] = row.data || {} })
  return Object.keys(out).length ? out : null
}

async function getRecordRow(collection, id, companyId) {
  const tenantId = requireCompanyId(companyId)
  const scopedId = scopedRowId(collection, id, tenantId)
  const legacyId = rowId(collection, id)
  const { data, error } = await supabase
    .from('hr_records')
    .select('id, data')
    .eq('collection', collection)
    .eq('company_id', tenantId)
    .in('id', [...new Set([scopedId, legacyId])])
    .limit(2)

  if (error) throw error
  return (data || []).find(row => row.id === scopedId) || data?.[0] || null
}

async function getRecord(collection, id, companyId) {
  const row = await getRecordRow(collection, id, companyId)
  return row?.data ?? null
}

async function listManualWorkdaysByMonth(month, companyId) {
  const out = { ...((await getRecord('manualWorkdays', month, companyId)) || {}) }
  const rows = await readCollectionRows('manualWorkdays', companyId)
  rows.forEach(row => {
    const logicalId = logicalRecordId(row.id, 'manualWorkdays', companyId)
    const monthPrefix = `${month}__`
    if (!logicalId.startsWith(monthPrefix)) return
    const employeeId = logicalId.slice(monthPrefix.length)
    if (employeeId) out[employeeId] = row.data || {}
  })
  return Object.keys(out).length ? out : null
}

async function upsertRecord(collection, physicalId, data, companyId) {
  const tenantId = requireCompanyId(companyId)
  const { error } = await supabase.from('hr_records').upsert(
    {
      id: physicalId,
      collection,
      company_id: tenantId,
      data,
      updated_at: new Date().toISOString()
    },
    { onConflict: 'id' }
  )
  if (error) throw error
}

async function setRecord(collection, id, data, companyId) {
  const existing = await getRecordRow(collection, id, companyId)
  await upsertRecord(
    collection,
    existing?.id || scopedRowId(collection, id, companyId),
    data,
    companyId
  )
}

async function patchRecord(collection, id, patch, companyId) {
  const existing = await getRecordRow(collection, id, companyId)
  const next = { ...(existing?.data || {}), ...(patch || {}) }
  await upsertRecord(
    collection,
    existing?.id || scopedRowId(collection, id, companyId),
    next,
    companyId
  )
  return next
}

async function deleteRecord(collection, id, companyId) {
  const tenantId = requireCompanyId(companyId)
  const ids = [scopedRowId(collection, id, tenantId), rowId(collection, id)]
  for (const idValue of [...new Set(ids)]) {
    const { error } = await supabase
      .from('hr_records')
      .delete()
      .eq('id', idValue)
      .eq('company_id', tenantId)
      .eq('collection', collection)
    if (error) throw error
  }
}

async function deleteCollection(collection, companyId) {
  const tenantId = requireCompanyId(companyId)
  const rows = await readCollectionRows(collection, tenantId)
  const ids = rows.map(row => row.id)
  for (let index = 0; index < ids.length; index += 500) {
    const { error } = await supabase
      .from('hr_records')
      .delete()
      .in('id', ids.slice(index, index + 500))
      .eq('company_id', tenantId)
      .eq('collection', collection)
    if (error) throw error
  }
}

async function listEmployeesAsFirebaseMap(companyId) {
  // YÊU CẦU: Bảng công chỉ được lấy nhân sự từ bảng nhan_su.
  // Không được join hoặc đưa các tài khoản hệ thống từ bảng users vào bảng công.
  const tenantId = requireCompanyId(companyId)
  const query = supabase.from('nhan_su').select('*').eq('company_id', tenantId)
  const { data, error } = await query.order('ma_nhan_vien', { ascending: true })

  if (error) throw error
  if (!data?.length) return null

  const out = {}
  data.forEach((ns) => {
    const employmentStatus = String(ns.trang_thai ?? '').trim()
    out[ns.id] = {
      id: ns.id,
      employeeId: ns.ma_nhan_vien || '',
      employeeCode: ns.ma_nhan_vien || '',
      ma_nhan_vien: ns.ma_nhan_vien || '',
      username: ns.ma_nhan_vien || '',
      name: ns.ho_ten || '',
      ho_va_ten: ns.ho_ten || '',
      ho_ten: ns.ho_ten || '',
      email: ns.email || '',
      phone: ns.so_dien_thoai || '',
      sđt: ns.so_dien_thoai || '',
      position: ns.chuc_vu || '',
      vi_tri: ns.chuc_vu || '',
      chuc_vu: ns.chuc_vu || '',
      department: ns.bo_phan || '',
      bo_phan: ns.bo_phan || '',
      shift: ns.ca_lam || 'Ca ngày',
      ca_lam_viec: ns.ca_lam || 'Ca ngày',
      // Trạng thái do HR đánh dấu; dữ liệu rỗng phải giữ rỗng, không suy diễn
      // thành "Đang làm việc" hay "Chính thức".
      status: employmentStatus,
      trang_thai: employmentStatus,
      joinDate: ns.ngay_vao_lam || '',
      ngay_vao_lam: ns.ngay_vao_lam || '',
      avatarDataUrl: ns.avatar_url || ''
    }
  })
  return out
}

export const fbGetEmployeesDirectory = companyId => listEmployeesAsFirebaseMap(requireCompanyId(companyId))

async function pushEmployee(payload, companyId) {
  const tenantId = requireCompanyId(companyId)
  const id = crypto.randomUUID()
  const dbPayload = mapAppToUser(payload || {}) || {}
  dbPayload.id = id
  if (!dbPayload.employee_id && payload?.employeeId) {
    dbPayload.employee_id = payload.employeeId
  }
  if (!dbPayload.role) dbPayload.role = payload?.role || 'user'
  dbPayload.company_id = tenantId

  const { error } = await supabase.from('users').insert([dbPayload])
  if (error) throw error
  return { name: id }
}

async function getHrRoot(companyId) {
  const tenantId = requireCompanyId(companyId)
  const query = supabase
    .from('hr_records')
    .select('id, collection, data')
    .eq('company_id', tenantId)
  const { data, error } = await query
  if (error) throw error

  const root = {}
  const applicableRows = [...(data || [])].sort((left, right) => {
    const leftIsScoped = Boolean(companyId && left.id.startsWith(scopedRowPrefix(left.collection, companyId)))
    const rightIsScoped = Boolean(companyId && right.id.startsWith(scopedRowPrefix(right.collection, companyId)))
    return Number(leftIsScoped) - Number(rightIsScoped)
  })
  ;applicableRows.forEach((row) => {
    const collection = row.collection
    const logicalId = logicalRecordId(row.id, collection, companyId)
    if (!root[collection]) root[collection] = {}
    root[collection][logicalId] = row.data || {}
  })
  return Object.keys(root).length ? root : null
}

export const fbGet = async (path, companyId) => {
  companyId = requireCompanyId(companyId)
  const parsed = parsePath(path)

  if (parsed.kind === 'employees') {
    if (parsed.id) {
      const query = supabase.from('nhan_su').select('*')
        .eq('id', parsed.id)
        .eq('company_id', requireCompanyId(companyId))
      const { data, error } = await query.maybeSingle()
      if (error) throw error
      if (!data) return null
      const employmentStatus = String(data.trang_thai ?? '').trim()
      return {
        id: data.id,
        employeeId: data.ma_nhan_vien || '',
        employeeCode: data.ma_nhan_vien || '',
        name: data.ho_ten || '',
        ho_va_ten: data.ho_ten || '',
        position: data.chuc_vu || '',
        department: data.bo_phan || '',
        shift: data.ca_lam || 'Ca ngày',
        status: employmentStatus,
        trang_thai: employmentStatus
      }
    }
    return listEmployeesAsFirebaseMap(companyId)
  }

  if (parsed.kind === 'hr_root') return getHrRoot(companyId)

  if (parsed.kind === 'manual_workdays_month') {
    return listManualWorkdaysByMonth(parsed.month, companyId)
  }

  if (parsed.kind === 'collection') {
    return listCollection(parsed.collection, companyId)
  }

  if (parsed.kind === 'record') {
    return getRecord(parsed.collection, parsed.id, companyId)
  }

  return null
}

export const fbGetAttendanceByEmployee = async (employeeId, companyId) => {
  companyId = requireCompanyId(companyId)
  const ownerId = String(employeeId || '').trim()
  if (!ownerId) return null
  const tenantId = requireCompanyId(companyId)
  const rows = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('hr_records')
      .select('id, data')
      .eq('company_id', tenantId)
      .eq('collection', 'attendanceLogs')
      .contains('data', { employeeId: ownerId })
      .order('id')
      .range(from, from + pageSize - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < pageSize) break
  }
  const out = {}
  rows.forEach(row => {
    out[logicalRecordId(row.id, 'attendanceLogs', companyId)] = row.data || {}
  })
  return Object.keys(out).length ? out : null
}

/**
 * Load attendance logs for one YYYY-MM (filters by data.date prefix).
 * Ưu tiên log Excel/online trong hr_records; dùng cham_cong làm fallback
 * cho dữ liệu cũ chưa có log mềm.
 */
export const fbGetAttendanceLogsByMonth = async (month, companyId, attendancePeriod = null) => {
  companyId = requireCompanyId(companyId)
  const period = String(month || '').trim()
  if (!/^\d{4}-\d{2}$/.test(period)) return null
  const tenantId = requireCompanyId(companyId)
  const [year, monthNumber] = period.split('-').map(Number)
  const lastDay = String(new Date(year, monthNumber, 0).getDate()).padStart(2, '0')
  const startDate = attendancePeriod?.startDate || `${period}-01`
  const endDate = attendancePeriod?.endDate || `${period}-${lastDay}`

  // Ưu tiên log Excel/online trong hr_records. Bảng cham_cong có thể chỉ
  // chứa các dòng cũ thiếu giờ; nếu thấy dữ liệu ở đây thì dùng nó để tính
  // công và hiển thị chi tiết, tránh làm tổng công về 0.
  try {
    const rows = []
    const pageSize = 1000
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('hr_records')
        .select('id, data')
        .eq('company_id', tenantId)
        .eq('collection', 'attendanceLogs')
        .gte('data->>date', startDate)
        .lte('data->>date', endDate)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1)
      if (error) throw error
      rows.push(...(data || []))
      if (!data || data.length < pageSize) break
    }
    if (rows.length > 0) {
      const out = {}
      rows.forEach(row => {
        out[logicalRecordId(row.id, 'attendanceLogs', companyId)] = row.data || {}
      })
      return out
    }
  } catch (err) {
    console.warn('[fbGetAttendanceLogsByMonth] Lỗi đọc log hr_records:', err)
  }

  // Nếu chưa có log mềm thì đọc bảng cham_cong chính thức liên kết với nhan_su.
  try {
    let query = supabase
      .from('cham_cong')
      .select('*, nhan_su(id, ma_nhan_vien, ho_ten, chuc_vu, bo_phan, ca_lam)')
      .gte('ngay', startDate)
      .lte('ngay', endDate)
    query = query.eq('company_id', tenantId)
    const { data: ccData, error: ccErr } = await query.order('ngay', { ascending: true })

    if (!ccErr && ccData && ccData.length > 0) {
      const out = {}
      ccData.forEach((row) => {
        const ns = row.nhan_su || {}
        out[row.id] = {
          id: row.id,
          employeeId: row.nhan_su_id,
          employeeCode: ns.ma_nhan_vien || '',
          employeeName: ns.ho_ten || '',
          sourceEmployeeCode: ns.ma_nhan_vien || '',
          sourceEmployeeName: ns.ho_ten || '',
          department: ns.bo_phan || '',
          position: ns.chuc_vu || '',
          date: row.ngay,
          checkIn: row.gio_vao || '',
          checkOut: row.gio_ra || '',
          cong: Number(row.tong_cong) || 0,
          hours: Number(row.gia_tri_goc) || (Number(row.tong_cong) * 8) || 0,
          giaTriGoc: row.gia_tri_goc || '',
          rawVal: row.gia_tri_goc || '',
          shiftName: row.ca_lam || ns.ca_lam || 'Ca ngày',
          tangCa: Number(row.tang_ca) || 0,
          phepSuDung: Number(row.phep_su_dung) || 0,
          congLamLe: Number(row.cong_lam_le) || 0,
          congLe: Number(row.cong_le) || 0,
          status: row.notes || (Number(row.tong_cong) >= 1 ? 'Đủ' : Number(row.tong_cong) > 0 ? 'Nửa ngày' : 'Nghỉ'),
          notes: row.notes || '',
          xacNhan: row.xac_nhan || false
        }
      })
      return out
    }
  } catch (err) {
    console.warn('[fbGetAttendanceLogsByMonth] Lỗi đọc từ bảng cham_cong:', err)
  }

  const rows = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('hr_records')
      .select('id, data')
      .eq('company_id', tenantId)
      .eq('collection', 'attendanceLogs')
      .gte('data->>date', startDate)
      .lte('data->>date', endDate)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < pageSize) break
  }
  const out = {}
  rows.forEach(row => {
    out[logicalRecordId(row.id, 'attendanceLogs', companyId)] = row.data || {}
  })
  return Object.keys(out).length ? out : null
}

/** List logical ids in a collection without loading full JSON payloads. */
export const fbListCollectionIds = async (collection, companyId) => {
  companyId = requireCompanyId(companyId)
  const name = String(collection || '').trim()
  if (!name) return []
  const rows = await readCollectionRows(name, companyId)
  return Array.from(new Set(rows.map(row =>
    logicalRecordId(row.id, name, companyId)
  )))
}

export const fbSet = async (path, data, companyId) => {
  companyId = requireCompanyId(companyId)
  const parsed = parsePath(path)

  if (parsed.kind === 'record') {
    await setRecord(parsed.collection, parsed.id, data || {}, companyId)
    return
  }

  if (parsed.kind === 'collection') {
    const tenantId = requireCompanyId(companyId)
    await deleteCollection(parsed.collection, companyId)
    const entries = Object.entries(data || {})
    if (!entries.length) return
    const rows = entries.map(([id, value]) => ({
      id: scopedRowId(parsed.collection, id, companyId),
      collection: parsed.collection,
      company_id: tenantId,
      data: value || {},
      updated_at: new Date().toISOString()
    }))
    const { error } = await supabase.from('hr_records').upsert(rows, { onConflict: 'id' })
    if (error) throw error
    return
  }

  if (parsed.kind === 'employees' && parsed.id) {
    const tenantId = requireCompanyId(companyId)
    const dbPayload = { ...(mapAppToUser(data || {}) || {}), company_id: tenantId }
    const { error } = await supabase.from('users').update(dbPayload).eq('company_id', tenantId).eq('id', parsed.id)
    if (error) throw error
  }
}

export const fbPush = async (path, data, companyId) => {
  companyId = requireCompanyId(companyId)
  const parsed = parsePath(path)

  if (parsed.kind === 'employees') {
    return pushEmployee(data, companyId)
  }

  const collection =
    parsed.kind === 'collection'
      ? parsed.collection
      : parsed.kind === 'record'
        ? parsed.collection
        : normalizePath(path).replace(/^hr\//, '') || 'misc'

  const id = genId()
  await upsertRecord(collection, scopedRowId(collection, id, companyId), data || {}, companyId)
  return { name: id }
}

export const fbDelete = async (path, companyId) => {
  companyId = requireCompanyId(companyId)
  const parsed = parsePath(path)

  if (parsed.kind === 'employees' && parsed.id) {
    const tenantId = requireCompanyId(companyId)
    const { error } = await supabase.from('users').delete().eq('company_id', tenantId).eq('id', parsed.id)
    if (error) throw error
    return
  }

  if (parsed.kind === 'collection') {
    await deleteCollection(parsed.collection, companyId)
    return
  }

  if (parsed.kind === 'record') {
    await deleteRecord(parsed.collection, parsed.id, companyId)
  }
}

export const fbUpdate = async (path, data, companyId) => {
  companyId = requireCompanyId(companyId)
  const parsed = parsePath(path)

  if (parsed.kind === 'employees' && parsed.id) {
    const tenantId = requireCompanyId(companyId)
    const dbPayload = { ...(mapAppToUser(data || {}) || {}), company_id: tenantId }
    const { error } = await supabase.from('users').update(dbPayload).eq('company_id', tenantId).eq('id', parsed.id)
    if (error) throw error
    return
  }

  if (parsed.kind === 'record') {
    await patchRecord(parsed.collection, parsed.id, data || {}, companyId)
    return
  }

  if (parsed.kind === 'collection') {
    const entries = Object.entries(data || {})
    for (const [id, value] of entries) {
      await patchRecord(parsed.collection, id, value || {}, companyId)
    }
  }
}
