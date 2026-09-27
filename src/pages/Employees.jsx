import { useEffect, useRef, useState } from 'react'
import EmployeeDirectory from '../components/EmployeeDirectory'
import { supabase } from '../services/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useCompany } from '../contexts/CompanyContext'
import { formatDateDisplay, getEmployeeEmploymentStatus, mapAppToUser, mapUserToApp, parseFlexibleDate, runUsersMutationWithSchemaFallback, USERS_DIRECTORY_COLUMNS, getMissingUsersColumnFromError } from '../utils/helpers'
import { normalizeImportedPhone, readEmployeeExcelRows } from '../utils/employeeExcelImport'
import { getCompanyEmployeeResetPreview, resetCompanyEmployees } from '../services/companyEmployeeReset'

const loadXlsx = () => import('xlsx')

const fetchUsersDirectory = async (companyId) => {
    let columns = USERS_DIRECTORY_COLUMNS.split(', ')
    const pageSize = 1000

    const fetchPage = (from) =>
        supabase
            .from('users')
            .select(columns.join(','))
            .eq('company_id', companyId)
            .order('name', { ascending: true })
            .range(from, from + pageSize - 1)

    for (let attempt = 0; attempt < 20; attempt++) {
        const first = await fetchPage(0)
        if (first.error) {
            const missing = getMissingUsersColumnFromError(first.error)
            if (!missing || !columns.includes(missing)) throw first.error
            columns = columns.filter(column => column !== missing)
            continue
        }

        const rows = [...(first.data || [])]
        if (rows.length < pageSize) return rows

        for (let from = pageSize; ; from += pageSize) {
            const next = await fetchPage(from)
            if (next.error) throw next.error
            rows.push(...(next.data || []))
            if (!next.data || next.data.length < pageSize) break
        }
        return rows
    }

    return []
}

const EMPLOYEE_EXCEL_HEADERS = [
    'STT',
    'Mã NV',
    'Chi nhánh',
    'Trạng thái',
    'HỌ TÊN',
    'Giới tính',
    'Ngày/ tháng/ năm sinh',
    'VỊ TRÍ',
    'CA LÀM',
    'TEAM',
    'Tình trạng',
    'Ngày vào làm',
    'Ngày lên chính thức',
    'Noted',
    'Cơ chế lương',
    'Tổng lương',
    'SĐT',
    'Số CCCD',
    'Ngày cấp',
    'Email cá nhân',
]

