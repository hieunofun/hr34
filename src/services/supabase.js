
import { createClient } from '@supabase/supabase-js'

const cleanEnv = (val) => (typeof val === 'string' ? val.replace(/^[\uFEFF\s]+|[\uFEFF\s]+$/g, '') : val)

const supabaseUrl = cleanEnv(import.meta.env.VITE_SUPABASE_URL)
const supabaseAnonKey = cleanEnv(import.meta.env.VITE_SUPABASE_ANON_KEY)

const SHARED_SUPABASE_HOST = 'abghublsyvuyangkyibz.supabase.co'
const COMPANY_ID_34 = '00000000-0000-0000-0000-000000000034'
const configuredCompanyId = cleanEnv(import.meta.env.VITE_DEFAULT_COMPANY_ID)

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Thiếu cấu hình Supabase cho HR34. Điền VITE_SUPABASE_URL và VITE_SUPABASE_ANON_KEY trong .env.local.'
  )
}

if (new URL(supabaseUrl).hostname !== SHARED_SUPABASE_HOST) {
  throw new Error(
    `HR34 phải dùng Supabase chung với HR22/HR23 (${SHARED_SUPABASE_HOST}).`
  )
}

if (configuredCompanyId && configuredCompanyId !== COMPANY_ID_34) {
  throw new Error(
    `HR34 phải dùng company_id ${COMPANY_ID_34}, nhận được ${configuredCompanyId}.`
  )
}

export const DEFAULT_COMPANY_ID = COMPANY_ID_34

export const supabase = createClient(
  supabaseUrl,
  supabaseAnonKey
)

