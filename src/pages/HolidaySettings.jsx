import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useCompany } from '../contexts/CompanyContext'
import { useSearchParams } from 'react-router-dom'
import LeaveSettingsPanel from '../components/LeaveSettingsPanel'
import { fbGet, fbUpdate } from '../services/firebase'
import {
  ATTENDANCE_SHIFT_IDS,
  buildAttendanceShiftSettingsPayload,
  getAttendanceShiftOptions,
  normalizeAttendanceShiftSettings,
  validateAttendancePolicy
} from '../utils/attendanceShift'
import {
  createPenaltyCategory,
  DEFAULT_PENALTY_CATEGORIES,
  normalizePenaltyCategories
} from '../utils/attendancePenalties'
import './HolidaySettings.css'

const TABS = [
  { id: 'holidays', label: 'Cài đặt ngày lễ', icon: 'fas fa-calendar-day' },
  { id: 'shifts', label: 'Cài đặt ca', icon: 'fas fa-clock' },
  { id: 'penalties', label: 'Cài đặt Nội dung phạt và mức phạt', icon: 'fas fa-file-invoice-dollar' },
  { id: 'leave', label: 'Cài đặt phép', icon: 'fas fa-calendar-alt' }
]

const TAB_COPY = {
  holidays: 'Khai báo ngày lễ/ngày nghỉ để hiển thị chính xác trên Bảng Công.',
  shifts: 'Cài giờ chuẩn từng ca. Báo cáo đi muộn/về sớm dùng ca của từng nhân viên.',
  penalties: 'Nội dung và mức phạt này dùng khi nhập hoặc nạp Bảng phạt từ chấm công.',
  leave: 'Thiết lập tổng phép năm và phân bổ phép từng tháng cho mỗi nhân sự.'
}

const sortHolidays = holidays => [...(holidays || [])]
  .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(String(item?.date || '')))
  .sort((left, right) => left.date.localeCompare(right.date))

