import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../services/supabase'
import './Requests.css'

async function requestApi(method, body) {
  const { data: { session }, error } = await supabase.auth.getSession()
  if (error || !session?.access_token) throw new Error('Phiên đăng nhập đã hết hạn.')
  const response = await fetch('/api/employee-requests', {
    method,
    headers: { Authorization: `Bearer ${session.access_token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || 'Không xử lý được yêu cầu.')
  return payload
}

const statusLabel = { pending: 'Đang chờ duyệt', approved: 'Đã duyệt', rejected: 'Không duyệt' }

export default function Requests() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [kind, setKind] = useState('leave')
  const [subject, setSubject] = useState('')
  const [content, setContent] = useState('')
  const [leaveStartDate, setLeaveStartDate] = useState('')
  const [leaveEndDate, setLeaveEndDate] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await requestApi('GET')
      setRequests(result.requests || [])
      setError('')
    } catch (loadError) { setError(loadError.message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const submit = async event => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await requestApi('POST', { kind, subject, content, leaveStartDate, leaveEndDate })
      setSubject('')
      setContent('')
      setLeaveStartDate('')
      setLeaveEndDate('')
      await load()
    } catch (submitError) { setError(submitError.message) }
    finally { setBusy(false) }
  }
  const decide = async (id, status) => {
    setBusy(true)
    setError('')
    try { await requestApi('PATCH', { id, status }); await load() }
    catch (decisionError) { setError(decisionError.message) }
    finally { setBusy(false) }
  }

  return <div className="requests-page">
    <header className="requests-page__header">
      <div><h1>{isAdmin ? 'Duyệt yêu cầu nhân viên' : 'Đơn nghỉ & đề xuất'}</h1>
        <p>{isAdmin ? 'Yêu cầu của nhân viên trong công ty' : 'Gửi yêu cầu và theo dõi trạng thái của bạn'}</p></div>
      <button type="button" className="btn" onClick={load} disabled={loading || busy}>Làm mới</button>
    </header>
    {error && <div role="alert" className="requests-page__error">{error}</div>}
    {!isAdmin && <form className="requests-page__form card" onSubmit={submit}>
      <h2>Tạo yêu cầu</h2>
      <label>Loại yêu cầu
        <select value={kind} onChange={event => setKind(event.target.value)}>
          <option value="leave">Đơn nghỉ phép</option><option value="proposal">Đề xuất</option>
        </select>
      </label>
      <label>Tiêu đề
        <input value={subject} onChange={event => setSubject(event.target.value)} maxLength={160} required />
      </label>
      {kind === 'leave' && <div className="requests-page__dates">
        <label>Từ ngày<input type="date" value={leaveStartDate}
          onChange={event => setLeaveStartDate(event.target.value)} required /></label>
        <label>Đến ngày<input type="date" value={leaveEndDate} min={leaveStartDate}
          onChange={event => setLeaveEndDate(event.target.value)} required /></label>
      </div>}
      <label>Nội dung
        <textarea value={content} onChange={event => setContent(event.target.value)}
          rows={4} maxLength={3000} required />
      </label>
      <button type="submit" className="btn btn-primary" disabled={busy}>Gửi yêu cầu</button>
    </form>}
    <section className="requests-page__list">
      <h2>{isAdmin ? 'Danh sách yêu cầu' : 'Yêu cầu của tôi'}</h2>
      {loading ? <p>Đang tải...</p> : requests.length === 0 ? <p>Chưa có yêu cầu.</p>
        : requests.map(item => <article className="card requests-page__item" key={item.id}>
          <div className="requests-page__item-head"><strong>{item.subject}</strong>
            <span className={`requests-page__status requests-page__status--${item.status}`}>
              {statusLabel[item.status] || item.status}</span></div>
          <small>{item.kind === 'leave' ? 'Đơn nghỉ phép' : 'Đề xuất'}
            {isAdmin ? ` · ${item.requesterName || 'Nhân viên'}` : ''}
            {item.leaveStartDate ? ` · ${item.leaveStartDate} → ${item.leaveEndDate}` : ''}</small>
          <p>{item.content}</p>
          {isAdmin && item.status === 'pending' && <div className="requests-page__actions">
            <button type="button" className="btn btn-primary" disabled={busy}
              onClick={() => decide(item.id, 'approved')}>Duyệt</button>
            <button type="button" className="btn" disabled={busy}
              onClick={() => decide(item.id, 'rejected')}>Không duyệt</button>
          </div>}
        </article>)}
    </section>
  </div>
}
