import { providersToTry, type ProviderOption } from '@rent/domain/payments';
import {
  FakeProvidersPayments,
  InMemoryPayments,
  PaystackPayments,
  type PaymentsPort,
} from '@rent/integrations';
import type { AppConfig } from './config';

/** The fake provider's development key (apps/fake-providers), when FAKE_PAYMENTS_SECRET_KEY is unset. */
export const DEV_FAKE_PAYMENTS_SECRET_KEY = 'sk_test_fake_providers_dev_only';

/**
 * A provider rent may be charged through (BC-02; D1, D2; M4b decision 1). `settlesDirect` is
 * whether it settles straight into landlords' and agencies' accounts, confirmed in writing: one
 * that cannot is never tried, even as a failover.
 */
export interface ProviderEntry {
  readonly name: string;
  readonly port: PaymentsPort;
  readonly settlesDirect: boolean;
}

/**
 * The provider registry (plan 4.9): every provider this deployment is configured for, by the name
 * stored on intents, payments and subaccounts. Each company may set its own order (company
 * settings); otherwise the deployment's order applies.
 */
export class PaymentProviders {
  private readonly byName: ReadonlyMap<string, ProviderEntry>;

  constructor(
    entries: readonly ProviderEntry[],
    readonly defaultOrder: readonly string[] = entries.map((e) => e.name),
  ) {
    this.byName = new Map(entries.map((e) => [e.name, e]));
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  get(name: string): PaymentsPort {
    const entry = this.byName.get(name);
    if (!entry) throw new Error(`Payment provider ${name} is not configured`);
    return entry.port;
  }

  /** The providers to try for a company, in order, given those its account has subaccounts with. */
  order(
    companyOrder: readonly string[] | null,
    subaccountProviders: ReadonlySet<string>,
  ): string[] {
    const order = companyOrder ?? this.defaultOrder;
    const options: ProviderOption[] = [...this.byName.values()].map((e) => ({
      provider: e.name,
      configured: true,
      settlesDirect: e.settlesDirect,
      hasSubaccount: subaccountProviders.has(e.name),
    }));
    return providersToTry(order, options);
  }

  /** The providers subaccounts are created with: every configured one that settles directly. */
  settlingProviders(): string[] {
    return [...this.byName.values()].filter((e) => e.settlesDirect).map((e) => e.name);
  }
}

/**
 * The deployment's providers. Paystack when its key is set (a test key, unless live collection is
 * enabled: decision 3); otherwise the fake provider locally, standing in for Paystack under its
 * name; otherwise, outside production, an in-memory fake. Production without a key takes no
 * provider payments at all.
 */
export function paymentProvidersFor(config: AppConfig): PaymentProviders {
  if (config.PAYSTACK_SECRET_KEY)
    return new PaymentProviders([
      {
        name: 'paystack',
        port: new PaystackPayments({
          secretKey: config.PAYSTACK_SECRET_KEY,
          liveCollection: config.LIVE_RENT_COLLECTION,
        }),
        settlesDirect: true,
      },
    ]);
  if (config.FAKE_PROVIDERS_URL)
    return new PaymentProviders([
      {
        name: 'paystack',
        port: new FakeProvidersPayments(
          config.FAKE_PROVIDERS_URL,
          config.FAKE_PAYMENTS_SECRET_KEY || DEV_FAKE_PAYMENTS_SECRET_KEY,
        ),
        settlesDirect: true,
      },
    ]);
  if (config.NODE_ENV === 'production') return new PaymentProviders([]);
  return new PaymentProviders([
    {
      name: 'paystack',
      port: new InMemoryPayments('sk_test_in_memory', 'paystack'),
      settlesDirect: true,
    },
  ]);
}
