import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    fakeProvidersUrl: string;
    fakePaymentsSecretKey: string;
    fakeWhatsAppAppSecret: string;
  }
}

export interface FakeProvidersContext {
  readonly baseUrl: string;
  readonly paymentsSecretKey: string;
  readonly whatsappAppSecret: string;
}

/**
 * The private `apps/fake-providers` instance started by the contracts-http project's global
 * setup (`fake-providers.global-setup.ts`). Only usable in that project.
 */
export function fakeProvidersContext(): FakeProvidersContext {
  return {
    baseUrl: inject('fakeProvidersUrl'),
    paymentsSecretKey: inject('fakePaymentsSecretKey'),
    whatsappAppSecret: inject('fakeWhatsAppAppSecret'),
  };
}

/** A message as `GET /messages` on the fake server returns it. */
export interface CapturedMessage {
  readonly id: string;
  readonly channel: string;
  readonly to: string;
  readonly body: string;
  readonly at: string;
  readonly meta?: Record<string, unknown>;
}

export async function capturedMessages(
  baseUrl: string,
  channel: 'sms' | 'whatsapp' | 'push',
): Promise<CapturedMessage[]> {
  const response = await fetch(`${baseUrl}/messages?channel=${channel}`);
  if (!response.ok) throw new Error(`GET /messages failed with HTTP ${response.status}`);
  return (await response.json()) as CapturedMessage[];
}
