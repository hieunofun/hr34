import { createClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'

const respond = (res, status, body) => {
  res.status(status).setHeader('Cache-Control', 'no-store').json(body)
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const makeEmployeeUsername = name => {
  const slug = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '')
    .slice(0, 32) || 'nhanvien'
  return `${slug}.${randomBytes(4).toString('hex')}`
}

const dataOf = (result, label) => {
  if (result.error) throw fail(`${label}: ${result.error.message}`, 500)
  return result.data
}

export async function provisionEmployeeAccount(db, actorAuthId, input) {
  if (!uuid.test(String(input?.profileId || ''))) throw fail('Hồ sơ nhân viên không hợp lệ.')
  if (input.companyId !== undefined || input.company_id !== undefined) {
    throw fail('Không nhận company_id từ trình duyệt.')
  }
  const email = String(input.email || '').trim().toLowerCase()
  if (!emailPattern.test(email) || email.length > 254) throw fail('Email đăng nhập không hợp lệ.')
  const password = input.password
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw fail('Mật khẩu phải từ 8 đến 128 ký tự.')
  }

  const actor = dataOf(await db.from('users').select('id,company_id,role')
    .eq('auth_user_id', actorAuthId).maybeSingle(), 'Kiểm tra Admin')
  if (!actor || actor.role !== 'admin' || !actor.company_id) throw fail('Chỉ Admin công ty được cấp tài khoản.', 403)
  const profile = dataOf(await db.from('users').select('id,company_id,name,employee_id,role,auth_user_id')
    .eq('id', input.profileId).eq('company_id', actor.company_id).maybeSingle(), 'Kiểm tra hồ sơ')
  if (!profile || profile.role !== 'user' || profile.auth_user_id || !profile.employee_id) {
    throw fail('Hồ sơ nhân viên không thuộc công ty này hoặc đã có tài khoản.', 409)
  }
  const employee = dataOf(await db.from('nhan_su').select('id').eq('company_id', actor.company_id)
    .eq('ma_nhan_vien', profile.employee_id).maybeSingle(), 'Kiểm tra nhân sự')
  if (!employee) throw fail('Mã nhân viên chưa liên kết với bảng nhân sự.', 409)

  const username = makeEmployeeUsername(profile.name)
  const authResult = await db.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { name: profile.name }
  })
  if (authResult.error || !authResult.data?.user?.id) {
    throw fail('Không tạo được tài khoản Auth. Kiểm tra email hoặc cấu hình Supabase.', 409)
  }
  const authId = authResult.data.user.id
  const { data: linked, error: linkError } = await db.from('users')
    .update({ auth_user_id: authId, email, username, password: null })
    .eq('id', profile.id).eq('company_id', actor.company_id).is('auth_user_id', null)
    .select('id').maybeSingle()
  if (linkError || !linked) {
    // Không xóa tài khoản Auth vừa tạo: cần điều tra và xử lý có kiểm soát.
    console.error('Employee Auth created but profile link failed', { authId, profileId: profile.id, code: linkError?.code })
    throw fail('Auth đã tạo nhưng chưa gắn được hồ sơ. Liên hệ quản trị hệ thống; không tạo lại.', 500)
  }
  return { profileId: profile.id, username, email, companyId: actor.company_id, role: 'user' }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return respond(res, 405, { error: 'Phương thức không hợp lệ.' })
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return respond(res, 503, { error: 'API cấp tài khoản chưa được cấu hình.' })
  const token = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1]
  if (!token) return respond(res, 401, { error: 'Vui lòng đăng nhập.' })
  try {
    const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: { user }, error } = await db.auth.getUser(token)
    if (error || !user) return respond(res, 401, { error: 'Phiên đăng nhập không hợp lệ.' })
    const result = await provisionEmployeeAccount(db, user.id, req.body || {})
    return respond(res, 201, { account: result })
  } catch (error) {
    if ((error.status || 500) >= 500) console.error('Employee account API error', error)
    return respond(res, error.status || 500, { error: error.message || 'Không cấp được tài khoản.' })
  }
}
