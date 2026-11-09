import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  deliverWebhook,
  e164,
  escapeHtml,
  hmacHex,
  htmlPage,
  invalid,
  selfUrl,
  type idGenerator,
} from './shared';
import type { FakeSettlement, FakeStore, FakeTransaction } from './store';

export interface PaymentsOptions {
  /** Authenticates API calls and signs webhooks, as Paystack's secret key does both. */
  readonly secretKey: string;
  readonly webhookUrl?: string;
}

const pesewas = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reference = z
  .string()
  .regex(/^[A-Za-z0-9.=-]{1,100}$/, 'reference may hold 1 to 100 letters, digits, -, . and =');

/** Paystack's `POST /transaction/initialize`, plus a MoMo phone so the prompt goes straight to it. */
const initializeSchema = z.object({
  reference,
  amount: pesewas,
  currency: z.literal('GHS'),
  email: z.email(),
  channels: z.array(z.enum(['mobile_money', 'card', 'bank'])).length(1),
  /** Left out only for a platform charge (M10 decision 9): see `checkSubaccount`. */
  subaccount: z.string().min(1).optional(),
  metadata: z
    .record(z.string(), z.string().max(500))
    .refine((m) => Object.keys(m).length <= 50, 'at most 50 metadata entries')
    .default({}),
  mobile_money: z.object({ phone: e164 }).optional(),
});

const subaccountSchema = z.object({
  business_name: z.string().trim().min(1).max(100),
  settlement_bank: z.string().trim().min(1).max(50),
  account_number: z.string().regex(/^\d{6,20}$/),
});

const rangeSchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});

/** Paystack's `POST /charge` for mobile money: the prompt goes straight to the phone. */
const chargeSchema = z.object({
  reference,
  amount: pesewas,
  currency: z.literal('GHS'),
  email: z.email(),
  /** Left out only for a platform charge (M10 decision 9): see `checkSubaccount`. */
  subaccount: z.string().min(1).optional(),
  metadata: z
    .record(z.string(), z.string().max(500))
    .refine((m) => Object.keys(m).length <= 50, 'at most 50 metadata entries')
    .default({}),
  mobile_money: z.object({ phone: e164, provider: z.enum(['mtn', 'vod', 'atl']).optional() }),
});

const refundSchema = z.object({ transaction: reference, amount: pesewas.optional() });

