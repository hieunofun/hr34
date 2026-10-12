const COMPANY_32_ID = '00000000-0000-0000-0000-000000000032'

export const usesCustomAttendancePeriod = companyId => String(companyId || '').trim() === COMPANY_32_ID

export const maxAttendancePeriodDays = companyId => usesCustomAttendancePeriod(companyId) ? 32 : 31
