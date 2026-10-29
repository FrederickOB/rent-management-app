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
  subaccount: z.string().min(1),
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
    subaccount: { subaccount_code: tx.subaccount },
  };
}

function settlementView(s: FakeSettlement) {
  return {
    id: s.id,
    status: 'success',
    currency: 'GHS',
    total_amount: s.totalAmount,
    total_fees: s.totalFees,
    effective_amount: s.effectiveAmount,
    settlement_date: s.settledAt,
    subaccount: { subaccount_code: s.subaccount },
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
        if (!store.subaccounts.has(body.subaccount)) {
          return reply.code(400).send({ status: false, message: 'Subaccount not found' });
        }
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
          subaccount: body.subaccount,
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

  /** Pays out every successful charge not yet settled, one settlement per subaccount. */
  app.post('/payments/_test/settle', async (_request, reply) => {
    const due = new Map<string, FakeTransaction[]>();
    for (const tx of store.transactions.values()) {
      if (tx.status !== 'success' || tx.settlementId !== undefined) continue;
      due.set(tx.subaccount, [...(due.get(tx.subaccount) ?? []), tx]);
    }
    const settledAt = new Date().toISOString();
    const created = [...due].map(([subaccount, txs]): FakeSettlement => {
      const totalAmount = txs.reduce((sum, tx) => sum + tx.amount, 0);
      const totalFees = txs.reduce((sum, tx) => sum + tx.fees, 0);
      const settlement: FakeSettlement = {
        id: ids.nextNumber(),
        subaccount,
        totalAmount,
        totalFees,
        effectiveAmount: totalAmount - totalFees,
        settledAt,
        references: txs.map((tx) => tx.reference),
      };
      for (const tx of txs) tx.settlementId = settlement.id;
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
