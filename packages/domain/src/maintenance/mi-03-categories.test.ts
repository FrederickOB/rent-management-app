import { describe, expect, it } from 'vitest';
import { MAINTENANCE_CATEGORIES, MAINTENANCE_CATEGORY_LABELS } from './maintenance';

/**
 * MI-03 (PRD Module 6): the repair categories. The ten the PRD names, each with a label staff and
 * tenants see, plus "other" for what fits none. Added in M11 so the traceability table finds a
 * test named for the requirement (the categories exist since M8).
 */
const PRD_CATEGORIES = [
  ['plumbing', 'Plumbing'],
  ['electrical', 'Electrical'],
  ['roofing', 'Roofing'],
  ['carpentry', 'Carpentry'],
  ['painting', 'Painting'],
  ['pest_control', 'Pest control'],
  ['air_conditioning', 'AC'],
  ['generator', 'Generator'],
  ['borehole', 'Borehole'],
  ['septic', 'Septic'],
] as const;

describe('MI-03 repair categories', () => {
  it('has every category the PRD names, and only those plus "other"', () => {
    expect([...MAINTENANCE_CATEGORIES].sort()).toEqual(
      [...PRD_CATEGORIES.map(([key]) => key), 'other'].sort(),
    );
  });

  it('labels each one in plain words', () => {
    for (const category of MAINTENANCE_CATEGORIES) {
      const label = MAINTENANCE_CATEGORY_LABELS[category];
      expect(label, category).toMatch(/^[A-Z][A-Za-z ]+$/);
    }
    for (const [key, prdWord] of PRD_CATEGORIES)
      expect(MAINTENANCE_CATEGORY_LABELS[key].toLowerCase(), key).toContain(
        prdWord.toLowerCase() === 'ac' ? 'air' : prdWord.toLowerCase(),
      );
  });
});
