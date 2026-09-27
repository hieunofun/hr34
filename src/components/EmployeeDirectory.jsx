import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { formatDateDisplay, getEmployeeEmploymentStatus } from '../utils/helpers'

const EmployeeModal = lazy(() => import('./EmployeeModal'))
const StatusHistoryView = lazy(() => import('./StatusHistoryView'))

const getName = (employee) => employee.ho_va_ten || employee.name || employee.Tên || 'Chưa cập nhật'
const getTinhTrang = (employee) => getEmployeeEmploymentStatus(employee)
const getShift = (employee) => String(employee?.ca_lam_viec || employee?.shift || '').trim()
const isResigned = (employee) =>
    getTinhTrang(employee) === 'Nghỉ việc'

function EmployeeDirectory({
    companyId, employees, filteredEmployees, activeTab, setActiveTab, searchTerm, setSearchTerm,
    filterBranch, setFilterBranch,
    filterDept, setFilterDept, filterStatus, setFilterStatus, filterContract, setFilterContract,
    filterShift = '', setFilterShift,
    selectedEmployee, setSelectedEmployee, isModalOpen, setIsModalOpen, isReadOnly, setIsReadOnly,
    onReload, onExport, onDownloadTemplate, onImport, onDelete, onDeleteAll, deletingAll = false, onResolveEmployee
}) {
    const importInputRef = useRef(null)
    const [openMenu, setOpenMenu] = useState(null)
    const [openingEmployee, setOpeningEmployee] = useState(false)

    const activeEmployees = useMemo(
        () => employees.filter(employee => !isResigned(employee)),
        [employees]
    )

    const daysUntil = (value) => {
        if (!value) return null
        const date = new Date(value)
        return Number.isNaN(date.getTime()) ? null : Math.ceil((date.getTime() - Date.now()) / 86400000)
    }

    const expiring = activeEmployees.filter(employee => {
        const days = daysUntil(employee.ngay_het_han || employee.contractEndDate || employee.ngay_het_han_hop_dong)
        return days !== null && days >= 0 && days <= 60
    })
    const month = new Date().getMonth()
    const branches = [...new Set(activeEmployees.map(employee => employee.chi_nhanh).filter(Boolean))].sort()
    const departments = [...new Set(activeEmployees.map(employee => employee.bo_phan).filter(Boolean))].sort()
    const contracts = [...new Set(activeEmployees.map(employee => employee.loai_hop_dong || employee.contractType).filter(Boolean))].sort()
    const shifts = [...new Set(activeEmployees.map(getShift).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'))
    const noShiftCount = activeEmployees.filter(employee => !getShift(employee)).length
    const stats = [
        ['Tổng nhân sự', activeEmployees.length, 'fa-users', 'blue'],
        ['Nhân sự thử việc', activeEmployees.filter(e => getTinhTrang(e) === 'Thử việc').length, 'fa-user-clock', 'orange'],
        ['Nhân sự chính thức', activeEmployees.filter(e => getTinhTrang(e) === 'Chính thức').length, 'fa-user-check', 'green'],
        ['Hợp đồng sắp hết hạn', expiring.length, 'fa-file-circle-exclamation', 'red'],
        ['Hồ sơ thiếu giấy tờ', activeEmployees.filter(e => !e.cccd || !e.so_bhxh || !e.ngay_sinh).length, 'fa-folder-open', 'purple'],
        ['Đi muộn nhiều', activeEmployees.filter(e => Number(e.so_lan_di_muon || 0) > 3).length, 'fa-clock', 'red'],
        ['Nghỉ phép nhiều', activeEmployees.filter(e => Number(e.phep_da_su_dung || 0) > 8).length, 'fa-calendar-minus', 'orange'],
        ['Sinh nhật tháng này', activeEmployees.filter(e => { const d = new Date(e.ngay_sinh); return !Number.isNaN(d.getTime()) && d.getMonth() === month }).length, 'fa-cake-candles', 'pink'],
        ['Sắp đến thâm niên', activeEmployees.filter(e => { const d = new Date(e.ngay_vao_lam); return !Number.isNaN(d.getTime()) && d.getMonth() === month }).length, 'fa-award', 'teal']
    ]

    const openEmployee = async (employee, readOnly = true) => {
        if (openingEmployee) return
        setOpenMenu(null)
        setIsReadOnly(readOnly)
        if (!employee) {
            setSelectedEmployee(null)
            setIsModalOpen(true)
            return
        }
        setOpeningEmployee(true)
        try {
            const full = onResolveEmployee ? await onResolveEmployee(employee) : employee
            setSelectedEmployee(full || employee)
            setIsModalOpen(true)
        } finally {
            setOpeningEmployee(false)
        }
    }

    useEffect(() => {
        if (!openMenu) return undefined
        const close = () => setOpenMenu(null)
        document.addEventListener('click', close)
        return () => document.removeEventListener('click', close)
    }, [openMenu])

    return (
        <div className={`employees-page${openingEmployee ? ' is-opening' : ''}`}>
            <header className="employees-hero">
                <div>
                    <h1><i className="fas fa-users"></i> Quản lý nhân sự</h1>
                    <p>Quản lý tập trung hồ sơ, hợp đồng và tình trạng nhân viên</p>
                </div>
                <div className="employees-hero__actions">
                    <button className="btn" onClick={onDownloadTemplate}><i className="fas fa-download"></i> Tải mẫu Excel</button>
                    <button className="btn" onClick={onExport}><i className="fas fa-file-excel"></i> Xuất Excel</button>
                    <button className="btn" onClick={() => importInputRef.current?.click()}><i className="fas fa-file-import"></i> Nhập Excel</button>
                    <input ref={importInputRef} className="employees-file-input" type="file" accept=".xlsx,.xls,.csv" onChange={onImport} />
                    {onDeleteAll && <button className="btn btn-danger" onClick={onDeleteAll} disabled={deletingAll}>
                        <i className="fas fa-trash"></i> {deletingAll ? 'Đang xóa...' : 'Xóa tất cả'}
                    </button>}
                    <button className="btn btn-primary" onClick={() => openEmployee(null, false)}><i className="fas fa-plus"></i> Thêm nhân viên</button>
                </div>
            </header>

            <section className="hr-overview">
                {stats.map(([label, value, icon, tone]) => (
                    <button key={label} className={`hr-stat hr-stat--${tone}`} onClick={() => {
                        if (label === 'Hợp đồng sắp hết hạn') setActiveTab('expiring')
                        if (label === 'Nhân sự thử việc') { setActiveTab('list'); setFilterStatus('Thử việc') }
                        if (label === 'Nhân sự chính thức') { setActiveTab('list'); setFilterStatus('Chính thức') }
                    }}>
                        <span className="hr-stat__icon"><i className={`fas ${icon}`}></i></span>
                        <span><strong>{value}</strong><small>{label}</small></span>
                    </button>
                ))}
            </section>

            <nav className="employees-tabs">
                <button className={activeTab === 'list' ? 'active' : ''} onClick={() => setActiveTab('list')}><i className="fas fa-list"></i> Danh sách nhân viên</button>
                <button className={activeTab === 'expiring' ? 'active danger' : ''} onClick={() => setActiveTab('expiring')}><i className="fas fa-triangle-exclamation"></i> Hợp đồng sắp hết hạn <span>{expiring.length}</span></button>
                <button className={activeTab === 'history' ? 'active' : ''} onClick={() => setActiveTab('history')}><i className="fas fa-clock-rotate-left"></i> Lịch sử biến động</button>
            </nav>

            {activeTab === 'history' ? (
                <Suspense fallback={<div className="loadingState">Đang tải lịch sử...</div>}>
                    <StatusHistoryView companyId={companyId} employees={employees} onDataChange={onReload} />
                </Suspense>
            ) : <>
                <section className="employees-filter-card">
                    <label className="employees-search"><i className="fas fa-search"></i><input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Tìm theo họ tên, email, số điện thoại..." /></label>
                    <select value={filterBranch} onChange={e => setFilterBranch(e.target.value)}>
                        <option value="">Tất cả chi nhánh</option>
                        {branches.map(value => <option key={value}>{value}</option>)}
                        <option value="__none__">Chưa có chi nhánh</option>
                    </select>
                    <select value={filterDept} onChange={e => setFilterDept(e.target.value)}><option value="">Tất cả phòng ban</option>{departments.map(value => <option key={value}>{value}</option>)}</select>
                    <select value={filterContract} onChange={e => setFilterContract(e.target.value)}><option value="">Tất cả hợp đồng</option>{contracts.map(value => <option key={value}>{value}</option>)}</select>
                    <select value={filterShift} onChange={e => setFilterShift(e.target.value)}>
                        <option value="">Tất cả ca</option>
                        {shifts.map(value => <option key={value}>{value}</option>)}
                        {noShiftCount > 0 && <option value="__none__">Chưa gán ca</option>}
                    </select>
                    <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                        <option value="">Tất cả trạng thái</option>
                        <option value="Thử việc">Thử việc</option>
                        <option value="Chính thức">Chính thức</option>
                        <option value="Tạm nghỉ">Tạm nghỉ</option>
                        <option value="Nghỉ việc">Đã nghỉ</option>
                    </select>
                    <button className="btn btn-icon" title="Làm mới" onClick={onReload}><i className="fas fa-rotate"></i></button>
                </section>

                <section className="employees-table-card">
                    <div className="employees-table-card__caption">
                        <span>Hiển thị <strong>{filteredEmployees.length}</strong> nhân viên</span>
                    </div>
                    <div className="employees-table-wrap">
                        <table className="employees-table">
                            <thead><tr><th>Nhân viên</th><th>Phòng ban</th><th>Chức danh</th><th>Ca</th><th>Ngày vào làm</th><th>Loại hợp đồng</th><th>Tình trạng</th><th></th></tr></thead>
                            <tbody>{filteredEmployees.map((employee, index) => {
                                const name = getName(employee)
                                const status = getTinhTrang(employee)
                                const avatar = employee.avatarDataUrl || employee.avatarUrl || employee.avatar
                                const days = daysUntil(employee.ngay_het_han || employee.contractEndDate || employee.ngay_het_han_hop_dong)
                                return <tr key={employee.id || index} onClick={() => openEmployee(employee)}>
                                    <td><div className="employee-identity"><span className="employee-avatar">{avatar ? <img src={avatar} alt="" loading="lazy" decoding="async" /> : name.charAt(0)}</span><span><strong>{name}</strong><small>{employee.email || employee.sdt || employee.sđt || 'Chưa có thông tin liên hệ'}</small></span></div></td>
                                    <td>{employee.bo_phan || 'Chưa phân bổ'}</td><td>{employee.vi_tri || 'Chưa cập nhật'}</td>
                                    <td>{getShift(employee) || 'Chưa gán ca'}</td>
                                    <td>{formatDateDisplay(employee.ngay_vao_lam) || '—'}</td>
                                    <td><span className="contract-cell">{employee.loai_hop_dong || employee.contractType || 'Chưa cập nhật'}{days !== null && days >= 0 && days <= 60 && <small>Còn {days} ngày</small>}</span></td>
                                    <td><span className={`employee-status ${status === 'Chính thức' ? 'success' : status === 'Thử việc' ? 'warning' : status === 'Nghỉ việc' ? 'danger' : ''}`}><i></i>{status === 'Nghỉ việc' ? 'Đã nghỉ' : status}</span></td>
                                    <td className="employee-row-actions" onClick={(event) => event.stopPropagation()}>
                                        <button
                                            className="employee-row-menu"
                                            title="Thao tác"
                                            onClick={(event) => {
                                                event.stopPropagation()
                                                const rowKey = employee.id || `row-${index}`
                                                if (openMenu?.id === rowKey) {
                                                    setOpenMenu(null)
                                                    return
                                                }
                                                const rect = event.currentTarget.getBoundingClientRect()
                                                setOpenMenu({
                                                    id: rowKey,
                                                    top: rect.bottom + 4,
                                                    right: window.innerWidth - rect.right
                                                })
                                            }}
                                        >
                                            <i className="fas fa-ellipsis"></i>
                                        </button>
                                        {openMenu?.id === (employee.id || `row-${index}`) && (
                                            <div
                                                className="employee-row-dropdown"
                                                style={{ top: openMenu.top, right: openMenu.right }}
                                                onClick={(event) => event.stopPropagation()}
                                            >
                                                <button type="button" onClick={() => openEmployee(employee, true)}>
                                                    <i className="fas fa-eye"></i> Xem
                                                </button>
                                                <button type="button" onClick={() => openEmployee(employee, false)}>
                                                    <i className="fas fa-edit"></i> Sửa
                                                </button>
                                                <button
                                                    type="button"
                                                    className="danger"
                                                    onClick={() => {
                                                        setOpenMenu(null)
                                                        onDelete?.(employee.id, name)
                                                    }}
                                                >
                                                    <i className="fas fa-trash"></i> Xóa
                                                </button>
                                            </div>
                                        )}
                                    </td>
                                </tr>
                            })}</tbody>
                        </table>
                        {!filteredEmployees.length && <div className="employee-card-empty">Không tìm thấy nhân viên phù hợp</div>}
                    </div>
                </section>
            </>}

            {isModalOpen && (
                <Suspense fallback={null}>
                    <EmployeeModal companyId={companyId} employee={selectedEmployee} isOpen={isModalOpen} onClose={() => { setIsModalOpen(false); setSelectedEmployee(null); setIsReadOnly(false) }} onSave={onReload} readOnly={isReadOnly} departmentOptions={departments} positionOptions={[...new Set(activeEmployees.map(e => e.vi_tri).filter(Boolean))]} />
                </Suspense>
            )}
        </div>
    )
}

export default EmployeeDirectory
