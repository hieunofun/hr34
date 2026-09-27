import { useEffect, useState } from 'react'
import { supabase } from '../services/supabase'
import { requireTenantCompanyId } from '../services/tenantSession'

function StatusHistoryView({ companyId, employees, onDataChange }) {
    companyId = requireTenantCompanyId(companyId)
    const [logs, setLogs] = useState([])
    const [loading, setLoading] = useState(true)
    const [fromDate, setFromDate] = useState('')
    const [toDate, setToDate] = useState('')
    const [activeTab, setActiveTab] = useState('detail') // 'detail' or 'summary'

    useEffect(() => {
        loadData()
    }, [])

    const loadData = async () => {
        try {
            setLoading(true)
            setLoading(true)
            const { data, error } = await supabase
                .from('employee_status_history')
                .select('*')
                .eq('company_id', companyId)
                .order('created_at', { ascending: false })

            if (error) throw error

            const rawLogs = (data || []).map(item => ({
                id: item.id,
                employeeId: item.employee_id, // Map database column to UI expected field
                employeeCode: item.employee_code,
                employeeName: item.employee_name,
                oldStatus: item.old_status,
                newStatus: item.new_status,
                effectiveDate: item.effective_date,
                actor: item.actor,
                note: item.note,
                createdAt: item.created_at
            }))
            // Sort newest first
            // Sort manually if needed, though Supabase order() handles it
            // rawLogs.sort((a, b) => new Date(b.effectiveDate || b.createdAt || 0) - new Date(a.effectiveDate || a.createdAt || 0))
            setLogs(rawLogs)
            setLoading(false)
        } catch (error) {
            console.error('Error loading status history:', error)
            setLogs([])
            setLoading(false)
        }
    }

    const filterByDate = (items) => {
        if (!fromDate && !toDate) return items
        return items.filter(item => {
            const rawDate = item.effectiveDate || item.createdAt
            if (!rawDate) return false
            const dateStr = rawDate.substring(0, 10)
            if (fromDate && dateStr < fromDate) return false
            if (toDate && dateStr > toDate) return false
            return true
        })
    }

    const filteredLogs = filterByDate(logs)

    const summaryStats = {
        thuViec: filteredLogs.filter(l => l.newStatus === 'Thử việc').length,
        chinhThuc: filteredLogs.filter(l => l.newStatus === 'Chính thức').length,
        tamNghi: filteredLogs.filter(l => l.newStatus === 'Tạm nghỉ').length,
        nghiViec: filteredLogs.filter(l => l.newStatus === 'Nghỉ việc').length
    }

    if (loading) {
        return <div className="loadingState">Đang tải dữ liệu...</div>
    }

    return (
        <div className="status-history-view animate-fade-in">
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '20px',
                background: '#fff',
                padding: '15px',
                borderRadius: '8px',
                boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
            }}>
                <div className="tabs" style={{ display: 'flex', gap: '10px' }}>
                    <button
                        className={`tab-btn ${activeTab === 'detail' ? 'active' : ''}`}
                        onClick={() => setActiveTab('detail')}
                        style={{
                            padding: '8px 16px',
                            border: 'none',
                            background: activeTab === 'detail' ? '#e3f2fd' : 'transparent',
                            color: activeTab === 'detail' ? '#0d47a1' : '#666',
                            borderRadius: '6px',
                            fontWeight: activeTab === 'detail' ? '600' : '500',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px'
                        }}
                    >
                        <i className="fas fa-list-alt"></i>
                        Chi tiết lịch sử
                    </button>
                    <button
                        className={`tab-btn ${activeTab === 'summary' ? 'active' : ''}`}
                        onClick={() => setActiveTab('summary')}
                        style={{
                            padding: '8px 16px',
                            border: 'none',
                            background: activeTab === 'summary' ? '#e3f2fd' : 'transparent',
                            color: activeTab === 'summary' ? '#0d47a1' : '#666',
                            borderRadius: '6px',
                            fontWeight: activeTab === 'summary' ? '600' : '500',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px'
                        }}
                    >
                        <i className="fas fa-chart-pie"></i>
                        Bảng tổng hợp
                    </button>
                </div>

                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#f8f9fa', padding: '4px 8px', borderRadius: '6px', border: '1px solid #eee' }}>
                        <span style={{ fontSize: '0.9rem', color: '#666' }}>Lọc ngày:</span>
                        <input
                            type="date"
                            value={fromDate}
                            onChange={(e) => setFromDate(e.target.value)}
                            style={{ padding: '6px 8px', borderRadius: '4px', border: '1px solid #ddd', fontSize: '0.9rem' }}
                        />
                        <span style={{ color: '#999' }}>-</span>
                        <input
                            type="date"
                            value={toDate}
                            onChange={(e) => setToDate(e.target.value)}
                            style={{ padding: '6px 8px', borderRadius: '4px', border: '1px solid #ddd', fontSize: '0.9rem' }}
                        />
                    </div>
                    <button
                        className="btn btn-primary"
                        onClick={loadData}
                        style={{ height: '36px', display: 'flex', alignItems: 'center', gap: '5px' }}
                    >
                        <i className="fas fa-sync"></i>
                        Làm mới
                    </button>
                </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                {/* Summary Table */}
                {activeTab === 'summary' && (
                    <div className="card" style={{ padding: '0', overflow: 'hidden', border: 'none', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }}>
                        <div style={{ padding: '15px', borderBottom: '1px solid #eee', background: 'linear-gradient(to right, #e3f2fd, #bbdefb)' }}>
                            <h4 style={{ margin: 0, fontSize: '1.1rem', color: '#0d47a1' }}>
                                <i className="fas fa-chart-pie" style={{ marginRight: '8px' }}></i>
                                Thống kê biến động nhân sự {fromDate ? `từ ${fromDate}` : ''} {toDate ? `đến ${toDate}` : ''}
                            </h4>
                        </div>
                        <table className="table" style={{ marginBottom: 0 }}>
                            <thead>
                                <tr>
                                    <th style={{ width: '50%' }}>Chỉ tiêu</th>
                                    <th style={{ width: '50%', textAlign: 'center' }}>Số lượng</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td>Tổng nhân viên Thử việc</td>
                                    <td style={{ textAlign: 'center', fontWeight: 'bold', color: '#1976d2', fontSize: '1.2rem' }}>{summaryStats.thuViec}</td>
                                </tr>
                                <tr>
                                    <td>Tổng nhân viên Chính thức</td>
                                    <td style={{ textAlign: 'center', fontWeight: 'bold', color: '#388e3c', fontSize: '1.2rem' }}>{summaryStats.chinhThuc}</td>
                                </tr>
                                <tr>
                                    <td>Tổng nhân viên Tạm nghỉ</td>
                                    <td style={{ textAlign: 'center', fontWeight: 'bold', color: '#f57c00', fontSize: '1.2rem' }}>{summaryStats.tamNghi}</td>
                                </tr>
                                <tr>
                                    <td>Tổng nhân viên Nghỉ việc</td>
                                    <td style={{ textAlign: 'center', fontWeight: 'bold', color: '#d32f2f', fontSize: '1.2rem' }}>{summaryStats.nghiViec}</td>
                                </tr>
                                <tr style={{ background: '#f8f9fa' }}>
                                    <td style={{ fontWeight: 'bold' }}>Tổng lượt biến động</td>
                                    <td style={{ textAlign: 'center', fontWeight: 'bold', color: '#333', fontSize: '1.2rem' }}>{filteredLogs.length}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                )}

                {/* Detailed History Table */}
                {activeTab === 'detail' && (
                    <div className="card" style={{ padding: '0', overflow: 'hidden', border: 'none', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }}>
                        <div style={{ padding: '15px', borderBottom: '1px solid #eee', background: '#fff' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <h4 style={{ margin: 0, fontSize: '1.1rem', color: '#333' }}>
                                    <i className="fas fa-list-alt" style={{ marginRight: '8px' }}></i>
                                    Nhật ký thay đổi trạng thái
                                </h4>
                                <span style={{ fontSize: '0.9rem', color: '#666', background: '#f1f1f1', padding: '2px 8px', borderRadius: '10px' }}>
                                    {filteredLogs.length} bản ghi
                                </span>
                            </div>
                        </div>
                        <div style={{ overflowX: 'scroll', overflowY: 'auto', maxHeight: 'calc(100vh - 350px)', border: '1px solid #e0e0e0' }}>
                            <table className="table" style={{ marginBottom: 0, minWidth: '101%' }}>
                                <thead>
                                    <tr>
                                        <th style={{ minWidth: '80px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>STT</th>
                                        <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Mã nhân viên</th>
                                        <th style={{ minWidth: '250px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Tên nhân viên</th>
                                        <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Trạng thái mới</th>
                                        <th style={{ minWidth: '150px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Ngày hiệu lực</th>
                                        <th style={{ minWidth: '200px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Người thực hiện</th>
                                        <th style={{ minWidth: '300px', position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 10 }}>Ghi chú</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredLogs.length > 0 ? (
                                        filteredLogs.map((log, idx) => (
                                            <tr key={log.id || idx}>
                                                <td>{idx + 1}</td>
                                                <td>
                                                    <span style={{ fontFamily: 'monospace', background: '#f5f5f5', padding: '2px 6px', borderRadius: '4px' }}>
                                                        {log.employeeCode || log.employeeId || ''}
                                                    </span>
                                                </td>
                                                <td style={{ fontWeight: '500' }}>{log.employeeName || ''}</td>
                                                <td>
                                                    <span className={`status-badge status-${String(log.newStatus).replace(/\s+/g, '-').toLowerCase()}`} style={{ padding: '4px 8px', borderRadius: '4px', fontSize: '0.85rem', fontWeight: '500' }}>
                                                        {log.newStatus || ''}
                                                    </span>
                                                </td>
                                                <td>{log.effectiveDate ? new Date(log.effectiveDate).toLocaleDateString('vi-VN') : ''}</td>
                                                <td>{log.actor || 'HR'}</td>
                                                <td>{log.note || ''}</td>
                                            </tr>
                                        ))
                                    ) : (
                                        <tr>
                                            <td colSpan="7" className="empty-state" style={{ padding: '30px', textAlign: 'center', color: '#999' }}>
                                                <i className="fas fa-search" style={{ fontSize: '2rem', marginBottom: '10px', display: 'block' }}></i>
                                                Không có dữ liệu trong khoảng thời gian này
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}

export default StatusHistoryView
