import { useEffect, useState } from 'react'
import { supabase } from '../services/supabase'
import { fbGet } from '../services/firebase'
import { requireTenantCompanyId } from '../services/tenantSession'
import { mapAppToUser, runUsersMutationWithSchemaFallback } from '../utils/helpers'
import {
  ATTENDANCE_SHIFT_IDS,
  DEFAULT_ATTENDANCE_SHIFT,
  getAttendanceShiftOptions
} from '../utils/attendanceShift'

const DEFAULT_EMPLOYEE_SHIFT_OPTIONS = getAttendanceShiftOptions()

function normalizeFiles(files = []) {
  return (files || []).map((file, idx) => {
    if (typeof file === 'string') {
      return { name: `Giấy tờ ${idx + 1}`, url: file, attachments: [] }
    }
    const attachments = Array.isArray(file.attachments)
      ? file.attachments.filter(item => item?.data).map(item => ({
          name: item.name || 'Tệp đính kèm',
          data: item.data,
          type: item.type || ''
        }))
      : (file.data
          ? [{ name: file.fileName || file.name || 'Tệp đính kèm', data: file.data, type: file.type || '' }]
          : [])
    return {
      name: file.name || `Giấy tờ ${idx + 1}`,
      url: file.url || file.link || '',
      attachments
    }
  })
}

