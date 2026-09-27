import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const send = (res, status, payload) => res.status(status)
  .setHeader('Cache-Control', 'no-store').json(payload)
const failure = (message, status = 400) => Object.assign(new Error(message), { status })
const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const validDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}
const dataOf = (result, label) => {
  if (result.error) throw failure(`${label}: ${result.error.message}`, 500)
  return result.data
}
const cleanText = (value, label, max) => {
  const text = String(value || '').trim()
  if (!text || text.length > max) throw failure(`${label} phải có từ 1 đến ${max} ký tự.`)
  return text
}

export async function handleEmployeeRequests(db, actorAuthId, method, input = {}) {
  const actor = dataOf(await db.from('users').select('id,name,role,company_id')
    .eq('auth_user_id', actorAuthId).maybeSingle(), 'Kiểm tra tài khoản')
  if (!actor?.company_id || !['user', 'admin'].includes(actor.role)) {
    throw failure('Tài khoản không có quyền sử dụng yêu cầu.', 403)
  }
  if (method === 'GET') {
    let query = db.from('hr_records').select('id,data,updated_at')
      .eq('company_id', actor.company_id).eq('collection', 'approvalRequests')
      .order('updated_at', { ascending: false }).limit(200)
    if (actor.role === 'user') query = query.contains('data', { requesterId: actor.id })
    const rows = dataOf(await query, 'Tải yêu cầu') || []
    return rows.map(row => ({ ...row.data, id: row.id }))
  }
  if (input.companyId !== undefined || input.company_id !== undefined) {
    throw failure('Không nhận company_id từ trình duyệt.')
  }
  if (method === 'POST') {
    if (actor.role !== 'user') throw failure('Chỉ nhân viên được gửi yêu cầu từ trang này.', 403)
    const kind = input.kind
    if (!['leave', 'proposal'].includes(kind)) throw failure('Loại yêu cầu không hợp lệ.')
    const subject = cleanText(input.subject, 'Tiêu đề', 160)
    const content = cleanText(input.content, 'Nội dung', 3000)
    const leaveStartDate = kind === 'leave' ? String(input.leaveStartDate || '') : null
    const leaveEndDate = kind === 'leave' ? String(input.leaveEndDate || '') : null
    if (kind === 'leave' && (!validDate(leaveStartDate) || !validDate(leaveEndDate) ||
      leaveEndDate < leaveStartDate)) throw failure('Khoảng ngày nghỉ không hợp lệ.')
    const now = new Date().toISOString()
    const id = `${actor.company_id}::approvalRequests::${randomUUID()}`
    const data = { kind, subject, content, requesterId: actor.id,
      requesterName: actor.name, status: 'pending', createdAt: now,
      ...(kind === 'leave' ? { leaveStartDate, leaveEndDate } : {}) }
    dataOf(await db.from('hr_records').insert({ id, company_id: actor.company_id,
      collection: 'approvalRequests', data, updated_at: now }), 'Gửi yêu cầu')
    return { id, ...data }
  }
  if (method === 'PATCH') {
    if (actor.role !== 'admin') throw failure('Chỉ Admin công ty được duyệt yêu cầu.', 403)
    if (typeof input.id !== 'string' || !requestId.test(input.id.split('::').at(-1))) {
      throw failure('Mã yêu cầu không hợp lệ.')
    }
    if (!['approved', 'rejected'].includes(input.status)) throw failure('Trạng thái không hợp lệ.')
    const existing = dataOf(await db.from('hr_records').select('id,data')
      .eq('id', input.id).eq('company_id', actor.company_id)
      .eq('collection', 'approvalRequests').maybeSingle(), 'Kiểm tra yêu cầu')
    if (!existing) throw failure('Không tìm thấy yêu cầu trong công ty.', 404)
    if (existing.data?.status !== 'pending') throw failure('Yêu cầu đã được xử lý.', 409)
    const now = new Date().toISOString()
    const data = { ...existing.data, status: input.status, decidedAt: now,
      decidedById: actor.id }
    const updated = dataOf(await db.from('hr_records').update({ data, updated_at: now })
      .eq('id', input.id).eq('company_id', actor.company_id)
      .eq('collection', 'approvalRequests').contains('data', { status: 'pending' })
      .select('id').maybeSingle(), 'Duyệt yêu cầu')
    if (!updated) throw failure('Yêu cầu đã thay đổi; tải lại trang.', 409)
    return { id: input.id, ...data }
  }
  throw failure('Phương thức không hợp lệ.', 405)
}

export default async function handler(req, res) {
  if (!['GET', 'POST', 'PATCH'].includes(req.method)) return send(res, 405, { error: 'Phương thức không hợp lệ.' })
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return send(res, 503, { error: 'API yêu cầu chưa được cấu hình.' })
  const token = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1]
  if (!token) return send(res, 401, { error: 'Vui lòng đăng nhập.' })
  try {
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: { user }, error } = await db.auth.getUser(token)
    if (error || !user) return send(res, 401, { error: 'Phiên đăng nhập không hợp lệ.' })
    const result = await handleEmployeeRequests(db, user.id, req.method, req.body || {})
    return send(res, req.method === 'POST' ? 201 : 200,
      req.method === 'GET' ? { requests: result } : { request: result })
  } catch (error) {
    if ((error.status || 500) >= 500) console.error('Employee requests API error', error)
    return send(res, error.status || 500, { error: error.message || 'Không xử lý được yêu cầu.' })
  }
}
