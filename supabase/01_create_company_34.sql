-- Chạy trên Supabase project dùng chung với HR-Company-22 và HR-Company-23.
-- Không tạo bảng hoặc sửa dữ liệu của các công ty khác.
INSERT INTO public.companies (id, code, name)
VALUES ('00000000-0000-0000-0000-000000000034', 'COMPANY_31', 'Hr34')
ON CONFLICT (id) DO UPDATE
SET code = EXCLUDED.code, name = EXCLUDED.name, updated_at = now();
