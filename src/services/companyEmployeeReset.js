import { supabase } from './supabase'

const request = async (method, body) => {
  const { data: { session }, error } = await supabase.auth.getSession()
  if (error || !session?.access_token) throw new Error('Phiên đăng nhập đã hết hạn.')
  const response = await fetch('/api/employee-reset', {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'Không xử lý được yêu cầu xóa nhân sự.')
  return result
}

export const getCompanyEmployeeResetPreview = () => request('GET')
export const resetCompanyEmployees = (confirmation, expectedCounts) =>
  request('DELETE', { confirmation, expectedCounts })
