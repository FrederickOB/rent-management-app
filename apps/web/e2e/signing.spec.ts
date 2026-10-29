import { expect, test, type Download, type Page } from '@playwright/test';
import { DEV_LINKS_API_KEY, LINKS_API_KEY_HEADER } from '@rent/contracts';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  codeEmailedTo,
  codeTextedTo,
  handoverPath,
  issuedLease,
  MANAGER,
  managerApi,
  newProperty,
  pathOf,
  waitForSms,
} from '../../links/e2e/signing-support';
import { PEOPLE, ready, signIn, unique } from './helpers';
import { freshPhone, monthsFromToday, newPropertyWithUnits, termEnd } from './tenancy-helpers';

/** The no-login signing pages (apps/links), where every signer signs. */
const LINKS = (process.env.LINKS_ORIGIN ?? 'http://localhost:3702').replace(/\/+$/, '');

interface Draft {
  readonly leaseId: string;
  readonly unitCode: string;
  readonly tenant: { readonly name: string; readonly phone: string };
  readonly guarantor: { readonly name: string; readonly phone: string } | null;
}

/**
 * A tenant who agreed to SMS, optionally with a guarantor who did too, and a draft lease for them
 * on a new unit, made through the API as the signed-in manager. The lease starts in two months.
 * `witnessRequired` sets the witness rule on the draft itself, so a test never depends on the
 * company's default, which the settings spec changes while it runs.
 */
