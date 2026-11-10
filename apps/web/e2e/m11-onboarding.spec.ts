import { expect, test } from '@playwright/test';
import { onboardingWorkbookHeaders } from '@rent/domain/onboarding';
import { IMPORT_SHEETS, PROPERTY_COLUMNS, UNIT_COLUMNS } from '@rent/domain/portfolio';
import { BATCH_STATUS_LABELS } from '../lib/onboarding';
import { unique } from './helpers';
import {
  acceptInvitation,
  batchStatus,
  chooseWorkbook,
  inviteManager,
  workbook,
} from './onboarding-support';
import { fixture, smsIds } from './register-helpers';
import { firstAdmin, ok, onboard, platformAdmin } from './subscription-support';
import { cedis } from './tax-helpers';
import { freshPhone, monthsFromToday, termEnd, today } from './tenancy-helpers';

/**
 * M11 plan section 6, end to end (web): onboarding in three steps, approved by a second person
 * (decisions 2 and 3; P25). A fresh agency's admin sets the cut-over, imports the register (with
 * its Owners sheet), then the tenants and leases, then opening balances; the preview shows the
 * lease and the owner as they will be; a second, unscoped manager approves; the balances post.
 * No tenant is messaged. The imported lease's scan follows on its lease page.
 *
 * The workbooks are built at run time from the constants the template generator uses
 * (`onboardingWorkbookHeaders`, and the register's PROPERTY_COLUMNS and UNIT_COLUMNS).
 *
 * What it relies on (the server is the backend's phase B):
 * - P1. The second approver: the admin invites a manager. The invite waits for approval (founder
 *   D1); with nobody else to approve, the API's test control ends OQ-29's cooling-off and the
 *   admin self-confirms with a fresh code (`inviteManager`). The manager then accepts and enrols.
 * - P2. A new agency's first owner takes the reference the workbook gives (`OWN-01`).
 * - P3. Approvals lists the `opening_balances` request with an Approve button, as for others.
 */

test.describe.configure({ timeout: 360_000 });

/** A sheet's rows by header, from a record keyed by header. */
const sheet = (
  name: string,
  headers: readonly string[],
  rows: Record<string, string | number>[],
) => ({
  name,
  headers,
  rows,
});

