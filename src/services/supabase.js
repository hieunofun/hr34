
import { createClient } from '@supabase/supabase-js'

const cleanEnv = (val) => (typeof val === 'string' ? val.replace(/^[\uFEFF\s]+|[\uFEFF\s]+$/g, '') : val)

const supabaseUrl = cleanEnv(import.meta.env.VITE_SUPABASE_URL)
const supabaseAnonKey = cleanEnv(import.meta.env.VITE_SUPABASE_ANON_KEY)

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Thiếu cấu hình Supabase. Điền VITE_SUPABASE_URL và VITE_SUPABASE_ANON_KEY trong .env.local.'
  )
}

export const supabase = createClient(
  supabaseUrl,
  supabaseAnonKey
)

