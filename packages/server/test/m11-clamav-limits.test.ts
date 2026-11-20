import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MEDIA_RULES } from '@rent/domain/maintenance';
import { describe, expect, it } from 'vitest';
import { MEDIA_MAX_BYTES } from '../src/messaging/inbound.service';
import {
  PROPERTY_PAPER_UPLOAD,
  PROPERTY_PHOTO_UPLOAD,
} from '../src/portfolio/property-files.service';
import * as documents from '../src/documents/documents.service';

// M11 review (ClamAV limits): clamd scans every upload whole. Its limits in docker-compose.yml are
// at least the largest file any upload path accepts, and a file past a limit is flagged, never
// passed; clamd listens on this machine only.

const compose = readFileSync(
  path.resolve(import.meta.dirname, '../../../docker-compose.yml'),
  'utf8',
);
const clamav = compose.slice(compose.indexOf('\n  clamav:'), compose.indexOf('\nvolumes:'));
/** clamd's sizes: a number with K or M (binary multiples), as clamd.conf(5) reads them. */
const bytesOf = (value: string) => {
  const m = /^(\d+)([KM]?)$/.exec(value)!;
  return Number(m[1]) * (m[2] === 'M' ? 1024 * 1024 : m[2] === 'K' ? 1024 : 1);
};
const setting = (key: string) => {
  const m = new RegExp(`CLAMD_CONF_${key}: '?([^'\\n]+)'?`).exec(clamav);
  if (!m) throw new Error(`docker-compose.yml sets no ${key} for clamav`);
  return m[1]!.trim();
};

/** The largest file any upload path accepts: every purpose, every media kind, inbound media. */
const largestUpload = Math.max(
  ...Object.values(documents)
    .filter((v): v is documents.UploadPurpose =>
      Boolean(v && typeof v === 'object' && 'purpose' in v && 'maxBytes' in v),
    )
    .map((p) => p.maxBytes),
  ...Object.values(MEDIA_RULES).map((r) => r.maxBytes),
  PROPERTY_PHOTO_UPLOAD.maxBytes,
  PROPERTY_PAPER_UPLOAD.maxBytes,
  MEDIA_MAX_BYTES,
);

describe('NFR-SEC clamd scans the largest upload whole, and flags anything past its limits (M11 review)', () => {
  it('sets StreamMaxLength, MaxFileSize and MaxScanSize to at least the largest upload', () => {
    expect(largestUpload).toBe(50_000_000);
    for (const key of ['StreamMaxLength', 'MaxFileSize', 'MaxScanSize'])
      expect(bytesOf(setting(key)), key).toBeGreaterThanOrEqual(largestUpload);
  });

  it('reports a file past a limit (AlertExceedsMax), and listens on 127.0.0.1 only', () => {
    expect(setting('AlertExceedsMax')).toBe('yes');
    expect(clamav).toMatch(/ports:\n(\s+#.*\n)*\s+- '127\.0\.0\.1:3310:3310'/);
    expect(clamav).not.toMatch(/- '3310:3310'/);
  });
});
