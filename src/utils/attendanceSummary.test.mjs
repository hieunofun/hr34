import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAttendanceSummary, summarizeAttendanceDay } from './attendanceSummary.js'

test('tổng hợp giữ bộ phận chi tiết của Excel dù hồ sơ HR thuộc nhóm rộng', () => {
  const rows = buildAttendanceSummary({
    attendanceLogs: [{
      employeeId: 'employee-media',
      date: '2026-08-01',
      importFormat: 'attendance-monthly-matrix',
      calculationMode: 'matrix-value',
      department: 'MKT',
      sourceDepartment: 'Media',
      cong: 1
    }],
    employees: [{ id: 'employee-media', ho_va_ten: 'Nhân viên Media', bo_phan: 'MKT' }],
    month: '2026-08'
  })
  assert.equal(rows[0].department, 'Media')
})

test('keeps an unmatched source employee and recalculates punches by actual minutes', () => {
  const rows = buildAttendanceSummary({
    attendanceLogs: [{
      employeeId: 'external:00002::nguyenbuikhanhvan',
      employeeCode: '00002',
      employeeName: 'Nguyễn Bùi Khánh Vân',
      sourceEmployeeCode: '00002',
      sourceEmployeeName: 'Nguyễn Bùi Khánh Vân',
      department: 'Văn phòng',
      date: '2026-08-01',
      cong: 0.9,
      congPlus: 0,
      hours: 7.2,
      vao: '07:00',
      ra: '17:00'
    }],
    employees: [],
    month: '2026-08'
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0].employeeCode, '00002')
  assert.equal(rows[0].employeeName, 'Nguyễn Bùi Khánh Vân')
  assert.equal(rows[0].department, 'Văn phòng')
  // 07:00 → 17:00 (loại 2h trưa theo splitShift) = 480 phút = 1 công, 8h làm việc.
  assert.equal(rows[0].workdays, 1)
  assert.equal(rows[0].days.get('2026-08-01').hours, 8)
})
test('recalculates the late report from actual punches and each employee shift', () => {
  const employees = [
    { id: 'normal', name: 'Nhân viên thường', position: 'HR', shift: 'Ca ngày' },
    { id: 'sale', name: 'Nhân viên Sale', position: 'Sale', shift: 'Ca ngày' }
  ]
  const rows = buildAttendanceSummary({
    attendanceLogs: [
      {
        employeeId: 'normal',
        date: '2026-08-06',
        vao: '08:35',
        ra: '17:36',
        lateMinutes: 65,
        earlyMinutes: 0,
        cong: 1,
        hours: 8
      },
      {
        employeeId: 'sale',
        date: '2026-08-05',
        vao: '04:02',
        ra: '13:38',
        lateMinutes: 0,
        earlyMinutes: 202,
        cong: 1,
        hours: 8
      }
    ],
    employees,
    month: '2026-08',
    attendanceSettings: {
      workStart: '08:30',
      shifts: {
        administrative: { standardCheckIn: '08:30', standardCheckOut: '17:30' }
      }
    }
  })

  const normal = rows.find(row => row.employeeId === 'normal')
  const sale = rows.find(row => row.employeeId === 'sale')
  assert.equal(normal.lateMinutes, 5)
  assert.equal(normal.earlyMinutes, 0)
  assert.equal(normal.lateCount, 1)
  assert.equal(sale.lateMinutes, 2)
  assert.equal(sale.earlyMinutes, 0)
  assert.equal(sale.lateCount, 1)
})
test('uses configured times for the employee shift in summary reports', () => {
  const employees = [
    { id: 'normal', name: 'Hành chính', position: 'HR', shift: 'Ca Hành chính' },
    { id: 'sale', name: 'Sale', position: 'Sale', shift: 'Ca Sáng Sale' }
  ]
  const attendanceLogs = [
    { employeeId: 'normal', date: '2026-08-01', vao: '08:40', ra: '17:35', cong: 1 },
    { employeeId: 'sale', date: '2026-08-01', vao: '04:10', ra: '13:25', cong: 1 }
  ]
  const attendanceSettings = {
    shifts: {
      administrative: { standardCheckIn: '08:35', standardCheckOut: '17:40' },
      saleMorning: { standardCheckIn: '04:05', standardCheckOut: '13:35' }
    }
  }

  const rows = buildAttendanceSummary({
    attendanceLogs,
    employees,
    month: '2026-08',
    attendanceSettings
  })
  const normal = rows.find(row => row.employeeId === 'normal')
  const sale = rows.find(row => row.employeeId === 'sale')

  assert.equal(normal.lateMinutes, 5)
  assert.equal(normal.earlyMinutes, 5)
  assert.equal(sale.lateMinutes, 5)
  assert.equal(sale.earlyMinutes, 10)
})

