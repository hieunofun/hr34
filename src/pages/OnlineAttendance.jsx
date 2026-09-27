import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useCompany } from '../contexts/CompanyContext'
import { supabase } from '../services/supabase'
import { fbGet, fbUpdate, fbGetAttendanceByEmployee } from '../services/firebase'
import { uploadToCloudinary, getCloudinaryConfig, saveCloudinaryConfig } from '../utils/cloudinary'
import {
  applyCalculatedAttendanceTiming,
  ATTENDANCE_SHIFT_IDS,
  attendanceTimeToMinutes,
  buildAttendanceShiftSettingsPayload,
  calculateAttendanceTiming,
  getAttendanceShiftOptions,
  normalizeAttendanceShiftSettings,
  resolveAttendanceShift
} from '../utils/attendanceShift'
import './OnlineAttendance.css'

const getTime = value => {
  if (!value) return '—'
  const direct = String(value).match(/^(\d{1,2}):(\d{2})/)
  if (direct) return `${direct[1].padStart(2, '0')}:${direct[2]}`
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' })
}

const formatDateTimeNow = (timeValue, dateStr) => {
  if (!timeValue) return '—'
  const dateObj = new Date(timeValue)
  if (!Number.isNaN(dateObj.getTime())) {
    return dateObj.toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    })
  }
  if (dateStr && /^\d{1,2}:\d{2}/.test(String(timeValue))) {
    const [y, m, d] = dateStr.split('-')
    return `${timeValue} ${d}/${m}/${y}`
  }
  return String(timeValue)
}

const displayDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return value || '—'
  const [year, month, day] = value.split('-')
  return `${day}/${month}/${year}`
}