test.describe('P25 onboarding: three workbooks, previewed, approved by a second person', () => {
  test('the register, tenancies and opening balances go in; the preview matches; a manager approves; nothing is sent to a tenant', async ({
    browser,
    baseURL,
  }) => {
    const platform = await platformAdmin(browser, baseURL);
    const company = await onboard(platform.page, { kind: 'agency', tier: 'growth', trialDays: 0 });
    const admin = await firstAdmin(browser, baseURL, company);
    const invited = await inviteManager(admin, platform.page);
    await platform.context.close();
    const manager = await acceptInvitation(browser, baseURL, invited.email, invited.name);
    try {
      const page = admin.page;
      const tag = unique();
      const part = `Q${tag.slice(-3)}`;
      const propertyCode = `ACC-${part}`;
      const unitCode = `${propertyCode}-B1-01`;
      const tenantName = `Esi Imported ${tag} (e2e)`;
      const tenantPhone = freshPhone();
      const ownerName = `Yaw Owner ${tag} (e2e)`;
      const cutOver = today();
      const leaseStart = monthsFromToday(-3);

      // The cut-over first: every opening balance is dated it.
      await page.goto('/onboarding');
      const cut = page.getByRole('form', { name: 'Set the cut-over date' });
      await cut.getByLabel('Cut-over date').fill(cutOver);
      await cut.getByRole('button', { name: 'Set the cut-over' }).click();
      await expect(page.getByTestId('cut-over-text')).toContainText('Cut-over');

      // Step 1, the register: an owner, a property and a unit.
      const owners = onboardingWorkbookHeaders('register')[0]!;
      const register = await workbook([
        sheet(owners.sheet, owners.headers, [
          {
            'Owner reference': 'OWN-01',
            Kind: 'Individual',
            Name: ownerName,
          },
        ]),
        sheet(
          IMPORT_SHEETS.properties,
          PROPERTY_COLUMNS.map((c) => c.header),
          [
            {
              'Property code': propertyCode,
              Name: `Imported rooms ${tag} (e2e)`,
              'Property type': 'Compound house',
              Use: 'Residential',
              'Owner reference': 'OWN-01',
              Region: 'Greater Accra',
            },
          ],
        ),
        sheet(
          IMPORT_SHEETS.units,
          UNIT_COLUMNS.map((c) => c.header),
          [
            {
              'Property code': propertyCode,
              'Block code': 'B1',
              Unit: '01',
              'Unit type': 'Single room',
            },
          ],
        ),
      ]);
      const step1 = page.getByTestId('onboarding-step-register');
      await chooseWorkbook(step1.getByLabel('Filled-in template'), 'register.xlsx', register);
      await step1.getByRole('button', { name: 'Check the file' }).click();
      await expect(step1.getByTestId('import-status')).toHaveText('Checked: ready to import', {
        timeout: 60_000,
      });
      await expect(step1.getByTestId('counts-owners')).toBeVisible();
      await step1.getByRole('button', { name: 'Import', exact: true }).click();
      await expect(step1.getByTestId('import-status')).toHaveText('Imported', { timeout: 60_000 });

      // Step 2, tenancies: the tenant and the lease signed on paper, with no scan yet.
      const [tenants, leases] = onboardingWorkbookHeaders('tenancies');
      const tenancies = await workbook([
        sheet(tenants!.sheet, tenants!.headers, [
          { Kind: 'Individual', Name: tenantName, Phone: tenantPhone, 'SMS consent': 'Yes' },
        ]),
        sheet(leases!.sheet, leases!.headers, [
          {
            Unit: unitCode,
            'Tenant phone': tenantPhone,
            'Start date': leaseStart,
            'End date': termEnd(leaseStart, 12),
            'Monthly rent': '500',
            'Rent cycle': 'Monthly',
            Deposit: '1000',
            'Notice days': '30',
            'Signed on': leaseStart,
          },
        ]),
      ]);
      const before = await smsIds(page.request, tenantPhone);
      const step2 = page.getByTestId('batch-tenancies');
      await chooseWorkbook(step2.getByLabel(/Filled-in workbook/), 'tenancies.xlsx', tenancies);
      await step2.getByRole('button', { name: 'Check the workbook' }).click();
      await batchStatus(step2, BATCH_STATUS_LABELS.validated);
      await step2.getByRole('button', { name: 'Write the tenants and leases' }).click();
      await batchStatus(step2, BATCH_STATUS_LABELS.committed);
      await expect(step2).toContainText('No tenant was sent anything.');

      // Step 3, opening balances: a month owed, the deposit held, and the owner's items.
      const balanceSheets = onboardingWorkbookHeaders('balances');
      const rows: Record<string, Record<string, string | number>[]> = {
        Arrears: [
          {
            Unit: unitCode,
            'Lease start': leaseStart,
            'Period start': monthsFromToday(-1),
            Kind: 'Rent',
            Amount: '500',
            'Due date': monthsFromToday(-1),
          },
        ],
        Deposits: [{ Unit: unitCode, 'Lease start': leaseStart, 'Amount held': '1000' }],
        'Owner items': [
          {
            'Owner reference': 'OWN-01',
            'Agent-held cash': '200',
            'Rent tax outstanding': '40',
            'Rent tax due date': cutOver,
          },
        ],
      };
      const balances = await workbook(
        balanceSheets.map((s) => sheet(s.sheet, s.headers, rows[s.sheet] ?? [])),
      );
      const step3 = page.getByTestId('batch-balances');
      await chooseWorkbook(step3.getByLabel(/Filled-in workbook/), 'balances.xlsx', balances);
      await step3.getByRole('button', { name: 'Check the workbook' }).click();
      await batchStatus(step3, BATCH_STATUS_LABELS.validated);

      // The preview shows the lease and the owner as they will be, to check against the books.
      const lease = step3.getByTestId('preview-lease').filter({ hasText: unitCode });
      await expect(lease).toContainText(tenantName);
      await expect(lease.getByTestId('preview-balance')).toContainText(cedis(50_000));
      await expect(lease.getByTestId('preview-balance')).toContainText('owes');
      await expect(lease).toContainText(cedis(100_000));
      const owner = step3.getByTestId('preview-owner').filter({ hasText: ownerName });
      await expect(owner).toContainText(cedis(20_000));
      await expect(owner).toContainText(cedis(4_000));

      // Committing asks a second person; nothing posts until then.
      await step3.getByRole('button', { name: 'Ask for approval to post' }).click();
      await batchStatus(step3, BATCH_STATUS_LABELS.awaiting_approval);
      const batches = await ok<{ id: string; approval: { requestId: string } | null }[]>(
        await page.request.get('/api/v1/onboarding/batches?kind=balances'),
        'list the balances batches',
      );
      const requestId = batches[0]!.approval!.requestId;

      // The manager approves in Approvals; the initiator never can.
      await manager.page.goto('/approvals');
      const request = manager.page.locator(`[data-approval-id="${requestId}"]`);
      await request.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(manager.page.getByText('It has taken effect.')).toBeVisible();

      await page.goto('/onboarding');
      await batchStatus(page.getByTestId('batch-balances'), BATCH_STATUS_LABELS.posted);

      // An import never messages tenants.
      expect(
        [...(await smsIds(page.request, tenantPhone))].filter((id) => !before.has(id)),
      ).toEqual([]);

      // The lease's scan follows on its lease page, and it leaves the list.
      const missing = page.getByTestId('missing-scan-row').filter({ hasText: unitCode });
      await missing.getByRole('link', { name: unitCode }).click();
      const scan = page.getByTestId('scan-to-follow');
      await scan.getByLabel('The signed lease, scanned').setInputFiles(fixture('title-deed.pdf'));
      await scan.getByLabel('This file has no ID card or passport copy').check();
      await scan.getByRole('button', { name: 'Attach the scan' }).click();
      await expect(page.getByText('The signed scan is attached to the lease.')).toBeVisible();
      await page.goto('/onboarding');
      await expect(page.getByTestId('missing-scan-row').filter({ hasText: unitCode })).toHaveCount(
        0,
      );
    } finally {
      await manager.context.close();
      await admin.context.close();
    }
  });
});