test('hiển thị ngày lễ cho nhân viên không có log nhưng không tự cộng công', () => {
  const rows = buildAttendanceSummary({
    attendanceLogs: [],
    employees: [{ id: 'employee-holiday', name: 'Nhân viên ngày lễ' }],
    month: '2026-09',
    attendanceSettings: {
      holidays: [{ date: '2026-09-02', name: 'Quốc khánh' }]
    }
  })

  const row = rows[0]
  const holiday = row.days.get('2026-09-02')
  assert.equal(holiday.isHoliday, true)
  assert.equal(holiday.holidayName, 'Quốc khánh')
  assert.equal(holiday.hours, 0)
  assert.equal(holiday.workdays, 0)
  assert.equal(row.attendanceDays, 0)
  assert.equal(row.workdays, 0)
})

test('tách công thực tế, phép hưởng lương và tổng công tính lương', () => {
  const rows = buildAttendanceSummary({
    attendanceLogs: [
      {
        employeeId: 'employee-breakdown',
        date: '2026-08-03',
        cong: 0.88,
        hours: 7.02
      },
      {
        employeeId: 'employee-breakdown',
        date: '2026-08-04',
        cong: 0,
        congPlus: 1,
        kyHieuPlus: 'V'
      }
    ],
    employees: [{ id: 'employee-breakdown', name: 'Nhân viên tách công' }],
    month: '2026-08'
  })

  assert.equal(rows[0].actualWorkdays, 0.88)
  assert.equal(rows[0].paidLeaveWorkdays, 1)
  assert.equal(rows[0].workdays, 1.88)
})

test('nhận P1 từ matrix import là phép hưởng lương nhưng vẫn giữ tổng công', () => {
  const day = summarizeAttendanceDay(
    [{
      employeeId: 'employee-paid-leave',
      date: '2026-08-03',
      cong: 1,
      hours: 8,
      kyHieu: 'P1',
      calculationMode: 'matrix-value',
      syntheticPunch: true
    }],
    { id: 'employee-paid-leave', name: 'Nhân viên phép' },
    {},
    '2026-08-03'
  )

  assert.equal(day.workdays, 1)
  assert.equal(day.paidLeaveWorkdays, 1)
})

