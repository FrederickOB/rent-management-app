-- The VAT return's due date (P33; the compliance list, M9 decision 14). Applied as rent_owner,
-- after 0051. A tax value, so it lives in the rules table (CLAUDE.md section 7): no value yet,
-- `unverified`, until the tax adviser says when a VAT return is due to GRA and whether it depends
-- on the filing period (OQ-61). The compliance list shows "Due date unverified" until then.

INSERT INTO rule (country, key, value, effective_from, source, verification_status, notes, created_by)
VALUES ('GH', 'vat.return_due_days', NULL, DATE '2000-01-01',
        'Tax adviser to supply (OQ-61)', 'unverified',
        'Effective-from date is a technical lower bound, not a legal commencement date. '
        || 'No value until the tax adviser supplies one, with its source. A value is read as days '
        || 'after the end of the month the VAT was charged in.',
        'migration:0052_vat_return_due');
