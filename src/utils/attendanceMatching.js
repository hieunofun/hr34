import { normalizeString } from './helpers.js'

const COMMON_MIDDLE_NAMES = new Set(['thi', 'van'])
const MIN_NAME_SCORE_FOR_EXACT_CODE_MATCH = 0.9

export const normalizeEmployeeIdentity = (value) =>
  normalizeString(value)
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

export const compactEmployeeIdentity = (value) =>
  normalizeEmployeeIdentity(value).replace(/\s+/g, '')

const compactWithoutCommonMiddleNames = (value) => {
  const tokens = normalizeEmployeeIdentity(value).split(' ').filter(Boolean)
  if (tokens.length <= 2) return tokens.join('')

  return tokens
    .filter((token, index) =>
      index === 0 ||
      index === tokens.length - 1 ||
      !COMMON_MIDDLE_NAMES.has(token)
    )
    .join('')
}

const levenshteinDistance = (left, right) => {
  if (left === right) return 0
  if (!left) return right.length
  if (!right) return left.length

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      )
    }
    previous = current
  }

  return previous[right.length]
}

const similarity = (left, right) => {
  if (!left || !right) return 0
  return 1 - levenshteinDistance(left, right) / Math.max(left.length, right.length)
}

const employeeName = (employee) =>
  employee?.ho_va_ten || employee?.name || employee?.fullName || ''

const givenName = (value) => {
  const tokens = normalizeEmployeeIdentity(value).split(' ').filter(Boolean)
  return tokens[tokens.length - 1] || ''
}

export const getCanonicalEmployeeCode = (employee) =>
  employee?.employeeId ||
  employee?.employee_id ||
  employee?.username ||
  employee?.code ||
  ''

const employeeCodes = (employee) =>
  [
    employee?.employeeId,
    employee?.employee_id,
    employee?.username,
    employee?.code
  ]
    .map(compactEmployeeIdentity)
    .filter(Boolean)

export const buildSourceEmployeeKey = (code, name) => {
  const normalizedName = compactEmployeeIdentity(name)
  const normalizedCode = compactEmployeeIdentity(code)
  return `${normalizedCode || 'no-code'}::${normalizedName || 'no-name'}`
}

const describeName = name => ({
  compact: compactEmployeeIdentity(name),
  withoutMiddle: compactWithoutCommonMiddleNames(name),
  given: givenName(name)
})

const describeEmployee = employee => ({
  employee,
  ...describeName(employeeName(employee)),
  codes: employeeCodes(employee)
})

const scoreCandidate = (sourceCodeCompact, source, candidate) => {
  const { employee } = candidate
  const sourceNameCompact = source.compact
  const candidateNameCompact = candidate.compact
  const sourceWithoutMiddle = source.withoutMiddle
  const candidateWithoutMiddle = candidate.withoutMiddle
  const candidateCodes = candidate.codes
  const sourceGivenName = source.given
  const candidateGivenName = candidate.given
  const givenNameCompatible =
    Boolean(sourceGivenName) &&
    Boolean(candidateGivenName) &&
    similarity(sourceGivenName, candidateGivenName) >= 0.85

  const exactName =
    Boolean(sourceNameCompact) &&
    Boolean(candidateNameCompact) &&
    sourceNameCompact === candidateNameCompact
  const exactCode =
    Boolean(sourceCodeCompact) &&
    candidateCodes.includes(sourceCodeCompact)
  const fullNameScore = similarity(sourceNameCompact, candidateNameCompact)
  const withoutMiddleScore = similarity(sourceWithoutMiddle, candidateWithoutMiddle) * 0.96
  let score = Math.max(fullNameScore, withoutMiddleScore)
  let method = withoutMiddleScore > fullNameScore ? 'Bỏ qua tên đệm phổ biến' : 'Tên gần giống'

  const isPlaceholderName =
    !sourceNameCompact ||
    sourceNameCompact === `nv${sourceCodeCompact}` ||
    sourceNameCompact === sourceCodeCompact ||
    /^nv\d+$/i.test(sourceNameCompact)

  if (exactCode && exactName) {
    score = 1
    method = 'Mã và tên trùng hồ sơ'
  } else if (exactCode && isPlaceholderName) {
    score = 1
    method = 'Mã nhân viên trùng'
  } else if (
    exactCode &&
    givenNameCompatible &&
    score >= MIN_NAME_SCORE_FOR_EXACT_CODE_MATCH
  ) {
    score = Math.max(score, 0.99)
    method = 'Mã trùng, tên tương thích'
  } else if (exactCode) {
    // A machine code can coincidentally equal a Lumi code belonging to another
    // employee. Keep this conflict for manual review instead of linking it.
    score = Math.max(score, 0.59)
    method = 'Mã trùng nhưng tên không khớp'
  } else if (exactName) {
    score = 1
    method = 'Tên trùng → gán mã nhân viên Lumi'
  }

  return {
    employee,
    employeeCode: getCanonicalEmployeeCode(employee),
    score: Math.max(0, Math.min(1, score)),
    method,
    exactName,
    exactCode,
    hasSourceName: Boolean(sourceNameCompact),
    isPlaceholderName,
    givenNameCompatible
  }
}

