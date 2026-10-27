import assert from 'node:assert/strict'
import test from 'node:test'
import { createAttendanceEmployeeMatcher, matchAttendanceEmployee } from './attendanceMatching.js'

test('does not auto-match a machine code collision when employee names differ', () => {
  const wrongEmployee = {
    id: 'wrong-profile',
    employeeId: '00019',
    ho_va_ten: 'Nguyễn Thị Hồng Thắm'
  }

  const match = matchAttendanceEmployee(
    '00019',
    'Nguyễn Thị Phương Anh',
    [wrongEmployee]
  )

  assert.equal(match.employee, null)
  assert.ok(match.confidence < 0.9)
  assert.equal(match.method, 'Mã trùng nhưng tên không khớp')
})

test('prefers an exact name over a colliding machine code', () => {
  const wrongEmployee = {
    id: 'wrong-profile',
    employeeId: '00019',
    ho_va_ten: 'Nguyễn Thị Hồng Thắm'
  }
  const correctEmployee = {
    id: 'correct-profile',
    employeeId: 'LU099',
    ho_va_ten: 'Nguyễn Thị Phương Anh'
  }

  const match = matchAttendanceEmployee(
    '00019',
    'Nguyễn Thị Phương Anh',
    [wrongEmployee, correctEmployee]
  )

  assert.equal(match.employee?.id, 'correct-profile')
  assert.equal(match.method, 'Tên trùng → gán mã nhân viên Lumi')
})

test('still auto-matches when both employee code and name agree', () => {
  const employee = {
    id: 'correct-profile',
    employeeId: 'LU035',
    ho_va_ten: 'Đặng Thùy Liên'
  }

  const match = matchAttendanceEmployee('LU035', 'Đặng Thùy Liên', [employee])

  assert.equal(match.employee?.id, 'correct-profile')
  assert.equal(match.status, 'matched')
})

test('does not auto-match different Vietnamese given names with a high overall similarity', () => {
  const employee = {
    id: 'wrong-profile',
    employeeId: 'LU003',
    ho_va_ten: 'Nguyễn Thị Gấm'
  }

  const match = matchAttendanceEmployee('00012', 'Nguyễn Thị Đảm', [employee])

  assert.equal(match.employee, null)
  assert.equal(match.status, 'review')
})

test('does not choose arbitrarily when multiple profiles have the same full name', () => {
  const employees = [
    { id: 'profile-1', employeeId: 'LU012', ho_va_ten: 'Nguyễn Thị Lan Anh' },
    { id: 'profile-2', employeeId: 'LU018', ho_va_ten: 'Nguyễn Thị Lan Anh' }
  ]

  const match = matchAttendanceEmployee('00004', 'Nguyễn Thị Lan Anh', employees)

  assert.equal(match.employee, null)
  assert.equal(match.status, 'review')
})

test('indexed matching keeps code conflicts, ambiguous names, typos and branch selection consistent', () => {
  const employees = [
    { id: 'a', employeeId: 'LU01', name: 'Nguyễn Văn An', branch: 'HCM' },
    { id: 'b', employeeId: 'LU02', name: 'Nguyễn Văn Anh', branch: 'HCM' },
    { id: 'c', employeeId: 'LU03', name: 'Trần Thị Lan', branch: 'HCM' },
    { id: 'd', employeeId: 'LU04', name: 'Trần Thị Lan', branch: 'HN' }
  ]
  for (const branch of ['', 'HCM', 'HN', 'Không có']) {
    const match = createAttendanceEmployeeMatcher(employees, branch)
    for (const [code, name] of [
      ['M01', 'NGUYENVANAN'], ['LU01', 'Trần Thị Lan'], ['M02', 'Trần Thị Lan'],
      ['LU04', 'Trần Thị Lan'], ['LU01', 'Nguyễn Văn Ann'], ['LU02', ''],
      ['M03', 'Nguyễn Văn Anh'], ['LU01', 'Nguyễn Văn Anh'], ['M04', 'Không có tên này']
    ]) {
      const legacy = matchAttendanceEmployee(code, name, employees, branch)
      const actual = match(code, name)
      assert.equal(actual.employee?.id, legacy.employee?.id, `${branch}: ${code}/${name}`)
      assert.equal(actual.suggestedEmployee?.id, legacy.suggestedEmployee?.id)
      assert.equal(actual.status, legacy.status)
      assert.equal(actual.method, legacy.method)
      assert.equal(actual.confidence, legacy.confidence)
      assert.strictEqual(actual, match(code, name), 'daily rows reuse the cached match')
    }
  }
})

test('matching cache is isolated to the current roster and selected branch', () => {
  const employees = [
    { id: 'hcm', employeeId: '01', name: 'Trần Văn An', branch: 'HCM' },
    { id: 'hn', employeeId: '02', name: 'Trần Văn An', branch: 'HN' }
  ]
  assert.equal(createAttendanceEmployeeMatcher(employees, 'HCM')('M1', 'TRAN VAN AN').employee.id, 'hcm')
  assert.equal(createAttendanceEmployeeMatcher(employees, 'HN')('M1', 'TRAN VAN AN').employee.id, 'hn')
  assert.equal(createAttendanceEmployeeMatcher([])('M1', 'TRAN VAN AN').employee, null)
})
