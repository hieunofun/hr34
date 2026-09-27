let activeTenant = null

export function setTenantSession(authUserId, companyId) {
  const userId = String(authUserId || '').trim()
  const tenantId = String(companyId || '').trim()
  activeTenant = userId && tenantId ? { authUserId: userId, companyId: tenantId } : null
}

export function getTenantSession() {
  return activeTenant
}

export function requireTenantCompanyId(candidate) {
  if (!activeTenant?.companyId) throw new Error('Chưa xác định công ty từ phiên đăng nhập.')
  if (candidate != null && String(candidate).trim() !== activeTenant.companyId) {
    throw new Error('Mã công ty không khớp phiên đăng nhập.')
  }
  return activeTenant.companyId
}
