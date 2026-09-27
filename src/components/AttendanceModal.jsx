import { useEffect, useState } from 'react'
import { fbPush, fbUpdate } from '../services/firebase'
import { normalizeString } from '../utils/helpers'
import {
  calculateAttendanceTiming,
  formatAttendanceTime,
  normalizeAttendancePolicy,
  resolveAttendanceShift
} from '../utils/attendanceShift'
import {
  calculateAttendanceMetrics,
  roundDecimal,
  STANDARD_WORK_MINUTES
} from '../utils/attendanceCalculations'

const DAY_NAMES = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7']

function formatTimeHM(value) {
  return formatAttendanceTime(value) || String(value || '')
}

function dayOfWeekFromDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(`${dateStr}T00:00:00`)
  if (isNaN(d.getTime())) return ''
  return DAY_NAMES[d.getDay()] || ''
}

function emptyForm(today, settings = {}) {
  const policy = normalizeAttendancePolicy(settings)
  return {
    employeeId: '',
    employeeCode: '',
    employeeName: '',
    machineName: '',
    department: '',
    position: '',
    date: today,
    dayOfWeek: dayOfWeekFromDate(today),
    checkIn: policy.workStart,
    checkOut: policy.workEnd,
    cong: policy.standardWorkUnit,
    hours: policy.standardWorkMinutes / 60,
    congPlus: 0,
    gioPlus: 0,
    lateMinutes: 0,
    earlyMinutes: 0,
    tc1: 0,
    tc2: 0,
    tc3: 0,
    shiftName: '',
    kyHieu: '',
    kyHieuPlus: '',
    tongGio: policy.standardWorkMinutes / 60,
    status: 'Đủ'
  }
}

