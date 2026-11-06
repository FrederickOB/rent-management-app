import { describe, expect, it } from 'vitest';
import { evidenceGuidance, needsEvidence } from './move-out';

// Founder decision of 2026-11-06: damage and missing-items deductions always need evidence (an
// inspection item or a photo), deposit settlements included.

describe('MI-11 damage and missing items need evidence, so the form guides to the inspection', () => {
  it('asks for the inspection first when there is none to take evidence from', () => {
    for (const kind of ['damage', 'missing_items'] as const) {
      expect(needsEvidence(kind)).toBe(true);
      expect(evidenceGuidance(kind, false)).toBe(
        'Damage and missing items need an inspection item or a photo behind them, so do the move-out inspection first. It is optional for other deductions, such as cleaning or keys.',
      );
    }
  });

  it('says nothing once there is an inspection, or for deductions that need no evidence', () => {
    expect(evidenceGuidance('damage', true)).toBeNull();
    for (const kind of ['cleaning', 'keys', 'other', ''] as const) {
      expect(needsEvidence(kind)).toBe(false);
      expect(evidenceGuidance(kind, false)).toBeNull();
    }
  });
});
