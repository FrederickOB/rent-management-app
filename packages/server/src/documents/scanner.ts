import { ClamAvScanner, FakeMalwareScanner, type MalwareScannerPort } from '@rent/integrations';
import type { AppConfig } from '../core/config';

/** M11 decision 6: an injected scanner for tests; otherwise the documents module makes its own. */
export const MALWARE_SCANNER = Symbol('MALWARE_SCANNER');

/** How long clamd may go quiet during one scan before the scan is abandoned (and retried). */
const CLAMAV_TIMEOUT_MS = 60_000;

/**
 * The configured scanner (M11 decision 6): clamd over TCP, or the fake that knows only the EICAR
 * test file. Production refuses the fake, so a deployment without a scanner does not start.
 */
export function malwareScannerFor(config: AppConfig): MalwareScannerPort {
  if (config.MALWARE_SCANNER === 'clamav')
    return new ClamAvScanner({
      host: config.CLAMAV_HOST,
      port: config.CLAMAV_PORT,
      timeoutMs: CLAMAV_TIMEOUT_MS,
    });
  if (config.NODE_ENV === 'production')
    throw new Error('MALWARE_SCANNER must be clamav in production (M11 decision 6)');
  return new FakeMalwareScanner();
}
