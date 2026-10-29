import { expect, test, type APIRequestContext } from '@playwright/test';

const FAKE = process.env.FAKE_PROVIDERS_URL ?? 'http://localhost:4010';
const TENANT_PHONE = '+233200000021'; // seeded demo tenant (pnpm db:seed)

async function latestCode(request: APIRequestContext): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await request.get(
      `${FAKE}/messages?channel=sms&to=${encodeURIComponent(TENANT_PHONE)}`,
    );
    const messages = (await response.json()) as { body: string }[];
    const code = messages[0] && /\b(\d{6})\b/.exec(messages[0].body)?.[1];
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('No sign-in code reached the fake SMS provider');
}

test.describe('AD-06 tenant phone sign-in in the Expo web build', () => {
  test('a seeded tenant signs in with the code sent through the fake SMS provider', async ({
    page,
    request,
  }) => {
    await request.delete(`${FAKE}/messages`);
    await page.goto('/');
    await expect(page.getByTestId('phone-input')).toBeVisible();
    await page.getByTestId('phone-input').fill('020 000 0021');
    await page.getByTestId('send-code').click();

    await expect(page.getByTestId('code-input')).toBeVisible();
    await page.getByTestId('code-input').fill(await latestCode(request));
    await page.getByTestId('verify-code').click();

    await expect(page.getByText('Hello, Ama Tenant (demo)')).toBeVisible();
    await page.getByTestId('open-profile').click();
    await expect(page.getByText(/Signed in/).first()).toBeVisible();
    await page.getByTestId('sign-out').click();
    await expect(page.getByTestId('phone-input')).toBeVisible();
  });
});
