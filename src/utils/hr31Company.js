const HR31_COMPANY_ID = '00000000-0000-0000-0000-000000000031'

export const isHr31CompanyId = companyId => String(companyId || '').trim() === HR31_COMPANY_ID
