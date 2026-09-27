import { DEFAULT_ATTENDANCE_POLICY, DEFAULT_ATTENDANCE_PENALTY_CATEGORIES } from './attendanceShift.js'

export const DEFAULT_PENALTY_CATEGORIES = DEFAULT_ATTENDANCE_PENALTY_CATEGORIES

export const PENALTY_CATEGORIES = DEFAULT_PENALTY_CATEGORIES

const cloneCategory = item => ({
  key: item.key,
  label: item.label,
  amount: item.amount
})

const fallbackKey = (index) => `custom_${index + 1}`

export const normalizePenaltyCategories = (categories) => {
  const source = Array.isArray(categories) ? categories : []
  if (source.length === 0) {
    return DEFAULT_PENALTY_CATEGORIES.map(cloneCategory)
  }

  const usedKeys = new Set()
  return source.map((item, index) => {
    const label = String(item?.label || item?.name || item?.content || '').trim()
    const parsedAmount = Number(item?.amount ?? item?.money ?? 0)
    const matchedDefault = DEFAULT_PENALTY_CATEGORIES.find(entry =>
      entry.key === item?.key ||
      entry.key === item?.id ||
      entry.label === label
    )
    let key = String(item?.key || item?.id || matchedDefault?.key || '').trim() || fallbackKey(index)
    if (usedKeys.has(key)) key = `${key}_${index + 1}`
    usedKeys.add(key)
    return {
      key,
      label: label || matchedDefault?.label || `Hạng mục ${index + 1}`,
      amount: Number.isFinite(parsedAmount) && parsedAmount >= 0 ? Math.round(parsedAmount) : 0
    }
  })
}

export const createPenaltyCategory = (partial = {}) => ({
  key: String(partial.key || `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`),
  label: String(partial.label || '').trim(),
  amount: Math.max(0, Math.round(Number(partial.amount || 0)) || 0)
})

const findCategory = (categories, key) => {
  const list = normalizePenaltyCategories(categories)
  return list.find(item => item.key === key) || (Array.isArray(categories) && categories.length > 0
    ? null : DEFAULT_PENALTY_CATEGORIES.find(item => item.key === key))
}

export const createEmptyPenaltyRow = (monthValue = '', categories = DEFAULT_PENALTY_CATEGORIES) => {
  const first = normalizePenaltyCategories(categories)[0] || DEFAULT_PENALTY_CATEGORIES[0]
  return {
    id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    date: monthValue ? `${monthValue}-01` : '',
    employeeId: '',
    employeeCode: '',
    employeeName: '',
    category: first.label,
    content: '',
    amount: first.amount,
    note: '',
    source: 'manual'
  }
}

export const normalizePenaltyRows = (rows = []) =>
  (rows || []).map((row, index) => ({
    id: row.id || `p-legacy-${index}-${String(row.date || '')}-${String(row.employeeId || row.employeeName || '')}`,
    date: String(row.date || '').slice(0, 10),
    employeeId: row.employeeId || '',
    employeeCode: row.employeeCode || '',
    employeeName: row.employeeName || '',
    category: row.category || '',
    content: row.content || '',
    amount: Number(row.amount || 0),
    note: row.note || '',
    source: row.source || 'manual'
  }))

const autoRow = ({ employeeId, employeeCode, employeeName, date, suffix, category, content }) => ({
  id: `p-auto-${employeeId}-${date}-${suffix}`,
  date,
  employeeId,
  employeeCode,
  employeeName,
  category: category.label,
  content,
  amount: category.amount,
  note: '',
  source: 'auto'
})

export const buildPenaltyDetailRows = (summaryRows = [], categories = DEFAULT_PENALTY_CATEGORIES,
  thresholdMinutes = DEFAULT_ATTENDANCE_POLICY.latePenaltyThresholdMinutes) => {
  const lateUnder = findCategory(categories, 'late_under_30')
  const lateOver = findCategory(categories, 'late_over_30')
  const missingPunch = findCategory(categories, 'missing_punch')
  const unapprovedAbsence = findCategory(categories, 'unapproved_absence')
  const details = []

  summaryRows.forEach(row => {
    const employeeName = row.employeeName || row.employeeCode || row.employeeId || ''
    const employeeId = row.employeeId || ''
    const employeeCode = row.employeeCode || ''
    const days = row.days instanceof Map ? row.days : new Map(Object.entries(row.days || {}))
    days.forEach((day, date) => {
      if (!day) return
      const lateMinutes = Number(day.lateMinutes || 0)
      const earlyMinutes = Number(day.earlyMinutes || 0)

      if (day.late && lateMinutes > 0 && lateUnder && lateOver) {
        const over30 = lateMinutes >= thresholdMinutes
        details.push(autoRow({
          employeeId,
          employeeCode,
          employeeName,
          date,
          suffix: 'late',
          category: over30 ? lateOver : lateUnder,
          content: `Đi muộn ${lateMinutes} phút`
        }))
      }

      if (day.early && earlyMinutes > 0 && lateUnder && lateOver) {
        const over30 = earlyMinutes >= thresholdMinutes
        details.push(autoRow({
          employeeId,
          employeeCode,
          employeeName,
          date,
          suffix: 'early',
          category: over30 ? lateOver : lateUnder,
          content: `Về sớm ${earlyMinutes} phút`
        }))
      }

      if (day.missingPunch && missingPunch) {
        details.push(autoRow({
          employeeId,
          employeeCode,
          employeeName,
          date,
          suffix: 'missing',
          category: missingPunch,
          content: 'Quên chấm công (thiếu vào/ra)'
        }))
      }

      if (day.unapprovedAbsence && unapprovedAbsence) {
        details.push(autoRow({
          employeeId,
          employeeCode,
          employeeName,
          date,
          suffix: 'absence',
          category: unapprovedAbsence,
          content: 'Nghỉ không phép'
        }))
      }
    })
  })

  return details.sort((left, right) => {
    const byDate = String(left.date).localeCompare(String(right.date))
    if (byDate !== 0) return byDate
    return String(left.employeeName).localeCompare(String(right.employeeName), 'vi')
  })
}