async function draftLease(
  page: Page,
  tag: string,
  options: { readonly guarantor: boolean; readonly witnessRequired?: boolean },
): Promise<Draft> {
  const { units } = await newPropertyWithUnits(page, 1);
  const tenant = { name: `Abla Signer ${tag} (e2e)`, phone: freshPhone() };
  const guarantor = options.guarantor
    ? { name: `Yaw Guarantor ${tag} (e2e)`, phone: freshPhone() }
    : null;
  const created = await page.request.post('/api/v1/tenants', {
    data: {
      kind: 'individual',
      displayName: tenant.name,
      phone: tenant.phone,
      consent: { sms: true },
      contacts: guarantor
        ? [
            {
              kind: 'guarantor',
              name: guarantor.name,
              phone: guarantor.phone,
              consent: { sms: true },
            },
          ]
        : [],
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const tenantId = ((await created.json()) as { tenant: { id: string } }).tenant.id;
  const start = monthsFromToday(2);
  const lease = await page.request.post('/api/v1/leases', {
    data: {
      unitId: units[0]!.id,
      tenantId,
      startDate: start,
      endDate: termEnd(start, 12),
      monthlyRentMinor: 120_000,
      cycle: 'monthly',
      noticeDays: 30,
      ...(options.witnessRequired === undefined
        ? {}
        : { witnessRequired: options.witnessRequired }),
    },
  });
  expect(lease.status(), await lease.text()).toBe(200);
  return {
    leaseId: ((await lease.json()) as { id: string }).id,
    unitCode: units[0]!.code,
    tenant,
    guarantor,
  };
}

/** Signs on the links page with a typed name and the code that reached the signer. */
async function signThrough(
  page: Page,
  path: string,
  name: string,
  code: (sentAfter: number) => Promise<string>,
) {
  const started = Date.now();
  await page.goto(`${LINKS}${path}`);
  await page
    .getByRole('button', { name: /send me a code|send a new code/i })
    .first()
    .click();
  await expect(page.getByLabel('Your 6-digit code')).toBeVisible();
  await page.getByLabel('Your 6-digit code').fill(await code(started));
  await page.getByLabel('Type your full name to sign').fill(name);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thank you: you have signed');
}

/** Hands a link over from the lease page, as staff would in person, and reads it from the copy field. */
async function handOver(page: Page, name: string): Promise<string> {
  const signer = page.getByTestId('signer').filter({ hasText: name });
  await signer.getByRole('button', { name: `Hand over a link to ${name}` }).click();
  const panel = signer.getByRole('group', { name: `Hand over a link to ${name}` });
  await expect(panel).toContainText('replaces any link they already have');
  await panel.getByRole('button', { name: 'Make the link' }).click();
  await expect(
    panel.getByRole('img', { name: `QR code of the signing link for ${name}` }),
  ).toBeVisible();
  const url = await panel.getByLabel(`Signing link for ${name}`).inputValue();
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel).toHaveCount(0);
  return pathOf(url);
}

test.describe('TL-07 issuing and signing', () => {
  test('a manager sends a lease for signing; the tenant, guarantor, landlord and witness sign through their links, with no printing', async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    const tag = unique();
    const witness = { name: `Esi Witness ${tag} (e2e)`, phone: freshPhone() };
    await signIn(page, PEOPLE.managerOne.email);
    const lease = await draftLease(page, tag, { guarantor: true, witnessRequired: true });

    // This draft asks for a witness: it cannot go without one.
    await page.goto(`/leases/${lease.leaseId}`);
    await ready(page, 'Send for signing');
    await page.getByRole('button', { name: 'Send for signing' }).click();
    let confirm = page.getByRole('group', { name: 'Send for signing' });
    await expect(confirm.getByTestId('issue-signer')).toHaveCount(3);
    await expect(confirm).toContainText('Add the witness who will sign');
    await expect(confirm.getByRole('button', { name: 'Send for signing' })).toBeDisabled();
    await confirm.getByRole('link', { name: 'Edit the draft' }).click();
    await ready(page, 'Save the draft');
    const edit = page.getByRole('form', { name: 'Edit the draft' });
    await edit.getByLabel('Add someone who signs as').selectOption({ label: 'Witness' });
    await edit.getByRole('button', { name: 'Add signer' }).click();
    const added = edit.getByTestId('party-row').last();
    await added.getByLabel('Name', { exact: true }).fill(witness.name);
    await added.getByLabel('Phone (optional)').fill(witness.phone);
    await edit.getByRole('button', { name: 'Save the draft' }).click();
    await expect(page.getByText('Saved the draft.')).toBeVisible();

    // Sending freezes the terms; the confirmation says so and lists the four signers.
    await page.getByRole('button', { name: 'Send for signing' }).click();
    confirm = page.getByRole('group', { name: 'Send for signing' });
    await expect(confirm).toContainText('Sending freezes the terms');
    await expect(confirm.getByTestId('issue-signer')).toHaveCount(4);
    await confirm.getByRole('button', { name: 'Send for signing' }).click();
    await expect(page.getByText('Sent for signing.')).toBeVisible();
    await expect(page.getByTestId('lease-status').first()).toHaveText('Waiting for signatures');
    await expect(page.getByRole('link', { name: 'Edit the draft' })).toHaveCount(0);

    // The worker renders the document and opens the request; the page checks every 15 seconds.
    const signing = page.getByTestId('signing');
    await expect(signing.getByTestId('signing-status')).toHaveText('Out for signature', {
      timeout: 90_000,
    });
    await expect(signing.getByTestId('signer')).toHaveCount(4);
    const witnessRow = signing.getByTestId('signer').filter({ hasText: witness.name });
    // The witness agreed to no channel, so nothing went out: staff hand the link over.
    await expect(witnessRow).toContainText('No link has gone out');
    await expect(
      signing.getByRole('button', { name: 'Download the document being signed' }),
    ).toBeVisible();

    const signer = await browser.newContext();
    try {
      const links = await signer.newPage();
      // The tenant and the guarantor got their links by SMS, where they agreed to messages.
      const tenantPath = pathOf(await waitForSms(lease.tenant.phone, /\/l\//));
      await signThrough(links, tenantPath, lease.tenant.name, (after) =>
        codeTextedTo(lease.tenant.phone, after),
      );
      const guarantorPath = pathOf(await waitForSms(lease.guarantor!.phone, /\/l\//));
      await signThrough(links, guarantorPath, lease.guarantor!.name, (after) =>
        codeTextedTo(lease.guarantor!.phone, after),
      );

      // The witness is handed a link in person; codes still go only to the phone on record.
      await page.getByTestId('signing').getByRole('button', { name: 'Refresh' }).click();
      await expect(
        signing
          .getByTestId('signer')
          .filter({ hasText: lease.tenant.name })
          .getByTestId('signer-state'),
      ).toHaveText('Signed');
      const witnessPath = await handOver(page, witness.name);
      await expect(witnessRow).toContainText('Link handed over in person');
      await signThrough(links, witnessPath, witness.name, (after) =>
        codeTextedTo(witness.phone, after),
      );

      // The landlord's signer is the manager, whose codes go by email.
      const landlordPath = await handOver(page, MANAGER.name);
      await signThrough(links, landlordPath, MANAGER.name, (after) =>
        codeEmailedTo(MANAGER.email, after),
      );
    } finally {
      await signer.close();
    }

    // The worker adds the certificate and the lease is signed; the page follows on its own.
    await expect(page.getByTestId('lease-status').first()).toHaveText('Signed', {
      timeout: 120_000,
    });
    await expect(signing.getByTestId('signing-status')).toHaveText('Everyone has signed');
    for (const name of [lease.tenant.name, lease.guarantor!.name, witness.name, MANAGER.name])
      await expect(
        signing.getByTestId('signer').filter({ hasText: name }).getByTestId('signer-state'),
      ).toHaveText('Signed');
    await expect(signing).toContainText('(Africa/Accra)');

    // Both fingerprints show, short, with the whole value to copy; the signed copy matches its own.
    const progress = (await (
      await page.request.get(`/api/v1/leases/${lease.leaseId}/signing`)
    ).json()) as { documentSha256: string; finalSha256: string };
    await expect(signing.getByTestId('document-sha256')).toHaveAttribute(
      'title',
      progress.documentSha256,
    );
    await expect(signing.getByTestId('final-sha256')).toHaveAttribute(
      'title',
      progress.finalSha256,
    );
    await expect(signing.getByTestId('final-sha256')).toContainText(
      progress.finalSha256.slice(0, 8),
    );
    // The button opens a 5-minute link in a new tab, which the browser saves as the PDF.
    const downloaded = new Promise<Download>((resolve) =>
      page.context().once('page', (tab) => tab.once('download', resolve)),
    );
    await signing.getByRole('button', { name: 'Download the signed copy' }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(`signed-lease-${lease.leaseId}.pdf`);
    const bytes = await readFile((await download.path())!);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(progress.finalSha256);
  });

  test('a manager recalls a lease out for signature: its links stop working and it is a draft again', async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    const tag = unique();
    await signIn(page, PEOPLE.managerOne.email);
    const lease = await draftLease(page, tag, { guarantor: false });
    expect(
      (
        await page.request.patch(`/api/v1/leases/${lease.leaseId}`, {
          data: { witnessRequired: false },
        })
      ).status(),
    ).toBe(200);

    await page.goto(`/leases/${lease.leaseId}`);
    await ready(page, 'Send for signing');
    await page.getByRole('button', { name: 'Send for signing' }).click();
    await page
      .getByRole('group', { name: 'Send for signing' })
      .getByRole('button', { name: 'Send for signing' })
      .click();
    const signing = page.getByTestId('signing');
    await expect(signing.getByTestId('signing-status')).toHaveText('Out for signature', {
      timeout: 90_000,
    });
    const tenantPath = pathOf(await waitForSms(lease.tenant.phone, /\/l\//));

    await signing.getByRole('button', { name: 'Recall the lease' }).click();
    const recall = page.getByRole('form', { name: 'Recall the lease' });
    await expect(recall).toContainText('Every signing link stops working');
    const reason = `The rent was typed wrongly ${tag}`;
    await recall.getByLabel('Reason (optional)').fill(reason);
    await recall.getByRole('button', { name: 'Recall the lease' }).click();
    await expect(page.getByText('Recalled. Every signing link has stopped working')).toBeVisible();
    await expect(page.getByTestId('lease-status').first()).toHaveText('Draft');
    // The latest request stays on the page, closed, with the reason given.
    await expect(signing.getByTestId('signing-status')).toHaveText('Recalled');
    await expect(signing).toContainText(reason);
    await expect(signing.getByRole('button', { name: /^Hand over/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send for signing' })).toBeVisible();

    const signer = await browser.newContext();
    try {
      const links = await signer.newPage();
      await links.goto(`${LINKS}${tenantPath}`);
      await expect(links.getByRole('heading', { level: 1 })).toHaveText(
        /This document is no longer out for signing|This link has been replaced/,
      );
      await expect(links.locator('form')).toHaveCount(0);
    } finally {
      await signer.close();
    }
  });

  test('a signer declines: the lease page follows, shows the decline with its reason, and the lease is a draft again', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const tag = unique();
    const tenantName = `Kojo Decliner ${tag} (e2e)`;
    const reason = `The rent is higher than we agreed ${tag}`;
    // Made through the API as the links e2e does: the tenant (by SMS), the manager for the
    // landlord and a witness, issued and opened by the worker.
    const api = await managerApi();
    try {
      const [unit] = await newProperty(api, 1);
      const lease = await issuedLease(api, unit!.id, tenantName);
      await signIn(page, PEOPLE.managerOne.email);
      await page.goto(`/leases/${lease.leaseId}`);
      const signing = page.getByTestId('signing');
      await expect(signing.getByTestId('signing-status')).toHaveText('Out for signature');

      // The tenant declines with a reason, through the links API as apps/links calls it.
      const token = (await handoverPath(api, lease, 'tenant')).slice('/l/'.length);
      const declined = await api.post('/links/decline', {
        headers: { [LINKS_API_KEY_HEADER]: DEV_LINKS_API_KEY },
        data: { token, client: { ip: '127.0.0.1', userAgent: 'web e2e (decline)' }, reason },
      });
      expect(declined.status(), await declined.text()).toBe(200);

      // The page checks again on its own and shows the lease back to draft.
      await expect(page.getByTestId('lease-status').first()).toHaveText('Draft', {
        timeout: 90_000,
      });
      await expect(page.getByText('A signer declined. The lease is back to draft.')).toBeVisible();
      await expect(signing).toContainText('Last signing request');
      await expect(signing.getByTestId('signing-status')).toHaveText('Declined');
      await expect(signing).toContainText(reason);
      const tenantRow = signing.getByTestId('signer').filter({ hasText: tenantName });
      await expect(tenantRow.getByTestId('signer-state')).toHaveText('Declined');
      await expect(tenantRow).toContainText(reason);
      // The others did not sign, and the closed request offers no links.
      await expect(
        signing.getByTestId('signer').filter({ hasText: MANAGER.name }).getByTestId('signer-state'),
      ).toHaveText('Did not sign');
      await expect(signing.getByRole('button', { name: /^Hand over/ })).toHaveCount(0);
      await expect(signing.getByRole('button', { name: 'Recall the lease' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Send for signing' })).toBeVisible();
    } finally {
      await api.dispose();
    }
  });
});