test('bảng công áp dụng hai khung buổi cho cả một hoặc hai cặp chấm', () => {
  const attendanceSettings = {
    shifts: {
      administrative: {
        name: 'Ca Hành chính',
        standardCheckIn: '08:30',
        standardCheckOut: '17:30',
        splitShift: {
          enabled: true,
          morning: { start: '08:30', end: '12:00', workdays: 0.5 },
          afternoon: { start: '13:00', end: '17:30', workdays: 0.5 }
        }
      },
      saleMorning: {
        name: 'Ca Sáng Sale',
        standardCheckIn: '04:00',
        standardCheckOut: '13:30',
        splitShift: {
          enabled: true,
          morning: { start: '04:00', end: '08:00', workdays: 0.5 },
          afternoon: { start: '09:30', end: '13:30', workdays: 0.5 }
        }
      }
    }
  }
  const rows = buildAttendanceSummary({
    attendanceLogs: [
      {
        employeeId: 'split-worker',
        date: '2026-08-03',
        vao: '08:30',
        ra: '17:30',
        punchPairs: [
          { checkIn: '08:30', checkOut: '12:00' },
          { checkIn: '13:00', checkOut: '17:30' }
        ]
      },
      {
        employeeId: 'full-worker',
        date: '2026-08-03',
        vao: '08:30',
        ra: '17:30',
        punchPairs: [{ checkIn: '08:30', checkOut: '17:30' }]
      },
      {
        employeeId: 'sale-split-worker',
        date: '2026-08-03',
        vao: '04:00',
        ra: '13:30',
        punchPairs: [
          { checkIn: '04:00', checkOut: '08:00' },
          { checkIn: '09:30', checkOut: '13:30' }
        ]
      }
    ],
    employees: [
      { id: 'split-worker', name: 'Nhân viên chia buổi', shift: 'Ca Hành chính' },
      { id: 'full-worker', name: 'Nhân viên full ngày', shift: 'Ca Hành chính' },
      { id: 'sale-split-worker', name: 'Sale chia buổi', shift: 'Ca Sáng Sale', position: 'Sale' }
    ],
    month: '2026-08',
    attendanceSettings
  })

  const splitDay = rows.find(row => row.employeeId === 'split-worker').days.get('2026-08-03')
  const fullDay = rows.find(row => row.employeeId === 'full-worker').days.get('2026-08-03')
  const saleSplitDay = rows.find(row => row.employeeId === 'sale-split-worker').days.get('2026-08-03')
  assert.equal(splitDay.calculationMode, 'split-shift')
  assert.equal(splitDay.hours, 8)
  assert.equal(splitDay.workdays, 1)
  assert.equal(fullDay.calculationMode, 'split-shift')
  assert.equal(fullDay.hours, 8)
  assert.equal(fullDay.workdays, 1)
  assert.equal(saleSplitDay.calculationMode, 'split-shift')
  assert.equal(saleSplitDay.hours, 8)
  assert.equal(saleSplitDay.workdays, 1)
})

test('bảng công tính từng buổi theo phút và tự bỏ giờ nghỉ trưa', () => {
  const attendanceSettings = {
    standardWorkMinutes: 480,
    unpaidBreakMinutes: 60,
    shifts: {
      administrative: {
        name: 'Ca Hành chính',
        standardCheckIn: '08:30',
        standardCheckOut: '17:30',
        splitShift: {
          enabled: true,
          morning: { start: '08:30', end: '12:00', workdays: 0.5 },
          afternoon: { start: '13:00', end: '17:30', workdays: 0.5 }
        }
      }
    }
  }
  const punches = [
    ['2026-08-01', '08:24', '17:37'],
    ['2026-08-02', '08:30', '12:33'],
    ['2026-08-03', '12:30', '17:33'],
    ['2026-08-04', '09:00', '17:30']
  ]
  const rows = buildAttendanceSummary({
    attendanceLogs: punches.map(([date, checkIn, checkOut]) => ({
      employeeId: 'worker', date, vao: checkIn, ra: checkOut,
      calculationMode: 'punches',
      punchPairs: [{ checkIn, checkOut }]
    })),
    employees: [{ id: 'worker', name: 'Nhân viên', shift: 'Ca Hành chính' }],
    month: '2026-08',
    attendanceSettings
  })
  const days = rows[0].days
  assert.equal(days.get('2026-08-01').workdaysExact, 1)
  assert.equal(days.get('2026-08-01').hours, 8)
  assert.equal(days.get('2026-08-02').workdaysExact, 0.5)
  assert.equal(days.get('2026-08-02').hours, 3.5)
  assert.equal(days.get('2026-08-02').earlyMinutes, 0)
  assert.equal(days.get('2026-08-03').workdaysExact, 0.5)
  assert.equal(days.get('2026-08-03').hours, 4.5)
  assert.equal(days.get('2026-08-03').lateMinutes, 0)
  assert.equal(days.get('2026-08-04').workdaysExact, 180 / 210 * 0.5 + 0.5)
  assert.equal(days.get('2026-08-04').hours, 7.5)
  assert.equal(days.get('2026-08-04').lateMinutes, 30)
})

