import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import CompanyLogo from '../components/CompanyLogo'
import { GENERIC_HR_NAME, companyLogoSource } from '../utils/companyBrand'
import { isAccountingUser, isCoreStaffUser } from '../utils/staffAccess'
import './Login.css'

function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const { login } = useAuth()
  const brandName = GENERIC_HR_NAME
  const brandLogoUrl = null
  const navigate = useNavigate()
  const location = useLocation()
  const from = location.state?.from?.pathname || '/'

  useEffect(() => {
    document.title = brandName
    const icon = document.querySelector('link[rel="icon"]')
    if (icon) icon.href = companyLogoSource(brandLogoUrl)
  }, [brandName, brandLogoUrl])

  const handleLogin = async event => {
    event.preventDefault()
    setError('')
    setLoading(true)
    try {
      const cleanEmail = email.trim()
      const cleanPassword = password.trim()
      const profile = await login(cleanEmail, cleanPassword)
      if (isAccountingUser(profile) && !isCoreStaffUser(profile)) {
        const target = ['/bang-cong-preview', '/holiday-settings', '/cham-cong-online'].includes(from)
          ? from
          : '/bang-cong-preview'
        navigate(target, { replace: true })
        return
      }
      if (profile?.role === 'user') {
        navigate('/bang-cong', { replace: true })
        return
      }
      if (isCoreStaffUser(profile)) {
        const target = ['/', '/bang-cong', '/cham-cong-online'].includes(from) ? '/employees' : from
        navigate(target, { replace: true })
        return
      }
      setError('Tài khoản chưa được cấp quyền sử dụng hệ thống.')
    } catch (loginError) {
      console.error('Login error:', loginError)
      const msg = loginError?.message || ''
      if (msg.includes('Invalid login credentials')) {
        setError('Email hoặc mật khẩu không chính xác. Hãy kiểm tra lại mật khẩu (chú ý tắt tự động điền mật khẩu cũ).')
      } else if (msg) {
        setError(msg)
      } else {
        setError('Email hoặc mật khẩu không chính xác.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="system-login">
      <section className="system-login__form-panel">
        <div className="system-login__form-wrap">
          <div className="system-login__intro">
            <CompanyLogo logoUrl={brandLogoUrl} alt="" />
            <h1>Đăng nhập hệ thống</h1>
            <p>{brandName}</p>
          </div>

          {error && <div className="system-login__error"><i className="fas fa-exclamation-circle"></i><span>{error}</span></div>}

          <form onSubmit={handleLogin}>
            <label className="system-login__field">
              <span>Email</span>
              <div><i className="fas fa-envelope"></i><input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="email@congty.vn" autoComplete="username" required /></div>
            </label>
            <label className="system-login__field">
              <span>Mật khẩu</span>
              <div style={{ position: 'relative' }}>
                <i className="fas fa-lock"></i>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                  style={{ paddingRight: '40px' }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{
                    position: 'absolute',
                    right: '10px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: '#64748b',
                    fontSize: '0.95rem'
                  }}
                  title={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                >
                  <i className={`fas ${showPassword ? 'fa-eye-slash' : 'fa-eye'}`}></i>
                </button>
              </div>
            </label>
            <button className="system-login__submit" type="submit" disabled={loading}>
              {loading ? <><i className="fas fa-spinner fa-spin"></i> Đang kết nối...</> : <>Đăng nhập <i className="fas fa-arrow-right"></i></>}
            </button>
          </form>

          <p className="system-login__employee-link">Nhân viên có thể đăng nhập tại đây hoặc <Link to="/employee-login">mở trang nhân viên</Link>.</p>
        </div>
        <footer>© {new Date().getFullYear()} {brandName}</footer>
      </section>

      <aside className="system-login__branding" aria-label={brandName}>
        <div className="system-login__branding-content">
          <div className="system-login__brand-logo"><CompanyLogo logoUrl={brandLogoUrl} alt="" /></div>
          <h2>{brandName}</h2>
          <p className="system-login__slogan">QUẢN LÝ NHÂN SỰ</p>
          <div className="system-login__accent"></div>
          <p className="system-login__description">Hệ thống quản lý nhân sự tập trung, chuyên nghiệp và hiệu quả.</p>
        </div>
      </aside>
    </main>
  )
}

export default Login
