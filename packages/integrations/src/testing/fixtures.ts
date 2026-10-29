import { randomInt, randomUUID } from 'node:crypto';

/** A number in the fake range the seed uses, +233 20 000 0xxx. Never a real subscriber. */
export const fakePhone = (): string => `+233200000${String(randomInt(0, 1000)).padStart(3, '0')}`;

/** Unique per call; letters, digits and hyphens, which every provider accepts in a reference. */
export const uniqueReference = (prefix: string): string => `${prefix}-${randomUUID()}`;

/** An address at the reserved `.test` domain. */
export const fakeEmail = (): string => `contract-${randomUUID()}@example.test`;

/** A Ghana Card number in the right format whose last digit picks the fake outcome. */
export const fakeGhanaCard = (lastDigit: number): string =>
  `GHA-${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}-${lastDigit}`;

/** ID numbers for each outcome under the fakes' last-digit rule (`fakeIdentityOutcome`). */
export const fakeIdNumbers = {
  verified: () => fakeGhanaCard(1),
  notMatched: () => fakeGhanaCard(0),
  failed: () => fakeGhanaCard(9),
  neverCompletes: () => fakeGhanaCard(8),
};

export const fakeExpoToken = (label = 'device'): string =>
  `ExponentPushToken[${label}-${randomUUID()}]`;

/** A small, valid PDF, so attachments and media are real documents. */
export const SAMPLE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

/** The 8-byte PNG signature and a header chunk: enough to carry a content type. */
export const SAMPLE_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
  'hex',
);
