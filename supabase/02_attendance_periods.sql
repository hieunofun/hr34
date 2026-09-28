-- Chạy một lần trên Supabase dùng chung trước khi triển khai frontend kỳ công.
-- Không sửa hoặc phân loại lại bất kỳ log chấm công hiện có nào.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS public.attendance_periods (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  month_key text NOT NULL CHECK (month_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  start_date date NOT NULL,
  end_date date NOT NULL,
  confirmed_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_periods_pk PRIMARY KEY (company_id, month_key),
  CONSTRAINT attendance_periods_dates CHECK (
    start_date <= end_date AND end_date - start_date BETWEEN 0 AND 30
    AND to_char(end_date, 'YYYY-MM') = month_key
  ),
  CONSTRAINT attendance_periods_no_overlap EXCLUDE USING gist (
    company_id WITH =, daterange(start_date, end_date, '[]') WITH &&
  )
);

ALTER TABLE public.attendance_periods ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.set_attendance_period_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.confirmed_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attendance_periods_audit ON public.attendance_periods;
CREATE TRIGGER attendance_periods_audit BEFORE UPDATE ON public.attendance_periods
  FOR EACH ROW EXECUTE FUNCTION public.set_attendance_period_audit();

DROP POLICY IF EXISTS attendance_periods_read_company ON public.attendance_periods;

CREATE POLICY attendance_periods_read_company ON public.attendance_periods
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid() AND u.company_id = attendance_periods.company_id)
  );

DROP POLICY IF EXISTS attendance_periods_insert_staff ON public.attendance_periods;
CREATE POLICY attendance_periods_insert_staff ON public.attendance_periods
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid() AND u.company_id = attendance_periods.company_id
      AND u.role IN ('admin', 'hr', 'manager'))
  );

DROP POLICY IF EXISTS attendance_periods_update_staff ON public.attendance_periods;
CREATE POLICY attendance_periods_update_staff ON public.attendance_periods
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid() AND u.company_id = attendance_periods.company_id
      AND u.role IN ('admin', 'hr', 'manager'))
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid() AND u.company_id = attendance_periods.company_id
      AND u.role IN ('admin', 'hr', 'manager'))
  );

REVOKE ALL ON public.attendance_periods FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.attendance_periods TO authenticated;
