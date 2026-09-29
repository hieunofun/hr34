import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyCalculatedAttendanceTiming,
  buildAttendanceShiftSettingsPayload,
  calculateAttendanceTiming,
  formatAttendanceTime,
  findMissingAttendanceShifts,
  normalizeAttendanceShiftSettings,
  resolveAttendanceShift,
  validateAttendancePolicy
} from './attendanceShift.js'

test('uses the normal morning shift for a non-Sale employee', () => {
  const result = calculateAttendanceTiming({
    employee: { position: 'HR', shift: 'Ca ngày' },
    checkIn: '08:45',
    checkOut: '17:20',
    attendanceSettings: { workStart: '08:30', workEnd: '17:30' }
  })

  assert.equal(result.shift.start, '08:30')
  assert.equal(result.shift.end, '17:30')
  assert.equal(result.lateMinutes, 15)
  assert.equal(result.earlyMinutes, 10)
})

test('uses 04:00-13:30 for an employee identified as Sale', () => {
  const result = calculateAttendanceTiming({
    employee: { department: 'Trang', position: 'Sale', shift: 'Ca ngày' },
    checkIn: '04:15',
    checkOut: '13:20'
  })

  assert.equal(result.shift.start, '04:00')
  assert.equal(result.shift.end, '13:30')
  assert.equal(result.lateMinutes, 15)
  assert.equal(result.earlyMinutes, 10)
})

test('stores and resolves separate times for each configured shift', () => {
  const settings = normalizeAttendanceShiftSettings({
    shifts: {
      administrative: {
        name: 'Ca Hành chính',
        standardCheckIn: '08:35',
        standardCheckOut: '17:40'
      },
      saleMorning: {
        name: 'Ca Sáng Sale',
        standardCheckIn: '04:05',
        standardCheckOut: '13:35'
      }
    }
  })

  assert.deepEqual(
    resolveAttendanceShift({ shift: 'Ca Hành chính', position: 'HR' }, {}, settings),
    { name: 'Ca Hành chính', start: '08:35', end: '17:40' }
  )
  assert.deepEqual(
    resolveAttendanceShift({ shift: 'Ca Sáng Sale', position: 'Sale' }, {}, settings),
    { name: 'Ca Sáng Sale', start: '04:05', end: '13:35' }
  )

  const payload = buildAttendanceShiftSettingsPayload(settings)
  assert.equal(payload.shifts.administrative.standardCheckIn, '08:35')
  assert.equal(payload.shifts.saleMorning.standardCheckIn, '04:05')
  assert.equal(payload.standardCheckIn, '08:35')
})

test('legacy shared settings only change the administrative shift', () => {
  const settings = normalizeAttendanceShiftSettings({
    standardCheckIn: '09:00',
    standardCheckOut: '18:00'
  })

  assert.equal(settings.shifts.administrative.standardCheckIn, '09:00')
  assert.equal(settings.shifts.saleMorning.standardCheckIn, '04:00')
  assert.equal(settings.shifts.saleMorning.standardCheckOut, '13:30')
})

test('reuses the existing Trang team mapping to identify Sale employees', () => {
  const result = resolveAttendanceShift({ department: 'Trang', position: '' })
  assert.deepEqual(result, resolveAttendanceShift({ position: 'Sale' }))
})

test('configured shift ID and exact name take priority over Sale role inference', () => {
  const settings = normalizeAttendanceShiftSettings({ shifts: {
    custom_evening: { name: 'Ca tối riêng', standardCheckIn: '15:00', standardCheckOut: '23:00' }
  } })
  assert.equal(resolveAttendanceShift({ position: 'Sale', shift_id: 'custom_evening' }, {}, settings).name, 'Ca tối riêng')
  assert.equal(resolveAttendanceShift({ position: 'Sale', shift: 'Ca tối riêng' }, {}, settings).start, '15:00')
  assert.equal(resolveAttendanceShift({ position: 'Sale', shift_id: 'administrative' },
    { shift_id: 'custom_evening' }, settings).name, 'Ca tối riêng')
})

