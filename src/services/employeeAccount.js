import { supabase } from './supabase'

export async function provisionEmployeeAccount({ profileId, email, password }) {
  const { data: { session }, error } = await supabase.auth.getSession()
  if (error || !session?.access_token) throw new Error('Phiên đăng nhập đã hết hạn.')
  const response = await fetch('/api/employee-account', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify({ profileId, email, password })
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'Không cấp được tài khoản đăng nhập.')
  return result.account
}