const externalSchema = z.object({
  subaccountCode: z.string().min(1),
  amountMinor: pesewas,
  channel: z.enum(['momo', 'card', 'bank']),
  payerPhone: e164.optional(),
  narration: z.string().max(200).optional(),
  feesMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

/** The platform's own charges (the subscription, M10 decision 9) carry this reference prefix. */
export const PLATFORM_REFERENCE_PREFIX = 'SUB-';

/** Fictional banks: never a real institution's code (ADR-008 tests and the seed). */
const BANKS = [
  { code: 'FAKEBANK1', name: 'Test Bank One' },
  { code: 'FAKEBANK2', name: 'Test Bank Two' },
];

const outcomeSchema = z.object({
  status: z.enum(['success', 'failed', 'abandoned']),
  amountMinor: pesewas.optional(),
  feesMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

function transactionView(tx: FakeTransaction) {
  return {
    id: tx.id,
    domain: 'test',
    status: tx.status,
    reference: tx.reference,
    amount: tx.amount,
    requested_amount: tx.requestedAmount,
    currency: tx.currency,
    channel: tx.channel,
    fees: tx.fees,
    paid_at: tx.paidAt ?? null,
    created_at: tx.createdAt,
    metadata: tx.metadata,
    customer: { email: tx.email, phone: tx.phone ?? null },
    // A platform charge names no subaccount (M10 decision 9), as Paystack shows it.
    subaccount: tx.subaccount ? { subaccount_code: tx.subaccount } : {},
  };
}

function settlementView(s: FakeSettlement) {
  return {
    id: s.id,
    status: 'success',
    currency: 'GHS',
    total_amount: s.totalAmount,
    total_fees: s.totalFees,
    deductions: s.deductions,
    effective_amount: s.effectiveAmount,
    settlement_date: s.settledAt,
    // The platform's own balance (M10 decision 9) is paid out with no subaccount.
    subaccount: s.subaccount ? { subaccount_code: s.subaccount } : null,
    deducted: s.deducted,
  };
}

const inRange = (at: string, range: { from: string; to: string }) => {
  const t = Date.parse(at);
  return t >= Date.parse(range.from) && t < Date.parse(range.to);
};

/**
 * Payments, shaped like Paystack (refined in M4b). Amounts are integer pesewas. Like Paystack,
 * only a successful charge sends a webhook (`charge.success`), signed with HMAC-SHA512 of the raw
 * body under the secret key in `x-paystack-signature`.
 */
export function registerPayments(
  app: FastifyInstance,
  store: FakeStore,
  ids: ReturnType<typeof idGenerator>,
  options: PaymentsOptions,
): void {
  type Outcome = z.infer<typeof outcomeSchema>;

  /**
   * Rent always names a known subaccount, so it settles to the landlord or agency (D1). A charge
   * with none is the platform's own revenue (M10 decision 9), which settles to the platform's
   * balance; this fake takes it only under the platform's reference prefix, so a rent charge that
   * lost its subaccount is refused rather than paid to the platform. Returns the refusal, if any.
   */
  const checkSubaccount = (ref: string, subaccount: string | undefined): string | null => {
    if (subaccount === undefined)
      return ref.startsWith(PLATFORM_REFERENCE_PREFIX) ? null : 'Subaccount required';
    return store.subaccounts.has(subaccount) ? null : 'Subaccount not found';
  };

  /** Applies an outcome to a pending charge; returns the signed webhook for a success. */
  const complete = async (tx: FakeTransaction, outcome: Outcome) => {
    const amount = outcome.amountMinor ?? tx.requestedAmount;
    const fees = outcome.feesMinor ?? 0;
    if (fees > amount) return { error: 'fees cannot exceed the amount' } as const;
    tx.status = outcome.status;
    if (outcome.status !== 'success') return { webhook: null, delivery: null } as const;
    tx.amount = amount;
    tx.fees = fees;
    tx.paidAt = new Date().toISOString();
    const rawBody = JSON.stringify({ event: 'charge.success', data: transactionView(tx) });
    const signature = hmacHex('sha512', options.secretKey, rawBody);
    const delivery = await deliverWebhook(
      store,
      'payments',
      'charge.success',
      options.webhookUrl,
      rawBody,
      {
        'x-paystack-signature': signature,
      },
    );
    return { webhook: { rawBody, signature }, delivery } as const;
  };

  // The provider's API sits behind the secret key, as Paystack's does.
  app.register(
    async (api) => {
      api.addHook('onRequest', async (request, reply) => {
        if (request.headers.authorization !== `Bearer ${options.secretKey}`) {
          return reply.code(401).send({ status: false, message: 'Invalid key' });
        }
      });

      api.post('/transaction/initialize', async (request, reply) => {
        const parsed = initializeSchema.safeParse(request.body);
        if (!parsed.success) return invalid(reply, parsed.error);
        const body = parsed.data;
        const refused = checkSubaccount(body.reference, body.subaccount);
        if (refused) return reply.code(400).send({ status: false, message: refused });
        if (store.transactions.has(body.reference)) {
          return reply
            .code(409)
            .send({ status: false, message: 'Duplicate Transaction Reference' });
        }
        const channel = body.channels[0] ?? 'card';
        const tx: FakeTransaction = {
          id: ids.nextNumber(),
          reference: body.reference,
          accessCode: ids.next('access'),
          requestedAmount: body.amount,
          currency: body.currency,
          channel,
          email: body.email,
          ...(body.mobile_money ? { phone: body.mobile_money.phone } : {}),
          subaccount: body.subaccount ?? '',
          metadata: body.metadata,
          createdAt: new Date().toISOString(),
          status: 'pending',
          amount: body.amount,
          fees: 0,
        };
        store.transactions.set(tx.reference, tx);
        if (channel === 'mobile_money' && tx.phone !== undefined) {
          return reply.send({
            status: true,
            message: 'Charge attempted',
            data: {
              reference: tx.reference,
              status: 'pay_offline',
              display_text: 'Approve the payment on your phone',
            },
          });
        }
        return reply.send({
          status: true,
          message: 'Authorization URL created',
          data: {
            reference: tx.reference,
            access_code: tx.accessCode,
            authorization_url: selfUrl(
              request,
              `/payments/checkout/${encodeURIComponent(tx.accessCode)}`,
            ),
          },
        });
      });

      api.post('/charge', async (request, reply) => {
        const parsed = chargeSchema.safeParse(request.body);
        if (!parsed.success) return invalid(reply, parsed.error);
        const body = parsed.data;
        const refused = checkSubaccount(body.reference, body.subaccount);
        if (refused) return reply.code(400).send({ status: false, message: refused });
        if (store.transactions.has(body.reference)) {
          return reply
            .code(409)
            .send({ status: false, message: 'Duplicate Transaction Reference' });
        }
        const tx: FakeTransaction = {
          id: ids.nextNumber(),
          reference: body.reference,
          accessCode: ids.next('access'),
          requestedAmount: body.amount,
          currency: body.currency,
          channel: 'mobile_money',
          email: body.email,
          phone: body.mobile_money.phone,
          subaccount: body.subaccount ?? '',
          metadata: body.metadata,
          createdAt: new Date().toISOString(),
          status: 'pending',
          amount: body.amount,
          fees: 0,
        };
        store.transactions.set(tx.reference, tx);
        return reply.send({
          status: true,
          message: 'Charge attempted',
          data: {
            reference: tx.reference,
            status: 'pay_offline',
            display_text: 'Approve the payment on your phone',
          },
        });
      });

      api.post('/refund', async (request, reply) => {
        const parsed = refundSchema.safeParse(request.body);
        if (!parsed.success) return invalid(reply, parsed.error);
        const tx = store.transactions.get(parsed.data.transaction);
        if (!tx) return reply.code(404).send({ status: false, message: 'Transaction not found' });
        if (tx.status !== 'success') {
          return reply
            .code(400)
            .send({ status: false, message: 'Transaction has been fully reversed' });
        }
        const amount = parsed.data.amount ?? tx.amount;
        if (amount > tx.amount) {
          return reply
            .code(400)
            .send({ status: false, message: 'Refund amount cannot exceed the transaction' });
        }
        tx.status = 'reversed';
        tx.chargedBack = { amount };
        const id = ids.nextNumber();
        (tx.reversals ??= []).push({
          kind: 'refund',
          id,
          amount,
          createdAt: new Date().toISOString(),
        });
        return reply.send({
          status: true,
          message: 'Refund has been queued for processing',
          data: {
            id,
            transaction: transactionView(tx),
            amount,
            currency: 'GHS',
            status: 'processed',
          },
        });
      });

      // Refunds and disputes: one charge's (Paystack's `transaction` filter, its id), or every
      // charge's made in a range (`from` and `to`).
      const reversalsOf = (query: unknown, kind: 'refund' | 'dispute') => {
        const q = query as { transaction?: string; from?: string; to?: string };
        const range = q.from && q.to ? { from: Date.parse(q.from), to: Date.parse(q.to) } : null;
        return [...store.transactions.values()]
          .filter((t) => q.transaction === undefined || t.id === Number(q.transaction))
          .flatMap((tx) =>
            (tx.reversals ?? [])
              .filter((r) => r.kind === kind)
              .filter((r) => {
                if (!range) return true;
                const at = Date.parse(r.createdAt);
                return at >= range.from && at < range.to;
              })
              .map((r) => ({ tx, r })),
          );
      };
      api.get('/refund', async (request, reply) =>
        reply.send({
          status: true,
          message: 'Refunds retrieved',
          data: reversalsOf(request.query, 'refund').map(({ tx, r }) => ({
            id: r.id,
            transaction: { id: tx.id, reference: tx.reference },
            dispute: null,
            amount: r.amount,
            deducted_amount: tx.chargedBack?.deductedIn === undefined ? 0 : r.amount,
            currency: 'GHS',
            status: 'processed',
            settlement: tx.chargedBack?.deductedIn ?? null,
            created_at: r.createdAt,
          })),
        }),
      );
      api.get('/dispute', async (request, reply) =>
        reply.send({
          status: true,
          message: 'Disputes retrieved',
          data: reversalsOf(request.query, 'dispute').map(({ tx, r }) => ({
            id: r.id,
            refund_amount: r.amount,
            currency: 'GHS',
            status: 'resolved',
            resolution: 'merchant-accepted',
            transaction: { id: tx.id, reference: tx.reference },
            created_at: r.createdAt,
          })),
        }),
      );

      api.get('/bank', async (_request, reply) =>
        reply.send({ status: true, message: 'Banks retrieved', data: BANKS }),
      );

      api.get('/bank/resolve', async (request, reply) => {
        const parsed = z
          .object({ account_number: z.string().regex(/^\d{6,20}$/), bank_code: z.string() })
          .safeParse(request.query);
        if (!parsed.success) return invalid(reply, parsed.error);
        if (!BANKS.some((b) => b.code === parsed.data.bank_code)) {
          return reply.code(400).send({ status: false, message: 'Unknown bank code' });
        }
        // An account ending 0000 cannot be checked, as some banks cannot.
        if (parsed.data.account_number.endsWith('0000')) {
          return reply.code(422).send({ status: false, message: 'Could not resolve account name' });
        }
        return reply.send({
          status: true,
          message: 'Account number resolved',
          data: {
            account_number: parsed.data.account_number,
            account_name: `TEST ACCOUNT ${parsed.data.account_number.slice(-4)}`,
          },
        });
      });

      api.get<{ Params: { reference: string } }>(
        '/transaction/verify/:reference',
        async (request, reply) => {
          const tx = store.transactions.get(request.params.reference);
          if (!tx) {
            return reply
              .code(404)
              .send({ status: false, message: 'Transaction reference not found' });
          }
          return reply.send({
            status: true,
            message: 'Verification successful',
            data: transactionView(tx),
          });
        },
      );

      api.get('/transaction', async (request, reply) => {
        const parsed = rangeSchema.safeParse(request.query);
        if (!parsed.success) return invalid(reply, parsed.error);
        const data = [...store.transactions.values()]
          .filter((tx) => inRange(tx.createdAt, parsed.data))
          .map(transactionView);
        return reply.send({
          status: true,
          message: 'Transactions retrieved',
          data,
          meta: { total: data.length, page: 1, pageCount: 1 },
        });
      });

      api.get('/settlement', async (request, reply) => {
        const parsed = rangeSchema.safeParse(request.query);
        if (!parsed.success) return invalid(reply, parsed.error);
        const data = store.settlements
          .filter((s) => inRange(s.settledAt, parsed.data))
          .map(settlementView);
        return reply.send({ status: true, message: 'Settlements retrieved', data });
      });

      api.get<{ Params: { id: string } }>(
        '/settlement/:id/transactions',
        async (request, reply) => {
          const settlement = store.settlements.find((s) => String(s.id) === request.params.id);
          if (!settlement) {
            return reply.code(404).send({ status: false, message: 'Settlement not found' });
          }
          const data = settlement.references.flatMap((ref) => {
            const tx = store.transactions.get(ref);
            return tx ? [transactionView(tx)] : [];
          });
          return reply.send({ status: true, message: 'Settlement transactions retrieved', data });
        },
      );

      api.post('/subaccount', async (request, reply) => {
        const parsed = subaccountSchema.safeParse(request.body);
        if (!parsed.success) return invalid(reply, parsed.error);
        const code = `ACCT_${ids.next('fake').replaceAll('-', '')}`;
        store.subaccounts.set(code, {
          code,
          businessName: parsed.data.business_name,
          settlementBank: parsed.data.settlement_bank,
          accountNumber: parsed.data.account_number,
          at: new Date().toISOString(),
        });
        return reply.code(201).send({
          status: true,
          message: 'Subaccount created',
          data: {
            subaccount_code: code,
            business_name: parsed.data.business_name,
            settlement_bank: parsed.data.settlement_bank,
          },
        });
      });
    },
    { prefix: '/payments' },
  );

  // Test controls and the fake checkout page: not part of Paystack's API, so no key.
  app.post<{ Params: { reference: string } }>(
    '/payments/_test/charges/:reference',
    async (request, reply) => {
      const parsed = outcomeSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const tx = store.transactions.get(request.params.reference);
      if (!tx) return reply.code(404).send({ error: 'transaction not found' });
      if (tx.status !== 'pending') {
        return reply.code(409).send({ error: 'charge already completed' });
      }
      const result = await complete(tx, parsed.data);
      if ('error' in result) return reply.code(400).send({ error: result.error });
      return reply.send({ reference: tx.reference, status: tx.status, ...result });
    },
  );

  /** The payer's bank charges a paid charge back: reversed, deducted next settlement, webhook sent. */
  app.post<{ Params: { reference: string } }>(
    '/payments/_test/chargebacks/:reference',
    async (request, reply) => {
      const tx = store.transactions.get(request.params.reference);
      if (!tx) return reply.code(404).send({ error: 'transaction not found' });
      if (tx.status !== 'success') {
        return reply.code(409).send({ error: 'only a paid charge is disputed' });
      }
      const asked = (request.body as { amount?: unknown } | undefined)?.amount;
      const amount =
        typeof asked === 'number' && Number.isSafeInteger(asked) && asked > 0 && asked <= tx.amount
          ? asked
          : tx.amount;
      if (amount === tx.amount) tx.status = 'reversed';
      tx.chargedBack = { amount };
      const disputeId = ids.nextNumber();
      (tx.reversals ??= []).push({
        kind: 'dispute',
        id: disputeId,
        amount,
        createdAt: new Date().toISOString(),
      });
      const rawBody = JSON.stringify({
        event: 'charge.dispute.resolve',
        data: {
          id: disputeId,
          status: 'resolved',
          resolution: 'merchant-accepted',
          refund_amount: amount,
          currency: 'GHS',
          transaction: { id: tx.id, reference: tx.reference },
        },
      });
      const signature = hmacHex('sha512', options.secretKey, rawBody);
      await deliverWebhook(
        store,
        'payments',
        'charge.dispute.resolve',
        options.webhookUrl,
        rawBody,
        {
          'x-paystack-signature': signature,
        },
      );
      return reply.send({ reference: tx.reference, webhook: { rawBody, signature } });
    },
  );

  /** A successful payment to a subaccount that did not start on our pay page (the unmatched queue). */
  app.post('/payments/_test/external', async (request, reply) => {
    const parsed = externalSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const body = parsed.data;
    if (!store.subaccounts.has(body.subaccountCode)) {
      return reply.code(400).send({ error: 'subaccount not found' });
    }
    const id = ids.nextNumber();
    const tx: FakeTransaction = {
      id,
      reference: `ext-${id}`,
      accessCode: ids.next('access'),
      requestedAmount: body.amountMinor,
      currency: 'GHS',
      channel: body.channel === 'momo' ? 'mobile_money' : body.channel,
      email: `payer-${id}@example.test`,
      ...(body.payerPhone ? { phone: body.payerPhone } : {}),
      subaccount: body.subaccountCode,
      metadata: body.narration ? { narration: body.narration } : {},
      createdAt: new Date().toISOString(),
      status: 'pending',
      amount: body.amountMinor,
      fees: 0,
    };
    store.transactions.set(tx.reference, tx);
    const result = await complete(tx, {
      status: 'success',
      ...(body.feesMinor === undefined ? {} : { feesMinor: body.feesMinor }),
    });
    if ('error' in result || !result.webhook)
      return reply.code(400).send({ error: 'not completed' });
    return reply.send({ reference: tx.reference, webhook: result.webhook });
  });

  /**
   * Pays out every successful charge not yet settled, one settlement per subaccount, less the
   * chargebacks and refunds not yet deducted (OQ-41).
   */
  app.post('/payments/_test/settle', async (_request, reply) => {
    const due = new Map<string, { paid: FakeTransaction[]; back: FakeTransaction[] }>();
    const group = (code: string) => {
      const found = due.get(code) ?? { paid: [], back: [] };
      due.set(code, found);
      return found;
    };
    for (const tx of store.transactions.values()) {
      const back = tx.chargedBack && tx.chargedBack.deductedIn === undefined;
      if (
        tx.settlementId === undefined &&
        (tx.status === 'success' || (tx.status === 'reversed' && back))
      )
        group(tx.subaccount).paid.push(tx);
      if (back && (tx.settlementId !== undefined || tx.status === 'reversed'))
        group(tx.subaccount).back.push(tx);
    }
    const settledAt = new Date().toISOString();
    const created = [...due].map(([subaccount, { paid, back }]): FakeSettlement => {
      const totalAmount = paid.reduce((sum, tx) => sum + tx.amount, 0);
      const totalFees = paid.reduce((sum, tx) => sum + tx.fees, 0);
      const deducted = back.map((tx) => ({
        reference: tx.reference,
        amount: tx.chargedBack!.amount,
      }));
      const deductions = deducted.reduce((sum, d) => sum + d.amount, 0);
      const settlement: FakeSettlement = {
        id: ids.nextNumber(),
        subaccount,
        totalAmount,
        totalFees,
        deductions,
        effectiveAmount: totalAmount - totalFees - deductions,
        settledAt,
        references: paid.map((tx) => tx.reference),
        deducted,
      };
      for (const tx of paid) tx.settlementId = settlement.id;
      for (const tx of back)
        tx.chargedBack = { amount: tx.chargedBack!.amount, deductedIn: settlement.id };
      return settlement;
    });
    store.settlements.push(...created);
    return reply.send({
      settlements: created.map((s) => ({ ...settlementView(s), references: s.references })),
    });
  });

  app.get<{ Params: { accessCode: string } }>(
    '/payments/checkout/:accessCode',
    async (request, reply) => {
      const tx = [...store.transactions.values()].find(
        (t) => t.accessCode === request.params.accessCode,
      );
      if (!tx) return reply.code(404).send({ error: 'checkout not found' });
      const action = `/payments/checkout/${encodeURIComponent(tx.accessCode)}`;
      const choice =
        tx.status === 'pending'
          ? `<form method="post" action="${escapeHtml(action)}"><button name="status" value="success">Pay</button><button name="status" value="failed">Decline</button></form>`
          : `<p>This charge is already <strong>${escapeHtml(tx.status)}</strong>.</p>`;
      return htmlPage(
        reply,
        'Fake checkout',
        `<h1>Fake checkout</h1><p class="note">A stand-in for the provider's payment page. No money moves.</p>
<table><tr><th>Reference</th><td>${escapeHtml(tx.reference)}</td></tr><tr><th>Amount (pesewas)</th><td>${tx.requestedAmount}</td></tr><tr><th>Channel</th><td>${escapeHtml(tx.channel)}</td></tr></table>${choice}`,
      );
    },
  );

  app.post<{ Params: { accessCode: string }; Body: Record<string, string> | undefined }>(
    '/payments/checkout/:accessCode',
    async (request, reply) => {
      const tx = [...store.transactions.values()].find(
        (t) => t.accessCode === request.params.accessCode,
      );
      if (!tx) return reply.code(404).send({ error: 'checkout not found' });
      const status = request.body?.status === 'success' ? 'success' : 'failed';
      if (tx.status === 'pending') await complete(tx, { status });
      return htmlPage(
        reply,
        'Fake checkout',
        `<h1>Fake checkout</h1><p>The charge is now <strong>${escapeHtml(tx.status)}</strong>. You can close this page.</p>`,
      );
    },
  );
}
