export const escapeHtml = (str) => {
  if (!str) return ''
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

export const formatMoney = (n) => {
  try {
    if (n === null || n === undefined || isNaN(n)) return '0 đ'
    return new Intl.NumberFormat('vi-VN').format(Number(n)) + ' đ'
  } catch (e) {
    return String(n || 0) + ' đ'
  }
}



// Display date as DD/MM/YYYY
export const formatDateDisplay = (dateStr) => {
  if (!dateStr) return '-'
  try {
    // If it's already DD/MM/YYYY
    if (String(dateStr).includes('/') && String(dateStr).split('/').length === 3) return dateStr

    // If YYYY-MM-DD
    const date = new Date(dateStr)
    if (isNaN(date.getTime())) return dateStr

    const day = String(date.getDate()).padStart(2, '0')
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const year = date.getFullYear()

    return `${day}/${month}/${year}`
  } catch (e) {
    return dateStr
  }
}

export const normalizeString = (str) => {
  if (!str) return ''
  return str.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .trim()
}

// Calculate Personal Income Tax (Progressive)
// Formula based on user request (Standard Vietnam PIT)
export const calculateProgressiveTax = (assessableIncome) => {
  if (assessableIncome <= 0) return 0

  // Tax constants
  const MILLION = 1000000

  if (assessableIncome <= 5 * MILLION) {
    return assessableIncome * 0.05
  } else if (assessableIncome <= 10 * MILLION) {
    return assessableIncome * 0.1 - 250000
  } else if (assessableIncome <= 18 * MILLION) {
    return assessableIncome * 0.15 - 750000
  } else if (assessableIncome <= 32 * MILLION) {
    return assessableIncome * 0.2 - 1650000
  } else if (assessableIncome <= 52 * MILLION) {
    return assessableIncome * 0.25 - 3250000
  } else if (assessableIncome <= 80 * MILLION) {
    return assessableIncome * 0.3 - 5850000
  } else {
    // Over 80M
    return assessableIncome * 0.35 - 9850000
  }
}

// List/directory query: skip documents, images, password (often huge JSON/base64).
export const USERS_DIRECTORY_COLUMNS = [
  'id',
  'auth_user_id',
  'employee_id',
  'username',
  'email',
  'name',
  'phone',
  'branch',
  'department',
  'position',
  'employment_status',
  'status',
  'shift',
  'role',
  'join_date',
  'official_date',
  'dob',
  'cccd',
  'identity_issue_date',
  'identity_issue_place',
  'address',
  'hometown',
  'gender',
  'marital_status',
  'notes',
  'salary_mechanism',
  'total_salary',
  'avatar_url'
].join(', ')

export const EMPLOYMENT_STATUS_OPTIONS = Object.freeze([
  'Thử việc',
  'Chính thức',
  'Tạm nghỉ',
  'Nghỉ việc'
])

const normalizeStatusText = value => String(value || '').trim().toLocaleLowerCase('vi')

/**
 * employment_status là nguồn chính cho trạng thái nhân sự. Cột status cũ
 * chỉ được dùng làm fallback khi nó thực sự chứa một trạng thái nhân sự;
 * tuyệt đối không suy diễn rỗng thành “Chính thức” (hoặc bất kỳ trạng thái
 * nào khác).
 */
export const getEmployeeEmploymentStatus = employee => {
  if (!employee) return ''
  const employmentFields = [
    employee.trang_thai,
    employee.employmentStatus,
    employee.employment_status
  ]
  const hasAuthoritativeEmploymentField = [
    'trang_thai',
    'employmentStatus',
    'employment_status'
  ].some(field => Object.prototype.hasOwnProperty.call(employee, field))
  if (hasAuthoritativeEmploymentField) {
    const value = employmentFields.find(item => String(item || '').trim())
    return value ? String(value).trim() : ''
  }

  const candidates = [employee.status, employee.tinh_trang]
  const recognized = candidates.find(value => {
    const normalized = normalizeStatusText(value)
    return normalized && EMPLOYMENT_STATUS_OPTIONS.some(option => normalizeStatusText(option) === normalized)
  })
  if (recognized !== undefined) return String(recognized).trim()

  // Giữ nguyên giá trị nghiệp vụ khác nếu có, nhưng không tạo giá trị mặc định.
  const firstValue = candidates.find(value => String(value || '').trim())
  return firstValue ? String(firstValue).trim() : ''
}

// Map Supabase DB columns (English) -> App State (Vietnamese)
export const mapUserToApp = (user) => {
  if (!user) return null
  const companyId = user.company_id ?? user.companyId ?? null
  return {
    id: user.id,
    auth_user_id: user.auth_user_id || null,
    company_id: companyId,
    companyId,
    company_name: user.company_name || user.companyName || '',
    companyName: user.companyName || user.company_name || '',
    employeeId: user.employee_id || '',
    ho_va_ten: user.name || '',
    email: user.email || '',
    sđt: user.phone || '',
    chi_nhanh: user.branch || '',
    bo_phan: user.department || '',
    vi_tri: user.position || '',
    trang_thai: user.employment_status || '',
    employmentStatus: user.employment_status || '',
    employment_status: user.employment_status || '',
    tinh_trang: user.status || '',
    status: user.status || '',
    ca_lam_viec: user.shift || '',
    ngay_vao_lam: user.join_date || '',
    ngay_lam_chinh_thuc: user.official_date || '',
    cccd: user.cccd || '',
    ngay_cap: user.identity_issue_date || '',
    noi_cap: user.identity_issue_place || '',
    dia_chi_thuong_tru: user.address || '',
    que_quan: user.hometown || '',
    ngay_sinh: user.dob || '',
    gioi_tinh: user.gender || '',
    tinh_trang_hon_nhan: user.marital_status || '',
    ghi_chu: user.notes || '',
    co_che_luong: user.salary_mechanism || '',
    tong_luong: user.total_salary || '',
    avatarDataUrl: user.avatar_url || '',
    files: Array.isArray(user.documents)
      ? user.documents
      : (Array.isArray(user.files) ? user.files : []),
    images: Array.isArray(user.images) ? user.images : [],
    profileComplete: Array.isArray(user.documents),
    role: user.role || 'user',
    username: user.username || ''
  }
}

// Expand 2-digit year: 00-29 → 2000-2029, 30-99 → 1930-1999
const expandYear = (yearToken) => {
  const raw = String(yearToken || '').trim()
  if (/^\d{4}$/.test(raw)) return raw
  if (/^\d{1,2}$/.test(raw)) {
    const n = Number(raw)
    if (n <= 29) return String(2000 + n)
    return String(1900 + n)
  }
  return raw
}

// Parse Excel/HR dates: 10/7/26, 3/8/2026, 2026-07-10 → YYYY-MM-DD
export const parseFlexibleDate = (dateStr) => {
  if (dateStr == null || dateStr === '') return null
  if (dateStr instanceof Date && !Number.isNaN(dateStr.getTime())) {
    const dd = String(dateStr.getDate()).padStart(2, '0')
    const mm = String(dateStr.getMonth() + 1).padStart(2, '0')
    return `${dateStr.getFullYear()}-${mm}-${dd}`
  }

  let str = String(dateStr).trim()
  if (!str || str === '-') return null
  str = str.replace(/\s+.*$/, '') // drop time if Excel includes it

  const iso = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (iso) {
    const year = iso[1]
    const month = iso[2].padStart(2, '0')
    const day = iso[3].padStart(2, '0')
    const date = new Date(`${year}-${month}-${day}T00:00:00`)
    return Number.isNaN(date.getTime()) ? null : `${year}-${month}-${day}`
  }

  const slash = str.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/)
  if (slash) {
    const day = slash[1].padStart(2, '0')
    const month = slash[2].padStart(2, '0')
    const year = expandYear(slash[3])
    const date = new Date(`${year}-${month}-${day}T00:00:00`)
    if (Number.isNaN(date.getTime())) return null
    if (date.getFullYear() !== Number(year) || date.getMonth() + 1 !== Number(month) || date.getDate() !== Number(day)) {
      return null
    }
    return `${year}-${month}-${day}`
  }

  return null
}