test('nhiều log trong một ngày không cộng khoảng trống giữa hai lượt chấm', () => {
  const summary = buildAttendanceSummary({
    attendanceLogs: [
      { employeeId: 'worker', date: '2026-08-05', vao: '08:30', ra: '10:00' },
      { employeeId: 'worker', date: '2026-08-05', vao: '11:00', ra: '12:00' }
    ],
    employees: [{ id: 'worker', name: 'Nhân viên', shift: 'Ca Hành chính' }],
    month: '2026-08',
    attendanceSettings: {
      shifts: {
        administrative: {
          name: 'Ca Hành chính',
          standardCheckIn: '08:30', standardCheckOut: '17:30',
          splitShift: {
            enabled: true,
            morning: { start: '08:30', end: '12:00', workdays: 0.5 },
            afternoon: { start: '13:00', end: '17:30', workdays: 0.5 }
          }
        }
      }
    }
  })
  const day = summary[0].days.get('2026-08-05')
  assert.equal(day.hours, 2.5)
  assert.equal(day.workdaysExact, 150 / 210 * 0.5)
})

test('summary dùng Vào đầu và Ra cuối cho cặp chia buổi bị thiếu', () => {
  const attendanceSettings = {
    shifts: {
      administrative: {
        name: 'Ca Hành chính',
        standardCheckIn: '08:30',
        standardCheckOut: '17:30',
        splitShift: {
          enabled: true,
          morning: { start: '08:30', end: '12:00', workdays: 0.5 },
          afternoon: { start: '13:00', end: '17:30', workdays: 0.5 }
        }
      }
    }
  }
  const rows = buildAttendanceSummary({
    attendanceLogs: [
      {
        employeeId: 'partial-morning',
        date: '2026-08-19',
        vao: '08:00',
        ra: '12:00',
        punchPairs: [
          { checkIn: '08:00', checkOut: '12:00' },
          { checkIn: '13:00', checkOut: '' }
        ]
      },
      {
        employeeId: 'partial-afternoon',
        date: '2026-08-20',
        vao: '08:00',
        ra: '17:30',
        punchPairs: [
          { checkIn: '08:00', checkOut: '12:00' },
          { checkIn: '', checkOut: '17:30' }
        ]
      }
    ],
    employees: [
      { id: 'partial-morning', name: 'Thiếu Ra chiều', shift: 'Ca Hành chính' },
      { id: 'partial-afternoon', name: 'Thiếu Vào chiều', shift: 'Ca Hành chính' }
    ],
    month: '2026-08',
    attendanceSettings
  })

  const morningDay = rows.find(row => row.employeeId === 'partial-morning').days.get('2026-08-19')
  const afternoonDay = rows.find(row => row.employeeId === 'partial-afternoon').days.get('2026-08-20')
  assert.equal(morningDay.hours, 3.5)
  assert.equal(morningDay.workdays, 0.5)
  assert.equal(morningDay.calculationMode, 'split-shift')
  assert.equal(afternoonDay.hours, 8)
  assert.equal(afternoonDay.workdays, 1)
  assert.equal(afternoonDay.calculationMode, 'split-shift')
})

test('giữ Công và Giờ nguồn khi policy ưu tiên Công từ Excel', () => {
  const summary = summarizeAttendanceDay([
    {
      employeeId: 'nv-source',
      date: '2026-08-01',
      vao: '08:00',
      ra: '18:00',
      cong: 0.5,
      hours: 4,
      lateMinutes: 7,
      earlyMinutes: 3,
      calculationMode: 'source-value'
    }
  ], {}, { importPriorityMode: 'imported_work_unit' })

  assert.equal(summary.regularWorkdaysExact, 0.5)
  assert.equal(summary.hoursExact, 4)
  assert.equal(summary.lateMinutes, 7)
  assert.equal(summary.earlyMinutes, 3)
  assert.equal(summary.calculationMode, 'source-value')
})
