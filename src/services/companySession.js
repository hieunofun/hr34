const invalidCompany = message => {
  const error = new Error(message)
  error.code = 'TENANT_CONTEXT_INVALID'
  return error
}

export async function loadCompanySession(client, authUser) {
  if (!authUser?.id) return null

  const { data: profile, error: profileError } = await client
    .from('users')
    .select('*')
    .eq('auth_user_id', authUser.id)
    .single()

  if (profileError?.code === 'PGRST116') {
    throw invalidCompany('Tài khoản đăng nhập chưa có hồ sơ nhân sự. Vui lòng liên hệ quản trị viên.')
  }
  if (profileError) throw profileError
  if (!profile) {
    throw invalidCompany('Tài khoản đăng nhập chưa có hồ sơ nhân sự. Vui lòng liên hệ quản trị viên.')
  }

  const companyId = String(profile.company_id || '').trim()
  if (!companyId) {
    throw invalidCompany('Hồ sơ đăng nhập chưa được gán công ty. Vui lòng liên hệ quản trị viên.')
  }

  const { data: company, error: companyError } = await client
    .from('companies')
    .select('*')
    .eq('id', companyId)
    .single()

  if (companyError?.code === 'PGRST116') {
    throw invalidCompany('Không tìm thấy công ty của tài khoản đăng nhập. Vui lòng liên hệ quản trị viên.')
  }
  if (companyError) throw companyError
  if (!company || company.id !== companyId) {
    throw invalidCompany('Không tìm thấy công ty của tài khoản đăng nhập. Vui lòng liên hệ quản trị viên.')
  }

  return { profile, company }
}