function HolidaySettings() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const { companyId } = useCompany()
  const leaveCompanyId = companyId
  const canEditLeave = user?.role === 'admin' || user?.role === 'hr'
  const requestedTab = searchParams.get('tab')
  const activeTab = requestedTab === 'leave' && !canEditLeave ? 'holidays' :
    TABS.some(tab => tab.id === requestedTab) ? requestedTab : 'holidays'
  const setActiveTab = tab => setSearchParams(tab === 'holidays' ? {} : { tab })
  const [settings, setSettings] = useState(() => normalizeAttendanceShiftSettings())
  const [savedSettings, setSavedSettings] = useState(null)
  const [penaltyCategories, setPenaltyCategories] = useState(() =>
    DEFAULT_PENALTY_CATEGORIES.map(item => ({ ...item }))
  )
  const [savedPenaltyCategories, setSavedPenaltyCategories] = useState(null)
  const [selectedShiftId, setSelectedShiftId] = useState(ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE)
  const [holidayDate, setHolidayDate] = useState('')
  const [holidayName, setHolidayName] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const hasUnsavedChanges = savedSettings !== null && (
    JSON.stringify(settings) !== JSON.stringify(savedSettings) ||
    JSON.stringify(penaltyCategories) !== JSON.stringify(savedPenaltyCategories)
  )

  const loadSettings = useCallback(async () => {
    setLoading(true)
    setError('')
    setSavedSettings(null)
    try {
      const stored = await fbGet('hr/attendanceSettings/default', companyId)
      const nextSettings = normalizeAttendanceShiftSettings(stored)
      const nextPenaltyCategories = normalizePenaltyCategories(stored?.penaltyRules?.categories || stored?.penaltyCategories)
      setSettings(nextSettings)
      setSavedSettings(nextSettings)
      setPenaltyCategories(nextPenaltyCategories)
      setSavedPenaltyCategories(nextPenaltyCategories)
      setSelectedShiftId(ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE)
    } catch (requestError) {
      setError(requestError.message || 'Không tải được cài đặt.')
    } finally {
      setLoading(false)
    }
  }, [companyId])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  const holidays = sortHolidays(settings.holidays)
  const updateSchedule = (field, value) => {
    setError('')
    setNotice('')
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

  const shiftOptions = getAttendanceShiftOptions(settings)
  const selectedShift = settings.shifts[selectedShiftId]

  const addHoliday = () => {
    setError('')
    setNotice('')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(holidayDate)) {
      setError('Vui lòng chọn ngày lễ.')
      return
    }
    setSettings(current => ({
      ...current,
      holidays: sortHolidays([
        ...(current.holidays || []).filter(item => item.date !== holidayDate),
        { date: holidayDate, name: holidayName.trim() }
      ])
    }))
    setHolidayDate('')
    setHolidayName('')
  }

  const removeHoliday = date => {
    setNotice('')
    setSettings(current => ({
      ...current,
      holidays: (current.holidays || []).filter(item => item.date !== date)
    }))
  }

  const updateSelectedShift = (field, value) => {
    setSettings(current => ({
      ...current,
      ...(selectedShiftId === ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE && field === 'standardCheckIn' ? { workStart: value } : {}),
      ...(selectedShiftId === ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE && field === 'standardCheckOut' ? { workEnd: value } : {}),
      ...(selectedShiftId === ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE && field === 'standardWorkMinutes' ? { standardWorkMinutes: value } : {}),
      ...(selectedShiftId === ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE && field === 'unpaidBreakMinutes' ? { unpaidBreakMinutes: value } : {}),
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

  const addShift = () => {
    const id = `custom_${Date.now()}`
    setSettings(current => ({
      ...current,
      shifts: {
        ...current.shifts,
        [id]: {
          id,
          name: '',
          standardCheckIn: '',
          standardCheckOut: '',
          splitShift: { enabled: false }
        }
      }
    }))
    setSelectedShiftId(id)
    setError('')
  }

  const removeSelectedShift = () => {
    if (Object.values(ATTENDANCE_SHIFT_IDS).includes(selectedShiftId)) return
    setSettings(current => {
      const shifts = { ...current.shifts }
      delete shifts[selectedShiftId]
      return { ...current, shifts }
    })
    setSelectedShiftId(ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE)
  }

  const toggleSelectedSplitShift = enabled => {
    setSettings(current => {
      const shift = current.shifts[selectedShiftId]
      const splitShift = shift.splitShift || {}
      const defaultSessions = selectedShiftId === ATTENDANCE_SHIFT_IDS.SALE_MORNING
        ? { morningEnd: '08:00', afternoonStart: '09:30' }
        : { morningEnd: '12:00', afternoonStart: '13:00' }
      return {
        ...current,
        shifts: {
          ...current.shifts,
          [selectedShiftId]: {
            ...shift,
            splitShift: {
              ...splitShift,
              enabled,
              morning: {
                start: splitShift.morning?.start || shift.standardCheckIn || '',
                end: splitShift.morning?.end || defaultSessions.morningEnd,
                workdays: splitShift.morning?.workdays ?? 0.5
              },
              afternoon: {
                start: splitShift.afternoon?.start || defaultSessions.afternoonStart,
                end: splitShift.afternoon?.end || shift.standardCheckOut || '',
                workdays: splitShift.afternoon?.workdays ?? 0.5
              }
            }
          }
        }
      }
    })
  }

  const updateSelectedSplitSession = (session, field, value) => {
    setSettings(current => {
      const shift = current.shifts[selectedShiftId]
      return {
        ...current,
        ...(selectedShiftId === ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE ? {
          splitShiftEnabled: enabled,
          workUnitCalculationMode: enabled ? 'split_shift'
            : current.workUnitCalculationMode === 'split_shift' ? 'proportional' : current.workUnitCalculationMode
        } : {}),
        ...(selectedShiftId === ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE && field === 'workdays'
          ? { [session === 'morning' ? 'morningWeight' : 'afternoonWeight']: value } : {}),
        shifts: {
          ...current.shifts,
          [selectedShiftId]: {
            ...shift,
            splitShift: {
              ...(shift.splitShift || {}),
              [session]: {
                ...(shift.splitShift?.[session] || {}),
                [field]: value
              }
            }
          }
        }
      }
    })
  }

  const updatePenaltyCategory = (key, field, value) => {
    setNotice('')
    setPenaltyCategories(current => current.map(item => (
      item.key === key ? { ...item, [field]: value } : item
    )))
  }

  const addPenaltyCategory = () => {
    setNotice('')
    setPenaltyCategories(current => [
      ...current,
      createPenaltyCategory({ label: '', amount: 0 })
    ])
  }

  const removePenaltyCategory = key => {
    setNotice('')
    setPenaltyCategories(current => current.length <= 1 ? current : current.filter(item => item.key !== key))
  }

  const resetPenaltyCategories = () => {
    setNotice('')
    setPenaltyCategories(DEFAULT_PENALTY_CATEGORIES.map(item => ({ ...item })))
  }

  const saveSettings = async () => {
    const policyValidation = validateAttendancePolicy(settings)
    if (!policyValidation.isValid) {
      setActiveTab('shifts')
      setError(policyValidation.error)
      setNotice('')
      return
    }
    const invalidShift = getAttendanceShiftOptions(settings).find(shift =>
      !shift.name?.trim() || !shift.standardCheckIn || !shift.standardCheckOut ||
      shift.standardCheckIn === shift.standardCheckOut
    )
    if (invalidShift) {
      setSelectedShiftId(invalidShift.id)
      setActiveTab('shifts')
      setError(`Ca ${invalidShift.name || 'mới'} cần tên, giờ vào và giờ ra hợp lệ; hai mốc giờ phải khác nhau.`)
      setNotice('')
      return
    }

    const invalidSplitShift = getAttendanceShiftOptions(settings).find(shift => {
      if (!shift.splitShift?.enabled) return false
      const sessions = [shift.splitShift.morning, shift.splitShift.afternoon]
      return sessions.some(session =>
        !session?.start || !session?.end || session.start >= session.end ||
        Number(session.workdays) <= 0 || Number(session.workdays) > 1
      ) ||
        sessions[0]?.end > sessions[1]?.start ||
        sessions.reduce((sum, session) => sum + Number(session.workdays || 0), 0) > 1
    })
    if (invalidSplitShift) {
      setSelectedShiftId(invalidSplitShift.id)
      setActiveTab('shifts')
      setError(`Vui lòng kiểm tra giờ và mức công hai buổi của ${invalidSplitShift.name}. Tổng hai buổi không được vượt quá 1 công.`)
      setNotice('')
      return
    }

    const normalizedPenalties = normalizePenaltyCategories(penaltyCategories)
    const emptyPenalty = normalizedPenalties.find(item => !item.label.trim())
    if (emptyPenalty) {
      setActiveTab('penalties')
      setError('Vui lòng nhập nội dung phạt cho mọi hạng mục.')
      setNotice('')
      return
    }

    setSaving(true)
    setError('')
    setNotice('')
    try {
      const payload = buildAttendanceShiftSettingsPayload({
        ...settings,
        policyVersion: Number(settings.policyVersion || 0) + 1,
        penaltyRules: { ...settings.penaltyRules, categories: normalizedPenalties,
          latePenaltyThresholdMinutes: settings.latePenaltyThresholdMinutes },
        holidays: sortHolidays(settings.holidays)
      })
      await fbUpdate('hr/attendanceSettings/default', {
        ...payload,
        penaltyCategories: normalizedPenalties
      }, companyId)
      const storedAfterSave = await fbGet('hr/attendanceSettings/default', companyId)
      const savedShifts = storedAfterSave?.shifts || {}
      const allShiftsSaved = Object.entries(payload.shifts).every(([id, shift]) =>
        savedShifts[id]?.name === shift.name &&
        savedShifts[id]?.standardCheckIn === shift.standardCheckIn &&
        savedShifts[id]?.standardCheckOut === shift.standardCheckOut
      )
      if (!allShiftsSaved) {
        throw new Error('Ca chưa được lưu đầy đủ. Hãy thử lưu lại; các thay đổi vẫn còn trên màn hình.')
      }
      const verifiedSettings = normalizeAttendanceShiftSettings(storedAfterSave)
      setSettings(verifiedSettings)
      setSavedSettings(verifiedSettings)
      setPenaltyCategories(normalizedPenalties)
      setSavedPenaltyCategories(normalizedPenalties)
      setNotice('Đã lưu và kiểm tra lại cài đặt. Hãy tổng hợp lại Bảng Công nếu thay đổi ngày lễ hoặc ca.')
    } catch (requestError) {
      setError(requestError.message || 'Không lưu được cài đặt.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="holiday-settings-page">
      <header className="holiday-settings-head">
        <div>
          <h1>Cài đặt</h1>
          <p>{TAB_COPY[activeTab]}</p>
        </div>
        {activeTab !== 'leave' && <button type="button" className="btn btn-primary" onClick={saveSettings} disabled={loading || saving}>
          <i className="fas fa-save"></i> {saving ? 'Đang lưu...' : 'Lưu cài đặt'}
        </button>}
      </header>

      <div className="holiday-settings-tabs" role="tablist" aria-label="Cài đặt chấm công">
        {TABS.filter(tab => tab.id !== 'leave' || canEditLeave).map(tab => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`holiday-settings-tab${activeTab === tab.id ? ' is-active' : ''}`}
            onClick={() => {
              setActiveTab(tab.id)
              setError('')
              setNotice('')
            }}
          >
            <i className={tab.icon}></i>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {activeTab !== 'leave' && error && <div className="holiday-settings-alert is-error">{error}</div>}
      {activeTab !== 'leave' && hasUnsavedChanges && <div className="holiday-settings-alert is-warning">Có thay đổi chưa lưu. Bấm “Lưu cài đặt” trước khi rời trang.</div>}
      {activeTab !== 'leave' && notice && !hasUnsavedChanges && <div className="holiday-settings-alert is-success">{notice}</div>}

      {activeTab === 'leave' && <LeaveSettingsPanel companyId={leaveCompanyId} />}

      {activeTab === 'holidays' && (
        <section className="holiday-settings-card" role="tabpanel">
          <div className="holiday-settings-form">
            <label>
              <span>Ngày</span>
              <input type="date" value={holidayDate} onChange={event => setHolidayDate(event.target.value)} />
            </label>
            <label>
              <span>Tên ngày lễ</span>
              <input type="text" value={holidayName} onChange={event => setHolidayName(event.target.value)} placeholder="Ví dụ: Quốc khánh" />
            </label>
            <button type="button" className="btn" onClick={addHoliday} disabled={loading || !holidayDate}>
              <i className="fas fa-plus"></i> Thêm ngày lễ
            </button>
          </div>

          {loading ? (
            <div className="holiday-settings-empty">Đang tải cài đặt...</div>
          ) : holidays.length === 0 ? (
            <div className="holiday-settings-empty">Chưa khai báo ngày lễ.</div>
          ) : (
            <div className="holiday-settings-list">
              {holidays.map(item => (
                <div className="holiday-settings-item" key={item.date}>
                  <div>
                    <strong>{new Date(`${item.date}T00:00:00`).toLocaleDateString('vi-VN')}</strong>
                    <span>{item.name || 'Ngày lễ'}</span>
                  </div>
                  <button type="button" className="btn btn-icon" onClick={() => removeHoliday(item.date)} title="Xóa ngày lễ">
                    <i className="fas fa-trash"></i>
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {activeTab === 'shifts' && (
        <section className="holiday-settings-card" role="tabpanel">
          {loading ? (
            <div className="holiday-settings-empty">Đang tải cài đặt...</div>
          ) : (
            <>
              <div style={{ padding: 16, background: '#f8fafc', borderRadius: 8, border: '1px solid #cbd5e1', marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <h3 style={{ margin: 0, fontSize: 15, color: '#0f172a', fontWeight: 600 }}>
                    <i className="fas fa-business-time" style={{ marginRight: 6, color: '#2563eb' }}></i>
                    Khung giờ làm việc &amp; Nghỉ trưa của công ty
                  </h3>
                  <span style={{ fontSize: 12, color: '#64748b' }}>Cài đặt theo công ty</span>
                </div>
                <p style={{ margin: '0 0 14px', fontSize: 13, color: '#64748b' }}>
                  Giờ vào trước giờ bắt đầu sẽ được clamp về giờ bắt đầu. Giờ nghỉ trưa không tính công. Tăng ca (OT) tự động tính sau giờ kết thúc làm việc.
                </p>
                <div className="holiday-settings-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
                  <label>
                    <span style={{ fontWeight: 600 }}>Giờ bắt đầu làm việc [workStart]</span>
                    <input
                      type="time"
                      value={settings.workStart || '07:00'}
                      onChange={event => updateSchedule('workStart', event.target.value)}
                      required
                    />
                  </label>
                  <label>
                    <span style={{ fontWeight: 600 }}>Bắt đầu nghỉ trưa [lunchStart]</span>
                    <input
                      type="time"
                      value={settings.lunchStart || '11:00'}
                      onChange={event => updateSchedule('lunchStart', event.target.value)}
                      required
                    />
                  </label>
                  <label>
                    <span style={{ fontWeight: 600 }}>Kết thúc nghỉ trưa [lunchEnd]</span>
                    <input
                      type="time"
                      value={settings.lunchEnd || '13:00'}
                      onChange={event => updateSchedule('lunchEnd', event.target.value)}
                      required
                    />
                  </label>
                  <label>
                    <span style={{ fontWeight: 600 }}>Giờ kết thúc làm việc [workEnd]</span>
                    <input
                      type="time"
                      value={settings.workEnd || '17:00'}
                      onChange={event => updateSchedule('workEnd', event.target.value)}
                      required
                    />
                  </label>
                </div>
                <label style={{ display: 'block', maxWidth: 240, marginTop: 12 }}>
                  <span>Công chuẩn tháng</span>
                  <input
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
                  <small>Chỉ dùng cho cột Công chuẩn trong báo cáo tháng.</small>
                </label>
                <div style={{ marginTop: 12, padding: '10px 14px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, fontSize: 13, color: '#1e40af' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                    <span><strong>Ca sáng:</strong> {settings.workStart} – {settings.lunchStart} ({settings.morningMinutes || 0} phút)</span>
                    <span><strong>Nghỉ trưa:</strong> {settings.lunchStart} – {settings.lunchEnd} (0 công)</span>
                    <span><strong>Ca chiều:</strong> {settings.lunchEnd} – {settings.workEnd} ({settings.afternoonMinutes || 0} phút)</span>
                    <span><strong>Chuẩn 1 công:</strong> {settings.standardWorkMinutes || 0} phút ({((settings.standardWorkMinutes || 0) / 60).toFixed(2).replace(/\.00$/, '')}h)</span>
                  </div>
                </div>
              </div>

              <div className="holiday-settings-shift-pills">
                {shiftOptions.map(shift => (
                  <button
                    key={shift.id}
                    type="button"
                    className={`btn${selectedShiftId === shift.id ? ' btn-primary' : ''}`}
                    onClick={() => setSelectedShiftId(shift.id)}
                  >
                    {shift.name} ({shift.standardCheckIn}–{shift.standardCheckOut})
                  </button>
                ))}
                <button type="button" className="btn" onClick={addShift}>+ Thêm ca</button>
              </div>

              {!Object.values(ATTENDANCE_SHIFT_IDS).includes(selectedShiftId) && (
                <button type="button" className="btn" onClick={removeSelectedShift}>Xóa ca đang chọn</button>
              )}
              <p className="holiday-settings-split-note">
                Với file DEOCA, Ca 1/Ca 2 là nhãn ở cuối đường dẫn “Bộ phận”. Nếu làm cùng giờ cả ngày, chọn dùng giờ Ca Hành chính khi nhập file. Chỉ thêm ca riêng khi giờ thực tế khác.
                {Object.keys(settings.deocaShiftAliases || {}).length > 0 && (
                  <><br />Đang dùng chung giờ: {Object.entries(settings.deocaShiftAliases)
                    .map(([name, shiftId]) => `${name} → ${settings.shifts[shiftId]?.name || shiftId}`)
                    .join(', ')}.</>
                )}
              </p>

              <div className="holiday-settings-grid">
                <label>
                  <span>Tên ca</span>
                  <input
                    type="text"
                    value={selectedShift?.name || ''}
                    onChange={event => updateSelectedShift('name', event.target.value)}
                  />
                </label>
                <label>
                  <span>Giờ vào chuẩn</span>
                  <input
                    type="time"
                    value={selectedShift?.standardCheckIn || ''}
                    onChange={event => updateSelectedShift('standardCheckIn', event.target.value)}
                  />
                </label>
                <label>
                  <span>Giờ ra chuẩn</span>
                  <input
                    type="time"
                    value={selectedShift?.standardCheckOut || ''}
                    onChange={event => updateSelectedShift('standardCheckOut', event.target.value)}
                  />
                </label>
                <label>
                  <span>Chuẩn ngày công (phút)</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={settings.standardWorkMinutes ?? ''}
                    onChange={event => setSettings(current => ({
                      ...current,
                      standardWorkMinutes: Number(event.target.value),
                      shifts: { ...current.shifts, administrative: { ...current.shifts.administrative,
                        standardWorkMinutes: Number(event.target.value) } }
                    }))}
                  />
                </label>
                <label>
                  <span>Phút nghỉ không tính công</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={settings.unpaidBreakMinutes || 0}
                    onChange={event => setSettings(current => ({
                      ...current,
                      unpaidBreakMinutes: Number(event.target.value),
                      shifts: { ...current.shifts, administrative: { ...current.shifts.administrative,
                        unpaidBreakMinutes: Number(event.target.value) } }
                    }))}
                  />
                </label>
                <label><span>Chuẩn công ca này (phút)</span><input type="number" min="1" value={selectedShift?.standardWorkMinutes ?? ''} onChange={event => updateSelectedShift('standardWorkMinutes', Number(event.target.value))} /></label>
                <label><span>Công đủ ca</span><input type="number" min="0.01" step="0.05" value={selectedShift?.workUnit ?? 1} onChange={event => updateSelectedShift('workUnit', Number(event.target.value))} /></label>
                <label><span>Nghỉ không tính của ca (phút)</span><input type="number" min="0" value={selectedShift?.unpaidBreakMinutes ?? 0} onChange={event => updateSelectedShift('unpaidBreakMinutes', Number(event.target.value))} /></label>
              </div>

              <details className="holiday-settings-split-card">
                <summary>Quy tắc tính công nâng cao</summary>
                <div className="holiday-settings-grid">
                  <label><span>Cặp Vào/Ra bắt buộc mỗi ngày</span><input type="number" min="1" step="1" value={settings.requiredPunchPairs} onChange={event => setSettings(current => ({ ...current, requiredPunchPairs: Number(event.target.value) }))} /></label>
                  <label><span>Khi thiếu lượt chấm</span><select value={settings.missingPunchPolicy} onChange={event => setSettings(current => ({ ...current, missingPunchPolicy: event.target.value }))}>
                    <option value="zero">0 công</option><option value="partial">Tính cặp đủ</option><option value="manual_review">Cần duyệt tay</option><option value="use_first_last">Dùng lần đầu/cuối</option>
                  </select></label>
                  <label><span>Cách quy đổi công</span><select value={settings.workUnitCalculationMode} onChange={event => setSettings(current => ({ ...current,
                    workUnitCalculationMode: event.target.value,
                    splitShiftEnabled: event.target.value === 'split_shift',
                    shifts: { ...current.shifts, administrative: { ...current.shifts.administrative,
                      splitShift: { ...current.shifts.administrative.splitShift, enabled: event.target.value === 'split_shift' } } }
                  }))}>
                    <option value="proportional">Theo tỷ lệ phút</option><option value="split_shift">Theo buổi</option><option value="fixed_shift">Đủ ca</option><option value="imported">Theo dữ liệu nhập</option>
                  </select></label>
                  <label><span>Công chuẩn</span><input type="number" min="0.01" step="0.05" value={settings.standardWorkUnit} onChange={event => setSettings(current => ({ ...current, standardWorkUnit: Number(event.target.value) }))} /></label>
                  <label><span>Công tối đa/ngày</span><input type="number" min="0.01" step="0.05" value={settings.maxWorkUnitPerDay} onChange={event => setSettings(current => ({ ...current, maxWorkUnitPerDay: Number(event.target.value) }))} /></label>
                  <label><span>Muộn miễn trừ (phút)</span><input type="number" min="0" value={settings.lateGraceMinutes} onChange={event => setSettings(current => ({ ...current, lateGraceMinutes: Number(event.target.value) }))} /></label>
                  <label><span>Sớm miễn trừ (phút)</span><input type="number" min="0" value={settings.earlyLeaveGraceMinutes} onChange={event => setSettings(current => ({ ...current, earlyLeaveGraceMinutes: Number(event.target.value) }))} /></label>
                  <label><span>Ngưỡng phạt muộn/sớm (phút)</span><input type="number" min="1" value={settings.latePenaltyThresholdMinutes} onChange={event => setSettings(current => ({ ...current, latePenaltyThresholdMinutes: Number(event.target.value) }))} /></label>
                  <label><span>Ưu tiên dữ liệu import</span><select value={settings.importPriorityMode} onChange={event => setSettings(current => ({ ...current, importPriorityMode: event.target.value }))}><option value="raw_punch">Giờ chấm thô</option><option value="imported_hours">Giờ từ file</option><option value="imported_work_unit">Công từ file</option></select></label>
                  <label><span>Ưu tiên chỉnh công tay</span><select value={settings.manualOverridePriority} onChange={event => setSettings(current => ({ ...current, manualOverridePriority: event.target.value }))}><option value="none">Không cho phép</option><option value="allowed">Khi chưa có công</option><option value="highest">Luôn ưu tiên</option></select></label>
                  <label><span>Bắt đầu OT</span><input type="text" placeholder="shift_end hoặc HH:mm" value={settings.overtimeStart} onChange={event => setSettings(current => ({ ...current, overtimeStart: event.target.value }))} /></label>
                  <label><span>OT tối thiểu (phút)</span><input type="number" min="0" value={settings.overtimeMinMinutes} onChange={event => setSettings(current => ({ ...current, overtimeMinMinutes: Number(event.target.value) }))} /></label>
                  <label><span>Bước làm tròn OT (phút)</span><input type="number" min="1" value={settings.overtimeRoundingMinutes} onChange={event => setSettings(current => ({ ...current, overtimeRoundingMinutes: Number(event.target.value) }))} /></label>
                  <label><span>Kiểu làm tròn OT</span><select value={settings.overtimeRoundMode} onChange={event => setSettings(current => ({ ...current, overtimeRoundMode: event.target.value }))}><option value="floor">Xuống</option><option value="nearest">Gần nhất</option><option value="ceil">Lên</option></select></label>
                </div>
                <label className="holiday-settings-check"><input type="checkbox" checked={settings.allowOvernightShift === true} onChange={event => setSettings(current => ({ ...current, allowOvernightShift: event.target.checked }))} />Cho phép ca qua đêm</label>
              </details>

              <div className="holiday-settings-split-card">
                <label className="holiday-settings-check holiday-settings-split-toggle">
                  <input
                    type="checkbox"
                    checked={selectedShift?.splitShift?.enabled === true}
                    onChange={event => toggleSelectedSplitShift(event.target.checked)}
                  />
                  <span>
                    <strong>Bật chia ca thành 2 buổi</strong>
                    <small>Chỉ tính phút nằm trong khung từng buổi. Đi muộn hoặc về sớm làm giảm công buổi đó theo tỷ lệ; khoảng nghỉ giữa hai buổi không tính công.</small>
                  </span>
                </label>

                {selectedShift?.splitShift?.enabled && (
                  <>
                    <div className="holiday-settings-session-grid">
                      {[
                        { key: 'morning', label: 'Buổi sáng' },
                        { key: 'afternoon', label: 'Buổi chiều' }
                      ].map(session => (
                        <div className="holiday-settings-session" key={session.key}>
                          <h3>{session.label}</h3>
                          <label>
                            <span>Bắt đầu</span>
                            <input
                              type="time"
                              value={selectedShift.splitShift[session.key]?.start || ''}
                              onChange={event => updateSelectedSplitSession(session.key, 'start', event.target.value)}
                            />
                          </label>
                          <label>
                            <span>Kết thúc</span>
                            <input
                              type="time"
                              value={selectedShift.splitShift[session.key]?.end || ''}
                              onChange={event => updateSelectedSplitSession(session.key, 'end', event.target.value)}
                            />
                          </label>
                          <label>
                            <span>Công tối đa</span>
                            <input
                              type="number"
                              min="0.01"
                              max="1"
                              step="0.05"
                              value={selectedShift.splitShift[session.key]?.workdays ?? 0.5}
                              onChange={event => updateSelectedSplitSession(
                                session.key,
                                'workdays',
                                Number(event.target.value)
                              )}
                            />
                          </label>
                        </div>
                      ))}
                    </div>
                    <p className="holiday-settings-split-note">
                      Các mốc giờ và công tối đa có thể sửa riêng cho từng ca. Một hoặc nhiều cặp Vào/Ra đều được giới hạn trong giờ từng buổi; nếu thiếu một lượt chấm thì dùng khoảng từ Vào đầu đến Ra cuối. Khoảng nghỉ giữa hai buổi tự được loại, không trừ thêm ở mục “Phút nghỉ không tính công”.
                    </p>
                  </>
                )}
              </div>

              <label className="holiday-settings-check">
                <input
                  type="checkbox"
                  checked={settings.overtime?.autoCalculate !== false}
                  onChange={event => setSettings(current => ({
                    ...current,
                    overtimeEnabled: event.target.checked,
                    overtime: { ...(current.overtime || {}), autoCalculate: event.target.checked }
                  }))}
                />
                Tự động tính tăng ca sau giờ kết thúc ca (HR có thể tắt để tự đánh dấu Excel)
              </label>
              <div className="holiday-settings-save-row">
                {hasUnsavedChanges && <span>Các thay đổi ca chưa được lưu.</span>}
                <button type="button" className="btn btn-primary" onClick={saveSettings} disabled={saving}>
                  <i className="fas fa-save"></i> {saving ? 'Đang lưu...' : 'Lưu cài đặt ca'}
                </button>
              </div>
              {error && <div className="holiday-settings-alert is-error" role="alert">{error}</div>}
            </>
          )}
        </section>
      )}

      {activeTab === 'penalties' && (
        <section className="holiday-settings-card" role="tabpanel">
          <div className="holiday-settings-penalty-toolbar">
            <button type="button" className="btn" onClick={addPenaltyCategory} disabled={loading}>
              <i className="fas fa-plus"></i> Thêm nội dung phạt
            </button>
            <button type="button" className="btn" onClick={resetPenaltyCategories} disabled={loading}>
              Khôi phục mặc định
            </button>
          </div>
          <label className="holiday-settings-check">
            <span>Số lần nghỉ đột xuất miễn phạt mỗi tháng</span>
            <input type="number" min="0" step="1" value={settings.penaltyRules?.emergencyLeaveFreeCount ?? 2}
              onChange={event => setSettings(current => ({ ...current,
                penaltyRules: { ...current.penaltyRules, emergencyLeaveFreeCount: Number(event.target.value) } }))} />
          </label>

          {loading ? (
            <div className="holiday-settings-empty">Đang tải cài đặt...</div>
          ) : (
            <div className="holiday-settings-penalty-list">
              <div className="holiday-settings-penalty-head">
                <span>Nội dung phạt</span>
                <span>Mức phạt (đ)</span>
                <span></span>
              </div>
              {penaltyCategories.map(item => (
                <div className="holiday-settings-penalty-row" key={item.key}>
                  <input
                    type="text"
                    value={item.label}
                    placeholder="Ví dụ: Đi muộn"
                    onChange={event => updatePenaltyCategory(item.key, 'label', event.target.value)}
                  />
                  <input
                    type="number"
                    min="0"
                    step="1000"
                    value={item.amount}
                    onChange={event => updatePenaltyCategory(item.key, 'amount', Math.max(0, Number(event.target.value || 0)))}
                  />
                  <button
                    type="button"
                    className="btn btn-icon"
                    title="Xóa hạng mục"
                    onClick={() => removePenaltyCategory(item.key)}
                    disabled={penaltyCategories.length <= 1}
                  >
                    <i className="fas fa-trash"></i>
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

export default HolidaySettings
