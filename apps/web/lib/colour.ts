export type Rgb = readonly [number, number, number];

const DARK_TEXT = '#111827';
const LIGHT_TEXT = '#ffffff';
const DARK_RGB: Rgb = [17, 24, 39];

export const isHexColour = (value: string): boolean => /^#[0-9a-fA-F]{6}$/.test(value);

export function parseHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return null;
  const [, digits = ''] = match;
  const value = Number.parseInt(digits, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function linear(channel: number): number {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Text colour that reads best on a company's brand colour, so any colour a company picks stays legible. */
export function textOn(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return LIGHT_TEXT;
  return contrastRatio(rgb, [255, 255, 255]) >= contrastRatio(rgb, DARK_RGB)
    ? LIGHT_TEXT
    : DARK_TEXT;
}
