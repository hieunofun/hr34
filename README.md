# HR dùng chung cho nhiều công ty

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
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` và cấu hình Cloudinary công khai
`VITE_CLOUDINARY_CLOUD_NAME`, `VITE_CLOUDINARY_UPLOAD_PRESET` trong Production
Environment Variables. Không đặt service role hoặc API secret trong biến `VITE_*`.
`vercel.json` hiện có giữ route SPA và API `/api/attendance-match`. API đối sánh
AI này tùy chọn; muốn bật cần `GROQ_API_KEY` hoặc `OPENAI_API_KEY` ở server.
Đăng nhập hiện dùng email/mật khẩu, không dùng OAuth hoặc callback redirect.

## Một link đăng nhập chung

Mọi công ty dùng cùng một frontend và trang `/login`. Trang đăng nhập dùng
branding HR chung; sau đăng nhập, `CompanyContext` lấy tên, mã và URL logo từ
`companies` theo `users.company_id`. Quyền dữ liệu HR do hồ sơ đăng nhập và RLS
quyết định. Không cần `public_id` hoặc migration cho link riêng.

Tạo công ty và tài khoản trong `HR-System-Admin`. Cấu hình
`VITE_HR_APP_BASE_URL` ở System Admin thành URL của frontend HR dùng chung để
hiển thị link chung có thể gửi cho khách. Logo được upload qua Cloudinary của System
Admin và chỉ URL HTTPS được lưu trong `companies.logo_url`.

`supabase/01_create_company_34.sql` là script lịch sử của bản HR34; không dùng
script đó khi thêm công ty mới.