/** Dropdown chọn sẵn hoặc nhập giá trị mới */
function SelectOrCreateField({
  label,
  name,
  value,
  options = [],
  onChange,
  disabled = false,
  placeholder = 'Nhập giá trị mới...'
}) {
  const knownOptions = [...new Set(options.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'))
  const isKnownValue = !value || knownOptions.includes(value)
  const [customMode, setCustomMode] = useState(!isKnownValue && !!value)

  useEffect(() => {
    const known = !value || knownOptions.includes(value)
    setCustomMode(!known && !!value)
  }, [value, knownOptions.join('|')])

  const handleSelectChange = (e) => {
    const next = e.target.value
    if (next === '__new__') {
      setCustomMode(true)
      onChange({ target: { name, value: '' } })
      return
    }
    setCustomMode(false)
    onChange({ target: { name, value: next } })
  }

  if (disabled) {
    return (
      <div className="form-group">
        <label>{label}</label>
        <input type="text" name={name} value={value || ''} disabled />
      </div>
    )
  }

  return (
    <div className="form-group">
      <label>{label}</label>
      {!customMode ? (
        <select
          name={name}
          value={value || ''}
          onChange={handleSelectChange}
        >
          <option value="">-- Chọn {label.toLowerCase()} --</option>
          {knownOptions.map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
          <option value="__new__">+ Nhập mới...</option>
        </select>
      ) : (
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            name={name}
            value={value || ''}
            onChange={onChange}
            placeholder={placeholder}
            autoFocus
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="btn"
            title="Chọn từ danh sách"
            onClick={() => {
              setCustomMode(false)
              onChange({ target: { name, value: '' } })
            }}
            style={{ whiteSpace: 'nowrap', padding: '8px 10px' }}
          >
            <i className="fas fa-list"></i>
          </button>
        </div>
      )}
    </div>
  )
}

function getFileIcon(file) {
  const type = (file.type || '').toLowerCase()
  const name = (file.name || '').toLowerCase()
  if (type.includes('pdf') || name.endsWith('.pdf')) return 'fa-file-pdf'
  if (type.includes('word') || type.includes('document') || name.endsWith('.doc') || name.endsWith('.docx')) {
    return 'fa-file-word'
  }
  if (type.includes('image') || /\.(png|jpe?g|gif|webp)$/i.test(name)) return 'fa-file-image'
  return 'fa-file-alt'
}

function EmployeeModal({
  companyId: requestedCompanyId,
  employee,
  isOpen,
  onClose,
  onSave,
  readOnly = false,
  departmentOptions = [],
  positionOptions = []
}) {
  const companyId = requireTenantCompanyId(requestedCompanyId)
  const [activeTab, setActiveTab] = useState('info')
  const [editingReadOnly, setEditingReadOnly] = useState(false)
  const [formData, setFormData] = useState({
    ho_va_ten: '',
    employeeId: '',
    email: '',
    sđt: '',
    chi_nhanh: 'HCM',
    bo_phan: '',
    vi_tri: '',
    trang_thai: 'Thử việc',
    ca_lam_viec: DEFAULT_ATTENDANCE_SHIFT.name,
    ngay_vao_lam: '',
    ngay_lam_chinh_thuc: '',
    cccd: '',
    ngay_cap: '',
    noi_cap: '',
    dia_chi_thuong_tru: '',
    que_quan: '',
    ngay_sinh: '',
    gioi_tinh: '',
    tinh_trang_hon_nhan: '',
    avatarDataUrl: '',
    images: [],
    files: [],
    role: 'user',
    password: '',
    passwordConfirm: ''
  })
  const [avatarPreview, setAvatarPreview] = useState('')
  const [imagesPreview, setImagesPreview] = useState([])
  const [filesPreview, setFilesPreview] = useState([])
  const [showPassword, setShowPassword] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [hasExistingPassword, setHasExistingPassword] = useState(false)
  const [employeeShiftOptions, setEmployeeShiftOptions] = useState(DEFAULT_EMPLOYEE_SHIFT_OPTIONS)
  const [shiftOptionsError, setShiftOptionsError] = useState('')

  useEffect(() => {
    if (!isOpen) return undefined
    let cancelled = false
    fbGet('hr/attendanceSettings/default', companyId)
      .then(settings => {
        if (cancelled) return
        const options = getAttendanceShiftOptions(settings)
        setEmployeeShiftOptions(options)
        setShiftOptionsError('')
        if (!employee) {
          const defaultShift = options.find(option => option.id === ATTENDANCE_SHIFT_IDS.ADMINISTRATIVE)
          if (defaultShift) {
            setFormData(previous => previous.ca_lam_viec === DEFAULT_ATTENDANCE_SHIFT.name
              ? { ...previous, ca_lam_viec: defaultShift.name } : previous)
          }
        }
      })
      .catch(() => {
        if (!cancelled) setShiftOptionsError('Không tải được danh sách ca của công ty.')
      })
    return () => { cancelled = true }
  }, [companyId, employee, isOpen])

  const [avatarUrlInput, setAvatarUrlInput] = useState('')
  const [galleryUrlInput, setGalleryUrlInput] = useState('')

  const generateEmployeeId = () => {
    const nextId = `NV${Date.now().toString().slice(-6)}`
    setFormData(prev => ({ ...prev, employeeId: nextId }))
  }

  useEffect(() => {
    if (!isOpen) return
    setActiveTab('info')
    setEditingReadOnly(false)
    setShowPassword(false)
    setPasswordError('')

    if (employee) {
      const normalizedFiles = normalizeFiles(employee.files || employee.documents || [])
      const initialDocs = normalizedFiles.length > 0
        ? normalizedFiles
        : (readOnly ? [] : [{ name: '', url: '', attachments: [] }])
      setHasExistingPassword(Boolean(employee.password || employee.hasPassword))
      setFormData({
        ho_va_ten: employee.ho_va_ten || '',
        employeeId: employee.employeeId || '',
        email: employee.email || '',
        sđt: employee.sđt || employee.sdt || '',
        chi_nhanh: employee.chi_nhanh || 'HCM',
        bo_phan: employee.bo_phan || '',
        vi_tri: employee.vi_tri || '',
        // Hồ sơ đã tồn tại nhưng chưa được HR đánh dấu phải hiển thị trống;
        // chỉ hồ sơ tạo mới mới dùng trạng thái khởi tạo Thử việc.
        trang_thai: employee.trang_thai ?? employee.employmentStatus ?? employee.employment_status ?? employee.status ?? '',
        ca_lam_viec: employee.ca_lam_viec || DEFAULT_ATTENDANCE_SHIFT.name,
        ngay_vao_lam: employee.ngay_vao_lam || '',
        ngay_lam_chinh_thuc: employee.ngay_lam_chinh_thuc || '',
        cccd: employee.cccd || '',
        ngay_cap: employee.ngay_cap || '',
        noi_cap: employee.noi_cap || '',
        dia_chi_thuong_tru: employee.dia_chi_thuong_tru || '',
        que_quan: employee.que_quan || '',
        ngay_sinh: employee.ngay_sinh || employee.dob || '',
        gioi_tinh: employee.gioi_tinh || '',
        tinh_trang_hon_nhan: employee.tinh_trang_hon_nhan || '',
        avatarDataUrl: employee.avatarDataUrl || employee.avatarUrl || employee.avatar || '',
        images: employee.images || [],
        files: initialDocs,
        role: employee.role || 'user',
        password: '',
        passwordConfirm: ''
      })

      const initialAvatar = employee.avatarDataUrl || employee.avatarUrl || employee.avatar || ''
      setAvatarPreview(initialAvatar)
      if (initialAvatar.startsWith('http')) {
        setAvatarUrlInput(initialAvatar)
      } else {
        setAvatarUrlInput('')
      }

      setImagesPreview(employee.images || [])
      setFilesPreview(initialDocs)

      if (employee.id && employee.hasPassword === undefined) {
        supabase
          .from('users')
          .select('password')
          .eq('id', employee.id)
          .eq('company_id', companyId)
          .maybeSingle()
          .then(({ data }) => {
            setHasExistingPassword(Boolean(data?.password))
          })
          .catch(() => {})
      }
    } else {
      resetForm()
      generateEmployeeId()
      setHasExistingPassword(false)
      setFormData(prev => ({ ...prev, password: '123456', passwordConfirm: '123456' }))
    }
  }, [employee, isOpen, readOnly, companyId])

  const resetForm = () => {
    const emptyDoc = [{ name: '', url: '', attachments: [] }]
    setFormData({
      ho_va_ten: '',
      employeeId: '',
      email: '',
      sđt: '',
      chi_nhanh: 'HCM',
      bo_phan: '',
      vi_tri: '',
      trang_thai: 'Thử việc',
      ca_lam_viec: DEFAULT_ATTENDANCE_SHIFT.name,
      ngay_vao_lam: '',
      ngay_lam_chinh_thuc: '',
      cccd: '',
      ngay_cap: '',
      noi_cap: '',
      dia_chi_thuong_tru: '',
      que_quan: '',
      ngay_sinh: '',
      gioi_tinh: '',
      tinh_trang_hon_nhan: '',
      avatarDataUrl: '',
      images: [],
      files: emptyDoc,
      role: 'user',
      password: '123456',
      passwordConfirm: '123456'
    })
    setAvatarPreview('')
    setImagesPreview([])
    setFilesPreview(emptyDoc)
    setAvatarUrlInput('')
    setGalleryUrlInput('')
    setActiveTab('info')
    setEditingReadOnly(false)
    setShowPassword(false)
    setPasswordError('')
    setHasExistingPassword(false)
  }

  const editable = !readOnly || editingReadOnly

  const startAddDocuments = () => {
    setEditingReadOnly(true)
    setActiveTab('documents')
    if (filesPreview.length === 0) {
      syncDocuments([{ name: '', url: '', attachments: [] }])
    } else if (getFilledDocuments().length === filesPreview.length) {
      // đã có giấy tờ đầy đủ → thêm 1 dòng trống để nhập tiếp
      syncDocuments([...filesPreview, { name: '', url: '', attachments: [] }])
    }
  }

  const syncDocuments = (docs) => {
    setFilesPreview(docs)
    setFormData(prev => ({ ...prev, files: docs }))
  }

  const handleChange = (e) => {
    const { name, value } = e.target
    setFormData({
      ...formData,
      [name]: value
    })
    if (name === 'password' || name === 'passwordConfirm') {
      setPasswordError('')
    }
  }

  const resetPasswordDefault = () => {
    setFormData(prev => ({
      ...prev,
      password: '123456',
      passwordConfirm: '123456'
    }))
    setPasswordError('')
    setShowPassword(true)
  }

  const validatePasswordFields = () => {
    const pwd = (formData.password || '').trim()
    const confirm = (formData.passwordConfirm || '').trim()
    const isCreate = !(employee && employee.id)

    if (isCreate) {
      if (!pwd) {
        setPasswordError('Vui lòng nhập mật khẩu đăng nhập')
        return null
      }
      if (pwd.length < 4) {
        setPasswordError('Mật khẩu tối thiểu 4 ký tự')
        return null
      }
      if (pwd !== confirm) {
        setPasswordError('Xác nhận mật khẩu không khớp')
        return null
      }
      return pwd
    }

    // Sửa: để trống = giữ nguyên mật khẩu cũ
    if (!pwd && !confirm) return undefined
    if (!pwd) {
      setPasswordError('Vui lòng nhập mật khẩu mới')
      return null
    }
    if (pwd.length < 4) {
      setPasswordError('Mật khẩu tối thiểu 4 ký tự')
      return null
    }
    if (pwd !== confirm) {
      setPasswordError('Xác nhận mật khẩu không khớp')
      return null
    }
    return pwd
  }

  const handleAvatarChange = async (e) => {
    const file = e.target.files[0]
    if (!file) return

    if (file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = (ev) => {
        const dataUrl = ev.target.result
        setAvatarPreview(dataUrl)
        setFormData({ ...formData, avatarDataUrl: dataUrl })
      }
      reader.readAsDataURL(file)
    }
  }

  const handleImagesChange = async (e) => {
    const files = Array.from(e.target.files)
    const newImages = []

    for (const file of files) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader()
        reader.onload = (ev) => {
          newImages.push(ev.target.result)
          if (newImages.length === files.length) {
            setImagesPreview([...imagesPreview, ...newImages])
            setFormData({
              ...formData,
              images: [...formData.images, ...newImages]
            })
          }
        }
        reader.readAsDataURL(file)
      }
    }
  }

  const addDocumentRow = () => {
    syncDocuments([...filesPreview, { name: '', url: '', attachments: [] }])
  }

  const updateDocumentRow = (index, field, value) => {
    const next = filesPreview.map((doc, i) => (
      i === index ? { ...doc, [field]: value } : doc
    ))
    syncDocuments(next)
  }

  const handleRowFileUpload = (index, e) => {
    const selectedFiles = Array.from(e.target.files || [])
    if (selectedFiles.length === 0) return

    Promise.all(selectedFiles.map(file => new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = (ev) => resolve({
        name: file.name,
        data: ev.target.result,
        type: file.type
      })
      reader.onerror = reject
      reader.readAsDataURL(file)
    }))).then((newAttachments) => {
      const next = filesPreview.map((doc, i) => (
        i === index
          ? {
              ...doc,
              attachments: [...(doc.attachments || []), ...newAttachments]
            }
          : doc
      ))
      syncDocuments(next)
    })
    e.target.value = ''
  }

  const removeRowAttachment = (rowIndex, attachmentIndex) => {
    const next = filesPreview.map((doc, i) => (
      i === rowIndex
        ? {
            ...doc,
            attachments: (doc.attachments || []).filter((_, fileIndex) => fileIndex !== attachmentIndex)
          }
        : doc
    ))
    syncDocuments(next)
  }

  const openDocument = (file) => {
    if (file.url) {
      window.open(file.url, '_blank', 'noopener,noreferrer')
      return
    }
    if (file.data) {
      const link = document.createElement('a')
      link.href = file.data
      link.download = file.name || 'document'
      link.target = '_blank'
      link.click()
    }
  }

  const removeImage = (index) => {
    const newImages = imagesPreview.filter((_, i) => i !== index)
    setImagesPreview(newImages)
    setFormData({ ...formData, images: newImages })
  }

  const removeDocumentRow = (index) => {
    const next = filesPreview.filter((_, i) => i !== index)
    syncDocuments(next.length > 0 ? next : [{ name: '', url: '', attachments: [] }])
  }

  const getFilledDocuments = () => filesPreview.filter(doc =>
    (doc.name && doc.name.trim()) || doc.url || (doc.attachments || []).length > 0
  )

  const processImageUrl = (url) => {
    if (!url) return ''

    const driveRegex = /\/d\/([^/?]+)|id=([^&]+)/
    const match = url.match(driveRegex)

    if (match) {
      const id = match[1] || match[2]
      if (id) {
        return `https://lh3.googleusercontent.com/d/${id}`
      }
    }

    return url
  }

  const handleAvatarUrlChange = (e) => {
    const rawUrl = e.target.value
    setAvatarUrlInput(rawUrl)

    const displayUrl = processImageUrl(rawUrl)
    setAvatarPreview(displayUrl)
    setFormData({ ...formData, avatarDataUrl: displayUrl })
  }

  const handleAddGalleryUrl = () => {
    if (!galleryUrlInput) return

    const displayUrl = processImageUrl(galleryUrlInput)
    const newImages = [...imagesPreview, displayUrl]
    setImagesPreview(newImages)
    setFormData({
      ...formData,
      images: [...formData.images, displayUrl]
    })
    setGalleryUrlInput('')
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (readOnly && !editingReadOnly) return

    const nextPassword = validatePasswordFields()
    if (nextPassword === null) {
      setActiveTab('info')
      return
    }

    try {
      const oldStatus = employee ? (employee.trang_thai || employee.status || '') : ''
      const newStatus = formData.trang_thai
      const filledDocs = getFilledDocuments()
      const payloadForm = { ...formData, files: filledDocs }
      delete payloadForm.password
      delete payloadForm.passwordConfirm

      if (employee && employee.id) {
        const dbPayload = { ...mapAppToUser(payloadForm), company_id: companyId }
        if (nextPassword) {
          dbPayload.password = nextPassword
        }
        if (!employee.profileComplete) {
          delete dbPayload.documents
          delete dbPayload.images
        }
        const mutationResult = await runUsersMutationWithSchemaFallback(
          (payload) => supabase
            .from('users')
            .update(payload)
            .eq('id', employee.id)
            .eq('company_id', companyId),
          dbPayload
        )
        const { error } = mutationResult

        if (error) throw error

        if (editable && oldStatus !== newStatus) {
          const historyPayload = {
            company_id: companyId,
            employee_id: employee.id,
            employee_code: employee.employeeId || '',
            employee_name: formData.ho_va_ten || employee.ho_va_ten || '',
            new_status: newStatus,
            old_status: oldStatus,
            effective_date: new Date().toISOString().split('T')[0],
            actor: 'HR',
            note: 'Cập nhật trạng thái nhân sự'
          }

          const { error: historyError } = await supabase
            .from('employee_status_history')
            .insert([historyPayload])

          if (historyError) {
            console.error('Error logging status history:', historyError)
          }
        }
      } else {
        if (readOnly) return
        if ('id' in formData) delete formData.id

        const dbPayload = { ...mapAppToUser(payloadForm), company_id: companyId }
        dbPayload.password = nextPassword || '123456'
        dbPayload.id = crypto.randomUUID()

        const mutationResult = await runUsersMutationWithSchemaFallback(
          (payload) => supabase
            .from('users')
            .insert([payload]),
          dbPayload
        )
        const { error } = mutationResult

        if (error) throw error
      }
      onSave()
      onClose()
      resetForm()
    } catch (error) {
      alert('Lỗi khi lưu: ' + error.message)
    }
  }

  if (!isOpen) return null

  const getTitle = () => {
    if (readOnly && !editingReadOnly) return 'Chi tiết hồ sơ nhân viên'
    return employee ? 'Sửa nhân viên' : 'Thêm nhân viên mới'
  }

  return (
    <div className="modal show" onClick={onClose}>
      <div className="modal-content modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>
            <i className={readOnly && !editingReadOnly ? 'fas fa-eye' : 'fas fa-user'}></i>
            {' '}
            {getTitle()}
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {readOnly && !editingReadOnly && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => setEditingReadOnly(true)}
              >
                <i className="fas fa-pen"></i>
                {' '}Sửa hồ sơ
              </button>
            )}
            <button className="modal-close" onClick={onClose}>&times;</button>
          </div>
        </div>
        <div className="modal-body">
          <div className="modal-tabs">
            <button
              type="button"
              className={`tab-btn ${activeTab === 'info' ? 'active' : ''}`}
              onClick={() => setActiveTab('info')}
            >
              <i className="fas fa-id-card"></i>
              Thông tin
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'documents' ? 'active' : ''}`}
              onClick={() => setActiveTab('documents')}
            >
              <i className="fas fa-folder-open"></i>
              Giấy tờ liên quan
              {getFilledDocuments().length > 0 && (
                <span style={{
                  background: 'var(--primary)',
                  color: '#fff',
                  borderRadius: '999px',
                  padding: '1px 8px',
                  fontSize: '0.75rem'
                }}>
                  {getFilledDocuments().length}
                </span>
              )}
            </button>
          </div>

          <form onSubmit={handleSubmit}>
            {activeTab === 'info' && (
              <>
                {!editable ? (
                  <div className="employee-profile-header">
                    {avatarPreview ? (
                      <img
                        src={avatarPreview}
                        alt={formData.ho_va_ten || 'Avatar'}
                        className="employee-profile-avatar"
                      />
                    ) : (
                      <div className="employee-profile-avatar placeholder">
                        <i className="fas fa-user"></i>
                      </div>
                    )}
                    <div className="employee-profile-meta">
                      <h4>{formData.ho_va_ten || '—'}</h4>
                      <p><strong>Mã NV:</strong> {formData.employeeId || '—'}</p>
                      <p><strong>Vị trí:</strong> {formData.vi_tri || '—'} {formData.bo_phan ? `· ${formData.bo_phan}` : ''}</p>
                      <p><strong>Trạng thái:</strong> {formData.trang_thai || '—'}</p>
                      <p>
                        <strong>Vai trò:</strong>{' '}
                        {formData.role === 'admin'
                          ? 'Quản trị viên'
                          : formData.role === 'hr'
                            ? 'Nhân sự (HR)'
                            : formData.role === 'manager'
                              ? 'Quản lý'
                              : formData.role === 'accountant'
                                ? 'Kế toán'
                              : 'Nhân viên'}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="form-group">
                    <label>Ảnh đại diện</label>
                    {avatarPreview && (
                      <div className="employee-avatar-preview-wrap">
                        <img
                          src={avatarPreview}
                          alt="Avatar"
                          className="employee-avatar-preview"
                        />
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleAvatarChange}
                      />
                      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.9em', color: '#666' }}>Hoặc nhập link ảnh:</span>
                        <input
                          type="text"
                          placeholder="https://example.com/avatar.jpg"
                          value={avatarUrlInput}
                          onChange={handleAvatarUrlChange}
                          style={{ flex: 1 }}
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div className="form-row">
                  <div className="form-group">
                    <label>Mã nhân viên *</label>
                    <input
                      type="text"
                      name="employeeId"
                      value={formData.employeeId}
                      onChange={handleChange}
                      placeholder="Hệ thống tự tạo (VD: NV001)"
                      required
                      disabled={!editable}
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>Họ và tên *</label>
                    <input
                      type="text"
                      name="ho_va_ten"
                      value={formData.ho_va_ten}
                      onChange={handleChange}
                      required
                      disabled={!editable}
                    />
                  </div>
                  <div className="form-group">
                    <label>Email đăng nhập</label>
                    <input
                      type="email"
                      name="email"
                      value={formData.email}
                      onChange={handleChange}
                      disabled={!editable}
                      placeholder="dùng để đăng nhập hệ thống"
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>Vai trò *</label>
                    <select
                      name="role"
                      value={formData.role || 'user'}
                      onChange={handleChange}
                      disabled={!editable}
                    >
                      <option value="user">Nhân viên</option>
                      <option value="hr">Nhân sự (HR)</option>
                      <option value="manager">Quản lý</option>
                      <option value="accountant">Kế toán</option>
                      <option value="admin">Quản trị viên</option>
                    </select>
                  </div>
                </div>

                <div className="emp-password-box">
                  <div className="emp-password-box__head">
                    <div>
                      <strong>Quản trị mật khẩu</strong>
                      <p>
                        {employee?.id
                          ? (hasExistingPassword
                              ? 'Tài khoản đã có mật khẩu. Để trống nếu không đổi.'
                              : 'Chưa có mật khẩu — nhập mật khẩu mới bên dưới.')
                          : 'Mật khẩu mặc định khi tạo mới: 123456 (có thể đổi).'}
                      </p>
                    </div>
                    {employee?.id && (
                      <span className={`emp-password-badge ${hasExistingPassword ? 'is-set' : 'is-empty'}`}>
                        {hasExistingPassword ? 'Đã thiết lập' : 'Chưa có'}
                      </span>
                    )}
                  </div>

                  {!editable ? (
                    <div className="form-row">
                      <div className="form-group">
                        <label>Mật khẩu</label>
                        <input type="password" value="********" disabled readOnly />
                      </div>
                      <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
                        <small className="text-muted">Nhấn “Sửa hồ sơ” để đổi / đặt lại mật khẩu</small>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="form-row">
                        <div className="form-group">
                          <label>
                            {employee?.id ? 'Mật khẩu mới' : 'Mật khẩu *'}
                          </label>
                          <div className="emp-password-input">
                            <input
                              type={showPassword ? 'text' : 'password'}
                              name="password"
                              value={formData.password}
                              onChange={handleChange}
                              placeholder={employee?.id ? 'Để trống nếu giữ nguyên' : 'Nhập mật khẩu'}
                              autoComplete="new-password"
                              required={!employee?.id}
                            />
                            <button
                              type="button"
                              className="emp-password-toggle"
                              onClick={() => setShowPassword(v => !v)}
                              title={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                            >
                              <i className={`fas ${showPassword ? 'fa-eye-slash' : 'fa-eye'}`}></i>
                            </button>
                          </div>
                        </div>
                        <div className="form-group">
                          <label>Xác nhận mật khẩu{!employee?.id ? ' *' : ''}</label>
                          <input
                            type={showPassword ? 'text' : 'password'}
                            name="passwordConfirm"
                            value={formData.passwordConfirm}
                            onChange={handleChange}
                            placeholder="Nhập lại mật khẩu"
                            autoComplete="new-password"
                            required={!employee?.id}
                          />
                        </div>
                      </div>
                      <div className="emp-password-actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={resetPasswordDefault}
                        >
                          <i className="fas fa-key"></i> Đặt lại mặc định (123456)
                        </button>
                        {passwordError && (
                          <span className="emp-password-error">{passwordError}</span>
                        )}
                      </div>
                    </>
                  )}
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>SĐT</label>
                    <input
                      type="text"
                      name="sđt"
                      value={formData.sđt}
                      onChange={handleChange}
                      disabled={!editable}
                    />
                  </div>
                  <div className="form-group">
                    <label>Chi nhánh</label>
                    <select
                      name="chi_nhanh"
                      value={formData.chi_nhanh}
                      onChange={handleChange}
                      disabled={!editable}
                    >
                      <option value="HCM">HCM</option>
                      <option value="Hà Nội">Hà Nội</option>
                    </select>
                  </div>
                </div>

                <div className="form-row">
                  <SelectOrCreateField
                    label="Bộ phận"
                    name="bo_phan"
                    value={formData.bo_phan}
                    options={departmentOptions}
                    onChange={handleChange}
                    disabled={!editable}
                    placeholder="Nhập bộ phận mới..."
                  />
                  <SelectOrCreateField
                    label="Vị trí"
                    name="vi_tri"
                    value={formData.vi_tri}
                    options={positionOptions}
                    onChange={handleChange}
                    disabled={!editable}
                    placeholder="Nhập vị trí mới..."
                  />
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>Trạng thái</label>
                    <select
                      name="trang_thai"
                      value={formData.trang_thai}
                      onChange={handleChange}
                      disabled={!editable}
                    >
                      <option value="Thử việc">Thử việc</option>
                      <option value="Chính thức">Chính thức</option>
                      <option value="Tạm nghỉ">Tạm nghỉ</option>
                      <option value="Nghỉ việc">Nghỉ việc</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Ca làm việc</label>
                    <select
                      name="ca_lam_viec"
                      value={formData.ca_lam_viec}
                      onChange={handleChange}
                      disabled={!editable}
                    >
                      {formData.ca_lam_viec && !employeeShiftOptions.some(shift => shift.name === formData.ca_lam_viec) && (
                        <option value={formData.ca_lam_viec}>{formData.ca_lam_viec} (dữ liệu cũ)</option>
                      )}
                      {employeeShiftOptions.map(shift => (
                        <option key={shift.name} value={shift.name}>
                          {shift.name} ({shift.standardCheckIn} - {shift.standardCheckOut})
                        </option>
                      ))}
                    </select>
                    {shiftOptionsError && <small className="text-danger">{shiftOptionsError}</small>}
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>Ngày vào làm</label>
                    <input
                      type="date"
                      name="ngay_vao_lam"
                      value={formData.ngay_vao_lam}
                      onChange={handleChange}
                      disabled={!editable}
                    />
                  </div>
                  <div className="form-group">
                    <label>Ngày làm chính thức</label>
                    <input
                      type="date"
                      name="ngay_lam_chinh_thuc"
                      value={formData.ngay_lam_chinh_thuc}
                      onChange={handleChange}
                      disabled={!editable}
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>CCCD/CMND</label>
                    <input
                      type="text"
                      name="cccd"
                      value={formData.cccd}
                      onChange={handleChange}
                      placeholder="Số CCCD/CMND"
                      disabled={!editable}
                    />
                  </div>
                  <div className="form-group">
                    <label>Ngày cấp</label>
                    <input
                      type="date"
                      name="ngay_cap"
                      value={formData.ngay_cap}
                      onChange={handleChange}
                      disabled={!editable}
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>Nơi cấp</label>
                    <input
                      type="text"
                      name="noi_cap"
                      value={formData.noi_cap}
                      onChange={handleChange}
                      placeholder="Nơi cấp CCCD/CMND"
                      disabled={!editable}
                    />
                  </div>
                  <div className="form-group">
                    <label>Quê quán</label>
                    <input
                      type="text"
                      name="que_quan"
                      value={formData.que_quan}
                      onChange={handleChange}
                      placeholder="Quê quán"
                      disabled={!editable}
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>Địa chỉ thường trú</label>
                    <input
                      type="text"
                      name="dia_chi_thuong_tru"
                      value={formData.dia_chi_thuong_tru}
                      onChange={handleChange}
                      placeholder="Địa chỉ thường trú"
                      disabled={!editable}
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>Ngày sinh</label>
                    <input
                      type="date"
                      name="ngay_sinh"
                      value={formData.ngay_sinh}
                      onChange={handleChange}
                      disabled={!editable}
                    />
                  </div>
                  <div className="form-group">
                    <label>Giới tính</label>
                    <select
                      name="gioi_tinh"
                      value={formData.gioi_tinh}
                      onChange={handleChange}
                      disabled={!editable}
                    >
                      <option value="">-- Chọn giới tính --</option>
                      <option value="Nam">Nam</option>
                      <option value="Nữ">Nữ</option>
                      <option value="Khác">Khác</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Tình trạng hôn nhân</label>
                    <select
                      name="tinh_trang_hon_nhan"
                      value={formData.tinh_trang_hon_nhan}
                      onChange={handleChange}
                      disabled={!editable}
                    >
                      <option value="">-- Chọn tình trạng --</option>
                      <option value="Độc thân">Độc thân</option>
                      <option value="Đã kết hôn">Đã kết hôn</option>
                      <option value="Ly hôn">Ly hôn</option>
                      <option value="Khác">Khác</option>
                    </select>
                  </div>
                </div>

                <div className="form-group">
                  <label>Ảnh đính kèm</label>
                  {imagesPreview.length > 0 ? (
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
                      {imagesPreview.map((img, idx) => (
                        <div key={idx} style={{ position: 'relative' }}>
                          <img
                            src={img}
                            alt={`Preview ${idx}`}
                            style={{
                              width: '80px',
                              height: '80px',
                              objectFit: 'cover',
                              borderRadius: '4px'
                            }}
                          />
                          {editable && (
                            <button
                              type="button"
                              onClick={() => removeImage(idx)}
                              style={{
                                position: 'absolute',
                                top: '4px',
                                right: '4px',
                                background: 'var(--danger)',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '4px',
                                padding: '2px 6px',
                                cursor: 'pointer'
                              }}
                            >
                              ×
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    !editable && <p style={{ color: '#64748b', margin: '0 0 8px' }}>Chưa có ảnh đính kèm</p>
                  )}
                  {editable && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        onChange={handleImagesChange}
                      />
                      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                        <input
                          type="text"
                          placeholder="Nhập link ảnh..."
                          value={galleryUrlInput}
                          onChange={(e) => setGalleryUrlInput(e.target.value)}
                          style={{ flex: 1 }}
                        />
                        <button
                          type="button"
                          className="btn"
                          onClick={handleAddGalleryUrl}
                          style={{ padding: '8px 15px', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                        >
                          Thêm
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {activeTab === 'documents' && (
              <>
                {!editable ? (
                  <>
                    {getFilledDocuments().length > 0 ? (
                      <div className="document-list">
                        {getFilledDocuments().map((file, idx) => (
                          <div key={idx} className="document-item">
                            <div className="document-item-info">
                              <i className={`fas ${getFileIcon(file)}`} style={{ color: '#2563eb' }}></i>
                              <div style={{ minWidth: 0 }}>
                                <span style={{ display: 'block', fontWeight: 600 }}>{file.name || `Giấy tờ ${idx + 1}`}</span>
                                {(file.url || (file.attachments || []).length > 0) && (
                                  <span style={{ display: 'block', fontSize: '0.82rem', color: '#64748b' }}>
                                    {file.url || `${file.attachments.length} file đã tải lên`}
                                  </span>
                                )}
                              </div>
                            </div>
                            {(file.url || (file.attachments || []).length > 0) && (
                              <div className="document-item-actions">
                                {file.url && (
                                  <button type="button" className="btn" onClick={() => openDocument(file)} title="Mở link">
                                    <i className="fas fa-external-link-alt"></i>
                                  </button>
                                )}
                                {(file.attachments || []).map((attachment, attachmentIndex) => (
                                  <button
                                    key={attachmentIndex}
                                    type="button"
                                    className="btn"
                                    onClick={() => openDocument(attachment)}
                                    title={`Tải xuống ${attachment.name}`}
                                  >
                                    <i className="fas fa-download"></i>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="document-empty">
                        <i className="fas fa-folder-open" style={{ fontSize: '1.5rem', marginBottom: '8px', display: 'block' }}></i>
                        Chưa có giấy tờ liên quan
                      </div>
                    )}
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={startAddDocuments}
                      style={{ marginTop: '14px' }}
                    >
                      <i className="fas fa-plus"></i>
                      {' '}Thêm giấy tờ
                    </button>
                  </>
                ) : (
                  <div className="document-rows">
                    <div className="document-rows__head">
                      <span>Tên giấy tờ</span>
                      <span>Link / File</span>
                      <span></span>
                    </div>
                    {filesPreview.map((doc, idx) => (
                      <div key={idx} className="document-row">
                        <div className="document-row__name">
                          <i className={`fas ${getFileIcon(doc)}`}></i>
                          <input
                            type="text"
                            placeholder="VD: CCCD, HĐLĐ..."
                            value={doc.name || ''}
                            onChange={(e) => updateDocumentRow(idx, 'name', e.target.value)}
                          />
                        </div>
                        <div className="document-row__file">
                          <input
                            type="text"
                            placeholder="https://drive.google.com/..."
                            value={doc.url || ''}
                            onChange={(e) => updateDocumentRow(idx, 'url', e.target.value)}
                          />
                          <label className="btn document-row__upload" title="Tải lên một hoặc nhiều file">
                            <i className="fas fa-upload"></i>
                            <input
                              type="file"
                              multiple
                              onChange={(e) => handleRowFileUpload(idx, e)}
                              style={{ display: 'none' }}
                            />
                          </label>
                          {(doc.attachments || []).length > 0 && (
                            <div className="document-row__attachments">
                              {doc.attachments.map((attachment, attachmentIndex) => (
                                <span className="document-row__attachment" key={`${attachment.name}-${attachmentIndex}`}>
                                  <i className={`fas ${getFileIcon(attachment)}`}></i>
                                  <span title={attachment.name}>{attachment.name}</span>
                                  <button
                                    type="button"
                                    title={`Xóa ${attachment.name}`}
                                    onClick={() => removeRowAttachment(idx, attachmentIndex)}
                                  >
                                    <i className="fas fa-times"></i>
                                  </button>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          className="btn document-row__remove"
                          title="Xóa dòng"
                          onClick={() => removeDocumentRow(idx)}
                        >
                          <i className="fas fa-trash"></i>
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={addDocumentRow}
                      style={{ alignSelf: 'flex-start', marginTop: '4px' }}
                    >
                      <i className="fas fa-plus"></i>
                      {' '}Thêm dòng
                    </button>
                    <p className="document-rows__hint">
                      <i className="fas fa-circle-info"></i>
                      Mỗi dòng có thể nhập link và tải lên nhiều file cùng lúc. Bấm “Thêm dòng” để thêm giấy tờ mới.
                    </p>
                  </div>
                )}
              </>
            )}

            <div className="form-actions" style={{ marginTop: '20px', display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={onClose}>
                {readOnly && !editingReadOnly ? 'Đóng' : 'Hủy'}
              </button>
              {editable && (
                <button type="submit" className="btn btn-primary">
                  <i className="fas fa-save"></i>
                  Lưu
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

export default EmployeeModal
