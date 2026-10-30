import { DomainError } from '../errors';

/**
 * Payment references (BC-03; prd-issues 15; M4a decision 8): seven characters per lease, six
 * random Crockford base32 characters and a Luhn mod 32 check character from the same alphabet.
 * Opaque, never derived from the unit code, and unique across the platform.
 */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const N = CROCKFORD_ALPHABET.length;
export const REFERENCE_PAYLOAD_LENGTH = 6;
export const REFERENCE_LENGTH = REFERENCE_PAYLOAD_LENGTH + 1;

const valueOf = (char: string): number => {
  const value = CROCKFORD_ALPHABET.indexOf(char);
  if (value < 0)
    throw new DomainError('reference.bad_character', `Not a reference character: ${char}`);
  return value;
};

/** Luhn mod N: doubles every second value from the right, folding each sum back below N. */
function luhnSum(values: readonly number[], doubleFirstFromRight: boolean): number {
  let sum = 0;
  let double = doubleFirstFromRight;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    let addend = (values[i] as number) * (double ? 2 : 1);
    addend = Math.floor(addend / N) + (addend % N);
    sum += addend;
    double = !double;
  }
  return sum;
}

export function checkCharacter(payload: string): string {
  const sum = luhnSum([...payload].map(valueOf), true);
  return CROCKFORD_ALPHABET[(N - (sum % N)) % N] as string;
}

/**
 * Luhn mod 32 catches every single-character slip and every swap of neighbours except 0 and Z
 * (values 0 and 31), so a reference never has those two side by side.
 */
const hasBlindSwap = (reference: string): boolean => /0Z|Z0/.test(reference);

/**
 * Builds a reference from six random values in 0 to 31 (the caller supplies the randomness, so
 * this stays pure). Returns null when the values would put 0 next to Z: draw again.
 */
export function referenceFrom(randomValues: readonly number[]): string | null {
  if (
    randomValues.length !== REFERENCE_PAYLOAD_LENGTH ||
    randomValues.some((v) => !Number.isInteger(v) || v < 0 || v >= N)
  )
    throw new DomainError('reference.bad_random', 'A reference needs six values from 0 to 31');
  const payload = randomValues.map((v) => CROCKFORD_ALPHABET[v]).join('');
  const reference = payload + checkCharacter(payload);
  return hasBlindSwap(reference) ? null : reference;
}

/**
 * Normalises what someone typed: capitals, no spaces or dashes, and Crockford's look-alikes
 * (O for 0, I and L for 1). Returns null when it cannot be a valid reference.
 */
export function normaliseReference(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== REFERENCE_LENGTH) return null;
  if ([...cleaned].some((c) => !CROCKFORD_ALPHABET.includes(c))) return null;
  return isValidReference(cleaned) ? cleaned : null;
}

export function isValidReference(reference: string): boolean {
  if (reference.length !== REFERENCE_LENGTH) return false;
  if ([...reference].some((c) => !CROCKFORD_ALPHABET.includes(c))) return false;
  return luhnSum([...reference].map(valueOf), false) % N === 0;
}
