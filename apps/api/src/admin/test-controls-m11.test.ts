import { describe, expect, it } from 'vitest';
import { ownerUrlAllowed } from './test-controls.controller';

describe('AD-05 OQ-29 the cooling-off control’s owner URL (M11)', () => {
  const url = (db: string, user = 'rent_app') => `postgres://${user}:x@localhost:54320/${db}`;
  it('needs the API’s own database', () => {
    expect(ownerUrlAllowed(url('rent_e2e'), url('rent_e2e', 'rent_owner'), false)).toBe(true);
    expect(ownerUrlAllowed(url('rent_e2e'), url('rent_other', 'rent_owner'), false)).toBe(false);
    expect(ownerUrlAllowed(url('rent_e2e'), undefined, false)).toBe(false);
    expect(ownerUrlAllowed(undefined, url('rent_e2e', 'rent_owner'), true)).toBe(false);
  });

  it('refuses a database named rent outside CI, and allows CI’s throwaway one', () => {
    expect(ownerUrlAllowed(url('rent'), url('rent', 'rent_owner'), false)).toBe(false);
    expect(ownerUrlAllowed(url('rent'), url('rent', 'rent_owner'), true)).toBe(true);
    // CI still needs both URLs to name the same database.
    expect(ownerUrlAllowed(url('rent'), url('rent_e2e', 'rent_owner'), true)).toBe(false);
  });
});
