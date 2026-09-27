import { createContext, useContext, useMemo } from 'react'

const CompanyContext = createContext(null)

export function CompanyProvider({ company, loading, children }) {
  const value = useMemo(() => ({
    companyId: company?.id || null,
    companyCode: company?.code || '',
    companyName: company?.name || '',
    logoUrl: company?.logo_url || null,
    company: company || null,
    loading
  }), [company, loading])

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>
}

export function useCompany() {
  const context = useContext(CompanyContext)
  if (!context) throw new Error('useCompany phải được gọi bên trong CompanyProvider.')
  return context
}
