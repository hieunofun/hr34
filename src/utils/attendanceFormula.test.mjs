import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import xlsx from 'xlsx'

test('Công thức công ngày: Math.min(tong_gio / 8, 1) không làm tròn từng ngày', () => {
  const calculateDailyCong = (hours) => Math.min(Number(hours) / 8, 1)

  // 8h = 1 công
  assert.equal(calculateDailyCong(8), 1)

  // > 8h vẫn tối đa 1 công
  assert.equal(calculateDailyCong(9.5), 1)
  assert.equal(calculateDailyCong(12), 1)

  // < 8h giữ nguyên float không làm tròn
  assert.equal(calculateDailyCong(7.55), 7.55 / 8)
  assert.equal(calculateDailyCong(4), 0.5)
  assert.equal(calculateDailyCong(3.22), 3.22 / 8)
  assert.equal(calculateDailyCong(0), 0)
})

test('Công thức Tổng công tháng: cộng giá trị nguyên bản, chỉ round ở tổng cuối', () => {
  // Ví dụ 4 ngày mỗi ngày làm 7.55 giờ:
  // Mỗi ngày: 7.55 / 8 = 0.94375
  // Tổng nguyên bản: 0.94375 * 4 = 3.775 -> Round tổng cuối: 3.78
  // Nếu làm tròn từng ngày: 0.94 * 4 = 3.76 -> Bị lệch 0.02
  const hoursList = [7.55, 7.55, 7.55, 7.55]
  const unroundedDaily = hoursList.map(h => Math.min(h / 8, 1))
  const sum = unroundedDaily.reduce((acc, c) => acc + c, 0)
  const finalTotal = Math.round(sum * 100) / 100

  const roundedDailySum = hoursList
    .map(h => Math.round(Math.min(h / 8, 1) * 100) / 100)
    .reduce((acc, c) => acc + c, 0)

  assert.equal(finalTotal, 3.78)
  assert.equal(Math.round(roundedDailySum * 100) / 100, 3.76)
  assert.notEqual(finalTotal, Math.round(roundedDailySum * 100) / 100)
})

test('Khớp chính xác 100% 8 nhân viên từ 167 bản ghi file test tháng 08/2026', (t) => {
  const filePath = 'Cong_T88_da_dien_du_lieu_test.xlsx'
  if (!fs.existsSync(filePath)) {
    t.skip(`Thiếu file Excel mẫu: ${filePath}`)
    return
  }

  const buf = fs.readFileSync(filePath)
  const wb = xlsx.read(buf, { type: 'array' })
  const ws = wb.Sheets['Xuất lưới']
  const data = xlsx.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })

  const byEmp = {}
  for (let r = 3; r < data.length; r++) {
    const row = data[r]
    if (!row || !row[2]) continue
    const code = String(row[2]).trim()
    const name = String(row[3]).trim()
    const hours = parseFloat(String(row[18]).replace(',', '.')) || 0
    const cong = Math.min(hours / 8, 1)

    if (!byEmp[code]) byEmp[code] = { code, name, sum: 0, count: 0 }
    byEmp[code].sum += cong
    byEmp[code].count += 1
  }

  const expectedResults = {
    '00001': { name: 'Lê Trung Sỹ', total: 14.29, rows: 21 },
    '00002': { name: 'Tạ Trần Thanh Tùng', total: 7.91, rows: 19 },
    '00003': { name: 'Nguyễn Thị Mai', total: 10.53, rows: 21 },
    '00004': { name: 'Trần Quốc Đạt', total: 14.61, rows: 21 },
    '00005': { name: 'Đào Xuân Quyết', total: 10.31, rows: 21 },
    '00006': { name: 'Nguyễn Minh Hiếu', total: 13.44, rows: 22 },
    '00007': { name: 'Nguyễn Hồng Hạnh', total: 13.62, rows: 21 },
    '00008': { name: 'Nguyễn Thị Thùy Linh', total: 13.08, rows: 21 }
  }

  let totalRecords = 0
  for (const [code, exp] of Object.entries(expectedResults)) {
    assert.ok(byEmp[code], `Phải có dữ liệu nhân viên mã ${code}`)
    assert.equal(byEmp[code].name, exp.name)
    assert.equal(byEmp[code].count, exp.rows, `Mã ${code} phải có đúng ${exp.rows} dòng`)
    const calculated = Math.round(byEmp[code].sum * 100) / 100
    assert.equal(calculated, exp.total, `Mã ${code} (${exp.name}) phải có tổng công ${exp.total}, thực tế: ${calculated}`)
    totalRecords += byEmp[code].count
  }

  assert.equal(totalRecords, 167, 'Tổng số bản ghi phải đúng 167 bản ghi')
})
