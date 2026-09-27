import assert from 'node:assert/strict'
import test from 'node:test'
import { loadCompanySession } from './companySession.js'

function clientWith({ profile, company, profileError = null, companyError = null }) {
  const calls = []
  const client = {
    from(table) {
      return {
        select(columns) {
          return {
            eq(field, value) {
              calls.push({ table, columns, field, value })
              return {
                async single() {
                  return table === 'users'
                    ? { data: profile, error: profileError }
                    : { data: company, error: companyError }
                }
              }
            }
          }
        }
      }
    }
  }
  return { client, calls }
}

test('company comes from the authenticated profile for any company, not auth metadata', async () => {
  for (const companyId of [
    '00000000-0000-0000-0000-000000000022',
    '00000000-0000-0000-0000-000000000031'
  ]) {
    const profile = { id: 'profile-id', company_id: companyId }
    const company = { id: companyId, code: 'COMPANY', name: 'Tên công ty', logo_url: null }
    const { client, calls } = clientWith({ profile, company })
    const result = await loadCompanySession(client, {
      id: 'auth-id',
      user_metadata: { company_id: '00000000-0000-0000-0000-000000000034' }
    })

    assert.deepEqual(result, { profile, company })
    assert.deepEqual(calls.map(({ table, field, value }) => ({ table, field, value })), [
      { table: 'users', field: 'auth_user_id', value: 'auth-id' },
      { table: 'companies', field: 'id', value: companyId }
    ])
  }
})

test('missing company assignment or company record blocks the session', async () => {
  const authUser = { id: 'auth-id' }
  const missingAssignment = clientWith({ profile: { id: 'profile-id', company_id: null } })
  await assert.rejects(loadCompanySession(missingAssignment.client, authUser), {
    code: 'TENANT_CONTEXT_INVALID'
  })
  assert.equal(missingAssignment.calls.length, 1)

  const missingCompany = clientWith({
    profile: { id: 'profile-id', company_id: '00000000-0000-0000-0000-000000000022' },
    company: null
  })
  await assert.rejects(loadCompanySession(missingCompany.client, authUser), {
    code: 'TENANT_CONTEXT_INVALID'
  })
})

test('database errors remain errors and do not become invalid-company decisions', async () => {
  const databaseError = new Error('Network unavailable')
  const { client } = clientWith({ profile: null, profileError: databaseError })
  await assert.rejects(loadCompanySession(client, { id: 'auth-id' }), error => error === databaseError)
})

test('signed-out session does not query a company', async () => {
  const { client, calls } = clientWith({})
  assert.equal(await loadCompanySession(client, null), null)
  assert.deepEqual(calls, [])
})

test('company branding comes from the matched company row for different users', async () => {
  const companies = [
    { id: 'tenant-a', code: 'A', name: 'Công ty A', logo_url: null },
    { id: 'tenant-b', code: 'B', name: 'Công ty B', logo_url: 'https://res.cloudinary.com/demo/image/upload/logo.png' }
  ]
  for (const company of companies) {
    const { client, calls } = clientWith({ profile: { company_id: company.id }, company })
    const result = await loadCompanySession(client, { id: `auth-${company.code}` })
    assert.equal(result.company, company)
    assert.deepEqual(calls.map(call => call.value), [`auth-${company.code}`, company.id])
  }
})

test('profile not found blocks the authenticated session', async () => {
  const { client, calls } = clientWith({ profile: null, profileError: { code: 'PGRST116' } })
  await assert.rejects(loadCompanySession(client, { id: 'auth-id' }), {
    code: 'TENANT_CONTEXT_INVALID'
  })
  assert.equal(calls.length, 1)
})
