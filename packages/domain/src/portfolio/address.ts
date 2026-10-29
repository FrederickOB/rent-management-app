import { DomainError } from '../errors';

/**
 * GhanaPost GPS digital addresses (PR-03, OQ-23): region letter, district letter or digit, a 3
 * or 4 digit area and a 4 digit number, for example GA-183-8164. There is no published API, so
 * addresses are mostly typed by hand and checked against this pattern. The address adapter in
 * packages/integrations uses the same check.
 */
const GHANA_POST_GPS = /^[A-Z][A-Z0-9]-\d{3,4}-\d{4}$/;

/** Upper-cases, trims, and turns spaces or dashes between the groups into single hyphens. */
export function normaliseGhanaPostGps(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replace(/\s*[\s–—-]\s*/g, '-');
}

export function isGhanaPostGpsFormat(code: string): boolean {
  return GHANA_POST_GPS.test(normaliseGhanaPostGps(code));
}

export function checkGhanaPostGps(code: string): string {
  const value = normaliseGhanaPostGps(code);
  if (!GHANA_POST_GPS.test(value))
    throw new DomainError(
      'address.gps_invalid',
      'Enter a GhanaPost GPS address such as GA-183-8164',
    );
  return value;
}

/** Decimal degrees with up to 6 places, kept as text so no rounding happens on the way in. */
const DEGREES = /^-?\d{1,3}(\.\d{1,6})?$/;

export interface MapPin {
  readonly latitude: string;
  readonly longitude: string;
}

function degrees(value: string | number, limit: number, what: string): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!DEGREES.test(text) || Math.abs(Number(text)) > limit)
    throw new DomainError(
      'address.pin_invalid',
      `Enter the ${what} in decimal degrees, between -${limit} and ${limit}, with at most 6 decimal places`,
    );
  return text;
}

/** A map pin (PR-03; decision 2): latitude and longitude, range-checked. */
export function checkMapPin(latitude: string | number, longitude: string | number): MapPin {
  return {
    latitude: degrees(latitude, 90, 'latitude'),
    longitude: degrees(longitude, 180, 'longitude'),
  };
}

/** An "Open in maps" link for a pin. Maps URLs need no key and load nothing into our pages. */
export function mapsLink(pin: MapPin): string {
  return `https://www.google.com/maps/search/?api=1&query=${pin.latitude}%2C${pin.longitude}`;
}
