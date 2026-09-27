import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { supabase } from '../services/supabase'
import { loadCompanySession } from '../services/companySession'
import { setTenantSession } from '../services/tenantSession'
import { mapUserToApp } from '../utils/helpers'
import { CompanyProvider } from './CompanyContext'

const AuthContext = createContext(null)

const toIdentity = (session, authUser) => session && ({
  user: {
    ...mapUserToApp(session.profile),
    id: session.profile.id,
    authUserId: authUser.id,
    email: session.profile.email || authUser.email || ''
  },
  company: session.company
})

export function AuthProvider({ children }) {
  const [identity, setIdentity] = useState(null)
  const [loading, setLoading] = useState(true)
  const syncVersion = useRef(0)
  const loginInProgress = useRef(false)

  useEffect(() => {
    let active = true
    const syncSession = async (session) => {
      if (loginInProgress.current) return
      const version = ++syncVersion.current
      setLoading(true)
      setTenantSession(null, null)
      setIdentity(null)
      try {
        const resolved = await loadCompanySession(supabase, session?.user)
        if (active && version === syncVersion.current) {
          const nextIdentity = toIdentity(resolved, session?.user)
          setTenantSession(nextIdentity?.user?.authUserId, nextIdentity?.company?.id)
          setIdentity(nextIdentity)
        }
      } catch (error) {
        console.error('Không tải được hồ sơ đăng nhập:', error)
        if (active && version === syncVersion.current) {
          setTenantSession(null, null)
          setIdentity(null)
        }
        if (active && version === syncVersion.current && error?.code === 'TENANT_CONTEXT_INVALID') {
          await supabase.auth.signOut()
        }
      } finally {
        if (active && version === syncVersion.current) setLoading(false)
      }
    }
    supabase.auth.getSession().then(({ data }) => syncSession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange(() => {
      if (loginInProgress.current) return
      window.setTimeout(async () => {
        const { data } = await supabase.auth.getSession()
        if (active) syncSession(data.session)
      }, 0)
    })
    return () => {
      active = false
      syncVersion.current += 1
      setTenantSession(null, null)
      listener.subscription.unsubscribe()
    }
  }, [])

  const login = async (email, password) => {
    loginInProgress.current = true
    setLoading(true)
    setTenantSession(null, null)
    setIdentity(null)
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      loginInProgress.current = false
      setLoading(false)
      throw error
    }
    const version = ++syncVersion.current
    try {
      const resolved = await loadCompanySession(supabase, data.user)
      const nextIdentity = toIdentity(resolved, data.user)
      if (version === syncVersion.current) {
        setTenantSession(nextIdentity.user.authUserId, nextIdentity.company.id)
        setIdentity(nextIdentity)
      }
      return nextIdentity.user
    } catch (profileError) {
      setTenantSession(null, null)
      setIdentity(null)
      await supabase.auth.signOut()
      throw profileError
    } finally {
      loginInProgress.current = false
      if (version === syncVersion.current) setLoading(false)
    }
  }

  const logout = async () => {
    ++syncVersion.current
    setTenantSession(null, null)
    await supabase.auth.signOut()
    setIdentity(null)
    setLoading(false)
  }

  return (
    <AuthContext.Provider value={{ user: identity?.user || null, login, logout, loading }}>
      <CompanyProvider company={identity?.company || null} loading={loading}>
        {children}
      </CompanyProvider>
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