test('prefers an explicit shift range in the attendance row over Sale inference', () => {
  const result = resolveAttendanceShift(
    { position: 'Sale' },
    { shiftName: 'Ca điều động 09:00 - 18:00' }
  )
  assert.equal(result.start, '09:00')
  assert.equal(result.end, '18:00')
})

test('prefers an explicit time range stored in the employee shift', () => {
  assert.deepEqual(
    resolveAttendanceShift({ shift: 'Ca riêng 07:15 - 16:45', position: 'Sale' }),
    { name: 'Ca riêng 07:15 - 16:45', start: '07:15', end: '16:45' }
  )
})

test('keeps actual punch strings while replacing incorrect source penalties', () => {
  const log = applyCalculatedAttendanceTiming({
    vao: '04:02',
    ra: '13:38',
    lateMinutes: 0,
    earlyMinutes: 202
  }, { position: 'Sale' })

  assert.equal(log.vao, '04:02')
  assert.equal(log.ra, '13:38')
  assert.equal(log.lateMinutes, 2)
  assert.equal(log.earlyMinutes, 0)
})

test('preserves company shifts and uses the shift declared by each DEOCA row', () => {
  const settings = normalizeAttendanceShiftSettings({
    shifts: {
      custom_ca_1: { name: 'Ca 1', standardCheckIn: '06:00', standardCheckOut: '14:00' },
      custom_ca_2: { name: 'Ca 2', standardCheckIn: '14:00', standardCheckOut: '22:00' }
    }
  })
  const payload = buildAttendanceShiftSettingsPayload(settings)
  assert.equal(payload.shifts.custom_ca_1.name, 'Ca 1')
  assert.equal(payload.shifts.custom_ca_2.standardCheckOut, '22:00')
  const timing = calculateAttendanceTiming({
    employee: { shift: 'Ca ngày', position: 'HR' },
    log: { importFormat: 'deoca-punch', shiftName: 'Ca 2' },
    checkIn: '14:13',
    checkOut: '21:48',
    attendanceSettings: settings
  })
  assert.equal(timing.shift.name, 'Ca 2')
  assert.equal(timing.lateMinutes, 13)
  assert.equal(timing.earlyMinutes, 12)
})

test('finds missing DEOCA shifts using the same name matching as timing', () => {
  const settings = normalizeAttendanceShiftSettings({ shifts: {
    custom_ca_1: { name: 'Ca 1', standardCheckIn: '06:00', standardCheckOut: '14:00' },
    custom_ca_2: { name: 'Ca 2', standardCheckIn: '14:00', standardCheckOut: '22:00' }
  } })
  const logs = [
    { importFormat: 'deoca-punch', shiftName: ' CA\u00a0 1 ', _sourceEmployeeKey: 'a' },
    { importFormat: 'deoca-punch', shiftName: 'Ca02', _sourceEmployeeKey: 'b' },
    { importFormat: 'deoca-punch', shiftName: 'Ca 3', _sourceEmployeeKey: 'c' },
    { importFormat: 'deoca-punch', shiftName: 'ca03', _sourceEmployeeKey: 'd' }
  ]
  assert.deepEqual(findMissingAttendanceShifts(logs, settings), ['Ca 3'])
  assert.deepEqual(findMissingAttendanceShifts(logs, settings, new Set(['c', 'd'])), [])
  assert.equal(resolveAttendanceShift({}, logs[0], settings).start, '06:00')
})

