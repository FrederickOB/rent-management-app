-- Rules-table row approved with the M4a plan (TX-08, CLAUDE.md section 7; docs/plans/M4a.md
-- decision 4): VAT and levies on a commercial lease's service charge as well as its rent. An
-- unverified reading that the tax adviser must confirm (OQ-20). New row only: existing rows are
-- never edited. Its effective-from date is that of vat.commercial_rent (0002), the technical lower
-- bound, so both rows resolve together.

INSERT INTO rule (country, key, value, effective_from, source, verification_status, notes, created_by)
SELECT 'GH', 'vat.applies_to_service_charge', 'true'::jsonb, r.effective_from,
       'M4a decision 4; Act 1151 and GRA AG/26/001; tax adviser to confirm (OQ-20)', 'unverified',
       'Effective-from date is a technical lower bound, not a legal commencement date. '
       || 'VAT, NHIL and GETFund are charged on service-charge lines of commercial leases while this is true.',
       'migration:0014_rules_m4a'
FROM rule r
WHERE r.country = 'GH' AND r.key = 'vat.commercial_rent'
ORDER BY r.effective_from, r.created_at
LIMIT 1;