// Helper to convert DD/MM/YYYY (and Excel short dates) to YYYY-MM-DD
const formatDateForDB = (dateStr) => parseFlexibleDate(dateStr)

// Map App State (Vietnamese) -> Supabase DB columns (English)
export const mapAppToUser = (data) => {
  if (!data) return null
  return {
    // id field is usually handled by Supabase or passed separately for updates
    employee_id: (data.employeeId || data.employee_id || '').trim() || null,
    name: data.ho_va_ten || '',
    email: (data.email || '').trim() || null,
    phone: data.sđt || data.sdt || '',
    branch: data.chi_nhanh || '',
    department: data.bo_phan || '',
    position: data.vi_tri || '',
    // Rỗng phải được lưu rỗng để phân biệt với “Thử việc”; không tự suy diễn
    // nhân sự chưa được HR đánh dấu thành “Chính thức”.
    employment_status: data.trang_thai ?? data.employmentStatus ?? data.employment_status ?? '',
    status: data.tinh_trang ?? data.status ?? '',
    shift: data.ca_lam_viec || '',
    join_date: formatDateForDB(data.ngay_vao_lam),
    official_date: formatDateForDB(data.ngay_lam_chinh_thuc),
    cccd: data.cccd || '',
    identity_issue_date: formatDateForDB(data.ngay_cap),
    identity_issue_place: data.noi_cap || '',
    address: data.dia_chi_thuong_tru || data.address || '',
    hometown: data.que_quan || '',
    dob: formatDateForDB(data.ngay_sinh),
    gender: data.gioi_tinh || '',
    marital_status: data.tinh_trang_hon_nhan || '',
    notes: data.ghi_chu || data.notes || '',
    salary_mechanism: data.co_che_luong || '',
    total_salary: data.tong_luong || '',
    avatar_url: data.avatarDataUrl || data.avatarUrl || data.avatar || '',
    documents: Array.isArray(data.files) ? data.files.map(f => ({
      name: f.name || '',
      url: f.url || f.link || '',
      attachments: Array.isArray(f.attachments) ? f.attachments.map(item => ({
        name: item.name || '',
        type: item.type || '',
        data: item.data || ''
      })).filter(item => item.data) : [],
      // Backward compatibility for documents saved before multi-file upload.
      ...(!f.attachments && f.data ? { data: f.data, type: f.type || '' } : {})
    })) : [],
    images: Array.isArray(data.images) ? data.images : [],
    role: data.role || 'user',
    username: (data.username || data.employeeId || data.employee_id || '').trim() || null,
    ...((data.company_id || data.companyId)
      ? { company_id: data.company_id || data.companyId }
      : {}),
  }
}

