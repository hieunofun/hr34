import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { buildAttendanceShiftSettingsPayload, validateAttendancePolicy, resolveAttendanceShift } from '../src/utils/attendanceShift.js'
import { calculateAttendanceMetrics } from '../src/utils/attendanceCalculations.js'

const envPath = resolve(import.meta.dirname, '../../HR-System-Admin/.env.local')
const env = Object.fromEntries(readFileSync(envPath, 'utf8').split(/\r?\n/)
  .map(line => /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/.exec(line)).filter(Boolean)
  .map(([, key, value]) => [key, value.trim().replace(/^["']|["']$/g, '')]))
const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
const key = env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw new Error('Thiếu kết nối Admin Supabase.')
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
const apply = process.argv.includes('--apply')
const companyId = number => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`
const policies = [22, 23, 31].map(number => {
  const isLegacySplit = number === 31
  const policy = buildAttendanceShiftSettingsPayload({
    timezone: 'Asia/Ho_Chi_Minh',
    workStart: isLegacySplit ? '07:00' : '08:30',
    lunchStart: isLegacySplit ? '11:00' : '12:00',
    lunchEnd: '13:00',
    workEnd: isLegacySplit ? '17:00' : '17:30',
    standardWorkMinutes: 480,
    // HR chung trừ khung lunch theo overlap. Bản 22/23 cũ trừ field này
    // khỏi mọi ca, kể cả Sale; giữ 0 để không đổi ca Sale trước khi cutover.
    unpaidBreakMinutes: 0,
    monthlyStandardWorkUnits: 26,
    requiredPunchPairs: 1,
    missingPunchPolicy: 'zero',
    workUnitCalculationMode: isLegacySplit ? 'split_shift' : 'proportional',
    splitShiftEnabled: isLegacySplit,
    ...(isLegacySplit ? { morningWeight: 0.5, afternoonWeight: 0.5 } : {}),
    importPriorityMode: 'raw_punch',
    manualOverridePriority: 'highest',
    overtimeEnabled: true,
    overtimeStart: 'shift_end',
    overtimeMinMinutes: 0,
    policyVersion: 3
  })
  return { number, id: companyId(number), policy }
})

for (const { number, id, policy } of policies) {
  const validation = validateAttendancePolicy(policy)
  assert.equal(validation.isValid, true, `Policy ${number}: ${validation.error}`)
  const shift = resolveAttendanceShift({}, {}, policy)
  const metrics = calculateAttendanceMetrics({
    log: { checkIn: policy.workStart, checkOut: policy.workEnd },
    attendanceSettings: policy, shift
  })
  assert.equal(metrics.regularWorkdays, 1, `Công đủ ca ${number}`)
  assert.equal(metrics.hours, 8, `Giờ đủ ca ${number}`)
  assert.equal(metrics.overtimeHours, 0, `OT đủ ca ${number}`)
  const { data: rows, error } = await db.from('hr_records')
    .select('id,company_id,collection,data,updated_at')
    .eq('company_id', id).eq('collection', 'attendanceSettings')
  if (error) throw error
  if (rows.length > 1) throw new Error(`Company ${number} có nhiều attendanceSettings; dừng để tránh ghi sai.`)
  const matchingSchedule = rows.length === 1 &&
    rows[0].data?.workStart === policy.workStart &&
    rows[0].data?.lunchStart === policy.lunchStart &&
    rows[0].data?.lunchEnd === policy.lunchEnd &&
    rows[0].data?.workEnd === policy.workEnd &&
    rows[0].data?.standardWorkMinutes === policy.standardWorkMinutes
  const migrated = matchingSchedule && rows[0].data?.policyVersion === 3 &&
    rows[0].data?.unpaidBreakMinutes === 0
  const priorMigration = matchingSchedule && rows[0].data?.policyVersion === 2 &&
    rows[0].data?.unpaidBreakMinutes === (number === 31 ? 120 : 60)
  if (!migrated && !priorMigration && number === 22) {
    assert.equal(rows.length, 1)
    assert.equal(rows[0].data.standardCheckIn, '08:00')
    assert.equal(rows[0].data.standardCheckOut, '17:30')
  } else if (!migrated && !priorMigration) assert.equal(rows.length, 0)
  console.log(JSON.stringify({ company: number, action: migrated ? 'already-migrated' : rows.length ? 'update-settings' : 'insert-settings',
    oldWorkStart: rows[0]?.data?.standardCheckIn || null, newWorkStart: policy.workStart,
    lunch: `${policy.lunchStart}-${policy.lunchEnd}`, standardWorkMinutes: policy.standardWorkMinutes,
    monthlyStandardWorkUnits: policy.monthlyStandardWorkUnits, fullShiftWorkUnits: metrics.regularWorkdays,
    mode: apply ? 'apply' : 'dry-run' }))
  if (!apply || migrated) continue
  const updatedAt = new Date().toISOString()
  if (rows.length) {
    const { data: updated, error: updateError } = await db.from('hr_records')
      .update({ data: { ...rows[0].data, ...policy }, updated_at: updatedAt })
      .eq('id', rows[0].id).eq('company_id', id).eq('updated_at', rows[0].updated_at)
      .select('id').maybeSingle()
    if (updateError) throw updateError
    if (!updated) throw new Error(`Settings ${number} đã thay đổi trong khi migrate.`)
  } else {
    const { error: insertError } = await db.from('hr_records').insert({
      id: `${id}::attendanceSettings::default`, company_id: id,
      collection: 'attendanceSettings', data: policy, updated_at: updatedAt
    })
    if (insertError) throw insertError
  }
}
