import { createClient } from '@supabase/supabase-js'

const ATTENDANCE_COLLECTIONS = [
  'attendanceLogs', 'attendanceAdjustments', 'manualWorkdays',
  'attendanceMonthSummaries', 'attendanceMonthConfirmations',
  'attendanceMonthPenalties'
]
const DELETABLE_ROLES = ['user', 'hr', 'manager']
const COUNT_KEYS = ['users', 'nhan_su', 'cham_cong', 'attendanceRecords', 'penalties', 'statusHistory', 'adminAccounts']

const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const dataOf = (result, label) => {
  if (result.error) throw fail(`${label}: ${result.error.message}`, 500)
  return result.data
}

const readAllUsers = async (db, companyId) => {
  const users = []
  for (let from = 0; ; from += 1000) {
    const page = dataOf(await db.from('users')
      .select('id,role,auth_user_id').eq('company_id', companyId)
      .order('id').range(from, from + 999), 'Đọc hồ sơ nhân sự') || []
    users.push(...page)
    if (page.length < 1000) return users
  }
}

const countRows = async (db, table, companyId, collections) => {
  let query = db.from(table).select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
  if (collections) query = query.in('collection', collections)
  const result = await query
  if (result.error) throw fail(`Đếm ${table}: ${result.error.message}`, 500)
  return result.count || 0
}

export async function getEmployeeResetPreview(db, actorAuthId) {
  const actor = dataOf(await db.from('users').select('id,company_id,role')
    .eq('auth_user_id', actorAuthId).maybeSingle(), 'Kiểm tra tài khoản')
  if (!actor?.company_id || actor.role !== 'admin') {
    throw fail('Chỉ Admin công ty được xóa dữ liệu nhân sự.', 403)
  }
  const company = dataOf(await db.from('companies').select('id,code,name')
    .eq('id', actor.company_id).single(), 'Kiểm tra công ty')
  if (!company?.code) throw fail('Công ty chưa có mã để xác nhận xóa.', 409)

  const users = await readAllUsers(db, company.id)
  const counts = {
    users: users.filter(row => DELETABLE_ROLES.includes(row.role)).length,
    adminAccounts: users.filter(row => row.role === 'admin').length,
    nhan_su: await countRows(db, 'nhan_su', company.id),
    cham_cong: await countRows(db, 'cham_cong', company.id),
    attendanceRecords: await countRows(db, 'hr_records', company.id, ATTENDANCE_COLLECTIONS),
    penalties: await countRows(db, 'attendance_penalties', company.id),
    statusHistory: await countRows(db, 'employee_status_history', company.id)
  }
  return { companyId: company.id, company: { code: company.code, name: company.name }, counts, users }
}

const deleteRows = async (db, table, companyId, collections) => {
  let query = db.from(table).delete().eq('company_id', companyId)
  if (collections) query = query.in('collection', collections)
  dataOf(await query, `Xóa ${table}`)
}

export async function resetCompanyEmployees(db, actorAuthId, input) {
  const preview = await getEmployeeResetPreview(db, actorAuthId)
  if (input?.companyId !== undefined || input?.company_id !== undefined) {
    throw fail('Không nhận company_id từ trình duyệt.')
  }
  if (input?.confirmation !== preview.company.code ||
    !COUNT_KEYS.every(key => input?.expectedCounts?.[key] === preview.counts[key])) {
    throw fail('Mã công ty hoặc số lượng dữ liệu đã thay đổi. Tải lại trước khi xóa.', 409)
  }
  // company_id comes from the verified actor, never from the browser.
  const targetCompanyId = preview.companyId
  const targetUsers = preview.users.filter(row => DELETABLE_ROLES.includes(row.role))

  await deleteRows(db, 'hr_records', targetCompanyId, ATTENDANCE_COLLECTIONS)
  await deleteRows(db, 'attendance_penalties', targetCompanyId)
  await deleteRows(db, 'cham_cong', targetCompanyId)
  await deleteRows(db, 'nhan_su', targetCompanyId)
  await deleteRows(db, 'employee_status_history', targetCompanyId)

  for (const row of targetUsers) {
    if (!row.auth_user_id) continue
    const removed = await db.auth.admin.deleteUser(row.auth_user_id)
    if (removed.error && removed.error.status !== 404) {
      throw fail(`Không xóa được tài khoản đăng nhập của nhân viên: ${removed.error.message}`, 500)
    }
  }
  for (let index = 0; index < targetUsers.length; index += 200) {
    const ids = targetUsers.slice(index, index + 200).map(row => row.id)
    dataOf(await db.from('users').delete().eq('company_id', targetCompanyId)
      .in('role', DELETABLE_ROLES).in('id', ids), 'Xóa hồ sơ nhân viên')
  }

  const after = await getEmployeeResetPreview(db, actorAuthId)
  if (after.counts.adminAccounts !== preview.counts.adminAccounts ||
    COUNT_KEYS.filter(key => key !== 'adminAccounts').some(key => after.counts[key] !== 0)) {
    throw fail('Đã xóa một phần dữ liệu. Hãy tải lại và kiểm tra số còn lại.', 500)
  }
  return { deleted: preview.counts, adminAccountsKept: after.counts.adminAccounts }
}

export default async function handler(req, res) {
  const respond = (status, body) => res.status(status).setHeader('Cache-Control', 'no-store').json(body)
  if (!['GET', 'DELETE'].includes(req.method)) return respond(405, { error: 'Phương thức không hợp lệ.' })
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return respond(503, { error: 'API xóa nhân sự chưa được cấu hình.' })
  const token = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1]
  if (!token) return respond(401, { error: 'Vui lòng đăng nhập.' })

  try {
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: { user }, error } = await db.auth.getUser(token)
    if (error || !user) return respond(401, { error: 'Phiên đăng nhập không hợp lệ.' })
    if (req.method === 'GET') {
      const { company, counts } = await getEmployeeResetPreview(db, user.id)
      return respond(200, { company, counts })
    }
    const result = await resetCompanyEmployees(db, user.id, req.body || {})
    return respond(200, result)
  } catch (error) {
    if ((error.status || 500) >= 500) console.error('Employee reset API error', error)
    return respond(error.status || 500, { error: error.message || 'Không xóa được dữ liệu nhân sự.' })
  }
}
