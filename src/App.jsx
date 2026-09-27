import { Suspense, lazy } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import LoadingSpinner from './components/LoadingSpinner'
import ProtectedRoute from './components/ProtectedRoute'
import { CORE_STAFF_ROLES } from './utils/staffAccess'

const AttendancePreview = lazy(() => import('./pages/AttendancePreview'))
const AttendancePenalties = lazy(() => import('./pages/AttendancePenalties'))
const EmployeeLogin = lazy(() => import('./pages/EmployeeLogin'))
const Employees = lazy(() => import('./pages/Employees'))
const FeatureComingSoon = lazy(() => import('./pages/FeatureComingSoon'))
const HolidaySettings = lazy(() => import('./pages/HolidaySettings'))
const Login = lazy(() => import('./pages/Login'))
const MyAttendance = lazy(() => import('./pages/MyAttendance'))
const OnlineAttendance = lazy(() => import('./pages/OnlineAttendance'))
const Requests = lazy(() => import('./pages/Requests'))

const AppLayout = () => <Layout><Outlet /></Layout>
const STAFF_ROLES = [...CORE_STAFF_ROLES]
const ATTENDANCE_ROLES = ['user', ...STAFF_ROLES]

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<LoadingSpinner />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/employee-login" element={<EmployeeLogin />} />
          <Route element={<ProtectedRoute allowedRoles={ATTENDANCE_ROLES} allowAccounting />}>
            <Route element={<AppLayout />}>
              <Route path="/cham-cong-online" element={<OnlineAttendance />} />
            </Route>
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['user']} />}>
            <Route element={<AppLayout />}>
              <Route path="/bang-cong" element={<MyAttendance />} />
              <Route path="/my-requests" element={<Requests />} />
            </Route>
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['admin']} />}>
            <Route element={<AppLayout />}>
              <Route path="/approvals" element={<Requests />} />
            </Route>
          </Route>
          <Route element={<ProtectedRoute allowedRoles={STAFF_ROLES} allowAccounting />}>
            <Route element={<AppLayout />}>
              <Route path="/bang-cong-preview" element={<AttendancePreview />} />
              <Route path="/holiday-settings" element={<HolidaySettings />} />
            </Route>
          </Route>
          <Route element={<ProtectedRoute allowedRoles={STAFF_ROLES} />}>
            <Route element={<AppLayout />}>
              <Route path="/" element={<Navigate to="/employees" replace />} />
              <Route path="/employees" element={<Employees />} />
              <Route path="/bang-phat" element={<AttendancePenalties />} />
              <Route path="/attendance" element={<Navigate to="/bang-cong-preview" replace />} />
              <Route path="/honor" element={<Navigate to="/bang-cong-preview" replace />} />

              {/* Các tab còn lại: không tải DB, chỉ hiện thông báo demo */}
              <Route path="/dashboard" element={<FeatureComingSoon />} />
              <Route path="/recruitment" element={<FeatureComingSoon />} />
              <Route path="/salary" element={<FeatureComingSoon />} />
              <Route path="/competency" element={<FeatureComingSoon />} />
              <Route path="/kpi" element={<FeatureComingSoon />} />
              <Route path="/grading/:employeeId?" element={<FeatureComingSoon />} />
              <Route path="/tasks" element={<FeatureComingSoon />} />
            </Route>
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}

export default App
