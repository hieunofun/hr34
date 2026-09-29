import assert from 'node:assert/strict'
import test from 'node:test'
import { deleteAttendanceMonth } from './attendanceMonthDeletion.js'
import { commitAttendanceImport } from './attendanceImportCommit.js'
import { setTenantSession } from './tenantSession.js'

const companyId = '00000000-0000-0000-0000-000000000031'
const otherCompanyId = '00000000-0000-0000-0000-000000000022'
const period = { month: '2026-09', startDate: '2026-08-26', endDate: '2026-09-25' }
const hrRecord = (collection, id, data = {}, legacy = false, tenant = companyId) => ({
  id: `${legacy ? '' : `${tenant}::`}${collection}::${id}`, company_id: tenant, collection, data
})
const attendance = (id, date, tenant = companyId) => ({
  id, company_id: tenant, nhan_su_id: 'person-1', ngay: date,
  gio_vao: '08:00', gio_ra: '17:00', gia_tri_goc: 'old-punches', ca_lam: 'Ca 1', tong_cong: 0.75
})

function fakeDatabase({ noSnapshot = false, failDelete, denyDelete, failRead } = {}) {
  const tables = {
    attendance_periods: [{ company_id: companyId, month_key: period.month,
      start_date: period.startDate, end_date: period.endDate }],
    nhan_su: [{ id: 'person-1', company_id: companyId, ma_nhan_vien: 'DC01' }],
    cham_cong: [attendance('old-start', period.startDate), attendance('old-end', period.endDate),
      attendance('before', '2026-08-25'), attendance('after', '2026-09-26'),
      attendance('other-tenant', period.endDate, otherCompanyId)],
    hr_records: [
      hrRecord('attendanceLogs', 'start', { employeeId: 'person-1', date: period.startDate }),
      hrRecord('attendanceLogs', 'end', { employeeId: 'person-1', date: period.endDate }, true),
      hrRecord('attendanceLogs', 'before', { date: '2026-08-25' }),
      hrRecord('attendanceLogs', 'after', { date: '2026-09-26' }),
      hrRecord('attendanceLogs', 'other', { date: period.endDate }, false, otherCompanyId),
      hrRecord('manualWorkdays', '2026-09__person-1', { 26: 0.5 }),
      hrRecord('manualWorkdays', '2026-09__person-2', { 25: 1 }, true),
      hrRecord('manualWorkdays', '2026-09', { 'person-1': { 26: 0.5 } }),
      hrRecord('manualWorkdays', '2026-08__person-1', { 25: 1 }),
      hrRecord('manualWorkdays', '2026-09xxkeep', { 1: 1 }),
      hrRecord('attendanceAdjustments', period.month, { 'person-1': { totalWorkdays: 10 } }),
      hrRecord('attendanceMonthConfirmations', period.month, { 'person-1': true }),
      hrRecord('attendanceMonthConfirmations', period.month, { 'person-1': true }, true),
      hrRecord('attendanceMonthSummaries', period.month, { month: period.month }),
      hrRecord('attendanceMonthSummaries', period.month, { month: period.month }, true),
      hrRecord('attendanceMonthSummaries', '2026-08', { month: '2026-08' }),
      hrRecord('attendanceMonthSummaries', period.month, {}, false, otherCompanyId),
      hrRecord('attendanceSettings', 'default', { standardWorkMinutes: 480 })
    ]
  }
  if (noSnapshot) tables.hr_records = tables.hr_records.filter(row =>
    !(row.company_id === companyId && row.collection === 'attendanceMonthSummaries' && row.id.endsWith(`::${period.month}`)))
  const writes = []
  const matchesFailure = (option, table, rows) => typeof option === 'function'
    ? option(table, rows) : option === table
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.operation = 'select' }
    select(_columns, options = {}) { this.countOnly = options.head === true; return this }
    delete() { this.operation = 'delete'; return this }
    insert(rows) { this.operation = 'insert'; this.payload = rows; return this }
    upsert(rows) { this.operation = 'upsert'; this.payload = rows; return this }
    eq(column, value) { this.filters.push(row => row[column] === value); return this }
    in(column, values) { this.filters.push(row => values.includes(row[column])); return this }
    value(row, column) { return column === 'data->>date' ? row.data?.date : row[column] }
    gte(column, value) { this.filters.push(row => this.value(row, column) >= value); return this }
    lte(column, value) { this.filters.push(row => this.value(row, column) <= value); return this }
    like(column, pattern) {
      let source = '^'
      for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index]
        if (character === '\\') source += pattern[++index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        else if (character === '%') source += '.*'
        else if (character === '_') source += '.'
        else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      }
      const regex = new RegExp(`${source}$`)
      this.filters.push(row => regex.test(row[column]))
      return this
    }
    order() { return this }
    range(from, to) { this.window = [from, to]; return this }
    execute() {
      const rows = tables[this.table].filter(row => this.filters.every(filter => filter(row)))
      if (this.operation === 'delete') {
        writes.push({ table: this.table, ids: rows.map(row => row.id) })
        if (matchesFailure(failDelete, this.table, rows)) return { error: { message: 'connection failed' } }
        if (!matchesFailure(denyDelete, this.table, rows)) {
          tables[this.table] = tables[this.table].filter(row => !rows.includes(row))
        }
        return { error: null }
      }
      if (['insert', 'upsert'].includes(this.operation)) {
        const inserted = Array.isArray(this.payload) ? this.payload : [this.payload]
        for (const row of inserted) {
          if (this.operation === 'upsert') tables[this.table] = tables[this.table].filter(old => old.id !== row.id)
          tables[this.table].push(structuredClone(row))
        }
        return { error: null }
      }
      if (matchesFailure(failRead, this.table, rows)) return { error: { message: 'read denied' } }
      return { data: this.countOnly ? null : this.window ? rows.slice(this.window[0], this.window[1] + 1) : rows,
        count: rows.length, error: null }
    }
    maybeSingle() { const response = this.execute(); return Promise.resolve({ ...response, data: response.data?.[0] || null }) }
    then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject) }
  }
  return { db: { from: table => new Query(table) }, tables, writes }
}

