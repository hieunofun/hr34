-- Allow an inclusive 32-day period only for company 32. Keep all stored data,
-- tenant permissions, and the prohibition on overlapping periods.
BEGIN;

ALTER TABLE public.attendance_periods
  DROP CONSTRAINT IF EXISTS attendance_periods_dates;
ALTER TABLE public.attendance_periods
  ADD CONSTRAINT attendance_periods_dates CHECK (
    start_date <= end_date AND end_date - start_date BETWEEN 0 AND
      CASE WHEN company_id = '00000000-0000-0000-0000-000000000032'::uuid THEN 31 ELSE 30 END
    AND to_char(end_date, 'YYYY-MM') = month_key
  );

COMMIT;
