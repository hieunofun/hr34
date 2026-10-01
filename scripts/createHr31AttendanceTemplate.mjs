import ExcelJS from 'exceljs'
import { fileURLToPath } from 'node:url'

const sourcePath = process.argv[2]
if (!sourcePath) throw new Error('Usage: node scripts/createHr31AttendanceTemplate.mjs <source.xlsx>')

const workbook = new ExcelJS.Workbook()
await workbook.xlsx.readFile(sourcePath)
const sheet = workbook.worksheets[0]
if (!sheet) throw new Error('Source workbook has no worksheet')

const labels = new Map()
for (const rowNumber of [7, 8]) {
  for (let column = 1; column <= 64; column += 1) {
    if (column >= 18 && column <= 48) continue
    const cell = sheet.getRow(rowNumber).getCell(column)
    if (typeof cell.value === 'string' && cell.type !== ExcelJS.ValueType.Merge) {
      labels.set(cell.address, cell.value)
    }
  }
}

sheet.eachRow({ includeEmpty: true }, row => {
  row.eachCell({ includeEmpty: true }, cell => {
    if (cell.type !== ExcelJS.ValueType.Merge) cell.value = null
    // ExcelJS's note setter creates a note even for null; remove the imported comment model.
    cell._comment = undefined
  })
})
sheet.conditionalFormattings = []
sheet.getCell('A3').value = 'BẢNG TỔNG HỢP CHẤM CÔNG'
sheet.getCell('A40').value = 'Tổng Giám đốc'
sheet.getCell('S40').value = 'Ban Nhân sự'
sheet.getCell('BE40').value = 'Người lập'
for (const [address, value] of labels) sheet.getCell(address).value = value
sheet.name = 'MAU_BANG_CONG_HR31'
workbook.creator = 'HR34'
workbook.lastModifiedBy = 'HR34'
workbook.subject = 'Mẫu bảng công HR31 đã xóa dữ liệu nhân sự'
workbook.title = 'Bảng công HR31'
workbook.company = 'HR34'

await workbook.xlsx.writeFile(fileURLToPath(new URL('../public/templates/hr31-attendance-template.xlsx', import.meta.url)))
