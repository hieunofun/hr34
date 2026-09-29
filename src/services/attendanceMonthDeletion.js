import { calendarAttendancePeriod, validateAttendancePeriod } from '../utils/attendancePeriod.js'
import { requireTenantCompanyId } from './tenantSession.js'

const recordIds = (companyId, collection, month) => [
  `${companyId}::${collection}::${month}`,
  `${collection}::${month}`
]

const checkedCount = async operation => {
  const { count, error } = await operation.filter(operation.db.from(operation.table)
    .select('id', { count: 'exact', head: true }))
  if (error) throw new Error(`Không kiểm tra được ${operation.label}: ${error.message}`)
  if (typeof count !== 'number') throw new Error(`Không kiểm tra được số bản ghi ${operation.label}.`)
  return count
}

/** Clear both attendance stores before removing the saved summary, so a failed cleanup can be retried. */
export async function deleteAttendanceMonth({ db, companyId, month, expectedPeriod }) {
  companyId = requireTenantCompanyId(companyId)
  const calendarPeriod = calendarAttendancePeriod(month)
  const { data: storedPeriod, error: periodError } = await db.from('attendance_periods')
    .select('start_date,end_date')
    .eq('company_id', companyId)
    .eq('month_key', month)
    .maybeSingle()
  if (periodError) throw new Error(`Không kiểm tra được kỳ công: ${periodError.message}`)

  const period = validateAttendancePeriod(storedPeriod
    ? { month, startDate: storedPeriod.start_date, endDate: storedPeriod.end_date }
    : calendarPeriod)
  if (expectedPeriod && (expectedPeriod.month !== month ||
    expectedPeriod.startDate !== period.startDate || expectedPeriod.endDate !== period.endDate)) {
    throw new Error('Kỳ công đã thay đổi. Vui lòng tải lại bảng công trước khi xóa.')
  }

  const monthCollections = ['attendanceAdjustments', 'attendanceMonthConfirmations', 'manualWorkdays']
  const monthIds = monthCollections.flatMap(collection => recordIds(companyId, collection, month))
  const operations = [
    {
      table: 'cham_cong', label: 'dữ liệu chấm công',
      filter: query => query.eq('company_id', companyId)
        .gte('ngay', period.startDate).lte('ngay', period.endDate)
    },
    {
      table: 'hr_records', label: 'log chấm công',
      filter: query => query.eq('company_id', companyId).eq('collection', 'attendanceLogs')
        .gte('data->>date', period.startDate).lte('data->>date', period.endDate)
    },
    ...[`${companyId}::manualWorkdays::`, 'manualWorkdays::'].map(prefix => ({
      table: 'hr_records', label: 'công chỉnh tay từng nhân viên',
      filter: query => query.eq('company_id', companyId).eq('collection', 'manualWorkdays')
        .like('id', `${prefix}${month}\\_\\_%`)
    })),
    {
      table: 'hr_records', label: 'điều chỉnh và xác nhận bảng công',
      filter: query => query.eq('company_id', companyId)
        .in('collection', monthCollections).in('id', monthIds)
    },
    {
      table: 'hr_records', label: 'bảng công tổng hợp',
      filter: query => query.eq('company_id', companyId).eq('collection', 'attendanceMonthSummaries')
        .in('id', recordIds(companyId, 'attendanceMonthSummaries', month))
    }
  ].map(operation => ({ ...operation, db }))

  // Check access to every store before deleting anything. Count requests are not capped at 1000 rows.
  await Promise.all(operations.map(checkedCount))
  try {
    for (const operation of operations) {
      const { error } = await operation.filter(db.from(operation.table).delete())
      if (error) throw new Error(`Không xóa được ${operation.label}: ${error.message}`)
      if (await checkedCount(operation) > 0) {
        throw new Error(`${operation.label} vẫn còn dữ liệu. Kiểm tra quyền xóa hoặc dữ liệu vừa được thêm.`)
      }
    }
  } catch (error) {
    throw new Error(`Chưa xóa xong bảng công; có thể đã xóa một phần dữ liệu. Bấm Xóa bảng công lại để hoàn tất. ${error.message}`)
  }
  return period
}
