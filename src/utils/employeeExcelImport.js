const NAME_HEADERS = new Set(['ho_va_ten', 'ho_ten', 'ten_nhan_vien', 'ten', 'name'])
const CODE_HEADERS = new Set(['ma_nhan_vien', 'ma_nv', 'employee_id'])
const OTHER_HEADERS = new Set([
  'chi_nhanh', 'email_ca_nhan', 'email', 'vi_tri', 'vi_tri_cong_viec',
  'so_cccd', 'so_cmnd', 'sdt', 'so_dien_thoai', 'ngay_vao_lam',
  'ngay_bat_dau_di_lam'
])

export function normalizeEmployeeExcelHeader(value) {
  return String(value ?? '')
    .trim()
    .replace(/^\d+\s*[.)\-:]\s*/, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

export function normalizeImportedPhone(value) {
  const phone = String(value ?? '').trim().replace(/^[‘’'"\s]+/, '')
  // Excel often stores a Vietnamese mobile number as a nine-digit number,
  // dropping its leading zero before the importer receives it.
  return /^[35789]\d{8}$/.test(phone) ? `0${phone}` : phone
}

const hasValue = row => Array.isArray(row) && row.some(cell => String(cell ?? '').trim() !== '')

export function readEmployeeExcelRows(XLSX, workbook) {
  let selected = null

  for (const name of workbook.SheetNames || []) {
    const sheet = workbook.Sheets[name]
    if (!sheet?.['!ref']) continue
    const display = XLSX.utils.sheet_to_json(sheet, {
      header: 1, defval: '', blankrows: true, raw: false
    })
    const raw = XLSX.utils.sheet_to_json(sheet, {
      header: 1, defval: '', blankrows: true, raw: true
    })
    const firstRow = XLSX.utils.decode_range(sheet['!ref']).s.r + 1

    for (let index = 0; index < Math.min(display.length, 20); index++) {
      const headers = (display[index] || []).map(normalizeEmployeeExcelHeader)
      if (!headers.some(header => NAME_HEADERS.has(header))) continue
      const score = 20
        + (headers.some(header => CODE_HEADERS.has(header)) ? 10 : 0)
        + headers.filter(header => OTHER_HEADERS.has(header)).length
      const dataRows = display.slice(index + 1)
        .map((displayRow, offset) => ({
          displayRow,
          rawRow: raw[index + 1 + offset] || [],
          rowNumber: firstRow + index + 1 + offset
        }))
        .filter(item => hasValue(item.displayRow))
      if (!selected || score > selected.score ||
        (score === selected.score && dataRows.length > selected.dataRows.length)) {
        selected = { headers, dataRows, score }
      }
    }
  }

  if (!selected) {
    throw new Error('Không tìm thấy cột Họ và tên trong file Excel. Hãy kiểm tra dòng tiêu đề hoặc dùng file mẫu.')
  }
  if (!selected.dataRows.length) throw new Error('File chỉ có tiêu đề, chưa có dòng nhân viên.')
  return { headers: selected.headers, dataRows: selected.dataRows }
}