function Employees() {
    const { user } = useAuth()
    const { companyId } = useCompany()
    const [employees, setEmployees] = useState([])
    const [filteredEmployees, setFilteredEmployees] = useState([])
    const [loading, setLoading] = useState(true)
    const [searchTerm, setSearchTerm] = useState('')
    const [filterBranch, setFilterBranch] = useState('')
    const [filterDept, setFilterDept] = useState('')
    const [filterStatus, setFilterStatus] = useState('')
    const [filterBirthMonth, setFilterBirthMonth] = useState('')
    const [filterContract, setFilterContract] = useState('')
    const [filterShift, setFilterShift] = useState('')
    const [isModalOpen, setIsModalOpen] = useState(false)
    const [selectedEmployee, setSelectedEmployee] = useState(null)
    const [isReadOnly, setIsReadOnly] = useState(false)
    const fileInputRef = useRef(null)
    const [isImportModalOpen, setIsImportModalOpen] = useState(false)
    const [deletingAll, setDeletingAll] = useState(false)

    // Tab State
    const [activeTab, setActiveTab] = useState('list') // 'list' or 'history'

    useEffect(() => {
        loadEmployees()
    }, [companyId])

    useEffect(() => {
        filterEmployees()
    }, [employees, searchTerm, filterBranch, filterDept, filterStatus, filterBirthMonth, filterContract, filterShift, activeTab])

    const loadEmployees = async () => {
        try {
            setLoading(true)
            const data = await fetchUsersDirectory(companyId)
            setEmployees((data || []).map(u => mapUserToApp(u)))
            setLoading(false)
        } catch (err) {
            console.error("Error loading employees:", err)
            setEmployees([])
            setLoading(false)
        }
    }

    const resolveEmployee = async (employee) => {
        if (!employee?.id) return employee
        const { data, error } = await supabase
            .from('users')
            .select(`${USERS_DIRECTORY_COLUMNS},company_id,documents,images`)
            .eq('id', employee.id)
            .eq('company_id', companyId)
            .maybeSingle()
        if (error || !data) return employee
        return mapUserToApp(data)
    }

    const filterEmployees = () => {
        let filtered = employees.filter(item => {
            if (!item) return false

            const tinhTrang = getEmployeeEmploymentStatus(item)
            const trangThai = item.trang_thai || ''
            // Mặc định ẩn NV nghỉ việc; chỉ hiện khi chọn lọc "Nghỉ việc"
            if (!filterStatus && (trangThai === 'Nghỉ việc' || tinhTrang === 'Nghỉ việc')) return false

            const nameField = item.ho_va_ten || item.name || item.Tên || ""
            const shiftName = String(item.ca_lam_viec || item.shift || '').trim()
            const matchSearch = !searchTerm ||
                nameField.toLowerCase().includes(searchTerm.toLowerCase()) ||
                (item.email && item.email.toLowerCase().includes(searchTerm.toLowerCase())) ||
                (item.sđt && String(item.sđt || '').includes(searchTerm)) ||
                (item.sdt && String(item.sdt || '').includes(searchTerm)) ||
                (item.employeeId && String(item.employeeId).toLowerCase().includes(searchTerm.toLowerCase())) ||
                shiftName.toLowerCase().includes(searchTerm.toLowerCase())

            const matchBranch = !filterBranch
                || (filterBranch === '__none__' ? !item.chi_nhanh : item.chi_nhanh === filterBranch)
            const matchDept = !filterDept
                || (filterDept === '__none__' ? !item.bo_phan : item.bo_phan === filterDept)
            const matchStatus = !filterStatus || tinhTrang === filterStatus
            const contractType = item.loai_hop_dong || item.contractType || ''
            const matchContract = !filterContract || contractType === filterContract
            const matchShift = !filterShift
                || (filterShift === '__none__' ? !shiftName : shiftName === filterShift)

            let matchExpiry = true
            if (activeTab === 'expiring') {
                const expiryValue = item.ngay_het_han || item.contractEndDate || item.ngay_het_han_hop_dong
                const expiryDate = expiryValue ? new Date(expiryValue) : null
                const daysLeft = expiryDate && !Number.isNaN(expiryDate.getTime())
                    ? Math.ceil((expiryDate.getTime() - Date.now()) / 86400000)
                    : null
                matchExpiry = daysLeft !== null && daysLeft >= 0 && daysLeft <= 60
            }

            // Filter Birth Month
            let matchMonth = true
            if (filterBirthMonth) {
                const dob = item.ngay_sinh || item.dob || ''
                if (!dob) {
                    matchMonth = false
                } else {
                    let month = -1
                    // Handle YYYY-MM-DD
                    if (dob.includes('-')) {
                        const parts = dob.split('-')
                        if (parts.length === 3) {
                            // usually YYYY-MM-DD, month is parts[1]
                            month = parseInt(parts[1], 10)
                        }
                    }
                    // Handle DD/MM/YYYY
                    else if (dob.includes('/')) {
                        const parts = dob.split('/')
                        if (parts.length === 3) {
                            // usually DD/MM/YYYY, month is parts[1]
                            month = parseInt(parts[1], 10)
                        }
                    }

                    matchMonth = month === parseInt(filterBirthMonth, 10)
                }
            }

            return matchSearch && matchBranch && matchDept && matchStatus && matchMonth && matchContract && matchShift && matchExpiry
        })

        setFilteredEmployees(filtered)
    }

    const handleDelete = async (id, name) => {
        if (!confirm(`Bạn có chắc muốn xóa nhân viên "${name}"?\n\nHành động này không thể hoàn tác!`)) {
            return
        }

        try {
            const { error } = await supabase
                .from('users')
                .delete()
                .eq('id', id)
                .eq('company_id', companyId)

            if (error) throw error

            setEmployees(prev => prev.filter(item => item.id !== id))
            alert(`Đã xóa nhân viên "${name}"`)
        } catch (error) {
            alert(`Lỗi: ${error.message}`)
        }
    }

    const handleDeleteAll = async () => {
        if (user?.role !== 'admin' || deletingAll) return
        try {
            setDeletingAll(true)
            const { company, counts } = await getCompanyEmployeeResetPreview()
            const total = counts.users + counts.nhan_su + counts.cham_cong
                + counts.attendanceRecords + counts.penalties + counts.statusHistory
            if (!total) {
                alert('Công ty không còn hồ sơ nhân sự hoặc dữ liệu chấm công để xóa.')
                return
            }
            const confirmation = prompt(
                `XÓA TOÀN BỘ DỮ LIỆU NHÂN SỰ VÀ CHẤM CÔNG CỦA ${company.name}\n\n` +
                `${counts.users} hồ sơ nhân viên, ${counts.nhan_su} bản ghi nhân sự, ` +
                `${counts.cham_cong} dòng chấm công, ${counts.attendanceRecords} bản ghi chấm công liên quan, ` +
                `${counts.penalties} dòng phạt chấm công ` +
                `và ${counts.statusHistory} dòng lịch sử trạng thái sẽ bị xóa vĩnh viễn.\n` +
                `${counts.adminAccounts} tài khoản Admin được giữ lại.\n\n` +
                `Nhập chính xác mã công ty ${company.code} để tiếp tục:`
            )
            if (confirmation === null) return
            if (confirmation.trim() !== company.code) {
                alert('Mã công ty không khớp. Chưa xóa dữ liệu.')
                return
            }
            if (!confirm(`Xác nhận lần cuối: xóa dữ liệu nhân sự và chấm công của ${company.name}?`)) return
            const result = await resetCompanyEmployees(company.code, counts)
            await loadEmployees()
            alert(`Đã xóa dữ liệu nhân sự và chấm công. Giữ lại ${result.adminAccountsKept} tài khoản Admin.`)
        } catch (error) {
            await loadEmployees()
            alert(`Không hoàn tất xóa dữ liệu: ${error.message}\nHãy tải lại trang và kiểm tra dữ liệu còn lại.`)
        } finally {
            setDeletingAll(false)
        }
    }

    const downloadTemplate = async () => {
        const XLSX = await loadXlsx()
        const ws = XLSX.utils.aoa_to_sheet([EMPLOYEE_EXCEL_HEADERS])
        ws['!cols'] = EMPLOYEE_EXCEL_HEADERS.map((h) => ({ wch: Math.max(16, h.length + 4) }))
        const wb = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(wb, ws, 'Nhan_su')
        XLSX.writeFile(wb, 'Mau_import_nhan_su.xlsx')
    }

    const employeeToExcelRow = (emp, idx) => ([
        idx + 1,
        emp.employeeId || '',
        emp.chi_nhanh || '',
        getEmployeeEmploymentStatus(emp),
        emp.ho_va_ten || emp.name || emp.Tên || '',
        emp.gioi_tinh || '',
        formatDateDisplay(emp.ngay_sinh || emp.dob) === '-' ? '' : formatDateDisplay(emp.ngay_sinh || emp.dob),
        emp.vi_tri || '',
        emp.ca_lam_viec || '',
        emp.bo_phan || emp.team || '',
        emp.tinh_trang || emp.tinh_trang_hon_nhan || '',
        formatDateDisplay(emp.ngay_vao_lam) === '-' ? '' : formatDateDisplay(emp.ngay_vao_lam),
        formatDateDisplay(emp.ngay_lam_chinh_thuc) === '-' ? '' : formatDateDisplay(emp.ngay_lam_chinh_thuc),
        emp.ghi_chu || emp.notes || '',
        emp.co_che_luong || '',
        emp.tong_luong || '',
        emp.sđt || emp.sdt || '',
        emp.cccd || '',
        formatDateDisplay(emp.ngay_cap) === '-' ? '' : formatDateDisplay(emp.ngay_cap),
        emp.email || '',
    ])

    const exportToExcel = async () => {
        if (filteredEmployees.length === 0) {
            alert('Không có dữ liệu để xuất!')
            return
        }

        const XLSX = await loadXlsx()
        const rows = [
            EMPLOYEE_EXCEL_HEADERS,
            ...filteredEmployees.map((emp, idx) => employeeToExcelRow(emp, idx)),
        ]
        const ws = XLSX.utils.aoa_to_sheet(rows)
        ws['!cols'] = EMPLOYEE_EXCEL_HEADERS.map((h) => ({ wch: Math.max(16, h.length + 4) }))
        const wb = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(wb, ws, 'Nhan_su')
        const dateStr = new Date().toISOString().split('T')[0]
        XLSX.writeFile(wb, `Danh_sach_nhan_su_${dateStr}.xlsx`)
    }

    // Convert Google Drive link to direct image URL
    const convertDriveLink = (url) => {
        if (!url) return ''
        const urlStr = String(url).trim()

        // Check if it's a Google Drive link
        if (urlStr.includes('drive.google.com')) {
            // Extract file ID from various Drive URL formats
            let fileId = ''

            // Format: https://drive.google.com/file/d/FILE_ID/view
            const match1 = urlStr.match(/\/file\/d\/([^\/]+)/)
            if (match1) {
                fileId = match1[1]
            }

            // Format: https://drive.google.com/open?id=FILE_ID
            const match2 = urlStr.match(/[?\&]id=([^\&]+)/)
            if (match2) {
                fileId = match2[1]
            }

            // Format: https://drive.google.com/uc?id=FILE_ID
            const match3 = urlStr.match(/\/uc\?.*id=([^\&]+)/)
            if (match3) {
                fileId = match3[1]
            }

            if (fileId) {
                // Use thumbnail endpoint - works better with CORS
                const directUrl = `https://lh3.googleusercontent.com/d/${fileId}`
                console.log('🔄 Converted Drive link:', urlStr, '→', directUrl)
                console.log('   ℹ️ Alternative format: https://drive.google.com/uc?export=view&id=' + fileId)
                return directUrl
            } else {
                console.warn('⚠️ Could not extract file ID from Drive link:', urlStr)
            }
        }

        // If it's already a direct image URL (imgur, etc), return as is
        if (urlStr) {
            console.log('✅ Using direct URL:', urlStr)
        }
        return urlStr
    }

    const handleImportExcel = async (event) => {
        const input = event.target
        const file = input.files?.[0]
        if (!file) return

        const readWorkbook = async (XLSX) => {
            const bytes = new Uint8Array(await file.arrayBuffer())
            const sniff = new TextDecoder('utf-8').decode(bytes.slice(0, 512))
            const fileName = (file.name || '').toLowerCase()
            const looksHtml = /<html|<table|xmlns:x="urn:schemas-microsoft-com:office:excel"/i.test(sniff)
            const looksCsv = fileName.endsWith('.csv') || fileName.endsWith('.txt')

            if (looksHtml || looksCsv) {
                return XLSX.read(new TextDecoder('utf-8').decode(bytes), { type: 'string', raw: false })
            }

            try {
                return XLSX.read(bytes, { type: 'array', cellDates: false, raw: false })
            } catch {
                return XLSX.read(new TextDecoder('utf-8').decode(bytes), { type: 'string', raw: false })
            }
        }

        try {
            setLoading(true)
            const XLSX = await loadXlsx()
            const workbook = await readWorkbook(XLSX)
            const { headers, dataRows } = readEmployeeExcelRows(XLSX, workbook)

            console.log('📋 Headers detected:', headers)
            console.log('📊 Total data rows:', dataRows.length)

            const isValidDate = (dateStr) => !dateStr || Boolean(parseFlexibleDate(dateStr))

            const DATE_HEADERS = new Set([
                'ngay_thang_nam_sinh', 'ngay_sinh', 'dob', 'birth_date',
                'ngay_vao_lam', 'ngay_bat_dau', 'ngay_bat_dau_di_lam', 'ngay_len_chinh_thuc',
                'ngay_chinh_thuc', 'ngay_lam_chinh_thuc', 'ngay_cap'
            ])

            const formatDateValue = (cell) => {
                if (cell == null || cell === '') return ''
                if (cell instanceof Date && !Number.isNaN(cell.getTime())) {
                    const dd = String(cell.getDate()).padStart(2, '0')
                    const mm = String(cell.getMonth() + 1).padStart(2, '0')
                    return `${dd}/${mm}/${cell.getFullYear()}`
                }
                if (typeof cell === 'number' && cell > 20000 && cell < 80000) {
                    const parsed = XLSX.SSF?.parse_date_code?.(cell)
                    if (parsed?.y && parsed?.m && parsed?.d) {
                        const dd = String(parsed.d).padStart(2, '0')
                        const mm = String(parsed.m).padStart(2, '0')
                        return `${dd}/${mm}/${parsed.y}`
                    }
                }
                return String(cell).trim()
            }

            const formatCell = (cell, header = '') => {
                if (cell == null || cell === '') return ''
                if (DATE_HEADERS.has(header) || header.startsWith('ngay_')) {
                    return formatDateValue(cell)
                }
                if (typeof cell === 'number') {
                    return Number.isInteger(cell) || Math.abs(cell - Math.round(cell)) < 1e-9
                        ? String(Math.round(cell))
                        : String(cell)
                }
                return String(cell).trim()
            }

            const pick = (rowObj, ...keys) => {
                for (const key of keys) {
                    const value = rowObj[key]
                    if (value !== undefined && String(value).trim() !== '') return String(value).trim()
                }
                return ''
            }

            const normalizeCode = (value) => String(value || '').trim().replace(/\s+/g, '').toLowerCase()
            const describeDbError = (error) => {
                const msg = error?.message || error?.code || ''
                if (/users_employee_id_unique|employee_id/i.test(msg)) return 'Mã NV đã có trên hệ thống'
                if (/users_username_unique|username/i.test(msg)) return 'Tên đăng nhập trùng (không phải mã NV)'
                if (/users_email_unique|email/i.test(msg)) return 'Email đã tồn tại'
                return msg
            }

            const existingByCode = new Map()
            employees.forEach((emp) => {
                const code = normalizeCode(emp.employeeId)
                if (code && emp.id) existingByCode.set(code, emp)
            })

            let imported = 0
            let updated = 0
            let skipped = 0
            const errors = []
            const seenImportKeys = new Map()

            for (let i = 0; i < dataRows.length; i++) {
                const { displayRow, rawRow, rowNumber: rowIndex } = dataRows[i]

                const rowObj = {}
                headers.forEach((h, idx) => {
                    if (!h) return
                    const isDate = DATE_HEADERS.has(h) || h.startsWith('ngay_')
                    rowObj[h] = formatCell(isDate ? rawRow[idx] : displayRow[idx], h)
                })

                const payload = {
                    employeeId: pick(rowObj, 'ma_nhan_vien', 'ma_nv', 'employee_id'),
                    ho_va_ten: pick(rowObj, 'ho_va_ten', 'ho_ten', 'ten_nhan_vien', 'ten', 'name'),
                    email: pick(rowObj, 'email_ca_nhan', 'email'),
                    sđt: normalizeImportedPhone(pick(rowObj, 'sdt', 'so_dien_thoai', 'dien_thoai', 'phone')),
                    username: pick(rowObj, 'ten_dang_nhap', 'username', 'user_name'),
                    role: pick(rowObj, 'vai_tro', 'role') || 'user',
                    chi_nhanh: pick(rowObj, 'chi_nhanh', 'branch'),
                    bo_phan: pick(rowObj, 'team', 'bo_phan', 'phong_ban', 'department'),
                    vi_tri: pick(rowObj, 'vi_tri', 'vi_tri_cong_viec', 'chuc_vu', 'position'),
                    trang_thai: pick(rowObj, 'trang_thai', 'status'),
                    tinh_trang: pick(rowObj, 'tinh_trang', 'trang_thai_nhan_su'),
                    tinh_trang_hon_nhan: pick(rowObj, 'tinh_trang_hon_nhan', 'hon_nhan'),
                    ngay_sinh: pick(rowObj, 'ngay_thang_nam_sinh', 'ngay_sinh', 'dob', 'birth_date'),
                    ngay_vao_lam: pick(rowObj, 'ngay_vao_lam', 'ngay_bat_dau', 'ngay_bat_dau_di_lam'),
                    ngay_lam_chinh_thuc: pick(rowObj, 'ngay_len_chinh_thuc', 'ngay_chinh_thuc', 'ngay_lam_chinh_thuc'),
                    ca_lam_viec: pick(rowObj, 'ca_lam', 'ca_lam_viec', 'ca', 'shift'),
                    cccd: pick(rowObj, 'so_cccd', 'so_cmnd', 'cccd', 'cmnd'),
                    ngay_cap: pick(rowObj, 'ngay_cap'),
                    noi_cap: pick(rowObj, 'noi_cap'),
                    dia_chi_thuong_tru: pick(rowObj, 'dia_chi_thuong_tru', 'thuong_tru', 'dia_chi', 'address'),
                    que_quan: pick(rowObj, 'que_quan'),
                    gioi_tinh: pick(rowObj, 'gioi_tinh', 'gender'),
                    ghi_chu: pick(rowObj, 'noted', 'note', 'ghi_chu', 'notes'),
                    co_che_luong: pick(rowObj, 'co_che_luong'),
                    tong_luong: pick(rowObj, 'tong_luong'),
                    avatarUrl: convertDriveLink(pick(rowObj, 'link_anh', 'avatar', 'anh', 'hinh_anh', 'image'))
                }

                if (!payload.ho_va_ten) {
                    continue
                }

                // Bảng chấm công thường lặp lại một nhân viên theo từng ngày.
                // Chỉ tạo hồ sơ một lần, đồng thời báo rõ mã có nhiều tên khác nhau.
                const codeKey = normalizeCode(payload.employeeId)
                const importKey = codeKey || normalizeCode(payload.ho_va_ten)
                const previousName = seenImportKeys.get(importKey)
                if (previousName) {
                    if (normalizeCode(previousName) !== normalizeCode(payload.ho_va_ten)) {
                        errors.push({
                            row: rowIndex,
                            name: payload.ho_va_ten,
                            reason: `Mã NV ${payload.employeeId || '(trống)'} xuất hiện với tên khác (${previousName}); giữ hồ sơ đầu tiên`
                        })
                    }
                    skipped++
                    continue
                }
                seenImportKeys.set(importKey, payload.ho_va_ten)

                const rowErrors = []

                if (!isValidDate(payload.ngay_sinh)) rowErrors.push(`Ngày sinh không hợp lệ: "${payload.ngay_sinh}" (cần dd/mm/yyyy)`)
                if (!isValidDate(payload.ngay_vao_lam)) rowErrors.push(`Ngày vào làm không hợp lệ: "${payload.ngay_vao_lam}" (cần dd/mm/yyyy)`)
                if (!isValidDate(payload.ngay_lam_chinh_thuc)) rowErrors.push(`Ngày chính thức không hợp lệ: "${payload.ngay_lam_chinh_thuc}" (cần dd/mm/yyyy)`)
                if (!isValidDate(payload.ngay_cap)) rowErrors.push(`Ngày cấp CCCD không hợp lệ: "${payload.ngay_cap}" (cần dd/mm/yyyy)`)

                if (rowErrors.length > 0) {
                    errors.push({
                        row: rowIndex,
                        name: payload.ho_va_ten || 'Không tên',
                        reason: rowErrors.join(', ')
                    })
                    skipped++
                    continue
                }

                const dbPayload = { ...mapAppToUser(payload), company_id: companyId }
                const existing = codeKey ? existingByCode.get(codeKey) : null
                if (existing?.auth_user_id) {
                    // Giữ định danh Auth đã cấp khi import lại hồ sơ.
                    dbPayload.username = existing.username || dbPayload.username
                    dbPayload.email = existing.email || dbPayload.email
                }

                let mutationResult
                if (existing?.id) {
                    mutationResult = await runUsersMutationWithSchemaFallback(
                        (payloadToSave) => supabase.from('users').update(payloadToSave).eq('id', existing.id).eq('company_id', companyId),
                        dbPayload
                    )
                } else {
                    dbPayload.id = crypto.randomUUID()
                    if (!dbPayload.username) {
                        dbPayload.username = payload.employeeId || `nv${String(rowIndex).padStart(4, '0')}`
                    }
                    mutationResult = await runUsersMutationWithSchemaFallback(
                        (payloadToInsert) => supabase.from('users').insert([payloadToInsert]),
                        dbPayload
                    )
                }

                const { error } = mutationResult

                let nhanSuError = null
                if (!error) {
                    const nhanSuCode = String(payload.employeeId || dbPayload.employee_id || `NV-${rowIndex}`).trim()
                    const { error: syncError } = await supabase
                        .from('nhan_su')
                        .upsert([{
                            company_id: companyId,
                            ma_nhan_vien: nhanSuCode,
                            ho_ten: payload.ho_va_ten,
                            chuc_vu: payload.vi_tri || '',
                            bo_phan: payload.bo_phan || '',
                            ca_lam: payload.ca_lam_viec || 'Ca ngày',
                            trang_thai: payload.trang_thai || '',
                            so_dien_thoai: payload.sđt || '',
                            email: payload.email || '',
                            ngay_vao_lam: parseFlexibleDate(payload.ngay_vao_lam),
                            avatar_url: payload.avatarUrl || '',
                            updated_at: new Date().toISOString()
                        }], { onConflict: 'company_id,ma_nhan_vien' })
                    nhanSuError = syncError
                }

                if (error || nhanSuError) {
                    const finalError = error || nhanSuError
                    console.error('❌ Import error for:', payload.ho_va_ten, finalError)
                    errors.push({
                        row: rowIndex,
                        name: payload.ho_va_ten,
                        reason: describeDbError(finalError)
                    })
                    skipped++
                } else if (existing?.id) {
                    updated++
                } else {
                    imported++
                    if (codeKey) {
                        existingByCode.set(codeKey, { id: dbPayload.id, employeeId: payload.employeeId })
                    }
                }
            }

            await loadEmployees()

            let message = `Đã thêm mới ${imported} nhân viên`
            if (updated) message += `, cập nhật ${updated} nhân viên đã có mã NV`
            message += '.'
            if (skipped > 0) {
                message += `\nCó ${skipped} dòng bị lỗi/bỏ qua:\n\n`
                const showErrors = errors.slice(0, 10)
                showErrors.forEach(err => {
                    message += `• Dòng ${err.row} (${err.name}): ${err.reason}\n`
                })
                if (errors.length > 10) {
                    message += `... và ${errors.length - 10} dòng khác.`
                }
            }

            alert(message)
        } catch (error) {
            console.error('❌ Import error:', error)
            alert('Lỗi import: ' + error.message)
        } finally {
            setLoading(false)
            input.value = ''
            if (fileInputRef.current) fileInputRef.current.value = ''
        }
    }



    const isActiveEmployee = (e) => getEmployeeEmploymentStatus(e) !== 'Nghỉ việc'
    const activeEmployees = employees.filter(isActiveEmployee)

    // Employees scoped by selected branch (for department tabs)
    const employeesInBranch = activeEmployees.filter(e => {
        if (!filterBranch) return true
        if (filterBranch === '__none__') return !e.chi_nhanh
        return e.chi_nhanh === filterBranch
    })

    const branches = [...new Set(activeEmployees.map(e => e.chi_nhanh).filter(Boolean))].sort()
    const noBranchCount = activeEmployees.filter(e => !e.chi_nhanh).length

    const departments = [...new Set(employeesInBranch.map(e => e.bo_phan).filter(Boolean))].sort()
    const noDeptCount = employeesInBranch.filter(e => !e.bo_phan).length

    const getBranchCount = (branch) => {
        if (branch === '') return activeEmployees.length
        if (branch === '__none__') return noBranchCount
        return activeEmployees.filter(e => e.chi_nhanh === branch).length
    }

    const getDeptCount = (dept) => {
        if (dept === '') return employeesInBranch.length
        if (dept === '__none__') return noDeptCount
        return employeesInBranch.filter(e => e.bo_phan === dept).length
    }

    // Group filtered list by department
    const groupedEmployees = (() => {
        const groups = new Map()
        filteredEmployees.forEach(emp => {
            const key = emp.bo_phan || 'Chưa phân bộ phận'
            if (!groups.has(key)) groups.set(key, [])
            groups.get(key).push(emp)
        })

        const sortedKeys = [...groups.keys()].sort((a, b) => {
            if (a === 'Chưa phân bộ phận') return 1
            if (b === 'Chưa phân bộ phận') return -1
            return a.localeCompare(b, 'vi')
        })

        return sortedKeys.map(key => ({
            dept: key,
            items: groups.get(key)
        }))
    })()

    const openView = (emp) => {
        setSelectedEmployee(emp)
        setIsReadOnly(true)
        setIsModalOpen(true)
    }

    const openEdit = (emp) => {
        setSelectedEmployee(emp)
        setIsReadOnly(false)
        setIsModalOpen(true)
    }

    const renderCard = (emp, idx) => {
        const name = emp.ho_va_ten || emp.name || emp.Tên || 'N/A'
        const avatar = emp.avatarDataUrl || emp.avatarUrl || emp.avatar || ''
        const status = getEmployeeEmploymentStatus(emp)
        return (
            <article key={emp.id || idx} className="employee-photo-card">
                <div className="employee-photo-card__media">
                    {avatar ? (
                        <img
                            src={avatar}
                            alt={name}
                            onError={(e) => {
                                e.target.style.display = 'none'
                                const placeholder = e.target.nextSibling
                                if (placeholder) placeholder.style.display = 'flex'
                            }}
                        />
                    ) : null}
                    <div
                        className="employee-photo-card__placeholder"
                        style={{ display: avatar ? 'none' : 'flex' }}
                    >
                        <i className="fas fa-user"></i>
                    </div>
                    {status && (
                        <span className="employee-photo-card__status">{status}</span>
                    )}
                </div>
                <div className="employee-photo-card__body">
                    <h3 className="employee-photo-card__name">{name}</h3>
                    <p className="employee-photo-card__meta">
                        {emp.employeeId ? emp.employeeId : `#${idx + 1}`}
                    </p>
                    <div className="employee-photo-card__actions">
                        <div className="actions">
                            <button className="view" title="Xem" onClick={() => openView(emp)}>
                                <i className="fas fa-eye"></i>
                            </button>
                            <button className="edit" title="Sửa" onClick={() => openEdit(emp)}>
                                <i className="fas fa-edit"></i>
                            </button>
                            <button className="delete" title="Xóa" onClick={() => handleDelete(emp.id, name)}>
                                <i className="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </article>
        )
    }

    const renderListRow = (emp, idx) => {
        const name = emp.ho_va_ten || emp.name || emp.Tên || 'N/A'
        const avatar = emp.avatarDataUrl || emp.avatarUrl || emp.avatar || ''
        const status = getEmployeeEmploymentStatus(emp)
        return (
            <div key={emp.id || idx} className="employee-list-row">
                <div className="employee-list-row__photo">
                    {avatar ? (
                        <img
                            src={avatar}
                            alt={name}
                            onError={(e) => {
                                e.target.style.display = 'none'
                                const placeholder = e.target.nextSibling
                                if (placeholder) placeholder.style.display = 'flex'
                            }}
                        />
                    ) : null}
                    <div
                        className="employee-photo-card__placeholder"
                        style={{ display: avatar ? 'none' : 'flex' }}
                    >
                        <i className="fas fa-user"></i>
                    </div>
                </div>
                <div className="employee-list-row__info">
                    <h3 className="employee-list-row__name">{name}</h3>
                    <div className="employee-list-row__meta">
                        <span>{emp.employeeId || `#${idx + 1}`}</span>
                        <span>Sinh: {formatDateDisplay(emp.ngay_sinh || emp.dob) || '—'}</span>
                        <span>Chính thức: {formatDateDisplay(emp.ngay_lam_chinh_thuc) || '—'}</span>
                    </div>
                </div>
                {status && (
                    <span className="employee-list-row__status">{status}</span>
                )}
                <div className="employee-list-row__actions">
                    <div className="actions">
                        <button className="view" title="Xem" onClick={() => openView(emp)}>
                            <i className="fas fa-eye"></i>
                        </button>
                        <button className="edit" title="Sửa" onClick={() => openEdit(emp)}>
                            <i className="fas fa-edit"></i>
                        </button>
                        <button className="delete" title="Xóa" onClick={() => handleDelete(emp.id, name)}>
                            <i className="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            </div>
        )
    }

    const handleSelectBranch = (branch) => {
        setFilterBranch(branch)
        setFilterDept('')
    }

    const tabBtnStyle = (active) => ({
        padding: '8px 14px',
        border: '1px solid',
        borderColor: active ? 'var(--primary)' : '#ddd',
        borderRadius: '6px',
        background: active ? 'var(--primary)' : '#fff',
        color: active ? '#fff' : '#444',
        cursor: 'pointer',
        fontWeight: active ? 600 : 500,
        fontSize: '0.9rem'
    })

    if (loading) {
        return <div className="loadingState">Đang tải dữ liệu...</div>
    }

    return <EmployeeDirectory
        companyId={companyId}
        employees={employees}
        filteredEmployees={filteredEmployees}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        filterBranch={filterBranch}
        setFilterBranch={setFilterBranch}
        filterDept={filterDept}
        setFilterDept={setFilterDept}
        filterStatus={filterStatus}
        setFilterStatus={setFilterStatus}
        filterContract={filterContract}
        setFilterContract={setFilterContract}
        filterShift={filterShift}
        setFilterShift={setFilterShift}
        selectedEmployee={selectedEmployee}
        setSelectedEmployee={setSelectedEmployee}
        isModalOpen={isModalOpen}
        setIsModalOpen={setIsModalOpen}
        isReadOnly={isReadOnly}
        setIsReadOnly={setIsReadOnly}
        onReload={loadEmployees}
        onExport={exportToExcel}
        onDownloadTemplate={downloadTemplate}
        onImport={handleImportExcel}
        onDelete={handleDelete}
        onDeleteAll={user?.role === 'admin' ? handleDeleteAll : null}
        deletingAll={deletingAll}
        onResolveEmployee={resolveEmployee}
    />

    /*
    return (
        <div>
            <div className="page-header" style={{ marginBottom: '10px' }}>
                <h1 className="page-title">
                    <i className="fas fa-users"></i>
                    Hồ sơ nhân sự
                </h1>
                {activeTab === 'list' && (
                    <div>
                        <button
                            className="btn btn-primary"
                            onClick={() => {
                                setSelectedEmployee(null)
                                setIsModalOpen(true)
                            }}
                            style={{ marginRight: '10px' }}
                        >
                            <i className="fas fa-plus"></i>
                            Tạo mới NV
                        </button>
                        <button
                            className="btn btn-secondary"
                            onClick={() => setIsImportModalOpen(true)}
                            style={{ marginRight: '10px' }}
                        >
                            <i className="fas fa-file-upload"></i>
                            Upload Excel
                        </button>


                        <button
                            className="btn btn-info"
                            onClick={downloadTemplate}
                            style={{
                                marginRight: '10px',
                                color: '#fff',
                                background: '#17a2b8',
                                borderColor: '#17a2b8'
                            }}
                        >
                            <i className="fas fa-download"></i>
                            Tải file mẫu
                        </button>
                        <button
                            className="btn btn-success"
                            onClick={exportToExcel}
                            style={{
                                marginRight: '10px',
                                background: '#28a745',
                                borderColor: '#28a745',
                                color: '#fff'
                            }}
                        >
                            <i className="fas fa-file-excel"></i>
                            Xuất Excel
                        </button>
                        <button className="btn btn-primary" onClick={loadEmployees}>
                            <i className="fas fa-sync"></i>
                            Làm mới
                        </button>
                    </div>
                )}
            </div>

            <div className="main-tabs" style={{
                borderBottom: '1px solid #ddd',
                marginBottom: '20px',
                display: 'flex',
                gap: '5px'
            }}>
                <button
                    onClick={() => setActiveTab('list')}
                    style={{
                        padding: '10px 20px',
                        border: 'none',
                        background: activeTab === 'list' ? '#fff' : '#f8f9fa',
                        borderBottom: activeTab === 'list' ? '2px solid var(--primary)' : '2px solid transparent',
                        fontWeight: activeTab === 'list' ? '600' : '500',
                        color: activeTab === 'list' ? 'var(--primary)' : '#666',
                        cursor: 'pointer',
                        fontSize: '1rem'
                    }}
                >
                    <i className="fas fa-list" style={{ marginRight: '8px' }}></i>
                    Danh sách nhân viên
                </button>
                <button
                    onClick={() => setActiveTab('history')}
                    style={{
                        padding: '10px 20px',
                        border: 'none',
                        background: activeTab === 'history' ? '#fff' : '#f8f9fa',
                        borderBottom: activeTab === 'history' ? '2px solid var(--primary)' : '2px solid transparent',
                        fontWeight: activeTab === 'history' ? '600' : '500',
                        color: activeTab === 'history' ? 'var(--primary)' : '#666',
                        cursor: 'pointer',
                        fontSize: '1rem'
                    }}
                >
                    <i className="fas fa-history" style={{ marginRight: '8px' }}></i>
                    Biến động trạng thái
                </button>
            </div>

            {activeTab === 'list' ? (
                <>
                    <div style={{ marginBottom: '14px' }}>
                        <div style={{ fontSize: '0.82rem', color: '#64748b', marginBottom: '6px', fontWeight: 600 }}>
                            Chi nhánh
                        </div>
                        <div className="branch-tabs" style={{
                            display: 'flex',
                            gap: '8px',
                            flexWrap: 'wrap',
                            marginBottom: '12px',
                            paddingBottom: '12px',
                            borderBottom: '1px solid #eee'
                        }}>
                            <button
                                type="button"
                                onClick={() => handleSelectBranch('')}
                                style={tabBtnStyle(filterBranch === '')}
                            >
                                Tất cả
                                <span style={{ marginLeft: '6px', opacity: 0.85, fontSize: '0.8rem' }}>
                                    ({getBranchCount('')})
                                </span>
                            </button>
                            {branches.map(branch => (
                                <button
                                    key={branch}
                                    type="button"
                                    onClick={() => handleSelectBranch(branch)}
                                    style={tabBtnStyle(filterBranch === branch)}
                                >
                                    {branch}
                                    <span style={{ marginLeft: '6px', opacity: 0.85, fontSize: '0.8rem' }}>
                                        ({getBranchCount(branch)})
                                    </span>
                                </button>
                            ))}
                            {noBranchCount > 0 && (
                                <button
                                    type="button"
                                    onClick={() => handleSelectBranch('__none__')}
                                    style={tabBtnStyle(filterBranch === '__none__')}
                                >
                                    Chưa có chi nhánh
                                    <span style={{ marginLeft: '6px', opacity: 0.85, fontSize: '0.8rem' }}>
                                        ({noBranchCount})
                                    </span>
                                </button>
                            )}
                        </div>

                        <div style={{ fontSize: '0.82rem', color: '#64748b', marginBottom: '6px', fontWeight: 600 }}>
                            Bộ phận{filterBranch && filterBranch !== '__none__' ? ` · ${filterBranch}` : ''}
                        </div>
                        <div className="dept-tabs" style={{
                            display: 'flex',
                            gap: '8px',
                            flexWrap: 'wrap',
                            paddingBottom: '4px'
                        }}>
                            <button
                                type="button"
                                onClick={() => setFilterDept('')}
                                style={tabBtnStyle(filterDept === '')}
                            >
                                Tất cả
                                <span style={{ marginLeft: '6px', opacity: 0.85, fontSize: '0.8rem' }}>
                                    ({getDeptCount('')})
                                </span>
                            </button>
                            {departments.map(dept => (
                                <button
                                    key={dept}
                                    type="button"
                                    onClick={() => setFilterDept(dept)}
                                    style={tabBtnStyle(filterDept === dept)}
                                >
                                    {dept}
                                    <span style={{ marginLeft: '6px', opacity: 0.85, fontSize: '0.8rem' }}>
                                        ({getDeptCount(dept)})
                                    </span>
                                </button>
                            ))}
                            {noDeptCount > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setFilterDept('__none__')}
                                    style={tabBtnStyle(filterDept === '__none__')}
                                >
                                    Chưa phân bộ phận
                                    <span style={{ marginLeft: '6px', opacity: 0.85, fontSize: '0.8rem' }}>
                                        ({noDeptCount})
                                    </span>
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="search-box" style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                        <input
                            type="text"
                            placeholder="Tìm theo Mã NV, Họ tên, SĐT, Email..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
                            <option value="">Tất cả trạng thái</option>
                            <option value="Thử việc">Thử việc</option>
                            <option value="Chính thức">Chính thức</option>
                            <option value="Tạm nghỉ">Tạm nghỉ</option>
                            <option value="Nghỉ việc">Đã nghỉ</option>
                        </select>
                        <select value={filterBirthMonth} onChange={(e) => setFilterBirthMonth(e.target.value)}>
                            <option value="">Tất cả tháng sinh</option>
                            {Array.from({ length: 12 }, (_, i) => i + 1).map(month => (
                                <option key={month} value={month}>Tháng {month}</option>
                            ))}
                        </select>
                        <div className="employee-view-toggle">
                            <button
                                type="button"
                                className={viewMode === 'cards' ? 'active' : ''}
                                onClick={() => setViewMode('cards')}
                                title="Dạng thẻ"
                            >
                                <i className="fas fa-th-large"></i>
                            </button>
                            <button
                                type="button"
                                className={viewMode === 'list' ? 'active' : ''}
                                onClick={() => setViewMode('list')}
                                title="Dạng list"
                            >
                                <i className="fas fa-list"></i>
                            </button>
                        </div>
                    </div>

                    {filteredEmployees.length === 0 ? (
                        <div className="employee-card-empty">
                            {activeEmployees.length === 0 ? 'Chưa có dữ liệu nhân sự' : 'Không tìm thấy kết quả'}
                        </div>
                    ) : (
                        <div className="employee-dept-groups">
                            {groupedEmployees.map(group => (
                                <section key={group.dept} className="employee-dept-group">
                                    <div className="employee-dept-group__header">
                                        <h3>
                                            <i className="fas fa-building"></i>
                                            {group.dept}
                                        </h3>
                                        <span>{group.items.length} nhân viên</span>
                                    </div>
                                    {viewMode === 'cards' ? (
                                        <div className="employee-card-grid">
                                            {group.items.map((emp, idx) => renderCard(emp, idx))}
                                        </div>
                                    ) : (
                                        <div className="employee-list">
                                            {group.items.map((emp, idx) => renderListRow(emp, idx))}
                                        </div>
                                    )}
                                </section>
                            ))}
                        </div>
                    )}
                </>
            ) : (
                <StatusHistoryView employees={employees} onDataChange={() => { }} />
            )}

            <EmployeeModal
                employee={selectedEmployee}
                isOpen={isModalOpen}
                onClose={() => {
                    setIsModalOpen(false)
                    setSelectedEmployee(null)
                    setIsReadOnly(false)
                }}
                onSave={loadEmployees}
                readOnly={isReadOnly}
                departmentOptions={[...new Set(employees.map(e => e.bo_phan).filter(Boolean))]}
                positionOptions={[...new Set(employees.map(e => e.vi_tri).filter(Boolean))]}
            />

            {isImportModalOpen && (
                <div className="modal show" onClick={() => setIsImportModalOpen(false)}>
                    <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h3>
                                <i className="fas fa-file-upload"></i>
                                Upload Excel nhân sự
                            </h3>
                            <button className="modal-close" onClick={() => setIsImportModalOpen(false)}>&times;</button>
                        </div>
                        <div className="modal-body">
                            <div className="form-group">
                                <label>Chọn tệp (.xlsx, .xls, .csv)</label>
                                <input
                                    type="file"
                                    accept=".xlsx,.xls,.csv"
                                    ref={fileInputRef}
                                    onChange={(e) => {
                                        handleImportExcel(e)
                                        setIsImportModalOpen(false)
                                    }}
                                />
                            </div>
                            <div className="form-group">
                                <label>Lưu ý định dạng cột (theo thứ tự):</label>
                                <ul style={{ paddingLeft: '20px', marginTop: '8px' }}>
                                    <li>Họ và tên</li>
                                    <li>Email</li>
                                    <li>SĐT</li>
                                    <li>Tên đăng nhập (tùy chọn)</li>
                                    <li>Vai trò (tùy chọn, mặc định user)</li>
                                    <li>Tài khoản đăng nhập: cấp riêng trong hồ sơ nhân viên sau khi import</li>
                                    <li>Chi nhánh</li>
                                    <li>Bộ phận</li>
                                    <li>Vị trí</li>
                                    <li>Trạng thái</li>
                                    <li>Ngày vào làm</li>
                                    <li>Ngày chính thức</li>
                                    <li>CCCD</li>
                                    <li>Ngày cấp</li>
                                    <li>Nơi cấp</li>
                                    <li>Quê quán</li>
                                    <li>Giới tính</li>
                                    <li>Tình trạng hôn nhân</li>
                                    <li>Link ảnh (tùy chọn)</li>
                                </ul>
                                <small>Hàng đầu tiên là header. Các cột dữ liệu có thể để trống, hệ thống sẽ bỏ qua dòng trống hoàn toàn.</small>
                            </div>
                        </div>
                        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                            <button className="btn" onClick={() => setIsImportModalOpen(false)}>Đóng</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
    */
}

export default Employees