test('DEOCA Ca 1 and Ca 2 can share the full administrative workday', () => {
  const settings = normalizeAttendanceShiftSettings({
    workStart: '07:00',
    workEnd: '17:30',
    deocaShiftAliases: { 'Ca 1': 'administrative', 'Ca02': 'administrative' }
  })
  const payload = buildAttendanceShiftSettingsPayload(settings)
  assert.deepEqual(payload.deocaShiftAliases, { 'ca 1': 'administrative', 'ca 2': 'administrative' })
  const logs = ['Ca 1', 'Ca 2'].map(shiftName => ({ importFormat: 'deoca-punch', shiftName }))
  assert.deepEqual(findMissingAttendanceShifts(logs, settings), [])
  for (const log of logs) {
    const timing = calculateAttendanceTiming({
      employee: { position: 'Sale', shift: 'Ca ngày' },
      log,
      checkIn: '07:12',
      checkOut: '17:20',
      attendanceSettings: settings
    })
    assert.equal(timing.shift.name, 'Ca Hành chính')
    assert.equal(timing.shift.start, '07:00')
    assert.equal(timing.shift.end, '17:30')
    assert.equal(timing.lateMinutes, 12)
    assert.equal(timing.earlyMinutes, 10)
  }
  const withExplicitShift = normalizeAttendanceShiftSettings({
    ...settings,
    shifts: {
      ...settings.shifts,
      ca1: { name: 'Ca 1', standardCheckIn: '06:00', standardCheckOut: '14:00' }
    }
  })
  assert.equal(resolveAttendanceShift({}, logs[0], withExplicitShift).start, '06:00')
})

test('new custom shifts inherit a valid workday standard when only hours are entered', () => {
  const settings = normalizeAttendanceShiftSettings({
    shifts: {
      custom_ca_1: { name: 'Ca 1', standardCheckIn: '06:00', standardCheckOut: '14:00' }
    }
  })
  assert.equal(settings.shifts.custom_ca_1.standardWorkMinutes, settings.standardWorkMinutes)
  assert.equal(validateAttendancePolicy(settings).isValid, true)
})

test('split shift timing does not mark a morning-only checkout or afternoon-only checkin as missing a half-day', () => {
  const settings = normalizeAttendanceShiftSettings({
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
  })
  const employee = { shift: 'Ca Hành chính', position: 'HR' }
  const morning = calculateAttendanceTiming({
    employee, checkIn: '08:24', checkOut: '12:33', attendanceSettings: settings
  })
  assert.equal(morning.lateMinutes, 0)
  assert.equal(morning.earlyMinutes, 0)

  const afternoon = calculateAttendanceTiming({
    employee, checkIn: '12:30', checkOut: '17:33', attendanceSettings: settings
  })
  assert.equal(afternoon.lateMinutes, 0)
  assert.equal(afternoon.earlyMinutes, 0)

  const late = calculateAttendanceTiming({
    employee, checkIn: '09:00', checkOut: '17:30', attendanceSettings: settings
  })
  assert.equal(late.lateMinutes, 30)
  assert.equal(late.earlyMinutes, 0)
})

test('formats stored timestamps in the attendance timezone', () => {
  assert.equal(formatAttendanceTime('2026-08-05T21:02:00.000Z'), '04:02')
  assert.equal(formatAttendanceTime('8:30 PM'), '20:30')
})

test('lưu cấu hình chia hai buổi độc lập cho từng ca', () => {
  const settings = normalizeAttendanceShiftSettings({
    shifts: {
      administrative: {
        splitShift: {
          enabled: true,
          morning: { start: '08:30', end: '12:00', workdays: 0.5 },
          afternoon: { start: '13:00', end: '17:30', workdays: 0.5 }
        }
      },
      saleMorning: {
        splitShift: {
          enabled: true,
          morning: { start: '04:00', end: '08:00', workdays: 0.5 },
          afternoon: { start: '09:00', end: '13:30', workdays: 0.5 }
        }
      }
    }
  })
  const payload = buildAttendanceShiftSettingsPayload(settings)

  assert.equal(payload.shifts.administrative.splitShift.morning.end, '12:00')
  assert.equal(payload.shifts.saleMorning.splitShift.afternoon.start, '09:00')
  assert.equal(
    resolveAttendanceShift({ shift: 'Ca Sáng Sale', position: 'Sale' }, {}, settings).splitShift.enabled,
    true
  )

  const explicitEmployeeShift = resolveAttendanceShift({
    shift: 'Ca Hành chính',
    standardCheckIn: '08:30',
    standardCheckOut: '17:30'
  }, {}, settings)
  assert.equal(explicitEmployeeShift.splitShift.morning.end, '12:00')
})
