import { describe, expect, it } from 'vitest';
import { contrastRatio, isHexColour, parseHex, textOn } from './colour';

describe('AD-01 branding colours', () => {
  it('accepts only six-digit hex colours, as the API does', () => {
    expect(isHexColour('#0F766E')).toBe(true);
    expect(isHexColour('#0f766e')).toBe(true);
    expect(isHexColour('#FFF')).toBe(false);
    expect(isHexColour('0F766E')).toBe(false);
    expect(parseHex('#0F766E')).toEqual([15, 118, 110]);
    expect(parseHex('red')).toBeNull();
  });

  it('picks the text colour that reads best on any brand colour', () => {
    expect(textOn('#0F766E')).toBe('#ffffff');
    expect(textOn('#F59E0B')).toBe('#111827');
    expect(textOn('#FFFFFF')).toBe('#111827');
    expect(textOn('#000000')).toBe('#ffffff');
    for (const hex of ['#0F766E', '#F59E0B', '#777777', '#1D4ED8', '#FDE047']) {
      const background = parseHex(hex);
      const text = parseHex(textOn(hex));
      if (!background || !text) throw new Error('unparsable colour');
      // At least WCAG AA for large text, whatever colour the company picks.
      expect(contrastRatio(background, text)).toBeGreaterThanOrEqual(3);
    }
  });
});
