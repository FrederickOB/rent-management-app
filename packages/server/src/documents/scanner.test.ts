import type { Database } from '@rent/db';
import { ClamAvScanner, FakeMalwareScanner, InMemoryStorage } from '@rent/integrations';
import { describe, expect, it } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import { systemClock } from '../core/clock';
import { loadConfig, type AppConfig } from '../core/config';
import type { RulesService } from '../rules/rules.service';
import { DocumentsService } from './documents.service';
import { malwareScannerFor } from './scanner';

// M11 review B14 (decision 6): production never runs on the fake scanner. The documents module
// builds its scanner as DocumentsService is constructed, which the API and the worker both do as
// they start (DocumentsModule is in each), so either refuses to start without ClamAV.

const base = loadConfig({
  DATABASE_URL: 'postgres://rent_app@localhost:5432/rent',
  API_BASE_URL: 'https://api.example.invalid',
  WEB_ORIGIN: 'https://app.example.invalid',
  LINKS_ORIGIN: 'https://links.example.invalid',
  TENANT_WEB_ORIGIN: 'https://tenant.example.invalid',
  BETTER_AUTH_SECRET: 'a-real-secret-for-this-test-only-0123456789',
  NODE_ENV: 'development',
});
const production = (over: Partial<AppConfig> = {}): AppConfig => ({
  ...base,
  NODE_ENV: 'production',
  ...over,
});

/** DocumentsService as Nest builds it at start-up; nothing is queried in the constructor. */
const documentsWith = (config: AppConfig) =>
  new DocumentsService(
    { db: {} } as unknown as Database,
    new InMemoryStorage(),
    config,
    systemClock,
    {} as AuditService,
    {} as RulesService,
  );

describe('NFR-SEC production refuses the fake malware scanner (M11 review B14)', () => {
  it('the factory refuses `fake` in production, and gives ClamAV there when configured', () => {
    expect(base.MALWARE_SCANNER).toBe('fake');
    expect(() => malwareScannerFor(production())).toThrow(
      /MALWARE_SCANNER must be clamav in production/,
    );
    const clamav = malwareScannerFor(
      production({ MALWARE_SCANNER: 'clamav', CLAMAV_HOST: 'clamav', CLAMAV_PORT: 3310 }),
    );
    expect(clamav).toBeInstanceOf(ClamAvScanner);
    expect(clamav.engine).toBe('clamav');
  });

  it('the API and the worker cannot start in production on the fake: building DocumentsService throws', () => {
    expect(() => documentsWith(production())).toThrow(/MALWARE_SCANNER must be clamav/);
    expect(() => documentsWith(production({ MALWARE_SCANNER: 'clamav' }))).not.toThrow();
  });

  it('development and tests use the fake by default', () => {
    expect(malwareScannerFor(base)).toBeInstanceOf(FakeMalwareScanner);
    expect(malwareScannerFor({ ...base, NODE_ENV: 'test' })).toBeInstanceOf(FakeMalwareScanner);
    expect(() => documentsWith(base)).not.toThrow();
  });
});