const matchingEmployees = (employees, branch) => {
  const normalizedBranch = normalizeEmployeeIdentity(branch)
  const branchEmployees = normalizedBranch
    ? employees.filter(employee =>
        normalizeEmployeeIdentity(employee.chi_nhanh || employee.branch || '') ===
        normalizedBranch
      )
    : employees
  return branchEmployees.length > 0 ? branchEmployees : employees
}

const rankCandidates = (sourceCode, source, candidates) =>
  candidates
    .map(candidate => scoreCandidate(sourceCode, source, candidate))
    .sort((left, right) =>
      right.score - left.score ||
      Number(right.exactCode && right.exactName) -
        Number(left.exactCode && left.exactName) ||
      Number(right.exactName) - Number(left.exactName) ||
      Number(right.exactCode) - Number(left.exactCode) ||
      Number(right.givenNameCompatible) - Number(left.givenNameCompatible)
    )

export const rankEmployeeMatches = (sourceCode, sourceName, employees, branch = '') =>
  rankCandidates(
    compactEmployeeIdentity(sourceCode),
    describeName(sourceName),
    matchingEmployees(employees, branch).map(describeEmployee)
  )

export const matchAttendanceEmployee = (
  sourceCode,
  sourceName,
  employees,
  branch = ''
) => {
  const ranked = rankEmployeeMatches(sourceCode, sourceName, employees, branch)
  return matchFromRanked(ranked)
}

const matchFromRanked = ranked => {
  const best = ranked[0] || null
  const second = ranked[1] || null
  const confidence = best?.score || 0
  const gap = best ? Math.max(0, confidence - (second?.score || 0)) : 0
  const uniqueExactName = best?.exactName && !second?.exactName
  const autoMatched =
    Boolean(best) &&
    (
      uniqueExactName ||
      (best.exactCode && (
        best.exactName ||
        !best.hasSourceName ||
        best.isPlaceholderName ||
        (best.givenNameCompatible && confidence >= 0.9)
      )) ||
      (best.givenNameCompatible && confidence >= 0.9 && gap >= 0.08)
    )

  return {
    employee: autoMatched ? best.employee : null,
    suggestedEmployee: best?.employee || null,
    confidence,
    gap,
    method: best?.method || 'Không tìm thấy',
    status: autoMatched ? 'matched' : confidence >= 0.6 ? 'review' : 'unmatched',
    candidates: ranked.slice(0, 5)
  }
}

// One matcher per roster/branch. Daily rows reuse a source identity instead of
// repeating fuzzy comparisons against the entire roster. Exact names need only
// their indexed candidates; duplicate names still require manual review.
export const createAttendanceEmployeeMatcher = (employees, branch = '') => {
  const candidates = matchingEmployees(employees, branch).map(describeEmployee)
  const byName = new Map()
  for (const candidate of candidates) {
    if (!candidate.compact) continue
    if (!byName.has(candidate.compact)) byName.set(candidate.compact, [])
    byName.get(candidate.compact).push(candidate)
  }
  const cache = new Map()
  return (sourceCode, sourceName) => {
    const key = buildSourceEmployeeKey(sourceCode, sourceName)
    if (cache.has(key)) return cache.get(key)
    const source = describeName(sourceName)
    const exactNames = byName.get(source.compact)
    const ranked = rankCandidates(
      compactEmployeeIdentity(sourceCode), source, exactNames || candidates
    )
    const result = matchFromRanked(ranked)
    cache.set(key, result)
    return result
  }
}

export const applyEmployeeToAttendanceLog = (log, employee) => {
  const canonicalName = employeeName(employee)
  const canonicalCode = getCanonicalEmployeeCode(employee)
  const sourceName =
    log.sourceEmployeeName ||
    log.employeeName ||
    log.machineName ||
    log.tenTheoMayChamCong ||
    ''
  const sourceCode = log.sourceEmployeeCode || log.employeeCode || ''

  return {
    ...log,
    sourceEmployeeName: sourceName,
    sourceEmployeeCode: sourceCode,
    employeeId: employee.id,
    employeeCode: canonicalCode || sourceCode,
    employeeName: canonicalName || sourceName,
    machineName:
      log.machineName ||
      log.tenTheoMayChamCong ||
      sourceName ||
      canonicalName,
    tenTheoMayChamCong:
      log.tenTheoMayChamCong ||
      log.machineName ||
      sourceName ||
      canonicalName,
    department:
      employee.bo_phan ||
      employee.department ||
      log.department ||
      log.phongBan ||
      '',
    position:
      employee.vi_tri ||
      employee.position ||
      log.position ||
      log.chucVu ||
      ''
  }
}

export const buildAttendanceRecordKey = (log) => {
  const sourceCode = log.sourceEmployeeCode || log.employeeCode || ''
  const sourceName =
    log.sourceEmployeeName ||
    log.employeeName ||
    log.machineName ||
    log.tenTheoMayChamCong ||
    ''
  const employeeIdentity = sourceCode || sourceName
    ? buildSourceEmployeeKey(sourceCode, sourceName)
    : String(log.employeeId || '')
  const date = String(log.date || '').slice(0, 10)
  const checkIn = String(log.checkIn || log.vao || '')
  const checkOut = String(log.checkOut || log.ra || '')
  const shift = String(log.shiftName || log.tenCa || '')

  return [employeeIdentity, date, checkIn, checkOut, shift]
    .map(value => normalizeEmployeeIdentity(value))
    .join('|')
}
