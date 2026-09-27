import { useEffect, useMemo, useState } from 'react'
import { useCompany } from '../contexts/CompanyContext'
import { fbGet, fbUpdate } from '../services/firebase'
import { requireTenantCompanyId } from '../services/tenantSession'
import { getCloudinaryConfig, saveCloudinaryConfig } from '../utils/cloudinary'
import {
  ATTENDANCE_SHIFT_IDS,
  buildAttendanceShiftSettingsPayload,
  getAttendanceShiftOptions,
  normalizeAttendanceShiftSettings,
  validateAttendancePolicy
} from '../utils/attendanceShift'

function AttendanceSettingsModal({ isOpen, onClose, onSaved, companyId: propCompanyId }) {
  const { companyId: sessionCompanyId } = useCompany()
  const activeCompanyId = requireTenantCompanyId(propCompanyId || sessionCompanyId)

  const [settings, setSettings] = useState(() => normalizeAttendanceShiftSettings())
  const [selectedShiftId, setSelectedShiftId] = useState(ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE)
  const [cloudName, setCloudName] = useState('')
  const [uploadPreset, setUploadPreset] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [holidayDate, setHolidayDate] = useState('')
  const [holidayName, setHolidayName] = useState('')

  useEffect(() => {
    if (!isOpen) return
    setLoading(true)
    setError('')
    const { cloudName: cName, uploadPreset: cPreset } = getCloudinaryConfig()
    setCloudName(cName)
    setUploadPreset(cPreset)

    fbGet('hr/attendanceSettings/default', activeCompanyId)
      .then(storedSettings => {
        setSettings(normalizeAttendanceShiftSettings(storedSettings))
        setSelectedShiftId(ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE)
        setHolidayDate('')
        setHolidayName('')
      })
      .catch(requestError => setError(requestError.message))
      .finally(() => setLoading(false))
  }, [isOpen, activeCompanyId])

  const shiftOptions = getAttendanceShiftOptions(settings)
  const selectedShift = settings.shifts[selectedShiftId]

  const updateSchedule = (field, value) => {
    setError('')
    setSettings(current => {
      const next = { ...current, [field]: value }
      const shiftField = field === 'workStart' ? 'standardCheckIn' : field === 'workEnd' ? 'standardCheckOut' : field
      const session = field === 'workStart' || field === 'lunchStart' ? 'morning' : 'afternoon'
      const sessionField = field === 'workStart' || field === 'lunchEnd' ? 'start' : 'end'
      const admin = current.shifts.administrative
      next.shifts = {
        ...current.shifts,
        administrative: { ...admin, [shiftField]: value,
          splitShift: { ...admin.splitShift,
            [session]: { ...(admin.splitShift?.[session] || {}), [sessionField]: value } } }
      }
      return next
    })
  }

  const updateSelectedShift = (field, value) => {
    setSettings(current => ({
      ...current,
      ...(selectedShiftId === ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE && field === 'standardCheckIn' ? { workStart: value } : {}),
      ...(selectedShiftId === ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE && field === 'standardCheckOut' ? { workEnd: value } : {}),
      shifts: {
        ...current.shifts,
        [selectedShiftId]: {
          ...current.shifts[selectedShiftId],
          [field]: value,
          ...(field === 'standardCheckIn' || field === 'standardCheckOut' ? {
            splitShift: { ...current.shifts[selectedShiftId].splitShift,
              [field === 'standardCheckIn' ? 'morning' : 'afternoon']: {
                ...(current.shifts[selectedShiftId].splitShift?.[field === 'standardCheckIn' ? 'morning' : 'afternoon'] || {}),
                [field === 'standardCheckIn' ? 'start' : 'end']: value
              } }
          } : {})
        }
      }
    }))
  }

  const addHoliday = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(holidayDate)) return
    setSettings(current => ({
      ...current,
      holidays: [
        ...(current.holidays || []).filter(item => item.date !== holidayDate),
        { date: holidayDate, name: holidayName.trim() }
      ].sort((left, right) => left.date.localeCompare(right.date))
    }))
    setHolidayDate('')
    setHolidayName('')
  }

  const removeHoliday = date => setSettings(current => ({
    ...current,
    holidays: (current.holidays || []).filter(item => item.date !== date)
  }))

  const submit = async event => {
    event.preventDefault()

    // 1. Validation 4 mốc giờ theo quy định: workStart < lunchStart < lunchEnd < workEnd
    const scheduleValidation = validateAttendancePolicy(settings)
    if (!scheduleValidation.isValid) {
      setError(scheduleValidation.error)
      return
    }

    // 2. Validation các ca khác
    const invalidShift = getAttendanceShiftOptions(settings).find(
      shift => shift.standardCheckIn === shift.standardCheckOut
    )
    if (invalidShift) {
      setSelectedShiftId(invalidShift.id)
      setError(`Giờ ra chuẩn của ${invalidShift.name} phải khác giờ vào chuẩn.`)
      return
    }

    setSaving(true)
    setError('')
    try {
      await fbUpdate(
        'hr/attendanceSettings/default',
        buildAttendanceShiftSettingsPayload({ ...settings, policyVersion: Number(settings.policyVersion || 0) + 1 }),
        activeCompanyId
      )
      saveCloudinaryConfig(cloudName, uploadPreset)
      await onSaved?.()
      onClose()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  if (!isOpen) return null

  const morningMins = settings.morningMinutes || 0
  const afternoonMins = settings.afternoonMinutes || 0
  const standardMins = settings.standardWorkMinutes || 0
  const standardHours = (standardMins / 60).toFixed(2).replace(/\.00$/, '')

  return (
    <div className="modal show" onClick={onClose}>
      <div className="modal-content attendance-settings" onClick={event => event.stopPropagation()} style={{ maxWidth: 760 }}>
        <div className="modal-header">
          <h2>Cài đặt giờ chấm công &amp; Nghỉ trưa</h2>
          <button className="modal-close" onClick={onClose} type="button">&times;</button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}
            {loading ? (
              <div style={{ padding: 24, textAlign: 'center' }}>Đang tải cài đặt...</div>
            ) : (
              <>
                {/* 1. KHUNG CẤU HÌNH 4 TRƯỜNG CHÍNH THEO CÔNG TY */}
                <div style={{ padding: 16, background: '#f8fafc', borderRadius: 8, border: '1px solid #cbd5e1', marginBottom: 20 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <h3 style={{ margin: 0, fontSize: 15, color: '#0f172a', fontWeight: 600 }}>
                      <i className="fas fa-business-time" style={{ marginRight: 6, color: '#2563eb' }}></i>
                      Khung giờ làm việc &amp; Nghỉ trưa của công ty
                    </h3>
                    <span style={{ fontSize: 12, color: '#64748b' }}>Áp dụng theo Company ID</span>
                  </div>
                  <p style={{ margin: '0 0 14px', fontSize: 13, color: '#64748b' }}>
                    Quy tắc: Giờ vào sớm hơn giờ bắt đầu sẽ được clamp về giờ bắt đầu. Giờ nghỉ trưa không tính công. Tăng ca (OT) tự động tính sau giờ kết thúc làm việc.
                  </p>

                  <div className="attendance-settings__grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
                    <div className="form-group">
                      <label style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>
                        Giờ bắt đầu làm việc <span style={{ color: '#ef4444' }}>*</span>
                      </label>
                      <input
                        type="time"
                        id="setting-work-start"
                        value={settings.workStart || '07:00'}
                        onChange={event => updateSchedule('workStart', event.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>
                        Bắt đầu nghỉ trưa <span style={{ color: '#ef4444' }}>*</span>
                      </label>
                      <input
                        type="time"
                        id="setting-lunch-start"
                        value={settings.lunchStart || '11:00'}
                        onChange={event => updateSchedule('lunchStart', event.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>
                        Kết thúc nghỉ trưa <span style={{ color: '#ef4444' }}>*</span>
                      </label>
                      <input
                        type="time"
                        id="setting-lunch-end"
                        value={settings.lunchEnd || '13:00'}
                        onChange={event => updateSchedule('lunchEnd', event.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>
                        Giờ kết thúc làm việc <span style={{ color: '#ef4444' }}>*</span>
                      </label>
                      <input
                        type="time"
                        id="setting-work-end"
                        value={settings.workEnd || '17:00'}
                        onChange={event => updateSchedule('workEnd', event.target.value)}
                        required
                      />
                    </div>
                  </div>

                  <div className="form-group" style={{ maxWidth: 240, marginTop: 12 }}>
                    <label htmlFor="setting-monthly-standard-work-units">Công chuẩn tháng</label>
                    <input
                      id="setting-monthly-standard-work-units"
                      type="number"
                      min="0.01"
                      step="0.5"
                      value={settings.monthlyStandardWorkUnits ?? ''}
                      onChange={event => setSettings(current => ({
                        ...current,
                        monthlyStandardWorkUnits: Number(event.target.value)
                      }))}
                      required
                    />
                    <small>Chỉ dùng trong cột Công chuẩn của báo cáo tháng.</small>
                  </div>

                  {/* Summary card showing calculated periods */}
                  <div style={{ marginTop: 14, padding: '10px 14px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, fontSize: 13, color: '#1e40af' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                      <span><strong>Ca sáng:</strong> {settings.workStart} – {settings.lunchStart} ({morningMins} phút)</span>
                      <span><strong>Nghỉ trưa:</strong> {settings.lunchStart} – {settings.lunchEnd} (0 công)</span>
                      <span><strong>Ca chiều:</strong> {settings.lunchEnd} – {settings.workEnd} ({afternoonMins} phút)</span>
                      <span><strong>Chuẩn 1 công:</strong> {standardMins} phút ({standardHours}h)</span>
                    </div>
                  </div>
                </div>

                {/* 2. CHỌN CA ĐẶC THÙ (NẾU CÓ) */}
                <div style={{ marginBottom: 16 }}>
                  <h4 style={{ margin: '0 0 8px', fontSize: 14, color: '#1e293b' }}>Cài đặt giờ chuẩn theo ca</h4>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                    {shiftOptions.map(shift => (
                      <button
                        key={shift.id}
                        className={`btn ${selectedShiftId === shift.id ? 'btn-primary' : ''}`}
                        type="button"
                        onClick={() => setSelectedShiftId(shift.id)}
                      >
                        {shift.name} ({shift.standardCheckIn}–{shift.standardCheckOut})
                      </button>
                    ))}
                  </div>
                  <div className="attendance-settings__grid">
                    <div className="form-group">
                      <label>Giờ vào chuẩn ({selectedShift?.name})</label>
                      <input
                        type="time"
                        value={selectedShift?.standardCheckIn || ''}
                        onChange={event => updateSelectedShift('standardCheckIn', event.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Giờ ra chuẩn ({selectedShift?.name})</label>
                      <input
                        type="time"
                        value={selectedShift?.standardCheckOut || ''}
                        onChange={event => updateSelectedShift('standardCheckOut', event.target.value)}
                        required
                      />
                    </div>
                  </div>
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0', color: '#334155' }}>
                  <input
                    type="checkbox"
                    checked={settings.overtime?.autoCalculate !== false}
                    onChange={event => setSettings(current => ({
                      ...current,
                      overtime: { ...(current.overtime || {}), autoCalculate: event.target.checked }
                    }))}
                  />
                  Tự động tính tăng ca (OT) sau giờ kết thúc làm việc ({settings.workEnd || '17:00'})
                </label>

                {/* 3. NGÀY LỄ */}
                <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid #e2e8f0' }}>
                  <h4 style={{ margin: '0 0 8px', fontSize: 14, color: '#1e293b' }}>Ngày lễ / ngày nghỉ hưởng chế độ</h4>
                  <p style={{ margin: '0 0 10px', color: '#64748b', fontSize: 13 }}>
                    Ngày đã khai báo được đánh dấu riêng trong bảng công; không tự tạo Công khi không có dữ liệu chấm công.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) minmax(160px, 1.5fr) auto', gap: 8, alignItems: 'end' }}>
                    <div className="form-group"><label>Ngày</label><input type="date" value={holidayDate} onChange={event => setHolidayDate(event.target.value)} /></div>
                    <div className="form-group"><label>Tên ngày lễ</label><input type="text" value={holidayName} onChange={event => setHolidayName(event.target.value)} placeholder="Ví dụ: Quốc khánh" /></div>
                    <button type="button" className="btn" onClick={addHoliday} disabled={!holidayDate}>Thêm ngày lễ</button>
                  </div>
                  {(settings.holidays || []).length > 0 && (
                    <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
                      {settings.holidays.map(item => (
                        <div key={item.date} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 9px', background: '#f8fafc', borderRadius: 6 }}>
                          <span><strong>{item.date}</strong>{item.name ? ` — ${item.name}` : ''}</span>
                          <button type="button" className="btn btn-icon" title="Xoá ngày lễ" onClick={() => removeHoliday(item.date)}><i className="fas fa-trash"></i></button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 4. CLOUDINARY */}
                <h4 style={{ margin: '18px 0 8px', fontSize: '14px', color: '#1e293b' }}>Cấu hình Cloudinary (Lưu trữ ảnh xác thực)</h4>
                <div className="attendance-settings__grid">
                  <div className="form-group"><label>Cloud Name</label><input type="text" placeholder="ksny3wwy" value={cloudName} onChange={event => setCloudName(event.target.value)} /></div>
                  <div className="form-group"><label>Upload Preset (Unsigned)</label><input type="text" placeholder="nr5kwa0r" value={uploadPreset} onChange={event => setUploadPreset(event.target.value)} /></div>
                </div>
              </>
            )}
          </div>
          <div className="attendance-settings__footer">
            <a href="/holiday-settings?tab=shifts" className="btn">Quy tắc tính công nâng cao</a>
            <button className="btn" type="button" onClick={onClose}>Hủy</button>
            <button className="btn btn-primary" type="submit" disabled={loading || saving}>
              {saving ? 'Đang lưu...' : 'Lưu cài đặt'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default AttendanceSettingsModal
