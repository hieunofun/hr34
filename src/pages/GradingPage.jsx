import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useCompany } from '../contexts/CompanyContext'
import { supabase } from '../services/supabase'

function GradingPage() {
    const { employeeId } = useParams()
    const [loading, setLoading] = useState(false)
    const { user: authUser } = useAuth()
    const { companyId } = useCompany()
    const [user, setUser] = useState(null)
    const [userProfile, setUserProfile] = useState(null)
    const [month, setMonth] = useState(new Date().toISOString().slice(0, 7)) // YYYY-MM
    const [formData, setFormData] = useState({})
    const [managerData, setManagerData] = useState({})
    const [reviewId, setReviewId] = useState(null)
    const [status, setStatus] = useState('draft')
    const [selfComment, setSelfComment] = useState('')
    const [managerComment, setManagerComment] = useState('')

    // Criteria Structure
    const criteria = [
        {
            section: 'A',
            title: 'KHUNG ĐIỂM TRỪ [A = 20 - 1.1 - 1.2 - 1.3]',
            maxScore: 20,
            isDeduction: true,
            items: [
                { id: '1', title: 'Chấp hành Nội quy lao động', maxScore: 20, isHeader: true },
                { id: '1.1', title: 'Nhóm hành vi Điều 23 - Nội quy lao động', range: '1 - 9' },
                { id: '1.2', title: 'Nhóm hành vi Điều 24 - Nội quy lao động', range: '10 - 15' },
                { id: '1.3', title: 'Nhóm hành vi Điều 25, Điều 26 - Nội quy lao động', range: '16 - 20' },
            ]
        },
        {
            section: 'B',
            title: 'KHUNG ĐIỂM ĐẠT',
            maxScore: 80,
            items: [
                { id: '2', title: 'Hiệu quả công việc', maxScore: 45, isHeader: true },
                { id: '2.1', title: 'Khối lượng công việc', range: '1 - 10' },
                { id: '2.2', title: 'Thời gian thực hiện, tiến độ hoàn thành', range: '1 - 10' },
                { id: '2.3', title: 'Chất lượng công việc', maxScore: 15, isHeader: true },
                { id: '2.3.1', title: 'Tính chính xác so với mục tiêu, yêu cầu đề ra (hiệu quả)', range: '1 - 5' },
                { id: '2.3.2', title: 'Đúng phương pháp, quy trình, hướng dẫn (hiệu suất)', range: '1 - 5' },
                { id: '2.3.3', title: 'Mức độ khả thi, có thể áp dụng (thực tiễn)', range: '1 - 5' },
                { id: '2.4', title: 'Sắp xếp, quản lý công việc và ý thức tiết kiệm', maxScore: 10, isHeader: true },
                { id: '2.4.1', title: 'Tính khoa học, hợp lý trong quản lý công việc', range: '1 - 5' },
                { id: '2.4.2', title: 'Ý thức tiết kiệm (thời gian làm việc, nguồn lực, tài nguyên)', range: '1 - 5' },
                { id: '3', title: 'Tinh thần trách nhiệm, ý thức hợp tác, linh hoạt và thích ứng', maxScore: 15, isHeader: true },
                { id: '3.1', title: 'Tinh thần trách nhiệm', range: '1 - 5' },
                { id: '3.2', title: 'Ý thức hợp tác và giải quyết vấn đề', range: '1 - 5' },
                { id: '3.3', title: 'Khả năng chủ động thay đổi, thích ứng linh hoạt, kịp thời xử lý', range: '1 - 5' },
                { id: '4', title: 'Hiệu quả quản lý, điều hành, chỉ đạo', maxScore: 20, isHeader: true },
                { id: '4.1', title: 'Hiệu quả quản lý, chỉ đạo, điều hành công việc', range: '1 - 5' },
                { id: '4.2', title: 'Thực hiện chế độ họp, hội nghị, đào tạo - huấn luyện', range: '1 - 5' },
                { id: '4.3', title: 'Trách nhiệm thực hiện chế độ báo cáo, thông tin phản hồi với lãnh đạo', range: '1 - 5' },
                { id: '4.4', title: 'Hiệu quả hoạt động của cơ quan đơn vị', range: '1 - 5' },
            ]
        },
        {
            section: 'C',
            title: 'KHUNG ĐIỂM CỘNG',
            maxScore: 15,
            items: [
                { id: '5', title: 'Điểm cộng động viên, khuyến khích (04 tiêu chí)', range: '1 - 15' }
            ]
        }
    ]

    useEffect(() => {
        checkUser()
    }, [authUser, employeeId])

    useEffect(() => {
        if (user && month) {
            loadReview()
        }
    }, [user, month])

    const checkUser = async () => {
        if (authUser) {
            setUser(authUser)

            // Determine which profile to fetch: standard is current user, but if employeeId is passed, fetch that
            const targetId = employeeId || authUser.id

            // Fetch full profile
            const { data: profile } = await supabase
                .from('users')
                .select('*')
                .eq('id', targetId)
                .eq('company_id', companyId)
                .maybeSingle()
            if (profile) {
                setUserProfile(profile)
            }
        }
    }

    const loadReview = async () => {
        if (!user) return
        // If employeeId is passed, we load THAT user's review. Otherwise load current user's.
        const targetId = employeeId || user.id

        setLoading(true)
        try {
            const { data, error } = await supabase
                .from('performance_reviews')
                .select('*')
                .eq('employee_id', targetId)
                .eq('company_id', companyId)
                .eq('month', month)
                .maybeSingle()

            if (error) throw error

            if (data) {
                setReviewId(data.id)
                setFormData(data.self_assessment || {})
                setManagerData(data.supervisor_assessment || {})
                setSelfComment(data.self_comment || '')
                setManagerComment(data.supervisor_comment || '')
                setStatus(data.status || 'draft')
                // We don't necessarily need to set state for totals as they are recalculated from assessment data
            } else {
                setReviewId(null)
                setFormData({})
                setManagerData({})
                setSelfComment('')
                setManagerComment('')
                setStatus('draft')
            }
        } catch (error) {
            console.error('Error loading review:', error)
        } finally {
            setLoading(false)
        }
    }

    const isReviewingOthers = employeeId && user && employeeId !== user.id
    // If reviewing others, Self Assess is locked. If reviewing self, Manager Assess is locked.
    // Also check status:
    // - Self: Can edit Self Assess if draft.
    // - Manager: Can edit Manager Assess if status is NOT draft (or whatever logic, maybe always if they have access).
    const canEditSelf = !isReviewingOthers && status === 'draft'
    const canEditManager = isReviewingOthers // Simplified for now. Ideally check role 'manager'

    const handleScoreChange = (id, value) => {
        if (!canEditSelf) return
        setFormData(prev => ({
            ...prev,
            [id]: value
        }))
    }

    const handleManagerScoreChange = (id, value) => {
        if (!canEditManager) return
        setManagerData(prev => ({
            ...prev,
            [id]: value
        }))
    }

    const calculateTotals = (data) => {
        // Calculate A
        let scoreA = 20
        const sectionA = criteria.find(c => c.section === 'A')
        sectionA.items.forEach(item => {
            if (!item.isHeader) {
                scoreA -= Number(data[item.id] || 0)
            }
        })
        // Ensure A is between 0 and 20? The formula says A = 20 - ...
        // If deduction > 20, A could be negative? Assuming min 0.
        scoreA = Math.max(0, scoreA)

        // Calculate B
        let scoreB = 0
        const sectionB = criteria.find(c => c.section === 'B')
        sectionB.items.forEach(item => {
            if (!item.isHeader) {
                scoreB += Number(data[item.id] || 0)
            }
        })
        // Cap B at 80?
        scoreB = Math.min(80, scoreB)

        // Calculate C
        let scoreC = 0
        const sectionC = criteria.find(c => c.section === 'C')
        sectionC.items.forEach(item => {
            scoreC += Number(data[item.id] || 0)
        })
        scoreC = Math.min(15, scoreC)

        const total = scoreA + scoreB + scoreC
        return { scoreA, scoreB, scoreC, total }
    }

    const getGrade = (total) => {
        if (total >= 101) return 'A1'
        if (total >= 91) return 'A'
        if (total >= 76) return 'B'
        if (total >= 66) return 'C'
        return 'D'
    }

    const selfTotals = calculateTotals(formData)
    const managerTotals = calculateTotals(managerData)

    const selfGrade = getGrade(selfTotals.total)
    const managerGrade = getGrade(managerTotals.total)

    const handleSave = async (newStatus = 'draft') => {
        if (!user) return
        const targetId = employeeId || user.id

        setLoading(true)
        try {
            const payload = {
                company_id: companyId,
                employee_id: targetId,
                month,
                self_assessment: formData,
                self_comment: selfComment,
                supervisor_assessment: managerData,
                supervisor_comment: managerComment,

                // New separate columns
                self_total_score: selfTotals.total,
                self_grade: selfGrade,
                supervisor_total_score: managerTotals.total,
                supervisor_grade: managerGrade,

                status: newStatus
            }

            let error
            if (reviewId) {
                const { error: updateError } = await supabase
                    .from('performance_reviews')
                    .update(payload)
                    .eq('id', reviewId)
                    .eq('company_id', companyId)
                error = updateError
            } else {
                const { error: insertError } = await supabase
                    .from('performance_reviews')
                    .insert([payload])
                error = insertError
            }

            if (error) throw error

            alert(newStatus === 'submitted' ? 'Đã nộp đánh giá!' : 'Đã lưu nháp!')
            loadReview()
        } catch (e) {
            console.error('Error saving:', e)
            alert('Lỗi khi lưu: ' + e.message)
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="grading-page" style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto' }}>
            <div className="page-header" style={{ marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h1 className="page-title">
                    <i className="fas fa-star-half-alt" style={{ marginRight: '10px' }}></i>
                    Đánh giá mức độ hoàn thành công việc
                </h1>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <label>Kỳ đánh giá:</label>
                    <input
                        type="month"
                        value={month}
                        onChange={(e) => setMonth(e.target.value)}
                        className="form-control"
                        style={{ width: 'auto' }}
                    />
                </div>
            </div>

            <div className="card">
                <div className="card-header" style={{ textAlign: 'center', borderBottom: 'none', paddingBottom: '0' }}>
                    <h3 style={{ textTransform: 'uppercase', fontWeight: 'bold', marginBottom: '5px' }}>BẢNG TỰ ĐÁNH GIÁ MỨC ĐỘ HOÀN THÀNH CÔNG VIỆC</h3>
                    <p className="text-muted" style={{ fontStyle: 'italic', marginBottom: '5px' }}>
                        (Mẫu 01 áp dụng nhóm cán bộ, quản lý | Hạn nộp ngày 03 hàng tháng và 17 tháng 12)
                    </p>
                    <p style={{ fontWeight: 'bold' }}>Kỳ lương tháng {month.split('-')[1]} Năm {month.split('-')[0]}</p>
                </div>

                <div className="user-info-section" style={{ padding: '20px', fontSize: '1rem', lineHeight: '1.6', maxWidth: '800px', margin: '0 auto' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'min-content 1fr', gap: '10px 20px' }}>
                        <span style={{ fontWeight: 'bold', whiteSpace: 'nowrap' }}>Họ tên:</span>
                        <span style={{ borderBottom: '1px dotted #ccc' }}>{userProfile?.ho_va_ten || userProfile?.name || user?.email || '................................................'}</span>

                        <span style={{ fontWeight: 'bold', whiteSpace: 'nowrap' }}>Chức vụ công việc:</span>
                        <span style={{ borderBottom: '1px dotted #ccc' }}>{userProfile?.vi_tri || userProfile?.position || '................................................'}</span>

                        <span style={{ fontWeight: 'bold', whiteSpace: 'nowrap' }}>Đơn vị / bộ phận công tác:</span>
                        <span style={{ borderBottom: '1px dotted #ccc' }}>{userProfile?.bo_phan || userProfile?.department || '................................................'}</span>
                    </div>

                    <div style={{ marginTop: '15px', fontStyle: 'italic', textAlign: 'justify' }}>
                        Căn cứ Điều 13 và Phụ lục 04 Quy chế trả lương, thưởng của người lao động Tổng công ty và mức độ hoàn thành công việc thực tế hàng tháng theo sự phân công, nhiệm vụ được giao, bản thân tự đánh giá mức độ hoàn thành công việc trong tháng như sau:
                    </div>
                </div>

                <table className="table table-bordered" style={{ width: '100%', borderCollapse: 'collapse', marginTop: '10px' }}>
                    <thead>
                        <tr style={{ background: '#f8f9fa' }}>
                            <th style={{ width: '50%' }}>TIÊU CHÍ ĐÁNH GIÁ</th>
                            <th style={{ width: '10%', textAlign: 'center' }}>Khung điểm</th>
                            <th style={{ width: '15%', textAlign: 'center' }}>Tự đánh giá</th>
                            <th style={{ width: '15%', textAlign: 'center' }}>Cấp trên ĐG</th>
                            <th style={{ width: '10%', textAlign: 'center' }}>Ghi chú</th>
                        </tr>
                    </thead>
                    <tbody>
                        {/* SECTION A */}
                        <tr style={{ background: '#fff3cd' }}>
                            <td style={{ fontWeight: 'bold' }}>A. KHUNG ĐIỂM TRỪ [A = 20 - (Tổng điểm trừ)]</td>
                            <td style={{ textAlign: 'center', fontWeight: 'bold' }}>20</td>
                            <td style={{ textAlign: 'center', fontWeight: 'bold', color: 'red' }}>{selfTotals.scoreA}</td>
                            <td style={{ textAlign: 'center', fontWeight: 'bold', color: 'red' }}>{managerTotals.scoreA}</td>
                            <td></td>
                        </tr>
                        {criteria.find(c => c.section === 'A').items.map(item => (
                            <tr key={item.id}>
                                <td style={{ paddingLeft: item.isHeader ? '10px' : '30px', fontWeight: item.isHeader ? 'bold' : 'normal' }}>
                                    {item.id} {item.title}
                                </td>
                                <td style={{ textAlign: 'center' }}>
                                    {item.isHeader ? item.maxScore : item.range}
                                </td>
                                <td style={{ textAlign: 'center' }}>
                                    {!item.isHeader && (
                                        <input
                                            type="number"
                                            min="0"
                                            max="20"
                                            className="form-control"
                                            value={formData[item.id] || ''}
                                            onChange={(e) => handleScoreChange(item.id, e.target.value)}
                                            disabled={!canEditSelf}
                                            style={{ width: '80px', margin: '0 auto', textAlign: 'center' }}
                                        />
                                    )}
                                </td>
                                <td style={{ textAlign: 'center' }}>
                                    {!item.isHeader && (
                                        <input
                                            type="number"
                                            min="0"
                                            max="20"
                                            className="form-control"
                                            value={managerData[item.id] || ''}
                                            onChange={(e) => handleManagerScoreChange(item.id, e.target.value)}
                                            disabled={!canEditManager}
                                            style={{ width: '80px', margin: '0 auto', textAlign: 'center' }}
                                        />
                                    )}
                                </td>
                                <td></td>
                            </tr>
                        ))}

                        {/* SECTION B */}
                        <tr style={{ background: '#d4edda' }}>
                            <td style={{ fontWeight: 'bold' }}>B. KHUNG ĐIỂM ĐẠT</td>
                            <td style={{ textAlign: 'center', fontWeight: 'bold' }}>80</td>
                            <td style={{ textAlign: 'center', fontWeight: 'bold', color: 'green' }}>{selfTotals.scoreB}</td>
                            <td style={{ textAlign: 'center', fontWeight: 'bold', color: 'green' }}>{managerTotals.scoreB}</td>
                            <td></td>
                        </tr>
                        {criteria.find(c => c.section === 'B').items.map(item => (
                            <tr key={item.id}>
                                <td style={{ paddingLeft: item.isHeader ? '10px' : '30px', fontWeight: item.isHeader ? 'bold' : 'normal' }}>
                                    {item.id.length > 3 ? `${item.id.split('.').slice(1).join('.')} ${item.title}` : `${item.id} ${item.title}`}
                                    {/* Adjusted display logic slightly for sub-items looking like bullets */}
                                </td>
                                <td style={{ textAlign: 'center' }}>
                                    {item.isHeader ? item.maxScore : item.range}
                                </td>
                                <td style={{ textAlign: 'center' }}>
                                    {!item.isHeader && (
                                        <input
                                            type="number"
                                            min="0"
                                            max="10"
                                            className="form-control"
                                            value={formData[item.id] || ''}
                                            onChange={(e) => handleScoreChange(item.id, e.target.value)}
                                            disabled={!canEditSelf}
                                            style={{ width: '80px', margin: '0 auto', textAlign: 'center' }}
                                        />
                                    )}
                                </td>
                                <td style={{ textAlign: 'center' }}>
                                    {!item.isHeader && (
                                        <input
                                            type="number"
                                            min="0"
                                            max="10"
                                            className="form-control"
                                            value={managerData[item.id] || ''}
                                            onChange={(e) => handleManagerScoreChange(item.id, e.target.value)}
                                            disabled={!canEditManager}
                                            style={{ width: '80px', margin: '0 auto', textAlign: 'center' }}
                                        />
                                    )}
                                </td>
                                <td></td>
                            </tr>
                        ))}

                        {/* SECTION C */}
                        <tr style={{ background: '#cce5ff' }}>
                            <td style={{ fontWeight: 'bold' }}>C. KHUNG ĐIỂM CỘNG</td>
                            <td style={{ textAlign: 'center', fontWeight: 'bold' }}>15</td>
                            <td style={{ textAlign: 'center', fontWeight: 'bold', color: 'blue' }}>{selfTotals.scoreC}</td>
                            <td style={{ textAlign: 'center', fontWeight: 'bold', color: 'blue' }}>{managerTotals.scoreC}</td>
                            <td></td>
                        </tr>
                        {criteria.find(c => c.section === 'C').items.map(item => (
                            <tr key={item.id}>
                                <td style={{ paddingLeft: '10px' }}>
                                    {item.id} {item.title}
                                </td>
                                <td style={{ textAlign: 'center' }}>{item.range}</td>
                                <td style={{ textAlign: 'center' }}>
                                    <input
                                        type="number"
                                        min="0"
                                        max="15"
                                        className="form-control"
                                        value={formData[item.id] || ''}
                                        onChange={(e) => handleScoreChange(item.id, e.target.value)}
                                        disabled={!canEditSelf}
                                        style={{ width: '80px', margin: '0 auto', textAlign: 'center' }}
                                    />
                                </td>
                                <td style={{ textAlign: 'center' }}>
                                    <input
                                        type="number"
                                        min="0"
                                        max="15"
                                        className="form-control"
                                        value={managerData[item.id] || ''}
                                        onChange={(e) => handleManagerScoreChange(item.id, e.target.value)}
                                        disabled={!canEditManager}
                                        style={{ width: '80px', margin: '0 auto', textAlign: 'center' }}
                                    />
                                </td>
                                <td></td>
                            </tr>
                        ))}

                        {/* SUMMARY */}
                        <tr style={{ background: '#343a40', color: '#fff' }}>
                            <td style={{ textAlign: 'right', fontWeight: 'bold' }}>TỔNG ĐIỂM (A + B + C)</td>
                            <td></td>
                            <td style={{ textAlign: 'center', fontWeight: 'bold', fontSize: '1.2rem' }}>{selfTotals.total}</td>
                            <td style={{ textAlign: 'center', fontWeight: 'bold', fontSize: '1.2rem' }}>{managerTotals.total}</td>
                            <td></td>
                        </tr>
                        <tr style={{ background: '#343a40', color: '#fff' }}>
                            <td style={{ textAlign: 'right', fontWeight: 'bold' }}>XẾP LOẠI</td>
                            <td></td>
                            <td style={{ textAlign: 'center', fontWeight: 'bold', fontSize: '1.2rem' }}>
                                <span className={`badge ${selfGrade === 'A1' || selfGrade === 'A' ? 'badge-success' : selfGrade === 'B' ? 'badge-primary' : 'badge-warning'}`}>
                                    {selfGrade}
                                </span>
                            </td>
                            <td style={{ textAlign: 'center', fontWeight: 'bold', fontSize: '1.2rem' }}>
                                <span className={`badge ${managerGrade === 'A1' || managerGrade === 'A' ? 'badge-success' : managerGrade === 'B' ? 'badge-primary' : 'badge-warning'}`}>
                                    {managerGrade}
                                </span>
                            </td>
                            <td></td>
                        </tr>
                    </tbody>
                </table>

                <div style={{ marginTop: '20px' }}>
                    <label style={{ fontWeight: 'bold' }}>Lý do hoặc giải trình điểm trừ, điểm chưa đạt hoặc điểm cộng (nếu có):</label>
                    <textarea
                        className="form-control"
                        rows="4"
                        value={selfComment}
                        onChange={(e) => setSelfComment(e.target.value)}
                        disabled={!canEditSelf}
                        placeholder="Nhân viên tự giải trình"
                        style={{ width: '100%', padding: '10px', marginTop: '5px' }}
                    ></textarea>
                </div>



                <div className="form-actions" style={{ marginTop: '30px', textAlign: 'right', display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                    {/* Logic for buttons:
                - If Self: Show 'Save Draft', 'Submit' (if draft)
                - If Manager: Show 'Save Grading'
            */}

                    {canEditSelf && (
                        <>
                            <button
                                className="btn btn-secondary"
                                onClick={() => handleSave('draft')}
                                disabled={loading}
                            >
                                <i className="fas fa-save"></i> Lưu nháp
                            </button>
                            <button
                                className="btn btn-primary"
                                onClick={() => {
                                    if (confirm('Bạn có chắc muốn nộp đánh giá? Sau khi nộp bạn sẽ không thể chỉnh sửa.')) {
                                        handleSave('submitted')
                                    }
                                }}
                                disabled={loading}
                            >
                                <i className="fas fa-paper-plane"></i> Gửi đánh giá
                            </button>
                        </>
                    )}

                    {canEditManager && (
                        <button
                            className="btn btn-primary"
                            onClick={() => handleSave('approved')} // Or keep current status but save manager data? Let's assume manager finalizing approves it.
                            disabled={loading}
                        >
                            <i className="fas fa-check-double"></i> Lưu & Duyệt đánh giá
                        </button>
                    )}

                    {!canEditSelf && !canEditManager && (
                        <div className="alert alert-info" style={{ display: 'inline-block' }}>
                            <i className="fas fa-info-circle"></i> Trạng thái: {status} (Chỉ xem)
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

export default GradingPage
