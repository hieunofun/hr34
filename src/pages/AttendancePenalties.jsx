import { useCallback, useEffect, useMemo, useState } from 'react'
import { useCompany } from '../contexts/CompanyContext'
import { fbGet, fbListCollectionIds } from '../services/firebase'
import {
  getPenaltiesByMonth,
  listPenaltyEmployeesSlim,
  listPenaltyMonths,
  savePenaltiesByMonth
} from '../services/attendancePenaltiesDb'
import { hydrateAttendanceSummaryRows } from '../utils/attendanceSummary'
import {
  buildPenaltyDetailRows,
  createEmptyPenaltyRow,
  normalizePenaltyCategories,
  normalizePenaltyRows
} from '../utils/attendancePenalties'
import { normalizeAttendancePolicy } from '../utils/attendanceShift'
import './AttendancePenalties.css'

const money = value => Number(value || 0).toLocaleString('vi-VN')
const formatGeneratedAt = value => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('vi-VN')
}
const currentMonthValue = () => new Date().toISOString().slice(0, 7)
const employeeLabel = employee => {
  if (!employee) return ''
  const name = employee.name || employee.employeeName || ''
  const code = employee.code || employee.employeeCode || ''
  return code ? `${code} - ${name}` : name
}

function EmployeeNameSuggest({ employees, employeeId, employeeName, employeeCode, onSelect }) {
  const selected = employees.find(item => String(item.id) === String(employeeId))
  const selectedText = selected
    ? employeeLabel(selected)
    : employeeLabel({ name: employeeName, code: employeeCode })
  const [query, setQuery] = useState(selectedText)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) setQuery(selectedText)
  }, [open, selectedText])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase('vi')
    const list = !keyword
      ? employees
      : employees.filter(employee =>
          employeeLabel(employee).toLocaleLowerCase('vi').includes(keyword)
        )
    return list.slice(0, 25)
  }, [employees, query])

  return (
    <div className="employee-name-suggest">
      <input
        type="text"
        value={query}
        placeholder="Gõ tên hoặc mã NV..."
        autoComplete="off"
        onFocus={() => {
          setOpen(true)
          setQuery(selectedText)
        }}
        onChange={event => {
          setQuery(event.target.value)
          setOpen(true)
        }}
        onBlur={() => {
          window.setTimeout(() => {
            setOpen(false)
            setQuery(selectedText)
          }, 120)
        }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            setOpen(false)
            setQuery(selectedText)
          }
        }}
      />
      {open && (
        <div className="employee-name-suggest__menu">
          {filtered.length === 0 ? (
            <div className="employee-name-suggest__empty">Không tìm thấy nhân sự</div>
          ) : (
            filtered.map(employee => (
              <button
                key={employee.id}
                type="button"
                className={String(employee.id) === String(employeeId) ? 'is-active' : ''}
                onMouseDown={event => {
                  event.preventDefault()
                  onSelect(employee)
                  setQuery(employeeLabel(employee))
                  setOpen(false)
                }}
              >
                {employeeLabel(employee)}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function AttendancePenalties() {
  const { companyId } = useCompany()
  const [penaltyPolicy, setPenaltyPolicy] = useState(() => normalizeAttendancePolicy())
  const categories = useMemo(() => normalizePenaltyCategories(penaltyPolicy.penaltyRules.categories), [penaltyPolicy])
  const [month, setMonth] = useState(currentMonthValue)
  const [months, setMonths] = useState([])
  const [rows, setRows] = useState([])
  const [employees, setEmployees] = useState([])
  const [generatedAt, setGeneratedAt] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const total = useMemo(
    () => rows.reduce((sum, item) => sum + Number(item.amount || 0), 0),
    [rows]
  )

  const loadEmployees = useCallback(async () => {
    const list = await listPenaltyEmployeesSlim()
    setEmployees(list)
    return list
  }, [])

  const loadMonth = useCallback(async (targetMonth, { showLoading = true } = {}) => {
    if (!targetMonth) return
    if (showLoading) setLoading(true)
    setError('')
    try {
      const nextRows = await getPenaltiesByMonth(targetMonth)
      setRows(normalizePenaltyRows(nextRows))
      setGeneratedAt(nextRows.length ? new Date().toISOString() : '')
      setDirty(false)
      setMonth(targetMonth)
    } catch (requestError) {
      console.error('Không tải được bảng phạt:', requestError)
      const message = String(requestError?.message || '')
      if (/attendance_penalties|schema cache|does not exist/i.test(message)) {
        setError('Chưa tạo bảng attendance_penalties trên Supabase. Chạy file migration 20260911180000_attendance_penalties_table.sql trong SQL Editor.')
      } else {
        setError('Không thể tải bảng phạt.')
      }
      setRows([])
      setGeneratedAt('')
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError('')
      const initialMonth = currentMonthValue()
      try {
        const [penaltyMonthsResult, summaryIdsResult, employeesResult, monthRowsResult, settingsResult] = await Promise.allSettled([
          listPenaltyMonths(),
          fbListCollectionIds('attendanceMonthSummaries'),
          listPenaltyEmployeesSlim(),
          getPenaltiesByMonth(initialMonth),
          fbGet('hr/attendanceSettings/default', companyId)
        ])

        if (cancelled) return
        if (settingsResult.status === 'rejected') throw settingsResult.reason
        setPenaltyPolicy(normalizeAttendancePolicy(settingsResult.value))

        if (penaltyMonthsResult.status === 'rejected') {
          const message = String(penaltyMonthsResult.reason?.message || '')
          if (/attendance_penalties|schema cache|does not exist/i.test(message)) {
            throw penaltyMonthsResult.reason
          }
        }

        const penaltyMonths = penaltyMonthsResult.status === 'fulfilled' ? penaltyMonthsResult.value : []
        const summaryIds = summaryIdsResult.status === 'fulfilled' ? summaryIdsResult.value : []
        const nextMonths = [...new Set([...penaltyMonths, ...summaryIds, initialMonth])]
          .filter(value => /^\d{4}-\d{2}$/.test(value))
          .sort()
          .reverse()
        setMonths(nextMonths)

        if (employeesResult.status === 'fulfilled') {
          setEmployees(employeesResult.value)
        }

        if (monthRowsResult.status === 'fulfilled') {
          setRows(normalizePenaltyRows(monthRowsResult.value))
          setGeneratedAt(monthRowsResult.value.length ? new Date().toISOString() : '')
        } else {
          throw monthRowsResult.reason
        }

        setMonth(initialMonth)
        setDirty(false)
      } catch (requestError) {
        console.error(requestError)
        const message = String(requestError?.message || '')
        if (!cancelled) {
          if (/attendance_penalties|schema cache|does not exist/i.test(message)) {
            setError('Chưa tạo bảng attendance_penalties trên Supabase. Chạy file migration 20260911180000_attendance_penalties_table.sql trong SQL Editor.')
          } else {
            setError('Không thể tải dữ liệu bảng phạt.')
          }
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [companyId])

  const handleMonthChange = async (nextMonth) => {
    if (dirty && !confirm('Bạn có thay đổi chưa lưu. Đổi tháng sẽ mất thay đổi đó. Tiếp tục?')) {
      return
    }
    await loadMonth(nextMonth)
  }

  const handleAddRow = async () => {
    if (!employees.length) await loadEmployees()
    setRows(prev => [...prev, createEmptyPenaltyRow(month, categories)])
    setDirty(true)
  }

  const handleUpdateRow = (rowId, patch) => {
    setRows(prev => prev.map(row => (row.id === rowId ? { ...row, ...patch, source: 'manual' } : row)))
    setDirty(true)
  }

  const handleSelectEmployee = (rowId, employee) => {
    handleUpdateRow(rowId, {
      employeeId: employee?.id || '',
      employeeCode: employee?.code || '',
      employeeName: employee?.name || ''
    })
  }

  const handleSelectCategory = (rowId, category) => {
    const found = categories.find(item => item.label === category)
    handleUpdateRow(rowId, {
      category,
      amount: found ? found.amount : 0
    })
  }

  const handleDeleteRow = (rowId) => {
    setRows(prev => prev.filter(row => row.id !== rowId))
    setDirty(true)
  }

  const handleSave = async () => {
    const targetMonth = month || currentMonthValue()
    if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
      alert('Tháng không hợp lệ.')
      return
    }
    setSaving(true)
    try {
      const rowsToSave = normalizePenaltyRows(rows).map(row => ({
        ...row,
        amount: Number(row.amount || 0)
      }))
      const saved = await savePenaltiesByMonth(targetMonth, rowsToSave)
      setRows(normalizePenaltyRows(saved.rows))
      setGeneratedAt(saved.generatedAt)
      setDirty(false)
      setMonths(prev => {
        const next = new Set(prev)
        next.add(targetMonth)
        return Array.from(next).sort().reverse()
      })
      alert(`Đã lưu bảng phạt tháng ${targetMonth} vào DB Supabase (${saved.rows.length} dòng).`)
    } catch (requestError) {
      console.error(requestError)
      alert('Lỗi lưu bảng phạt: ' + (requestError.message || requestError))
    } finally {
      setSaving(false)
    }
  }

  const handleFillFromAttendance = async () => {
    const targetMonth = month || currentMonthValue()
    try {
      const snapshot = await fbGet(`hr/attendanceMonthSummaries/${targetMonth}`, companyId)
      if (!snapshot?.rows?.length) {
        alert('Chưa có bảng công tổng hợp cho tháng này. Hãy Tổng hợp ở trang Bảng Công trước.')
        return
      }
      if (rows.length > 0 && !confirm('Nạp từ chấm công sẽ thay toàn bộ bảng phạt hiện tại. Tiếp tục?')) {
        return
      }
      const summaryRows = hydrateAttendanceSummaryRows(snapshot.rows)
      const policy = snapshot.policySnapshot
        ? normalizeAttendancePolicy(snapshot.policySnapshot)
        : penaltyPolicy
      setRows(normalizePenaltyRows(buildPenaltyDetailRows(
        summaryRows, normalizePenaltyCategories(policy.penaltyRules.categories), policy.latePenaltyThresholdMinutes
      )))
      setDirty(true)
    } catch (requestError) {
      console.error(requestError)
      alert('Không nạp được từ chấm công: ' + (requestError.message || requestError))
    }
  }

  if (loading) return <div className="attendance-penalties-state">Đang tải bảng phạt...</div>
  if (error) return <div className="attendance-penalties-state is-error">{error}</div>

  return (
    <div className="attendance-penalties-page">
      <header>
        <div>
          <h1>Bảng phạt</h1>
          <p>
            {rows.length} dòng · Tổng {money(total)} đ
            {generatedAt ? ` · Đã lưu ${formatGeneratedAt(generatedAt)}` : ' · Chưa lưu'}
            {dirty ? ' · Chưa lưu thay đổi' : ''}
          </p>
        </div>
        <div className="attendance-penalties-actions">
          <label>
            Tháng
            <input
              type="month"
              value={month}
              onChange={event => handleMonthChange(event.target.value)}
              disabled={saving}
            />
          </label>
          {months.length > 0 && (
            <label>
              Đã lưu
              <select
                value={months.includes(month) ? month : ''}
                onChange={event => event.target.value && handleMonthChange(event.target.value)}
                disabled={saving}
              >
                {!months.includes(month) && <option value="">Chọn tháng</option>}
                {months.map(value => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          )}
          <button type="button" onClick={handleFillFromAttendance} disabled={saving}>Nạp từ chấm công</button>
          <button type="button" onClick={handleAddRow} disabled={saving}>+ Thêm dòng</button>
          <button type="button" className="is-primary" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? 'Đang lưu...' : 'Lưu bảng phạt'}
          </button>
        </div>
      </header>

      <div className="attendance-penalties-card">
        <div className="attendance-penalties-scroll">
          <table className="attendance-penalties-table">
            <thead>
              <tr>
                <th>STT</th>
                <th>Ngày</th>
                <th>Nhân sự</th>
                <th>Hạng mục phạt</th>
                <th>Nội dung phạt</th>
                <th>Số tiền phạt</th>
                <th>Ghi chú</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan="8" className="is-empty">
                    Chưa có dòng phạt. Bấm <strong>+ Thêm dòng</strong> để nhập tay, hoặc <strong>Nạp từ chấm công</strong>.
                  </td>
                </tr>
              ) : (
                rows.map((item, index) => (
                  <tr key={item.id}>
                    <td>{index + 1}</td>
                    <td>
                      <input
                        type="date"
                        value={item.date || ''}
                        onChange={event => handleUpdateRow(item.id, { date: event.target.value })}
                      />
                    </td>
                    <td className="name">
                      <EmployeeNameSuggest
                        employees={employees}
                        employeeId={item.employeeId}
                        employeeName={item.employeeName}
                        employeeCode={item.employeeCode}
                        onSelect={employee => handleSelectEmployee(item.id, employee)}
                      />
                    </td>
                    <td>
                      <select
                        value={item.category || ''}
                        onChange={event => handleSelectCategory(item.id, event.target.value)}
                      >
                        {categories.map(category => (
                          <option key={category.label} value={category.label}>{category.label}</option>
                        ))}
                        {item.category && !categories.some(category => category.label === item.category) && (
                          <option value={item.category}>{item.category}</option>
                        )}
                      </select>
                    </td>
                    <td className="content">
                      <input
                        type="text"
                        value={item.content || ''}
                        placeholder="Nội dung phạt"
                        onChange={event => handleUpdateRow(item.id, { content: event.target.value })}
                      />
                    </td>
                    <td className="fine">
                      <input
                        type="number"
                        min="0"
                        step="1000"
                        value={item.amount ?? 0}
                        onChange={event => handleUpdateRow(item.id, { amount: Number(event.target.value || 0) })}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={item.note || ''}
                        placeholder="Ghi chú"
                        onChange={event => handleUpdateRow(item.id, { note: event.target.value })}
                      />
                    </td>
                    <td>
                      <button type="button" className="is-danger" onClick={() => handleDeleteRow(item.id)}>Xóa</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan="5">Tổng cộng</td>
                  <td className="fine">{money(total)}</td>
                  <td colSpan="2"></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  )
}

export default AttendancePenalties
