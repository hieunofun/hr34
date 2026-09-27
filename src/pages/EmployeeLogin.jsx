import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useCompany } from '../contexts/CompanyContext'
import CompanyLogo from '../components/CompanyLogo'
import { companyDisplayName, companyLogoSource } from '../utils/companyBrand'
import './EmployeeLogin.css'

function EmployeeLogin() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { login, logout } = useAuth()
  const { companyName, logoUrl } = useCompany()
  const brandName = companyDisplayName(companyName)
  const navigate = useNavigate()

  useEffect(() => {
    document.title = `${brandName} · HR`
    const icon = document.querySelector('link[rel="icon"]')
    if (icon) icon.href = companyLogoSource(logoUrl)
  }, [brandName, logoUrl])

  const handleSubmit = async (event) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const profile = await login(email.trim(), password)
      if (!profile || profile.role !== 'user') {
        await logout()
        setError('Vui lòng sử dụng trang đăng nhập quản trị cho tài khoản này')
        return
      }
      navigate('/bang-cong', { replace: true })
    } catch (loginError) {
      console.error('Employee login error:', loginError)
      setError('Email hoặc mật khẩu không chính xác')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="employee-login">
      <section className="employee-login__card">
        <CompanyLogo logoUrl={logoUrl} alt="" />
        <h1>Đăng nhập nhân viên</h1>
        <p>{brandName} · Đăng nhập để xem Bảng công của bạn</p>
        {error && <div className="employee-login__error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <label><span>Email nhân viên</span><input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="email@congty.vn" autoComplete="username" required /></label>
          <label><span>Mật khẩu</span><input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Nhập mật khẩu" autoComplete="current-password" required /></label>
          <button type="submit" disabled={loading}>{loading ? 'Đang đăng nhập...' : 'Đăng nhập'}</button>
        </form>
        <Link to="/login">Đăng nhập quản trị</Link>
      </section>
    </main>
  )
}

export default EmployeeLogin
