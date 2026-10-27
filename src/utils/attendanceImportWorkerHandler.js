import * as XLSX from 'xlsx'
import { createAttendanceImportProcessor } from './attendanceImportProcessor.js'

// The workbook stays inside the worker between reading and processing.
export const createAttendanceImportWorkerHandler = () => {
  const sheets = new Map()
  return ({ type, data, sheetName, options }) => {
    if (type === 'read') {
      const workbook = XLSX.read(data, { type: 'array' })
      sheets.clear()
      return workbook.SheetNames.map(name => {
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: '' })
        sheets.set(name, rows)
        return { name, rows }
      })
    }
    if (type === 'deoca') {
      const rows = sheets.get(sheetName)
      if (!rows) throw new Error('Không tìm thấy sheet chấm công đã đọc.')
      const processor = createAttendanceImportProcessor(options)
      const result = processor.processDeocaPunchFormat(rows)
      const preview = processor.prepareMatchingPreview(result.logs)
      return { preview, skipped: result.skipped }
    }
    throw new Error('Không hỗ trợ thao tác đọc file này.')
  }
}
