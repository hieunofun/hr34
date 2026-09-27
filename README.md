# App Chấm Công

Một frontend kết nối database Supabase chung. Sau đăng nhập, ứng dụng đọc
`auth.users.id → users.auth_user_id → users.company_id → companies.id` và dùng
`CompanyContext` cho dữ liệu công ty. Không có biến môi trường chọn công ty.

## Chạy tại máy

```bash
npm ci
npm run dev
npm test
npm run build
```

Mặc định Vite chạy tại `http://localhost:3034`. Cấu hình
`VITE_SUPABASE_URL` và `VITE_SUPABASE_ANON_KEY` của database chung trong
`.env.local`. Khóa service role không được đưa vào frontend.

## Production trên Vercel

Project HR dùng framework Vite, build `npm run build`, output `dist`. Đặt
URL production chung là `https://appchamcongfun.vercel.app/login`. Source được
đẩy lên `hieunofun/hr34` nhánh `main`; Vercel project `appchamcong` build từ Git.

Đặt
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` và cấu hình Cloudinary công khai
`VITE_CLOUDINARY_CLOUD_NAME`, `VITE_CLOUDINARY_UPLOAD_PRESET` trong Production
Environment Variables. Không đặt service role hoặc API secret trong biến `VITE_*`.
`vercel.json` hiện có giữ route SPA và API `/api/attendance-match`. API đối sánh
AI này tùy chọn; muốn bật cần `GROQ_API_KEY` hoặc `OPENAI_API_KEY` ở server.
Đăng nhập hiện dùng email/mật khẩu, không dùng OAuth hoặc callback redirect.

Để Admin công ty cấp tài khoản cho nhân viên từ form hồ sơ, đặt thêm
`SUPABASE_SERVICE_ROLE_KEY` và `SUPABASE_URL` ở **server Environment Variables**
của project HR. Không đặt hai giá trị này vào biến `VITE_*` hoặc file được Git
theo dõi. Route `/api/employee-account` kiểm tra JWT Supabase, lấy công ty từ
hồ sơ Admin ở server, chỉ liên kết hồ sơ `role=user` cùng công ty đã có mã nhân
viên trong `nhan_su`. Form có thể lưu hồ sơ không có tài khoản; bật “Cấp tài khoản
đăng nhập” sẽ tạo Supabase Auth user và lưu `auth_user_id`. Username được sinh
ngẫu nhiên để nhận diện, còn đăng nhập hiện dùng email/mật khẩu. Mật khẩu ban
đầu chỉ gửi tới Supabase Auth, không lưu trong `users.password`.
Vai trò nhân viên hiện lưu nội bộ là `user` (giao diện hiển thị “Nhân viên”)
theo constraint và RLS hiện có; email là định danh đăng nhập, username là bí danh.

Nhân viên gửi đơn nghỉ phép hoặc đề xuất tại `/my-requests` và theo dõi trạng
thái tại đó. Admin công ty duyệt tại `/approvals`. API `/api/employee-requests`
xác thực JWT, lấy `company_id` và danh tính người gửi từ hồ sơ phía server;
nhân viên chỉ đọc đơn của mình, Admin chỉ xử lý đơn trong công ty của mình.
Luồng đơn hiện lưu trạng thái duyệt và không tự ghi lại bảng công hay tính lương.

## Một link đăng nhập chung

Mọi công ty dùng cùng một frontend và trang `/login`. Trước khi đăng nhập,
giao diện dùng tên và logo chung App Chấm Công; sau đăng nhập, `CompanyContext` lấy tên, mã và URL logo từ
`companies` theo `users.company_id`. Quyền dữ liệu HR do hồ sơ đăng nhập và RLS
quyết định. Không cần `public_id` hoặc migration cho link riêng.

Tạo công ty và tài khoản trong `HR-System-Admin`. Cấu hình
`VITE_HR_APP_BASE_URL` ở System Admin thành URL của frontend HR dùng chung để
hiển thị link chung có thể gửi cho khách. Logo được upload qua Cloudinary của System
Admin và chỉ URL HTTPS được lưu trong `companies.logo_url`.

`supabase/01_create_company_34.sql` là script lịch sử của bản HR34; không dùng
script đó khi thêm công ty mới.

Với Company 22, quyết định nghiệp vụ cho 15 log Sale lịch sử là **dùng policy
hiện tại**: hai log có đủ lượt chấm hiển thị 9 giờ, 1 công và 0 OT. Số giờ theo
cách tính cũ là 13,73 và 18,45 giờ. `scripts/verifyLegacyTenantSettings.mjs`
kiểm tra kết quả này ở chế độ chỉ đọc; không sửa log gốc, bảng công đã lưu hoặc
`policySnapshot`.
