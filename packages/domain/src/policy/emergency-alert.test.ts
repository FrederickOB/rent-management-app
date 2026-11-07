import { describe, expect, it } from 'vitest';
import { emergencyAlertRole } from './policy';

describe('MI-02 who an emergency alert reaches (decision 5; M8 review)', () => {
  it('reaches managers, caretakers and a self-managing landlord; agency admins only as the fallback', () => {
    expect(emergencyAlertRole('property_manager', 'agency')).toBe('manages');
    expect(emergencyAlertRole('property_manager', 'landlord')).toBe('manages');
    expect(emergencyAlertRole('owner', 'landlord')).toBe('manages');
    expect(emergencyAlertRole('caretaker', 'agency')).toBe('attends');
    expect(emergencyAlertRole('agency_admin', 'agency')).toBe('fallback');
    // An agency's client owner, accountants and advisers are not alerted.
    expect(emergencyAlertRole('owner', 'agency')).toBeNull();
    expect(emergencyAlertRole('accountant', 'agency')).toBeNull();
    expect(emergencyAlertRole('adviser', 'agency')).toBeNull();
  });
});
