/** Everything the fake providers remember. Kept in memory and lost on restart. */
export interface Captured {
  readonly id: string;
  readonly channel: 'sms' | 'whatsapp' | 'push' | 'email';
  readonly to: string;
  readonly body: string;
  readonly at: string;
  readonly meta?: Record<string, unknown>;
}

/** What a simulated tenant wrote to us, for the dev chat page. */
export interface FakeInbound {
  readonly id: string;
  readonly channel: 'whatsapp' | 'sms' | 'email';
  readonly from: string;
  readonly body: string;
  readonly at: string;
}

export interface FakeTemplate {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | 'DISABLED';
  readonly reason?: string;
}

export interface FakeMedia {
  readonly id: string;
  readonly contentType: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

export type FakePushReceipt =
  { readonly status: 'ok' } | { readonly status: 'error'; readonly error: string };

export interface FakeSubaccount {
  readonly code: string;
  readonly businessName: string;
  readonly settlementBank: string;
  readonly accountNumber: string;
  readonly at: string;
}

export interface FakeTransaction {
  readonly id: number;
  readonly reference: string;
  readonly accessCode: string;
  readonly requestedAmount: number;
  readonly currency: 'GHS';
  readonly channel: 'mobile_money' | 'card' | 'bank';
  readonly email: string;
  readonly phone?: string;
  readonly subaccount: string;
  readonly metadata: Record<string, string>;
  readonly createdAt: string;
  status: 'pending' | 'success' | 'failed' | 'abandoned' | 'reversed';
  /** Pesewas: the amount asked until paid, then the amount paid. */
  amount: number;
  fees: number;
  paidAt?: string;
  settlementId?: number;
  /** Refunded or charged back: deducted from the next settlement to its subaccount, once. */
  chargedBack?: { readonly amount: number; deductedIn?: number };
  /** Its refunds and disputes, as Paystack's refund and dispute APIs list them (M4b review). */
  reversals?: {
    readonly kind: 'refund' | 'dispute';
    readonly id: number;
    readonly amount: number;
    readonly createdAt: string;
  }[];
}

export interface FakeSettlement {
  readonly id: number;
  readonly subaccount: string;
  readonly totalAmount: number;
  readonly totalFees: number;
  readonly deductions: number;
  readonly effectiveAmount: number;
  readonly settledAt: string;
  readonly references: readonly string[];
  readonly deducted: readonly { readonly reference: string; readonly amount: number }[];
}

export interface FakeIdentityCheck {
  readonly checkId: string;
  readonly reference: string;
  readonly idType: 'ghana_card' | 'passport';
  /** Fake numbers only; masked wherever they are shown. */
  readonly idNumber: string;
  readonly createdAt: string;
  status: 'pending' | 'verified' | 'not_matched' | 'failed';
  checkedAt?: string;
  captured: boolean;
}

export interface WebhookDelivery {
  readonly at: string;
  readonly kind: 'payments' | 'whatsapp' | 'identity' | 'sms' | 'email';
  readonly event: string;
  readonly url: string;
  readonly status?: number;
  readonly error?: string;
}

export interface FakeStore {
  messages: Captured[];
  inbound: FakeInbound[];
  templates: Map<string, FakeTemplate>;
  media: Map<string, FakeMedia>;
  pushReceipts: Map<string, FakePushReceipt>;
  subaccounts: Map<string, FakeSubaccount>;
  transactions: Map<string, FakeTransaction>;
  settlements: FakeSettlement[];
  identityChecks: Map<string, FakeIdentityCheck>;
  webhooks: WebhookDelivery[];
}

export function createStore(): FakeStore {
  return {
    messages: [],
    inbound: [],
    templates: new Map(),
    media: new Map(),
    pushReceipts: new Map(),
    subaccounts: new Map(),
    transactions: new Map(),
    settlements: [],
    identityChecks: new Map(),
    webhooks: [],
  };
}

export function resetStore(store: FakeStore): void {
  store.messages.length = 0;
  store.inbound.length = 0;
  store.templates.clear();
  store.media.clear();
  store.pushReceipts.clear();
  store.subaccounts.clear();
  store.transactions.clear();
  store.settlements.length = 0;
  store.identityChecks.clear();
  store.webhooks.length = 0;
}
