import test from 'node:test'
import assert from 'node:assert/strict'
import { getEmployeeResetPreview, resetCompanyEmployees } from './employee-reset.js'

const A = '00000000-0000-0000-0000-000000000023'
const B = '00000000-0000-0000-0000-000000000022'

function fakeDatabase() {
  const tables = {
    companies: [
      { id: A, code: 'COMPANY_23', name: 'Company 23' },
      { id: B, code: 'COMPANY_22', name: 'Company 22' }
    ],
    users: [
      { id: 'admin-a', company_id: A, role: 'admin', auth_user_id: 'auth-admin-a' },
      { id: 'admin-a2', company_id: A, role: 'admin', auth_user_id: 'auth-admin-a2' },
      { id: 'staff-a', company_id: A, role: 'user', auth_user_id: 'auth-staff-a' },
      { id: 'staff-a2', company_id: A, role: 'user', auth_user_id: null },
      { id: 'admin-b', company_id: B, role: 'admin', auth_user_id: 'auth-admin-b' },
      { id: 'staff-b', company_id: B, role: 'user', auth_user_id: null }
    ],
    nhan_su: [{ id: 'ns-a', company_id: A }, { id: 'ns-b', company_id: B }],
    cham_cong: [{ id: 'cc-a', company_id: A }, { id: 'cc-b', company_id: B }],
    attendance_penalties: [{ id: 'penalty-a', company_id: A }, { id: 'penalty-b', company_id: B }],
    hr_records: [
      { id: 'log-a', company_id: A, collection: 'attendanceLogs' },
      { id: 'manual-a', company_id: A, collection: 'manualWorkdays' },
      { id: 'settings-a', company_id: A, collection: 'attendanceSettings' },
      { id: 'log-b', company_id: B, collection: 'attendanceLogs' }
    ],
    employee_status_history: [{ id: 'history-a', company_id: A }]
  }
  const deletedAuth = []

  class Query {
    constructor(table) { this.table = table; this.filters = []; this.operation = 'select' }
    select(_columns, options = {}) { this.operation = 'select'; this.headCount = options.head && options.count === 'exact'; return this }
    delete() { this.operation = 'delete'; return this }
    eq(column, value) { this.filters.push(row => row[column] === value); return this }
    in(column, values) { this.filters.push(row => values.includes(row[column])); return this }
    order(column) { this.orderColumn = column; return this }
    range(start, end) { this.window = [start, end]; return this }
    execute() {
      const rows = tables[this.table].filter(row => this.filters.every(testRow => testRow(row)))
      if (this.operation === 'delete') {
        const ids = new Set(rows.map(row => row.id))
        tables[this.table] = tables[this.table].filter(row => !ids.has(row.id))
        return { data: null, error: null }
      }
      if (this.headCount) return { data: null, count: rows.length, error: null }
      if (this.orderColumn) rows.sort((left, right) => String(left[this.orderColumn]).localeCompare(String(right[this.orderColumn])))
      return { data: this.window ? rows.slice(this.window[0], this.window[1] + 1) : rows, error: null }
    }
    maybeSingle() { const result = this.execute(); return Promise.resolve({ ...result, data: result.data[0] || null }) }
    single() { const result = this.execute(); return Promise.resolve({ ...result, data: result.data[0] || null }) }
    then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject) }
  }

  const db = {
    from: table => new Query(table),
    auth: { admin: { deleteUser: async id => {
      deletedAuth.push(id)
      return { error: null }
    } } }
  }
  return { db, tables, deletedAuth }
}

test('only a company Admin can preview or reset data', async () => {
  const { db, tables } = fakeDatabase()
  await assert.rejects(getEmployeeResetPreview(db, 'auth-staff-a'), { status: 403 })
  const preview = await getEmployeeResetPreview(db, 'auth-admin-a')
  assert.deepEqual(preview.counts, {
    users: 2, adminAccounts: 2, nhan_su: 1,
    cham_cong: 1, attendanceRecords: 2, penalties: 1, statusHistory: 1
  })
  await assert.rejects(resetCompanyEmployees(db, 'auth-admin-a', {
    confirmation: 'WRONG', expectedCounts: preview.counts
  }), { status: 409 })
  await assert.rejects(resetCompanyEmployees(db, 'auth-admin-a', {
    confirmation: 'COMPANY_23', expectedCounts: { ...preview.counts, users: 1 }
  }), { status: 409 })
  assert.equal(tables.users.length, 6)
})

test('reset deletes employee and attendance data only for the signed-in company', async () => {
  const { db, tables, deletedAuth } = fakeDatabase()
  const preview = await getEmployeeResetPreview(db, 'auth-admin-a')
  const result = await resetCompanyEmployees(db, 'auth-admin-a', {
    confirmation: preview.company.code, expectedCounts: preview.counts
  })
  assert.equal(result.adminAccountsKept, 2)
  assert.deepEqual(tables.users.map(row => row.id), ['admin-a', 'admin-a2', 'admin-b', 'staff-b'])
  assert.deepEqual(tables.nhan_su.map(row => row.id), ['ns-b'])
  assert.deepEqual(tables.cham_cong.map(row => row.id), ['cc-b'])
  assert.deepEqual(tables.attendance_penalties.map(row => row.id), ['penalty-b'])
  assert.deepEqual(tables.hr_records.map(row => row.id), ['settings-a', 'log-b'])
  assert.deepEqual(tables.employee_status_history, [])
  assert.deepEqual(deletedAuth, ['auth-staff-a'])
})
