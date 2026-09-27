import { useEffect, useState } from 'react'
import { companyLogoSource, GENERIC_HR_LOGO } from '../utils/companyBrand'

export default function CompanyLogo({ logoUrl, alt = '', ...props }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [logoUrl])
  return <img {...props} src={failed ? GENERIC_HR_LOGO : companyLogoSource(logoUrl)} alt={alt} onError={() => setFailed(true)} />
}