function OnlineAttendance() {
  const { user } = useAuth()
  const { companyId } = useCompany()
  const isAdminOrManager = user?.role === 'admin' || user?.role === 'hr' || user?.role === 'manager'
  const [today, setToday] = useState(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [settingsError, setSettingsError] = useState('')

  // 1. Đồng hồ thời gian thực
  const [currentTime, setCurrentTime] = useState(new Date())

  // 2. Định vị GPS
  const [location, setLocation] = useState(null)
  const [locationLoading, setLocationLoading] = useState(false)
  const [locationError, setLocationError] = useState('')

  // 3. Chụp ảnh & Tải ảnh Cloudinary
  const [photoPreview, setPhotoPreview] = useState(null)
  const [isCameraActive, setIsCameraActive] = useState(false)
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const fileInputRef = useRef(null)

  // 4. Cài đặt ca làm việc & Cloudinary
  const [showShiftModal, setShowShiftModal] = useState(false)
  const [attendanceSettings, setAttendanceSettings] = useState(() => normalizeAttendanceShiftSettings())
  const [shiftDrafts, setShiftDrafts] = useState(() => normalizeAttendanceShiftSettings())
  const [selectedShiftId, setSelectedShiftId] = useState(ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE)
  const [cloudNameInput, setCloudNameInput] = useState('')
  const [cloudPresetInput, setCloudPresetInput] = useState('')

  // 5. Lịch sử chấm công (List) & Bộ lọc tháng
  const [historyLogs, setHistoryLogs] = useState([])
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })

  const loadHistory = useCallback(async () => {
    const empId = user?.id || user?.auth_user_id
    if (!empId) return
    try {
      const data = await fbGetAttendanceByEmployee(empId)
      if (data) {
        const list = Object.entries(data).map(([id, val]) =>
          applyCalculatedAttendanceTiming({ ...val, id }, user, attendanceSettings)
        )
        list.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
        setHistoryLogs(list)
      }
    } catch (e) {
      console.warn('Lỗi tải lịch sử chấm công:', e)
    }
  }, [attendanceSettings, user])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  // Danh sách các tháng có dữ liệu
  const availableMonths = useMemo(() => {
    const currentMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
    const set = new Set([currentMonth])
    historyLogs.forEach(log => {
      const ym = String(log.date || '').slice(0, 7)
      if (/^\d{4}-\d{2}$/.test(ym)) set.add(ym)
    })
    return Array.from(set).sort().reverse()
  }, [historyLogs])

  // Lọc log theo tháng đã chọn
  const filteredLogs = useMemo(() => {
    if (!selectedMonth) return historyLogs
    return historyLogs.filter(log => String(log.date || '').startsWith(selectedMonth))
  }, [historyLogs, selectedMonth])

  // Cập nhật đồng hồ mỗi giây
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Tải cài đặt ca và Cloudinary ban đầu
  useEffect(() => {
    fbGet('hr/attendanceSettings/default', companyId)
      .then(settings => {
        const normalized = normalizeAttendanceShiftSettings(settings)
        setAttendanceSettings(normalized)
        setShiftDrafts(normalized)
        setSettingsError('')
      })
      .catch(() => setSettingsError('Không tải được chính sách chấm công của công ty. Giờ ca hiển thị có thể là giá trị mặc định.'))

    const { cloudName, uploadPreset } = getCloudinaryConfig()
    setCloudNameInput(cloudName)
    setCloudPresetInput(uploadPreset)
  }, [companyId])

  // Hàm lấy vị trí GPS
  const getCurrentLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationError('Trình duyệt không hỗ trợ định vị GPS')
      return
    }
    setLocationLoading(true)
    setLocationError('')
    navigator.geolocation.getCurrentPosition(
      pos => {
        setLocation({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
          timestamp: new Date().toISOString()
        })
        setLocationLoading(false)
      },
      err => {
        setLocationError(`Không thể lấy vị trí: ${err.message}`)
        setLocationLoading(false)
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    )
  }, [])

  // Tự động lấy vị trí khi vào trang
  useEffect(() => {
    getCurrentLocation()
  }, [getCurrentLocation])

  // Camera management
  const startCamera = async () => {
    setIsCameraActive(true)
    setPhotoPreview(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
      }
    } catch (err) {
      setError(`Không thể bật camera: ${err.message}. Bạn có thể chọn tải ảnh từ máy tính.`)
      setIsCameraActive(false)
    }
  }

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }
    setIsCameraActive(false)
  }

  const capturePhoto = () => {
    if (!videoRef.current) return
    const canvas = document.createElement('canvas')
    canvas.width = videoRef.current.videoWidth || 640
    canvas.height = videoRef.current.videoHeight || 480
    const ctx = canvas.getContext('2d')
    ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
    setPhotoPreview(dataUrl)
    stopCamera()
  }

  const handleFilePhoto = e => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setPhotoPreview(reader.result)
      stopCamera()
    }
    reader.readAsDataURL(file)
  }

  // Tải dữ liệu chấm công hôm nay
  const loadToday = useCallback(async () => {
    setLoading(true)
    setError('')
    const { data, error: requestError } = await supabase.rpc('get_online_attendance_today')
    if (requestError) {
      setError(requestError.message)
    } else {
      setToday(data)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadToday()
  }, [loadToday])

  const record = today?.record || null
  const checkedIn = Boolean(record?.checkIn || record?.vao)
  const checkedOut = Boolean(record?.checkOut || record?.ra)
  const userShift = useMemo(
    () => resolveAttendanceShift(user, record || {}, attendanceSettings),
    [attendanceSettings, record, user]
  )
  const standardIn = userShift.start
  const standardOut = userShift.end

  // Tính số phút đi muộn / về sớm thời gian thực
  const calcTimingStatus = () => {
    const stdInMinutes = attendanceTimeToMinutes(standardIn)
    const stdOutMinutes = attendanceTimeToMinutes(standardOut)
    const timing = calculateAttendanceTiming({ employee: user, log: record || {}, attendanceSettings })

    // Nếu đã check-in
    let checkInStatus = null
    if (checkedIn) {
      if (timing.hasCheckIn) {
        if (timing.lateMinutes > 0) {
          checkInStatus = { isLate: true, text: `Đi muộn ${timing.lateMinutes} phút`, class: 'badge-danger' }
        } else {
          const actualInMinutes = attendanceTimeToMinutes(record?.vao || record?.checkIn)
          const earlyArrival = stdInMinutes === null || actualInMinutes === null
            ? 0 : Math.max(0, stdInMinutes - actualInMinutes)
          checkInStatus = { isLate: false, text: earlyArrival ? `Đúng giờ (Sớm ${earlyArrival}p)` : 'Đúng giờ', class: 'badge-success' }
        }
      }
    } else {
      // Chưa check-in -> so sánh thời gian hiện tại
      const nowMinutes = currentTime.getHours() * 60 + currentTime.getMinutes()
      if (stdInMinutes !== null) {
        const potentialLateMinutes = Math.max(0, nowMinutes - stdInMinutes)
        if (potentialLateMinutes > attendanceSettings.lateGraceMinutes) {
          checkInStatus = { isLate: true, text: `Muộn ${potentialLateMinutes}p nếu check-in lúc này`, class: 'badge-warning' }
        } else {
          checkInStatus = { isLate: false, text: 'Check-in đúng giờ', class: 'badge-success' }
        }
      }
    }

    // Check-out status
    let checkOutStatus = null
    if (checkedOut) {
      if (timing.hasCheckOut) {
        if (timing.earlyMinutes > 0) {
          checkOutStatus = { isEarly: true, text: `Về sớm ${timing.earlyMinutes} phút`, class: 'badge-warning' }
        } else {
          const actualOutMinutes = attendanceTimeToMinutes(record?.ra || record?.checkOut)
          const afterShift = stdOutMinutes === null || actualOutMinutes === null
            ? 0 : Math.max(0, actualOutMinutes - stdOutMinutes)
          checkOutStatus = { isEarly: false, text: afterShift ? `Đúng giờ (Sau ca ${afterShift}p)` : 'Đúng giờ', class: 'badge-success' }
        }
      }
    }

    return { checkInStatus, checkOutStatus }
  }

  const { checkInStatus, checkOutStatus } = calcTimingStatus()

  // Nộp chấm công (Check-in hoặc Check-out)
  const submit = async action => {
    if (submitting) return
    setSubmitting(true)
    setError('')
    setNotice('')

    try {
      // 1. Upload ảnh lên Cloudinary nếu có ảnh
      let uploadedPhotoUrl = ''
      if (photoPreview) {
        uploadedPhotoUrl = await uploadToCloudinary(photoPreview)
      }

      // 2. Gọi RPC chấm công của hệ thống
      const functionName = action === 'in' ? 'employee_online_check_in' : 'employee_online_check_out'
      const { data, error: requestError } = await supabase.rpc(functionName)

      if (requestError) {
        throw new Error(requestError.message)
      }

      // 3. Cập nhật thêm ảnh Cloudinary và tọa độ GPS vào bản ghi
      if (uploadedPhotoUrl || location) {
        try {
          const recordDate = data?.date || new Date().toISOString().slice(0, 10)
          const recordId = `online_${user.id || user.auth_user_id}_${recordDate.replace(/-/g, '')}`
          const patch = {}
          if (action === 'in') {
            if (uploadedPhotoUrl) patch.checkInPhoto = uploadedPhotoUrl
            if (location) patch.checkInLocation = location
          } else {
            if (uploadedPhotoUrl) patch.checkOutPhoto = uploadedPhotoUrl
            if (location) patch.checkOutLocation = location
          }
          await fbUpdate(`hr/attendanceLogs/${recordId}`, patch)
        } catch (updateErr) {
          console.warn('Lưu ảnh/vị trí phụ:', updateErr.message)
        }
      }

      // 4. Cập nhật state giao diện
      setToday(current => ({
        ...current,
        ...data,
        record: {
          ...(current?.record || {}),
          ...(data?.record || {}),
          [action === 'in' ? 'checkInPhoto' : 'checkOutPhoto']: uploadedPhotoUrl,
          [action === 'in' ? 'checkInLocation' : 'checkOutLocation']: location
        }
      }))

      setPhotoPreview(null)
      stopCamera()
      setNotice(action === 'in' ? '✓ Check-in thành công kèm ảnh & vị trí!' : '✓ Check-out thành công!')
      loadHistory()
    } catch (err) {
      setError(err.message || 'Lỗi khi chấm công')
    } finally {
      setSubmitting(false)
    }
  }

  // Lưu cài đặt ca
  const saveShiftSettings = async () => {
    if (!isAdminOrManager) {
      alert('Chỉ Quản trị viên / Quản lý mới được thay đổi cài đặt ca.')
      return
    }
    const invalidShift = getAttendanceShiftOptions(shiftDrafts).find(
      shift => shift.standardCheckIn >= shift.standardCheckOut
    )
    if (invalidShift) {
      setSelectedShiftId(invalidShift.id)
      alert(`Giờ ra chuẩn của ${invalidShift.name} phải sau giờ vào chuẩn.`)
      return
    }
    try {
      const nextSettings = normalizeAttendanceShiftSettings(shiftDrafts)
      await fbUpdate(
        'hr/attendanceSettings/default',
        buildAttendanceShiftSettingsPayload(nextSettings)
      )
      saveCloudinaryConfig(cloudNameInput, cloudPresetInput)
      setAttendanceSettings(nextSettings)
      setShowShiftModal(false)
      setNotice('✓ Đã cập nhật cài đặt ca và Cloudinary thành công.')
    } catch (err) {
      alert('Lỗi lưu cài đặt: ' + err.message)
    }
  }

  const openShiftSettings = () => {
    if (!isAdminOrManager) return
    setShiftDrafts(normalizeAttendanceShiftSettings(attendanceSettings))
    setSelectedShiftId(ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE)
    setShowShiftModal(true)
  }

  const updateSelectedShift = (field, value) => {
    setShiftDrafts(current => ({
      ...current,
      shifts: {
        ...current.shifts,
        [selectedShiftId]: {
          ...current.shifts[selectedShiftId],
          [field]: value
        }
      }
    }))
  }

  const shiftOptions = getAttendanceShiftOptions(shiftDrafts)
  const selectedShift = shiftDrafts.shifts[selectedShiftId]

  const hoursStr = String(currentTime.getHours()).padStart(2, '0')
  const minutesStr = String(currentTime.getMinutes()).padStart(2, '0')
  const secondsStr = String(currentTime.getSeconds()).padStart(2, '0')
  const dayOfWeekNames = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy']
  const dateFormatted = `${dayOfWeekNames[currentTime.getDay()]}, ${currentTime.getDate().toString().padStart(2, '0')}/${(currentTime.getMonth() + 1).toString().padStart(2, '0')}/${currentTime.getFullYear()}`

  return (
    <div className="online-attendance-v2">
      {/* Header */}
      <div className="oa-header">
        <div>
          <h1>Chấm công online</h1>
          <p className="oa-subtitle">
            {user.ho_va_ten || user.name || user.email} · {dateFormatted}
          </p>
        </div>
        <div className="oa-header-actions">
          {isAdminOrManager && <button
            type="button"
            className="oa-btn-settings"
            onClick={openShiftSettings}
            title="Cài đặt ca làm việc & Cloudinary"
          >
            ⚙️ Cài đặt ca
          </button>}
          <Link className="oa-btn-view" to={isAdminOrManager ? '/bang-cong-preview' : '/bang-cong'}>
            Xem bảng công
          </Link>
        </div>
      </div>

      {/* Hero: Đồng hồ thời gian thực & Vị trí */}
      <div className="oa-dashboard-grid">
        {/* Đồng hồ số */}
        <div className="oa-clock-card">
          <div className="oa-card-label">ĐỒNG HỒ HỆ THỐNG (GIỜ VIỆT NAM)</div>
          <div className="oa-digital-clock">
            <span className="oa-digit">{hoursStr}</span>
            <span className="oa-colon">:</span>
            <span className="oa-digit">{minutesStr}</span>
            <span className="oa-colon">:</span>
            <span className="oa-digit oa-seconds">{secondsStr}</span>
          </div>
          <div className="oa-clock-date">{dateFormatted}</div>
          <div className="oa-shift-badge">
            Ca làm việc: <strong>{standardIn} - {standardOut}</strong>
          </div>
        </div>

        {/* Vị trí GPS */}
        <div className="oa-location-card">
          <div className="oa-card-label">VỊ TRÍ ĐỊNH VỊ GPS</div>
          {locationLoading ? (
            <div className="oa-loc-status is-loading">📡 Đang xác định tọa độ GPS...</div>
          ) : location ? (
            <div className="oa-loc-info">
              <div className="oa-loc-coords">
                📍 <strong>{location.latitude.toFixed(5)}° N, {location.longitude.toFixed(5)}° E</strong>
              </div>
              <div className="oa-loc-accuracy">
                Độ chính xác: ±{location.accuracy}m · <em>Vị trí hợp lệ</em>
              </div>
            </div>
          ) : (
            <div className="oa-loc-status is-error">
              {locationError || 'Chưa lấy được vị trí GPS. Hãy cho phép trình duyệt truy cập vị trí.'}
            </div>
          )}
          <button type="button" className="oa-btn-refresh-loc" onClick={getCurrentLocation}>
            🔄 Làm mới vị trí
          </button>
        </div>
      </div>

      {/* Thông báo thông điệp */}
      {settingsError && <div className="oa-alert oa-alert-danger">{settingsError}</div>}
      {error && <div className="oa-alert oa-alert-danger">{error}</div>}
      {notice && <div className="oa-alert oa-alert-success">{notice}</div>}

      {/* Trạng thái 2 cổng: Check-in & Check-out */}
      <div className="oa-punches-grid">
        {/* Cột Check-in */}
        <div className={`oa-punch-box ${checkedIn ? 'is-done' : 'is-pending'}`}>
          <div className="oa-punch-header">
            <span>GIỜ VÀO (CHECK-IN)</span>
            <span className="oa-req-time">Chuẩn: {standardIn}</span>
          </div>
          <div className="oa-punch-time">
            {checkedIn ? getTime(record?.vao || record?.checkIn) : 'Chưa chấm'}
          </div>
          <div className="oa-punch-status">
            {checkInStatus && (
              <span className={`oa-badge ${checkInStatus.class}`}>{checkInStatus.text}</span>
            )}
          </div>
          {record?.checkInPhoto && (
            <div className="oa-punch-photo-preview">
              <img src={record.checkInPhoto} alt="Ảnh Check-in" />
              <small>Ảnh xác thực check-in (Cloudinary)</small>
            </div>
          )}
        </div>

        {/* Cột Check-out */}
        <div className={`oa-punch-box ${checkedOut ? 'is-done' : checkedIn ? 'is-active' : 'is-pending'}`}>
          <div className="oa-punch-header">
            <span>GIỜ RA (CHECK-OUT)</span>
            <span className="oa-req-time">Chuẩn: {standardOut}</span>
          </div>
          <div className="oa-punch-time">
            {checkedOut ? getTime(record?.ra || record?.checkOut) : 'Chưa check-out'}
          </div>
          <div className="oa-punch-status">
            {checkOutStatus ? (
              <span className={`oa-badge ${checkOutStatus.class}`}>{checkOutStatus.text}</span>
            ) : (
              <span className="oa-badge badge-neutral">Chờ hoàn thành ca</span>
            )}
          </div>
          {record?.checkOutPhoto && (
            <div className="oa-punch-photo-preview">
              <img src={record.checkOutPhoto} alt="Ảnh Check-out" />
              <small>Ảnh xác thực check-out (Cloudinary)</small>
            </div>
          )}
        </div>
      </div>

      {/* Khu vực Tải / Chụp ảnh & Nút hành động */}
      {(!checkedIn || (checkedIn && !checkedOut)) && (
        <div className="oa-action-card">
          <h3>
            Xác thực chấm công {!checkedIn ? 'Check-in (Giờ vào)' : 'Check-out (Giờ ra)'}
          </h3>
          <p className="oa-action-desc">
            Chụp hoặc tải ảnh selfie/khuôn mặt để lưu trữ xác thực trên Cloudinary.
          </p>

          {/* Camera Viewfinder */}
          {isCameraActive && (
            <div className="oa-camera-container">
              <video ref={videoRef} autoPlay playsInline muted className="oa-video-feed" />
              <div className="oa-camera-controls">
                <button type="button" className="oa-btn-capture" onClick={capturePhoto}>
                  📸 Chụp ảnh ngay
                </button>
                <button type="button" className="oa-btn-cancel-cam" onClick={stopCamera}>
                  Đóng camera
                </button>
              </div>
            </div>
          )}

          {/* Photo Preview */}
          {photoPreview && (
            <div className="oa-preview-container">
              <img src={photoPreview} alt="Ảnh xác thực" className="oa-captured-image" />
              <div className="oa-preview-actions">
                <button type="button" className="oa-btn-retake" onClick={() => setPhotoPreview(null)}>
                  ✕ Bỏ ảnh / Chụp lại
                </button>
                <span className="oa-photo-ok">✓ Ảnh đã sẵn sàng tải lên Cloudinary</span>
              </div>
            </div>
          )}

          {/* Nút chụp ảnh hoặc upload */}
          {!isCameraActive && !photoPreview && (
            <div className="oa-photo-sources">
              <button type="button" className="oa-btn-open-cam" onClick={startCamera}>
                🎥 Bật Camera máy tính
              </button>
              <button
                type="button"
                className="oa-btn-upload-file"
                onClick={() => fileInputRef.current?.click()}
              >
                📸 Chụp / Chọn ảnh (Điện thoại)
              </button>
              <input
                type="file"
                ref={fileInputRef}
                accept="image/*"
                capture="user"
                style={{ display: 'none' }}
                onChange={handleFilePhoto}
              />
            </div>
          )}

          {/* Nút nộp Check-in / Check-out */}
          <div className="oa-submit-bar">
            {!checkedIn && (
              <button
                type="button"
                className="oa-btn-submit oa-btn-checkin"
                disabled={submitting}
                onClick={() => submit('in')}
              >
                {submitting ? 'Đang gửi dữ liệu & tải ảnh...' : 'XÁC NHẬN CHECK-IN'}
              </button>
            )}

            {checkedIn && !checkedOut && (
              <button
                type="button"
                className="oa-btn-submit oa-btn-checkout"
                disabled={submitting}
                onClick={() => submit('out')}
              >
                {submitting ? 'Đang gửi dữ liệu & tải ảnh...' : 'XÁC NHẬN CHECK-OUT'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Đã xong cả ngày */}
      {checkedIn && checkedOut && (
        <div className="oa-completed-card">
          <div className="oa-done-icon">✓</div>
          <h3>Bạn đã hoàn thành chấm công ngày hôm nay!</h3>
          <p>
            Vào: <strong>{getTime(record?.vao || record?.checkIn)}</strong> · Ra:{' '}
            <strong>{getTime(record?.ra || record?.checkOut)}</strong> · Tổng giờ:{' '}
            <strong>{record?.hours || record?.gio || 0} giờ</strong>
          </p>
        </div>
      )}

      {/* 5. Bảng Danh sách lịch sử chấm công (List theo yêu cầu của anh Công) */}
      <div className="oa-history-section">
        <div className="oa-history-header">
          <div>
            <h3>📋 Bảng danh sách chấm công (Lịch sử)</h3>
            <p className="oa-history-sub">
              Cột thời gian ghi nhận theo thời gian thực (Now: cả ngày & giờ)
            </p>
          </div>
          <div className="oa-history-filter-wrap">
            <label className="oa-month-label">
              <span>Tháng:</span>
              <select
                className="oa-month-select"
                value={selectedMonth}
                onChange={e => setSelectedMonth(e.target.value)}
              >
                {availableMonths.map(m => (
                  <option key={m} value={m}>
                    Tháng {m.split('-')[1]}/{m.split('-')[0]}
                  </option>
                ))}
              </select>
            </label>
            <span className="oa-history-count">{filteredLogs.length} ngày</span>
          </div>
        </div>

        <div className="oa-table-responsive">
          <table className="oa-history-table">
            <thead>
              <tr>
                <th>STT</th>
                <th>Ngày</th>
                <th>Thứ</th>
                <th>Time Check-in (Now)</th>
                <th>Ảnh Check-in</th>
                <th>Time Check-out (Now)</th>
                <th>Ảnh Check-out</th>
                <th>Tổng giờ</th>
                <th>Đi muộn</th>
                <th>Về sớm</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan="11" style={{ textAlign: 'center', padding: '28px', color: '#64748b' }}>
                    Chưa có lịch sử chấm công nào trong tháng {selectedMonth}.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log, idx) => {
                  const checkInFull = formatDateTimeNow(log.vao || log.checkIn, log.date)
                  const checkOutFull = formatDateTimeNow(log.ra || log.checkOut, log.date)
                  const isLate = Number(log.lateMinutes || log.vaoTre || 0) > 0
                  const isEarly = Number(log.earlyMinutes || log.raSom || 0) > 0
                  return (
                    <tr key={log.id || idx}>
                      <td>{idx + 1}</td>
                      <td><strong>{displayDate(log.date)}</strong></td>
                      <td>{log.dayOfWeek || '—'}</td>
                      <td><span className="oa-time-tag">{checkInFull}</span></td>
                      <td>
                        {log.checkInPhoto ? (
                          <a href={log.checkInPhoto} target="_blank" rel="noreferrer" title="Bấm xem ảnh Cloudinary">
                            <img src={log.checkInPhoto} alt="Ảnh vào" className="oa-table-thumb" />
                          </a>
                        ) : '—'}
                      </td>
                      <td><span className="oa-time-tag">{checkOutFull}</span></td>
                      <td>
                        {log.checkOutPhoto ? (
                          <a href={log.checkOutPhoto} target="_blank" rel="noreferrer" title="Bấm xem ảnh Cloudinary">
                            <img src={log.checkOutPhoto} alt="Ảnh ra" className="oa-table-thumb" />
                          </a>
                        ) : '—'}
                      </td>
                      <td><strong>{log.hours || log.gio || 0}h</strong></td>
                      <td>
                        {isLate ? (
                          <span className="oa-badge badge-danger">{log.lateMinutes || log.vaoTre}p</span>
                        ) : (
                          <span className="oa-badge badge-success">0p</span>
                        )}
                      </td>
                      <td>
                        {isEarly ? (
                          <span className="oa-badge badge-warning">{log.earlyMinutes || log.raSom}p</span>
                        ) : (
                          <span className="oa-badge badge-success">0p</span>
                        )}
                      </td>
                      <td>
                        <span className={`oa-badge ${isLate ? 'badge-danger' : 'badge-success'}`}>
                          {log.status || (isLate ? 'Muộn' : 'Đúng giờ')}
                        </span>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal Cài đặt ca làm việc & Cloudinary */}
      {showShiftModal && isAdminOrManager && (
        <div className="oa-modal-overlay" onClick={() => setShowShiftModal(false)}>
          <div className="oa-modal-box" onClick={e => e.stopPropagation()}>
            <div className="oa-modal-header">
              <h3>Cài đặt Ca làm việc & Cloudinary</h3>
              <button type="button" className="oa-modal-close" onClick={() => setShowShiftModal(false)}>
                ✕
              </button>
            </div>

            <div className="oa-modal-body">
              <h4>1. Cài đặt Giờ vào / Giờ ra theo ca</h4>
              <div className="oa-preset-shifts">
                {shiftOptions.map(shift => (
                  <button
                    key={shift.id}
                    type="button"
                    className={`oa-shift-chip ${selectedShiftId === shift.id ? 'is-active' : ''}`}
                    disabled={!isAdminOrManager}
                    onClick={() => setSelectedShiftId(shift.id)}
                  >
                    {shift.name} ({shift.standardCheckIn} - {shift.standardCheckOut})
                  </button>
                ))}
              </div>

              <div className="oa-form-row">
                <div className="oa-form-group">
                  <label>Giờ vào chuẩn (Bắt đầu ca)</label>
                  <input
                    type="time"
                    disabled={!isAdminOrManager}
                    value={selectedShift?.standardCheckIn || ''}
                    onChange={e => updateSelectedShift('standardCheckIn', e.target.value)}
                  />
                </div>
                <div className="oa-form-group">
                  <label>Giờ ra chuẩn (Kết thúc ca)</label>
                  <input
                    type="time"
                    disabled={!isAdminOrManager}
                    value={selectedShift?.standardCheckOut || ''}
                    onChange={e => updateSelectedShift('standardCheckOut', e.target.value)}
                  />
                </div>
              </div>

              <h4 style={{ marginTop: '20px' }}>2. Cấu hình Cloudinary (Lưu trữ ảnh online)</h4>
              <p style={{ fontSize: '13px', color: '#64748b' }}>
                Ảnh khuôn mặt chấm công sẽ tự động tải lên tài khoản Cloudinary này.
              </p>
              <div className="oa-form-group">
                <label>Cloud Name</label>
                <input
                  type="text"
                  disabled={!isAdminOrManager}
                  placeholder="Ví dụ: ksny3wwy"
                  value={cloudNameInput}
                  onChange={e => setCloudNameInput(e.target.value)}
                />
              </div>
              <div className="oa-form-group">
                <label>Upload Preset (Unsigned)</label>
                <input
                  type="text"
                  disabled={!isAdminOrManager}
                  placeholder="Ví dụ: nr5kwa0r"
                  value={cloudPresetInput}
                  onChange={e => setCloudPresetInput(e.target.value)}
                />
              </div>
            </div>

            <div className="oa-modal-footer">
              <button type="button" className="btn" onClick={() => setShowShiftModal(false)}>
                Đóng
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!isAdminOrManager}
                onClick={saveShiftSettings}
              >
                Lưu cài đặt
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default OnlineAttendance
