-- Rules-table rows approved with the M3 plan (TX-08, CLAUDE.md section 7; docs/plans/M3.md
-- decision 4 and section 4.11). Both are unverified research results that counsel must confirm.
-- New rows only: existing rows are never edited. As in 0002, effective_from 2000-01-01 is a
-- technical lower bound so imported history resolves, not a statement of when any law took effect.

INSERT INTO rule (country, key, value, effective_from, source, verification_status, notes, created_by)
SELECT 'GH', v.key, v.value::jsonb, DATE '2000-01-01', v.source, v.status,
       'Effective-from date is a technical lower bound, not a legal commencement date.' ||
       CASE WHEN v.note IS NULL THEN '' ELSE ' ' || v.note END,
       'migration:0008_rules_m3'
FROM (VALUES
  ('stamp_duty.deadline_months', '{"months": 2}',
   'Stamp Duty Act s.12 (research 2026-10-28); counsel to confirm (OQ-45)', 'unverified',
   'Months after signing within which a tenancy agreement is stamped.'),
  ('lease.writing_exemption_max_years', '{"years": 3}',
   'Land Act 2020 s.36(1)(f) (research 2026-10-28); counsel to confirm (OQ-44)', 'unverified',
   'Terms longer than this take the formal-lease path: legal practitioner, wet-signed copy and Lands Commission registration.')
) AS v(key, value, source, status, note);
