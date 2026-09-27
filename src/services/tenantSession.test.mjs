import assert from 'node:assert/strict'
import test from 'node:test'
import { getTenantSession, requireTenantCompanyId, setTenantSession } from './tenantSession.js'

test('tenant follows the authenticated session and rejects another company', () => {
  const companyA = '00000000-0000-0000-0000-000000000022'
  const companyB = '00000000-0000-0000-0000-000000000031'
  setTenantSession('auth-a', companyA)
  assert.equal(requireTenantCompanyId(), companyA)
  assert.throws(() => requireTenantCompanyId(companyB), /không khớp/)

  setTenantSession(null, null)
  assert.equal(getTenantSession(), null)
  assert.throws(() => requireTenantCompanyId(), /Chưa xác định/)

  setTenantSession('auth-b', companyB)
  assert.equal(requireTenantCompanyId(), companyB)
  assert.throws(() => requireTenantCompanyId(companyA), /không khớp/)
  setTenantSession(null, null)
})
