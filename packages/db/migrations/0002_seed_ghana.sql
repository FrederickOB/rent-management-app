-- Ghana configuration and rules-table seeds (TX-08, CLAUDE.md section 7). Every legal, tax or
-- regulatory value carries its source and verification status; nothing here is "verified".
-- effective_from 2000-01-01 is a technical lower bound so imported history resolves. It is not
-- a statement of when any law took effect. A JSON null value is stored as SQL NULL: no value yet.

INSERT INTO country (code, name, currency, currency_minor_unit, default_time_zone, calling_code, id_types, address_format)
VALUES ('GH', 'Ghana', 'GHS', 2, 'Africa/Accra', '233', ARRAY['ghana_card', 'passport'], 'ghanapost_gps');
--> statement-breakpoint

INSERT INTO rule (country, key, value, effective_from, source, verification_status, notes, created_by)
SELECT 'GH', v.key, CASE WHEN v.value = 'null' THEN NULL ELSE v.value::jsonb END, DATE '2000-01-01', v.source, v.status,
       'Effective-from date is a technical lower bound, not a legal commencement date.' ||
       CASE WHEN v.note IS NULL THEN '' ELSE ' ' || v.note END,
       'migration:0002_seed_ghana'
FROM (VALUES
  ('rent_tax.rate.residential', '{"bps": 800}', 'TX-01; GRA rent income tax page', 'from_prd', NULL),
  ('rent_tax.rate.commercial', '{"bps": 1500}', 'TX-01', 'from_prd', NULL),
  ('rent_tax.due_days_after_receipt', '{"days": 30}', 'TX-02', 'from_prd', NULL),
  ('rent_tax.alert_days', '{"days": [21, 28]}', 'TX-02', 'from_prd', NULL),
  ('rent_tax.base', '"rent_received_including_advances"', 'D9; tax adviser to confirm', 'unverified', NULL),
  ('rent_tax.rounding', '"half_up_per_receipt"', 'Tax adviser to confirm', 'unverified', NULL),
  ('rent_tax.includes_service_charge', 'true', 'Act 896 definition of rent; tax adviser to confirm', 'unverified', NULL),
  ('withholding_tax.rate.residential', '{"bps": 800}', 'TX-04; same as rent tax by band; tax adviser to confirm', 'unverified', NULL),
  ('withholding_tax.rate.commercial', '{"bps": 1500}', 'TX-04; same as rent tax by band; tax adviser to confirm', 'unverified', NULL),
  ('vat.commercial_rent', '{"vatBps": 1500, "nhilBps": 250, "getfundBps": 250}', 'Act 1151; GRA guidance AG/26/001; tax adviser to confirm', 'unverified', NULL),
  ('advance_rent.max_months.monthly_or_shorter', '{"months": 1}', 'Act 220 s.25(5), all premises; counsel to confirm', 'unverified', NULL),
  ('advance_rent.max_months.over_six_months', '{"months": 6}', 'Act 220 s.25(5), all premises; AR-05; counsel to confirm', 'unverified', NULL),
  ('rent_control.registration_days', '{"days": 14}', 'PNDCL 138 s.4; counsel to confirm', 'unverified', NULL),
  ('notice_to_quit.statutory_min_days.residential', 'null', 'D7; Act 220 sets none (research); counsel must confirm', 'unverified', 'No value until counsel supplies one.'),
  ('notice_to_quit.statutory_min_days.commercial', 'null', 'D7; Act 220 sets none (research); counsel must confirm', 'unverified', 'No value until counsel supplies one.'),
  ('data_retention.financial_and_notices', '{"years": 6}', 'Act 915 s.27; counsel to confirm', 'unverified', NULL),
  ('data_retention.other.messages', 'null', 'Act 843 s.24; counsel must supply', 'unverified', 'No value until counsel supplies one.'),
  ('data_retention.other.identity_data', 'null', 'Act 843 s.24; counsel must supply', 'unverified', 'No value until counsel supplies one.')
) AS v(key, value, source, status, note);

