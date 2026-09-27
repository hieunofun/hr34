import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { fbGet, fbGetAttendanceByEmployee } from '../services/firebase'
import { buildAttendanceSummary } from '../utils/attendanceSummary'
import {
  applyCalculatedAttendanceTiming,
  formatAttendanceTime,
  normalizeAttendanceShiftSettings
} from '../utils/attendanceShift'
import './MyAttendance.css'

const dateValue = log => String(log?.date || log?.timestamp || '').slice(0, 10)
const numberValue = value => Number.isFinite(Number(value)) ? Number(value) : 0
const timeValue = value => {
  return formatAttendanceTime(value) || '—'
}

function MyAttendance() {
  const { user } = useAuth()
  const employeeId = String(user.id)
  const [logs, setLogs] = useState([])
  const [attendanceSettings, setAttendanceSettings] = useState(() => normalizeAttendanceShiftSettings())
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.all([
      fbGetAttendanceByEmployee(employeeId),
      fbGet('hr/attendanceSettings/default')
    ]).then(([data, storedSettings]) => {
      if (!active) return
      setAttendanceSettings(normalizeAttendanceShiftSettings(storedSettings))
      const nextLogs = data ? Object.entries(data).map(([id, value]) => ({ ...value, id })) : []
      setLogs(nextLogs)
      const latest = [...new Set(nextLogs.map(dateValue).map(value => value.slice(0, 7)))].filter(value => /^\d{4}-\d{2}$/.test(value)).sort().at(-1)
      if (latest) setMonth(latest)
    }).catch(requestError => {
      console.error('Không tải được Bảng công cá nhân:', requestError)
      if (active) setError('Không thể tải dữ liệu chấm công.')
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [employeeId])

  const months = useMemo(() => [...new Set(logs.map(dateValue).map(value => value.slice(0, 7)))].filter(value => /^\d{4}-\d{2}$/.test(value)).sort().reverse(), [logs])
  const monthLogs = useMemo(() => logs
    .filter(log => dateValue(log).startsWith(month))
    .map(log => applyCalculatedAttendanceTiming(log, user, attendanceSettings))
    .sort((a, b) => dateValue(a).localeCompare(dateValue(b))), [attendanceSettings, logs, month, user])
  const summary = useMemo(() => buildAttendanceSummary({ attendanceLogs: logs, employees: [user], month, attendanceSettings }).find(row => String(row.employeeId) === employeeId), [attendanceSettings, employeeId, logs, month, user])

  return (
    <div className="my-attendance">
      <div className="page-header my-attendance__header">
        <div><h1 className="page-title"><i className="fas fa-calendar-check"></i>Bảng công</h1><p>Thông tin chấm công của {user.ho_va_ten || user.email}</p></div>
        <div className="my-attendance__header-actions"><Link className="btn" to="/cham-cong-online">Chấm công online</Link><label><span>Tháng</span><select value={month} onChange={event => setMonth(event.target.value)}>{months.length === 0 && <option>{month}</option>}{months.map(value => <option key={value}>{value}</option>)}</select></label></div>
      </div>
      <section className="my-attendance__identity card">
        <div><span>Mã nhân viên</span><strong>{user.employeeId || '—'}</strong></div><div><span>Họ tên</span><strong>{user.ho_va_ten || '—'}</strong></div><div><span>Phòng ban</span><strong>{user.bo_phan || '—'}</strong></div><div><span>Chức vụ</span><strong>{user.vi_tri || '—'}</strong></div>
      </section>
      {loading ? <div className="card my-attendance__state">Đang tải dữ liệu...</div> : error ? <div className="card my-attendance__state is-error">{error}</div> : <>
        <section className="my-attendance__stats">
          <div className="card"><span>Ngày có dữ liệu</span><strong>{summary?.attendanceDays || 0}</strong></div><div className="card"><span>Tổng công</span><strong>{summary?.workdays || 0}</strong></div><div className="card"><span>Tổng giờ</span><strong>{summary?.totalHours || 0}</strong></div><div className="card"><span>Đi muộn</span><strong>{summary?.lateCount || 0} lần</strong><small>{summary?.lateMinutes || 0} phút</small></div><div className="card"><span>Về sớm</span><strong>{summary?.earlyCount || 0} lần</strong><small>{summary?.earlyMinutes || 0} phút</small></div><div className="card"><span>Quên chấm</span><strong>{summary?.missingPunchCount || 0}</strong></div>
        </section>
        <section className="card my-attendance__table-card"><h3>Chi tiết chấm công</h3><div className="my-attendance__table-wrap"><table><thead><tr><th>Ngày</th><th>Thứ</th><th>Time (Check-in)</th><th>TimeCheckout</th><th>Công</th><th>Giờ</th><th>Đi muộn</th><th>Về sớm</th><th>Ký hiệu</th></tr></thead><tbody>
          {monthLogs.length ? monthLogs.map(log => {
            const date = dateValue(log), hours = numberValue(log.tongGio ?? (numberValue(log.hours ?? log.soGio ?? log.gio) + numberValue(log.gioPlus)))
            return <tr key={log.id}><td>{date ? new Date(`${date}T00:00:00`).toLocaleDateString('vi-VN') : '—'}</td><td>{log.dayOfWeek || log.thu || '—'}</td><td>{timeValue(log.vao || log.checkIn)}</td><td>{timeValue(log.ra || log.checkOut)}</td><td>{log.cong ?? '—'}</td><td>{hours || '—'}</td><td className={numberValue(log.lateMinutes ?? log.vaoTre) > 0 ? 'is-warning' : ''}>{numberValue(log.lateMinutes ?? log.vaoTre) || '—'}</td><td className={numberValue(log.earlyMinutes ?? log.raSom) > 0 ? 'is-warning' : ''}>{numberValue(log.earlyMinutes ?? log.raSom) || '—'}</td><td>{log.kyHieu || log.status || '—'}</td></tr>
          }) : <tr><td colSpan="9" className="my-attendance__empty">Không có dữ liệu trong tháng này.</td></tr>}
        </tbody></table></div></section>
      </>}
    </div>
  )
}

export default MyAttendance
