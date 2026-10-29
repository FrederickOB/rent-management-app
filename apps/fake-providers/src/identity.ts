import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deliverWebhook, escapeHtml, htmlPage, invalid, selfUrl, type idGenerator } from './shared';
import type { FakeIdentityCheck, FakeStore } from './store';

export interface IdentityOptions {
  readonly webhookUrl?: string;
}

const ID_FORMATS = { ghana_card: /^GHA-\d{9}-\d$/, passport: /^[A-Z0-9]{6,12}$/ } as const;

// Strict: a request carrying anything else, such as an image of the card, is refused (CLAUDE.md section 10).
const startSchema = z
  .strictObject({
    id_type: z.enum(['ghana_card', 'passport']),
    id_number: z.string().trim().toUpperCase().max(32),
    reference: z.string().min(1).max(100),
  })
  .refine((v) => ID_FORMATS[v.id_type].test(v.id_number), 'ID number does not match its type');

/**
 * The fake outcome, from the last character of the ID number: 0 not_matched, 9 failed (provider or
 * NIA unavailable), 8 never completes (stays pending), anything else verified. No real check runs.
 */
function outcomeFor(idNumber: string): FakeIdentityCheck['status'] {
  switch (idNumber.at(-1)) {
    case '0':
      return 'not_matched';
    case '9':
      return 'failed';
    case '8':
      return 'pending';
    default:
      return 'verified';
  }
}

/** Shows enough of a fake ID number to tell checks apart: GHA-*******89-0. */
export function maskIdNumber(idNumber: string): string {
  const card = /^GHA-(\d{9})-(\d)$/.exec(idNumber);
  if (card?.[1]) return `GHA-*******${card[1].slice(7)}-${card[2] ?? ''}`;
  return `${'*'.repeat(Math.max(idNumber.length - 3, 0))}${idNumber.slice(-3)}`;
}

/**
 * Identity checks: an ID number plus a selfie matched against NIA records. The capture page takes no
 * picture at all: it only simulates the person finishing the selfie. It never asks for the card.
 */
export function registerIdentity(
  app: FastifyInstance,
  store: FakeStore,
  ids: ReturnType<typeof idGenerator>,
  options: IdentityOptions,
): void {
  const resultView = (check: FakeIdentityCheck) => ({
    check_id: check.checkId,
    status: check.status,
    checked_at: check.checkedAt ?? null,
  });

  const capture = async (check: FakeIdentityCheck) => {
    check.captured = true;
    const outcome = outcomeFor(check.idNumber);
    if (outcome === 'pending') return { webhook: null, delivery: null };
    check.status = outcome;
    check.checkedAt = new Date().toISOString();
    const webhook = {
      event: 'identity.check.completed',
      check_id: check.checkId,
      status: outcome,
      checked_at: check.checkedAt,
      reference: check.reference,
    };
    const delivery = await deliverWebhook(
      store,
      'identity',
      webhook.event,
      options.webhookUrl,
      JSON.stringify(webhook),
      {},
    );
    return { webhook, delivery };
  };

  app.post('/identity/checks', async (request, reply) => {
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const { id_type: idType, id_number: idNumber, reference } = parsed.data;
    const existing = [...store.identityChecks.values()].find((c) => c.reference === reference);
    if (existing && (existing.idType !== idType || existing.idNumber !== idNumber)) {
      return reply.code(409).send({ error: 'reference already used for another ID' });
    }
    const check: FakeIdentityCheck = existing ?? {
      checkId: ids.next('chk'),
      reference,
      idType,
      idNumber,
      createdAt: new Date().toISOString(),
      status: 'pending',
      captured: false,
    };
    store.identityChecks.set(check.checkId, check);
    return reply.code(existing ? 200 : 201).send({
      check_id: check.checkId,
      capture_url: selfUrl(request, `/identity/capture/${encodeURIComponent(check.checkId)}`),
      status: check.status,
    });
  });

  app.get<{ Params: { checkId: string } }>('/identity/checks/:checkId', async (request, reply) => {
    const check = store.identityChecks.get(request.params.checkId);
    if (!check) return reply.code(404).send({ error: 'check not found' });
    return reply.send(resultView(check));
  });

  // Test control: the person finishes the selfie.
  app.post<{ Params: { checkId: string } }>(
    '/identity/_test/checks/:checkId/complete',
    async (request, reply) => {
      const check = store.identityChecks.get(request.params.checkId);
      if (!check) return reply.code(404).send({ error: 'check not found' });
      if (check.captured) return reply.code(409).send({ error: 'selfie already captured' });
      const result = await capture(check);
      return reply.send({ ...resultView(check), ...result });
    },
  );

  app.get<{ Params: { checkId: string } }>('/identity/capture/:checkId', async (request, reply) => {
    const check = store.identityChecks.get(request.params.checkId);
    if (!check) return reply.code(404).send({ error: 'check not found' });
    const action = `/identity/capture/${encodeURIComponent(check.checkId)}`;
    const body = check.captured
      ? `<p>The selfie for this check was already taken. Result: <strong>${escapeHtml(check.status)}</strong>.</p>`
      : `<form method="post" action="${escapeHtml(action)}"><button>Simulate a completed selfie</button></form>`;
    return htmlPage(
      reply,
      'Fake identity check',
      `<h1>Fake identity check</h1><p class="note">A stand-in for the provider's selfie page. It has no camera and takes no picture,
and it never asks for an image of the ID card. The outcome follows the ID number's last digit: 0 not matched, 9 failed,
8 never completes, anything else verified.</p><p>Check ${escapeHtml(check.checkId)} for ${escapeHtml(maskIdNumber(check.idNumber))}.</p>${body}`,
    );
  });

  app.post<{ Params: { checkId: string } }>(
    '/identity/capture/:checkId',
    async (request, reply) => {
      const check = store.identityChecks.get(request.params.checkId);
      if (!check) return reply.code(404).send({ error: 'check not found' });
      if (!check.captured) await capture(check);
      return htmlPage(
        reply,
        'Fake identity check',
        `<h1>Fake identity check</h1><p>Selfie recorded. Result: <strong>${escapeHtml(check.status)}</strong>. You can close this page.</p>`,
      );
    },
  );
}
