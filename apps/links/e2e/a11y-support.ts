import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

/**
 * axe on a page (M11 plan 4.9, NFR-A11Y): the WCAG 2.2 A and AA rules. A serious or critical
 * violation fails the test; every violation, whatever its impact, is attached to the report.
 */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export async function expectAccessible(
  page: Page,
  testInfo: TestInfo,
  state: string,
): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  if (results.violations.length > 0)
    await testInfo.attach(`axe: ${state}`, {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });
  const blocking = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) =>
        `${v.impact} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join('; ')})`,
    );
  expect(blocking, `serious or critical axe violations on ${state}`).toEqual([]);
}
