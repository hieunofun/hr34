import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from '../../HR-System-Admin/node_modules/playwright/index.mjs'
import { createClient } from '@supabase/supabase-js'

const parseEnv = path => Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/)
  .map(line => /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/.exec(line)).filter(Boolean)
  .map(([, key, value]) => [key, value.trim().replace(/^["']|["']$/g, '')]))
const root = resolve(import.meta.dirname, '..')
const app = parseEnv(resolve(root, '.env.local'))
const credentials = parseEnv(resolve(root, '../HR-System-Admin/.env.company-admins.local'))
const employeeCredentials = parseEnv(resolve(root, '.env.employee-readiness.local'))
const url = process.argv[2] || 'https://hr34.vercel.app'
const browser = await chromium.launch({ headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
try {
  for (const number of [22, 23, 31]) {
    const email = credentials[`COMPANY_ADMIN_${number}_EMAIL`]
    const password = credentials[`COMPANY_ADMIN_${number}_PASSWORD`]
    const db = createClient(app.VITE_SUPABASE_URL, app.VITE_SUPABASE_ANON_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } })
    const auth = await db.auth.signInWithPassword({ email, password })
    if (auth.error) throw auth.error
    const companyId = `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`
    const company = await db.from('companies').select('id,name,code,logo_url').eq('id', companyId).single()
    if (company.error) throw company.error
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      page.setDefaultTimeout(30000)
      await page.goto(`${url}/login`, { waitUntil: 'domcontentloaded' })
      await page.locator('input[type="email"]').fill(email)
      await page.locator('input[type="password"]').fill(password)
      await page.locator('button[type="submit"]').click()
      await page.waitForURL(/\/employees(?:[?#]|$)/)
      const sidebarName = await page.locator('.sidebar .brand span').textContent()
      const headerName = await page.locator('.header .logo h1').textContent()
      assert.equal(sidebarName.trim(), company.data.name)
      assert.equal(headerName.trim(), company.data.name)
      assert.equal(company.data.id, companyId)
      console.log(JSON.stringify({ company: number, login: 'pass', sharedUrl: page.url(),
        sidebarBrand: 'pass', headerBrand: 'pass' }))
    } finally { await context.close() }
  }
  for (const label of ['A', 'B']) {
    for (const index of [1, 2]) {
      const prefix = `EMPLOYEE_${label}${index}`
      const email = employeeCredentials[`${prefix}_EMAIL`]
      const password = employeeCredentials[`${prefix}_PASSWORD`]
      const db = createClient(app.VITE_SUPABASE_URL, app.VITE_SUPABASE_ANON_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } })
      const auth = await db.auth.signInWithPassword({ email, password })
      if (auth.error) throw auth.error
      const profile = await db.from('users').select('id,name,employee_id,company_id')
        .eq('auth_user_id', auth.data.user.id).single()
      if (profile.error) throw profile.error
      const company = await db.from('companies').select('name').eq('id', profile.data.company_id).single()
      if (company.error) throw company.error
      const context = await browser.newContext()
      try {
        const page = await context.newPage()
        page.setDefaultTimeout(30000)
        await page.goto(`${url}/employee-login`, { waitUntil: 'domcontentloaded' })
        await page.locator('input[type="email"]').fill(email)
        await page.locator('input[type="password"]').fill(password)
        await page.locator('button[type="submit"]').click()
        await page.waitForURL(/\/bang-cong(?:[?#]|$)/)
        assert.equal((await page.locator('.sidebar .brand span').textContent()).trim(), company.data.name)
        const identity = await page.locator('.my-attendance__identity').textContent()
        assert.ok(identity.includes(profile.data.employee_id))
        assert.ok(identity.includes(profile.data.name))
        await page.locator('.my-attendance__table-card tbody tr').first().waitFor()
        const attendanceRow = await page.locator('.my-attendance__table-card tbody').textContent()
        assert.ok(attendanceRow.includes('07:00') && attendanceRow.includes('17:00'))
        const otherPrefix = `EMPLOYEE_${label}${index === 1 ? 2 : 1}`
        const otherProfile = await db.from('users').select('employee_id')
          .eq('id', employeeCredentials[`${otherPrefix}_PROFILE_ID`]).maybeSingle()
        if (otherProfile.error) throw otherProfile.error
        assert.equal(otherProfile.data, null)
        console.log(JSON.stringify({ testEmployee: `${label}${index}`, login: 'pass',
          ownIdentity: 'pass', ownAttendance: 'pass', otherProfileHiddenByRls: 'pass', branding: 'pass' }))
      } finally { await context.close() }
    }
  }
} finally { await browser.close() }
