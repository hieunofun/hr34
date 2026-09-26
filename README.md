# HR34

Bản sao chức năng của HR31. Ứng dụng dùng chung Supabase project với HR22, HR23 và HR31, nhưng tách dữ liệu theo `company_id`: `00000000-0000-0000-0000-000000000034`.

## Chạy tại máy

```bash
npm ci
npm run dev
```

Mở http://localhost:3034. File `.env.local` dùng URL và publishable key của Supabase chung; file này không đưa lên Git.

## Thiết lập dữ liệu

- Chỉ tạo bản ghi công ty `Hr34` trong bảng `companies`. Không sao chép nhân sự, tài khoản, giờ công hay cài đặt của HR31.
- Tài khoản đăng nhập phải có `users.company_id` bằng `00000000-0000-0000-0000-000000000034`.
- Dữ liệu mới của HR34 nằm trong các bảng chung với `company_id` riêng.
- Mã SQL: `supabase/01_create_company_34.sql`. Không chạy script seed của HR31 hoặc công ty khác.

## Build

```bash
npm run build
```