const removeMonth = fixture => {
  setTenantSession('auth-staff', companyId)
  return deleteAttendanceMonth({ db: fixture.db, companyId, month: period.month, expectedPeriod: period })
}

test('deletes both attendance stores at both period boundaries, scoped and legacy month records only', async () => {
  const fixture = fakeDatabase()
  await removeMonth(fixture)
  assert.deepEqual(fixture.tables.cham_cong.map(row => row.id), ['before', 'after', 'other-tenant'])
  assert.deepEqual(fixture.tables.hr_records.map(row => row.id), [
    hrRecord('attendanceLogs', 'before').id, hrRecord('attendanceLogs', 'after').id,
    hrRecord('attendanceLogs', 'other', {}, false, otherCompanyId).id,
    hrRecord('manualWorkdays', '2026-08__person-1').id, hrRecord('manualWorkdays', '2026-09xxkeep').id,
    hrRecord('attendanceMonthSummaries', '2026-08').id,
    hrRecord('attendanceMonthSummaries', period.month, {}, false, otherCompanyId).id,
    hrRecord('attendanceSettings', 'default').id
  ])
  assert.equal(fixture.tables.nhan_su.length, 1)
  assert.equal(fixture.tables.attendance_periods.length, 1)
  assert.ok(fixture.writes.at(-1).ids.every(id => id.includes('attendanceMonthSummaries')))
})

test('cleans leftover raw records even when the previous delete removed the summary', async () => {
  const fixture = fakeDatabase({ noSnapshot: true })
  await removeMonth(fixture)
  assert.ok(!fixture.tables.cham_cong.some(row => row.id.startsWith('old-')))
  await removeMonth(fixture)
  assert.deepEqual(fixture.tables.cham_cong.map(row => row.id), ['before', 'after', 'other-tenant'])
})