function AttendanceModal({
  attendance,
  employees,
  attendanceSettings = {},
  isOpen,
  onClose,
  onSave,
  readOnly = false
}) {
  const [formData, setFormData] = useState(() => emptyForm(new Date().toISOString().split('T')[0], attendanceSettings))
  const [searchTerm, setSearchTerm] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    if (attendance) {
      const date = attendance.date
        ? String(attendance.date).slice(0, 10)
        : ''
      const emp = employees.find(e => e.id === attendance.employeeId)
      const hours = Number(attendance.hours ?? attendance.soGio ?? attendance.gio ?? 0) || 0
      const gioPlus = Number(attendance.gioPlus ?? 0) || 0
      setFormData({
        employeeId: attendance.employeeId || '',
        employeeCode: attendance.employeeCode || emp?.employeeId || emp?.username || '',
        employeeName: attendance.employeeName || emp?.ho_va_ten || emp?.name || '',
        machineName: attendance.machineName || attendance.tenTheoMayChamCong || attendance.employeeName || emp?.ho_va_ten || emp?.name || '',
        department: attendance.department || attendance.phongBan || emp?.bo_phan || '',
        position: attendance.position || attendance.chucVu || emp?.vi_tri || '',
        date,
        dayOfWeek: attendance.dayOfWeek || attendance.thu || dayOfWeekFromDate(date),
        checkIn: formatTimeHM(attendance.vao || attendance.checkIn),
        checkOut: formatTimeHM(attendance.ra || attendance.checkOut),
        cong: Number(attendance.cong ?? 0) || 0,
        hours,
        congPlus: Number(attendance.congPlus ?? 0) || 0,
        gioPlus,
        lateMinutes: Number(attendance.lateMinutes ?? attendance.vaoTre ?? 0) || 0,
        earlyMinutes: Number(attendance.earlyMinutes ?? attendance.raSom ?? 0) || 0,
        tc1: Number(attendance.tc1 ?? 0) || 0,
        tc2: Number(attendance.tc2 ?? 0) || 0,
        tc3: Number(attendance.tc3 ?? 0) || 0,
        shiftName: attendance.shiftName || attendance.tenCa || '',
        kyHieu: attendance.kyHieu || '',
        kyHieuPlus: attendance.kyHieuPlus || '',
        tongGio: Number(attendance.tongGio ?? hours + gioPlus) || 0,
        status: attendance.status || attendance.kyHieu || 'Đủ'
      })
      setSearchTerm(attendance.employeeName || emp?.ho_va_ten || emp?.name || '')
    } else {
      resetForm()
    }
  }, [attendance, isOpen, employees])

  const resetForm = () => {
    const today = new Date().toISOString().split('T')[0]
    setFormData(emptyForm(today, attendanceSettings))
    setSearchTerm('')
    setShowDropdown(false)
  }

  const calculateHours = (checkIn, checkOut, log = formData) => {
    const employee = employees.find(item => item.id === log.employeeId) || {}
    return calculateAttendanceMetrics({
      log,
      checkIn,
      checkOut,
      attendanceSettings,
      shift: resolveAttendanceShift(employee, log, attendanceSettings),
      standardMinutes: Number(attendanceSettings.standardWorkMinutes) || STANDARD_WORK_MINUTES,
      breakMinutes: Number(attendanceSettings.unpaidBreakMinutes) || 0,
      autoCalculateOvertime: false
    }).hours
  }

  const pickEmployee = (emp) => {
    setFormData(prev => {
      const updated = {
        ...prev,
        employeeId: emp.id,
        employeeCode: emp.employeeId || emp.username || '',
        employeeName: emp.ho_va_ten || emp.name || '',
        machineName: prev.machineName || emp.ho_va_ten || emp.name || '',
        department: emp.bo_phan || '',
        position: emp.vi_tri || '',
        shiftName: prev.shiftName || emp.ca_lam_viec || ''
      }
      const timing = calculateAttendanceTiming({
        employee: emp,
        log: updated,
        checkIn: updated.checkIn,
        checkOut: updated.checkOut,
        attendanceSettings
      })
      updated.lateMinutes = timing.lateMinutes ?? 0
      updated.earlyMinutes = timing.earlyMinutes ?? 0
      return updated
    })
    setSearchTerm(emp.ho_va_ten || emp.name || 'N/A')
    setShowDropdown(false)
  }

  const handleChange = (e) => {
    const { name, value } = e.target
    const updated = { ...formData, [name]: value }

    if (name === 'date') {
      updated.dayOfWeek = dayOfWeekFromDate(value)
    }

    if (name === 'checkIn' || name === 'checkOut' || name === 'shiftName') {
      const hours = calculateHours(updated.checkIn, updated.checkOut, updated)
      updated.hours = hours
      const employee = employees.find(item => item.id === updated.employeeId) || {}
      const metrics = calculateAttendanceMetrics({
        log: updated,
        checkIn: updated.checkIn,
        checkOut: updated.checkOut,
        attendanceSettings,
        shift: resolveAttendanceShift(employee, updated, attendanceSettings),
        standardMinutes: Number(attendanceSettings.standardWorkMinutes) || STANDARD_WORK_MINUTES,
        breakMinutes: Number(attendanceSettings.unpaidBreakMinutes) || 0,
        autoCalculateOvertime: false
      })
      updated.cong = roundDecimal(metrics.regularWorkdays)
      updated.tongGio = roundDecimal(hours + Number(updated.gioPlus || 0))
      if (metrics.regularWorkdays >= normalizeAttendancePolicy(attendanceSettings).standardWorkUnit) updated.status = 'Đủ'
      else if (hours > 0) updated.status = 'Thiếu'
      else updated.status = 'Vắng'
      if (!updated.kyHieu) updated.kyHieu = updated.status
      const timing = calculateAttendanceTiming({
        employee,
        log: updated,
        checkIn: updated.checkIn,
        checkOut: updated.checkOut,
        attendanceSettings
      })
      updated.lateMinutes = timing.lateMinutes ?? 0
      updated.earlyMinutes = timing.earlyMinutes ?? 0
    }

    if (name === 'hours' || name === 'gioPlus') {
      updated.tongGio = roundDecimal(Number(updated.hours || 0) + Number(updated.gioPlus || 0))
    }

    setFormData(updated)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (readOnly) return

    try {
      const baseDate = new Date(formData.date)
      let checkInDate = null
      if (formData.checkIn) {
        const [h, m] = formData.checkIn.split(':')
        checkInDate = new Date(baseDate)
        checkInDate.setHours(Number(h), Number(m), 0, 0)
      }
      let checkOutDate = null
      if (formData.checkOut) {
        const [h, m] = formData.checkOut.split(':')
        checkOutDate = new Date(baseDate)
        checkOutDate.setHours(Number(h), Number(m), 0, 0)
      }
      if (checkInDate && checkOutDate && checkOutDate < checkInDate) {
        checkOutDate.setDate(checkOutDate.getDate() + 1)
      }

      const calculatedMetrics = calculateAttendanceMetrics({
        log: formData,
        checkIn: formData.checkIn,
        checkOut: formData.checkOut,
        attendanceSettings,
        shift: resolveAttendanceShift(employees.find(item => item.id === formData.employeeId) || {}, formData, attendanceSettings),
        standardMinutes: Number(attendanceSettings.standardWorkMinutes) || STANDARD_WORK_MINUTES,
        breakMinutes: Number(attendanceSettings.unpaidBreakMinutes) || 0,
        autoCalculateOvertime: false,
        fallbackHours: parseFloat(formData.hours) || 0,
        fallbackWorkdays: parseFloat(formData.cong) || 0
      })
      const hasPunchPair = Boolean(formData.checkIn && formData.checkOut)
      const hours = hasPunchPair ? calculatedMetrics.hours : parseFloat(formData.hours) || 0
      const gioPlus = parseFloat(formData.gioPlus) || 0
      const employee = employees.find(item => item.id === formData.employeeId) || {}
      const timing = calculateAttendanceTiming({
        employee,
        log: formData,
        checkIn: formData.checkIn,
        checkOut: formData.checkOut,
        attendanceSettings
      })
      const dataToSave = {
        employeeId: formData.employeeId,
        employeeCode: formData.employeeCode,
        employeeName: formData.employeeName,
        machineName: formData.machineName || formData.employeeName,
        tenTheoMayChamCong: formData.machineName || formData.employeeName,
        department: formData.department,
        position: formData.position,
        date: formData.date,
        dayOfWeek: formData.dayOfWeek || dayOfWeekFromDate(formData.date),
        timestamp: baseDate.getTime(),
        checkIn: checkInDate ? checkInDate.toISOString() : null,
        checkOut: checkOutDate ? checkOutDate.toISOString() : null,
        vao: formData.checkIn || '',
        ra: formData.checkOut || '',
        cong: hasPunchPair ? roundDecimal(calculatedMetrics.regularWorkdays) : parseFloat(formData.cong) || 0,
        hours,
        gio: hours,
        congPlus: parseFloat(formData.congPlus) || 0,
        gioPlus,
        lateMinutes: timing.lateMinutes ?? 0,
        earlyMinutes: timing.earlyMinutes ?? 0,
        vaoTre: timing.lateMinutes ?? 0,
        raSom: timing.earlyMinutes ?? 0,
        tc1: parseFloat(formData.tc1) || 0,
        tc2: parseFloat(formData.tc2) || 0,
        tc3: parseFloat(formData.tc3) || 0,
        shiftName: formData.shiftName || timing.shift.name,
        tenCa: formData.shiftName || timing.shift.name,
        kyHieu: formData.kyHieu || formData.status || '',
        kyHieuPlus: formData.kyHieuPlus || '',
        tongGio: roundDecimal(hours + gioPlus),
        status: formData.status || formData.kyHieu || ''
      }

      if (attendance && attendance.id) {
        await fbUpdate(`hr/attendanceLogs/${attendance.id}`, dataToSave)
      } else {
        await fbPush('hr/attendanceLogs', dataToSave)
      }

      onSave()
      onClose()
      resetForm()
    } catch (error) {
      alert('Lỗi khi lưu: ' + error.message)
    }
  }

  if (!isOpen) return null

  return (
    <div className="modal show" onClick={onClose}>
      <div className="modal-content modal-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '860px' }}>
        <div className="modal-header">
          <h3>
            <i className={`fas ${readOnly ? 'fa-eye' : 'fa-clock'}`}></i>
            {readOnly ? 'Chi tiết chấm công' : (attendance ? 'Sửa chấm công' : 'Thêm chấm công')}
          </h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Nhân viên *</label>
              <div style={{ position: 'relative' }}>
                <input
                  type="text"
                  placeholder="Tìm kiếm nhân viên..."
                  value={searchTerm}
                  onChange={(e) => {
                    setSearchTerm(e.target.value)
                    setShowDropdown(true)
                    if (formData.employeeId) {
                      setFormData(prev => ({
                        ...prev,
                        employeeId: '',
                        employeeCode: '',
                        employeeName: '',
                        machineName: '',
                        department: '',
                        position: ''
                      }))
                    }
                  }}
                  onFocus={() => setShowDropdown(true)}
                  disabled={readOnly}
                  style={{ width: '100%' }}
                  required
                />
                {showDropdown && !readOnly && (
                  <ul style={{
                    position: 'absolute', top: '100%', left: 0, right: 0, maxHeight: '200px',
                    overflowY: 'auto', background: '#fff', border: '1px solid #ccc',
                    borderRadius: '0 0 4px 4px', zIndex: 1000, margin: 0, padding: 0,
                    listStyle: 'none', boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
                  }}>
                    {employees
                      .filter(emp => normalizeString(emp.ho_va_ten || emp.name || '').includes(normalizeString(searchTerm)))
                      .map(emp => (
                        <li
                          key={emp.id}
                          onClick={() => pickEmployee(emp)}
                          style={{ padding: '10px', cursor: 'pointer', borderBottom: '1px solid #eee' }}
                        >
                          <strong>{emp.ho_va_ten || emp.name || 'N/A'}</strong>
                          <br />
                          <small style={{ color: '#666' }}>
                            {emp.employeeId || emp.username || '-'} | {emp.vi_tri || '-'} | {emp.bo_phan || '-'}
                          </small>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
              {showDropdown && (
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 999 }}
                  onClick={() => setShowDropdown(false)}
                />
              )}
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Mã N.Viên</label>
                <input name="employeeCode" value={formData.employeeCode} onChange={handleChange} disabled={readOnly} />
              </div>
              <div className="form-group">
                <label>Tên nhân viên</label>
                <input name="employeeName" value={formData.employeeName} onChange={handleChange} disabled={readOnly} />
              </div>
              <div className="form-group">
                <label>Tên theo máy chấm công</label>
                <input
                  name="machineName"
                  value={formData.machineName}
                  onChange={handleChange}
                  disabled={readOnly}
                  placeholder="Tên hiển thị trên máy chấm công"
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Phòng ban</label>
                <input name="department" value={formData.department} onChange={handleChange} disabled={readOnly} />
              </div>
              <div className="form-group">
                <label>Chức vụ</label>
                <input name="position" value={formData.position} onChange={handleChange} disabled={readOnly} />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Ngày *</label>
                <input type="date" name="date" value={formData.date} onChange={handleChange} required disabled={readOnly} />
              </div>
              <div className="form-group">
                <label>Thứ</label>
                <input name="dayOfWeek" value={formData.dayOfWeek} onChange={handleChange} disabled={readOnly} />
              </div>
              <div className="form-group">
                <label>Tên ca</label>
                <input name="shiftName" value={formData.shiftName} onChange={handleChange} disabled={readOnly} placeholder="Ca Hành chính / Ca Sáng Sale" />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Vào</label>
                <input type="time" name="checkIn" value={formData.checkIn} onChange={handleChange} disabled={readOnly} />
              </div>
              <div className="form-group">
                <label>Ra</label>
                <input type="time" name="checkOut" value={formData.checkOut} onChange={handleChange} disabled={readOnly} />
              </div>
              <div className="form-group">
                <label>Vào trễ (phút)</label>
                <input type="number" name="lateMinutes" value={formData.lateMinutes} onChange={handleChange} min="0" disabled={readOnly} />
              </div>
              <div className="form-group">
                <label>Ra sớm (phút)</label>
                <input type="number" name="earlyMinutes" value={formData.earlyMinutes} onChange={handleChange} min="0" disabled={readOnly} />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Công</label>
                <input type="number" name="cong" value={formData.cong} onChange={handleChange} step="0.1" min="0" disabled={readOnly} />
              </div>
              <div className="form-group">
                <label>Giờ</label>
                <input type="number" name="hours" value={formData.hours} onChange={handleChange} step="0.1" min="0" disabled={readOnly} />
              </div>
              <div className="form-group">
                <label>Công+</label>
                <input type="number" name="congPlus" value={formData.congPlus} onChange={handleChange} step="0.1" min="0" disabled={readOnly} />
              </div>
              <div className="form-group">
                <label>Giờ+</label>
                <input type="number" name="gioPlus" value={formData.gioPlus} onChange={handleChange} step="0.1" min="0" disabled={readOnly} />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>TC1</label>
                <input type="number" name="tc1" value={formData.tc1} onChange={handleChange} step="0.1" min="0" disabled={readOnly} />
              </div>
              <div className="form-group">
                <label>TC2</label>
                <input type="number" name="tc2" value={formData.tc2} onChange={handleChange} step="0.1" min="0" disabled={readOnly} />
              </div>
              <div className="form-group">
                <label>TC3</label>
                <input type="number" name="tc3" value={formData.tc3} onChange={handleChange} step="0.1" min="0" disabled={readOnly} />
              </div>
              <div className="form-group">
                <label>Tổng giờ</label>
                <input type="number" name="tongGio" value={formData.tongGio} onChange={handleChange} step="0.1" min="0" disabled={readOnly} />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Kí hiệu</label>
                <input name="kyHieu" value={formData.kyHieu} onChange={handleChange} disabled={readOnly} placeholder="X / P / NP..." />
              </div>
              <div className="form-group">
                <label>Kí hiệu+</label>
                <input name="kyHieuPlus" value={formData.kyHieuPlus} onChange={handleChange} disabled={readOnly} />
              </div>
              <div className="form-group">
                <label>Trạng thái</label>
                <select name="status" value={formData.status} onChange={handleChange} disabled={readOnly}>
                  <option value="Đủ">Đủ công</option>
                  <option value="Thiếu">Thiếu công</option>
                  <option value="Muộn">Đi muộn</option>
                  <option value="Sớm">Về sớm</option>
                  <option value="Vắng">Vắng mặt</option>
                  <option value="Nghỉ phép">Nghỉ phép</option>
                </select>
              </div>
            </div>

            <div className="form-actions" style={{ marginTop: '20px', display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={onClose}>
                {readOnly ? 'Đóng' : 'Hủy'}
              </button>
              {!readOnly && (
                <button type="submit" className="btn btn-primary">
                  <i className="fas fa-save"></i> Lưu
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

export default AttendanceModal
export { formatTimeHM, dayOfWeekFromDate, DAY_NAMES }
