import assert from 'node:assert/strict'
import test from 'node:test'
import { companyDisplayName, companyLogoSource, GENERIC_HR_LOGO, GENERIC_HR_NAME } from './companyBrand.js'

test('missing or unsafe logo uses generic HR asset', () => {
  assert.equal(companyLogoSource(null), GENERIC_HR_LOGO)
  assert.equal(companyLogoSource(''), GENERIC_HR_LOGO)
  assert.equal(companyLogoSource('javascript:alert(1)'), GENERIC_HR_LOGO)
  assert.equal(companyLogoSource('https://res.cloudinary.com/demo/image/upload/logo.png'), 'https://res.cloudinary.com/demo/image/upload/logo.png')
  assert.equal(companyDisplayName(null), GENERIC_HR_NAME)
})
