import test from 'node:test'
import assert from 'node:assert/strict'
import { handleEmployeeRequests } from './employee-requests.js'

const actorId = '00000000-0000-0000-0000-000000000001'
const companyId = '00000000-0000-0000-0000-000000000034'
const otherCompanyId = '00000000-0000-0000-0000-000000000023'
const input = { kind: 'leave', subject: 'Nghỉ phép', content: 'Việc cá nhân',
  leaveStartDate: '2026-10-01', leaveEndDate: '2026-10-02' }

function fakeDb(role = 'user') {
  const inserts = []
  const db = {
    inserts,
    from(table) {
      if (table === 'users') {
        const query = { eq() { return this }, async maybeSingle() {
          return { data: { id: actorId, name: 'Test employee', company_id: companyId, role }, error: null }
        } }
        return { select() { return query } }
      }
      if (table === 'hr_records') return { async insert(row) {
        inserts.push(row)
        return { data: null, error: null }
      } }
      throw new Error(`Unexpected table: ${table}`)
    }
  }
  return db
}

test('request company and requester come from the authenticated profile', async () => {
  const db = fakeDb()
  const request = await handleEmployeeRequests(db, actorId, 'POST', input)
  assert.equal(db.inserts[0].company_id, companyId)
  assert.equal(db.inserts[0].data.requesterId, actorId)
  assert.equal(request.status, 'pending')
  assert.equal(db.inserts[0].collection, 'approvalRequests')
})

test('browser company ID cannot redirect requests to another tenant', async () => {
  const db = fakeDb()
  await assert.rejects(handleEmployeeRequests(db, actorId, 'POST',
    { ...input, company_id: otherCompanyId }), error => error.status === 400)
  assert.equal(db.inserts.length, 0)
})

test('only employees submit and only company admins decide', async () => {
  await assert.rejects(handleEmployeeRequests(fakeDb('admin'), actorId, 'POST', input),
    error => error.status === 403)
  await assert.rejects(handleEmployeeRequests(fakeDb('user'), actorId, 'PATCH',
    { id: `${companyId}::approvalRequests::00000000-0000-0000-0000-000000000099`, status: 'approved' }),
  error => error.status === 403)
})

test('invalid leave dates are rejected before writing', async () => {
  const db = fakeDb()
  await assert.rejects(handleEmployeeRequests(db, actorId, 'POST',
    { ...input, leaveStartDate: '2026-02-30' }), error => error.status === 400)
  assert.equal(db.inserts.length, 0)
})
