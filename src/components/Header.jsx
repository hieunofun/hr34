
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

function Header() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const displayName = user?.ho_va_ten || user?.email || 'Người dùng'
  const initial = displayName.trim().charAt(0).toUpperCase() || 'N'
  const handleLogout = async () => {
    await logout()
    navigate(user?.role === 'user' ? '/employee-login' : '/login', { replace: true })
  }
  return (
    <header className="header">
      <div className="logo">
        <img src="/hr-logo.svg" alt="HR34" />
        <h1>DEOCA <span>HR</span></h1>
      </div>
      <div className="user-info">
        <span>{displayName}</span>
        <div style={{
          width: '40px',
          height: '40px',
          borderRadius: '50%',
          background: '#0047ab',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontWeight: 'bold'
        }}>
          {initial}
        </div>
        <button className="btn btn-sm" onClick={handleLogout} title="Đăng xuất"><i className="fas fa-sign-out-alt"></i></button>
      </div>
    </header>
  )
}

export default Header
