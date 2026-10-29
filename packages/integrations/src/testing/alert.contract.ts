import { beforeEach, describe, expect, it } from 'vitest';
import type { AlertPort } from '../alert/alert';
import { uniqueReference } from './fixtures';

export interface AlertHarness {
  readonly port: AlertPort;
  /** Each alert as delivered (a log entry, an email), as text. */
  delivered(): Promise<readonly string[]>;
}

/** What every alert adapter must do. */
export function alertContract(
  adapter: string,
  makeHarness: () => AlertHarness | Promise<AlertHarness>,
): void {
  describe(`PLATFORM integration contracts: alerts (${adapter})`, () => {
    let h: AlertHarness;
    beforeEach(async () => {
      h = await makeHarness();
    });

    it('delivers a critical alert with its severity, code and message', async () => {
      const code = `jobs.dead_letter.${uniqueReference('t')}`;
      await h.port.raise({
        severity: 'critical',
        code,
        message: 'Job payments.verify gave up after 10 tries',
      });
      const text = (await h.delivered()).find((d) => d.includes(code));
      expect(text).toBeDefined();
      expect(text?.toLowerCase()).toContain('critical');
      expect(text).toContain('Job payments.verify gave up after 10 tries');
    });

    it('delivers a warning with its context', async () => {
      const code = `reconciliation.difference.${uniqueReference('t')}`;
      await h.port.raise({
        severity: 'warning',
        code,
        message: 'Settlement differs',
        context: { settlementId: 'stl-42', differenceMinor: 150 },
      });
      const text = (await h.delivered()).find((d) => d.includes(code));
      expect(text?.toLowerCase()).toContain('warning');
      expect(text).toContain('stl-42');
    });

    it('refuses an alert without a code', async () => {
      await expect(
        h.port.raise({ severity: 'warning', code: ' ', message: 'no code' }),
      ).rejects.toThrow();
    });
  });
}