test('cannot delete another company, an invalid month or a changed period', async () => {
  const fixture = fakeDatabase()
  setTenantSession('auth-staff', companyId)
  await assert.rejects(deleteAttendanceMonth({ db: fixture.db, companyId: otherCompanyId, month: period.month }), /không khớp phiên/)
  for (const month of ['2026-13', '', '2026-09__person-1']) {
    await assert.rejects(deleteAttendanceMonth({ db: fixture.db, companyId, month }), /YYYY-MM/)
  }
  await assert.rejects(deleteAttendanceMonth({ db: fixture.db, companyId, month: period.month,
    expectedPeriod: { ...period, startDate: '2026-09-01' } }), /Kỳ công đã thay đổi/)
  assert.equal(fixture.writes.length, 0)
})

test('checks all stores before writes and keeps the summary when source cleanup fails or is denied', async () => {
  const unreadable = fakeDatabase({ failRead: 'hr_records' })
  await assert.rejects(removeMonth(unreadable), /read denied/)
  assert.equal(unreadable.writes.length, 0)
  for (const options of [{ failDelete: 'cham_cong' }, { denyDelete: 'cham_cong' },
    { failDelete: (table, rows) => table === 'hr_records' && rows.some(row => row.collection === 'attendanceLogs') }]) {
    const fixture = fakeDatabase(options)
    await assert.rejects(removeMonth(fixture), /Bấm Xóa bảng công lại/)
    assert.ok(fixture.tables.hr_records.some(row => row.company_id === companyId &&
      row.collection === 'attendanceMonthSummaries' && row.id.endsWith(`::${period.month}`)))
    assert.ok(!fixture.writes.some(write => write.ids.some(id => id.includes('attendanceMonthSummaries'))))
  }
})

test('deletes more than 1000 records without leaving capped query results behind', async () => {
  const fixture = fakeDatabase()
  for (let index = 0; index < 1205; index += 1) {
    fixture.tables.cham_cong.push(attendance(`bulk-${index}`, period.endDate))
    fixture.tables.hr_records.push(hrRecord('attendanceLogs', `bulk-${index}`, { date: period.endDate }))
  }
  await removeMonth(fixture)
  assert.equal(fixture.tables.cham_cong.length, 3)
  assert.ok(!fixture.tables.hr_records.some(row => row.id.includes('::bulk-')))
})

test('uses calendar boundaries only when no confirmed period exists', async () => {
  const fixture = fakeDatabase()
  fixture.tables.attendance_periods = []
  setTenantSession('auth-staff', companyId)
  await deleteAttendanceMonth({ db: fixture.db, companyId, month: period.month })
  assert.deepEqual(fixture.tables.cham_cong.map(row => row.id), ['old-start', 'before', 'other-tenant'])
})

test('reproduces the reported cham_cong conflict then permits a fresh Excel import after deleting the period', async () => {
  const fixture = fakeDatabase({ noSnapshot: true })
  fixture.tables.hr_records = fixture.tables.hr_records.filter(row => row.collection !== 'attendanceLogs')
  const incoming = [{ employeeId: 'person-1', date: period.endDate, sourceEmployeeCode: 'DC01',
    importFormat: 'deoca-punch', vao: '06:49', ra: '07:03', cong: 0.00625,
    raw_punch_times: '06:49;07:03', shiftName: 'Ca 1' }]
  const fbGet = async () => Object.fromEntries(fixture.tables.hr_records.filter(row =>
    row.company_id === companyId && row.collection === 'attendanceLogs')
    .map(row => [row.id.split('::').at(-1), row.data]))
  const importFile = () => commitAttendanceImport({ supabase: fixture.db, companyId, fbGet,
    fbUpdate: async () => assert.fail('Fresh import must not update a legacy log'), incomingLogs: incoming })
  setTenantSession('auth-staff', companyId)
  await assert.rejects(importFile(), /cham_cong đã có bản ghi khác.*2026-09-25/)
  await removeMonth(fixture)
  const result = await importFile()
  assert.equal(result.inserted, 1)
  const inserted = fixture.tables.cham_cong.filter(row => row.company_id === companyId && row.ngay === period.endDate)
  assert.equal(inserted.length, 1)
  assert.equal(inserted[0].gio_vao, '06:49')
  assert.equal(inserted[0].gio_ra, '07:03')
  const repeated = await importFile()
  assert.equal(repeated.inserted, 0)
  assert.equal(fixture.tables.cham_cong.filter(row => row.company_id === companyId && row.ngay === period.endDate).length, 1)
})