// Parse Supabase schema-cache error, e.g.:
// "Could not find the 'address' column of 'users' in the schema cache"
export const getMissingUsersColumnFromError = (error) => {
  const message = error?.message || ''
  const match = message.match(/Could not find the '([^']+)' column of 'users' in the schema cache/i)
  return match?.[1] || null
}

// Remove unsupported column from payload to keep compatibility across different DB schemas
export const removeMissingUsersColumnFromPayload = (payload, error) => {
  const missingColumn = getMissingUsersColumnFromError(error)
  if (!missingColumn || !payload || !(missingColumn in payload)) {
    return { payload, removedColumn: null }
  }

  const sanitizedPayload = { ...payload }
  delete sanitizedPayload[missingColumn]

  return { payload: sanitizedPayload, removedColumn: missingColumn }
}

// Keep retrying users table mutation by stripping unsupported columns one by one.
export const runUsersMutationWithSchemaFallback = async (mutateFn, initialPayload, maxRetries = 20) => {
  let payload = { ...(initialPayload || {}) }
  let attempts = 0
  const removedColumns = []

  while (attempts <= maxRetries) {
    const result = await mutateFn(payload)
    const error = result?.error
    if (!error) {
      return { error: null, payload, removedColumns }
    }

    const fallback = removeMissingUsersColumnFromPayload(payload, error)
    if (!fallback.removedColumn) {
      return { error, payload, removedColumns }
    }

    removedColumns.push(fallback.removedColumn)
    payload = fallback.payload
    attempts += 1
  }

  return { error: new Error('Unable to adapt payload to users schema.'), payload, removedColumns }
}
