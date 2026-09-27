export const GENERIC_HR_LOGO = '/hr-generic-logo.svg'
export const GENERIC_HR_NAME = 'Hệ thống nhân sự'

export function companyLogoSource(logoUrl) {
  const value = String(logoUrl || '').trim()
  if (!value) return GENERIC_HR_LOGO
  try {
    return new URL(value).protocol === 'https:' ? value : GENERIC_HR_LOGO
  } catch {
    return GENERIC_HR_LOGO
  }
}

export function companyDisplayName(name) {
  return String(name || '').trim() || GENERIC_HR_NAME
}
