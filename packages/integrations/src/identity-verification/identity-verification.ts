import { z } from 'zod';
import { requestJson } from '../http';
import { conflict, invalidRequest, notFound, unexpectedResponse } from '../validation';

/**
 * Identity checks (TL-02; OQ-22, OQ-39). A check matches a live selfie against the NIA record for
 * an ID number. The person takes the selfie on the provider's page at `captureUrl`, so the image
 * never passes through us. Nothing here accepts, requests or stores an image of an ID card
 * (CLAUDE.md section 10). The real provider arrives in M3.
 */
export type IdType = 'ghana_card' | 'passport';
export type IdentityCheckStatus = 'pending' | 'verified' | 'not_matched' | 'failed';

export interface IdentityCheckRequest {
  readonly idType: IdType;
  /** Sensitive: never logged, and never part of an error message. */
  readonly idNumber: string;
  /** Our reference. Repeating it returns the same check, so a retried job pays for one check. */
  readonly reference: string;
}

export interface IdentityCheckStarted {
  readonly checkId: string;
  /** Send the person here to take the selfie. */
  readonly captureUrl: string;
}

export interface IdentityCheckResult {
  readonly status: IdentityCheckStatus;
  readonly checkedAt?: string;
}

export interface IdentityResultEvent {
  readonly checkId: string;
  readonly status: Exclude<IdentityCheckStatus, 'pending'>;
  readonly checkedAt: string;
  readonly reference?: string;
}

export interface IdentityVerificationPort {
  readonly provider: string;
  startCheck(request: IdentityCheckRequest): Promise<IdentityCheckStarted>;
  /** A non-retryable 404 for a check the provider does not know. */
  getResult(checkId: string): Promise<IdentityCheckResult>;
  /** The result webhook, or null when the body is not one. */
  parseResultWebhook(body: unknown): IdentityResultEvent | null;
}

/** Test controls both fakes offer; not part of the port. */
export interface IdentityVerificationTestControls {
  /** The person finishes the selfie. Returns the result webhook body, or null if none is sent. */
  completeCapture(checkId: string): Promise<unknown>;
}

const ID_FORMATS: Record<IdType, RegExp> = {
  ghana_card: /^GHA-\d{9}-\d$/,
  passport: /^[A-Z0-9]{6,12}$/,
};

export const normaliseIdNumber = (idNumber: string): string => idNumber.trim().toUpperCase();

export function checkIdentityRequest(provider: string, request: IdentityCheckRequest): void {
  const format = ID_FORMATS[request.idType] as RegExp | undefined;
  if (!format) throw invalidRequest(provider, 'unknown ID type');
  if (!format.test(normaliseIdNumber(request.idNumber))) {
    throw invalidRequest(provider, 'ID number does not match its type');
  }
  if (request.reference.length === 0 || request.reference.length > 100) {
    throw invalidRequest(provider, 'reference must be 1 to 100 characters');
  }
}

/**
 * The fakes decide a check's outcome from the last character of the ID number, so tests can pick
 * one. No real check happens.
 *
 * - `0`: not_matched
 * - `9`: failed (the provider or NIA was unavailable)
 * - `8`: never completes, so the check stays pending
 * - anything else: verified
 */
export function fakeIdentityOutcome(idNumber: string): IdentityCheckStatus {
  switch (normaliseIdNumber(idNumber).at(-1)) {
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

const resultWebhook = z.object({
  event: z.literal('identity.check.completed'),
  check_id: z.string().min(1),
  status: z.enum(['verified', 'not_matched', 'failed']),
  checked_at: z.iso.datetime({ offset: true }),
  reference: z.string().optional(),
});

/** The neutral result webhook our fakes send; the M3 provider maps its own to the same event. */
export function parseIdentityWebhook(body: unknown): IdentityResultEvent | null {
  const parsed = resultWebhook.safeParse(body);
  if (!parsed.success) return null;
  const { check_id, status, checked_at, reference } = parsed.data;
  return {
    checkId: check_id,
    status,
    checkedAt: checked_at,
    ...(reference === undefined ? {} : { reference }),
  };
}

interface MemoryCheck {
  readonly checkId: string;
  readonly request: IdentityCheckRequest;
  status: IdentityCheckStatus;
  checkedAt?: string;
  captured: boolean;
}

/** Keeps checks in memory and decides outcomes with `fakeIdentityOutcome`. */
export class InMemoryIdentityVerification
  implements IdentityVerificationPort, IdentityVerificationTestControls
{
  readonly provider = 'memory';
  private readonly checks = new Map<string, MemoryCheck>();
  private readonly byReference = new Map<string, MemoryCheck>();
  private counter = 0;

  async startCheck(request: IdentityCheckRequest): Promise<IdentityCheckStarted> {
    checkIdentityRequest(this.provider, request);
    const idNumber = normaliseIdNumber(request.idNumber);
    const existing = this.byReference.get(request.reference);
    if (existing) {
      if (existing.request.idType !== request.idType || existing.request.idNumber !== idNumber) {
        throw conflict(this.provider, 'reference already used for another ID');
      }
      return this.started(existing);
    }
    const check: MemoryCheck = {
      checkId: `mem-idv-${++this.counter}`,
      request: { idType: request.idType, idNumber, reference: request.reference },
      status: 'pending',
      captured: false,
    };
    this.checks.set(check.checkId, check);
    this.byReference.set(request.reference, check);
    return this.started(check);
  }

  async getResult(checkId: string): Promise<IdentityCheckResult> {
    const check = this.checks.get(checkId);
    if (!check) throw notFound(this.provider, 'check');
    return {
      status: check.status,
      ...(check.checkedAt === undefined ? {} : { checkedAt: check.checkedAt }),
    };
  }

  parseResultWebhook(body: unknown): IdentityResultEvent | null {
    return parseIdentityWebhook(body);
  }

  async completeCapture(checkId: string): Promise<unknown> {
    const check = this.checks.get(checkId);
    if (!check) throw notFound(this.provider, 'check');
    if (check.captured) throw conflict(this.provider, 'selfie already captured');
    check.captured = true;
    const outcome = fakeIdentityOutcome(check.request.idNumber);
    if (outcome === 'pending') return null;
    check.status = outcome;
    check.checkedAt = new Date().toISOString();
    return {
      event: 'identity.check.completed',
      check_id: check.checkId,
      status: outcome,
      checked_at: check.checkedAt,
      reference: check.request.reference,
    };
  }

  private started(check: MemoryCheck): IdentityCheckStarted {
    return {
      checkId: check.checkId,
      captureUrl: `https://identity.fake.invalid/capture/${check.checkId}`,
    };
  }
}

const startedResponse = z.object({ check_id: z.string().min(1), capture_url: z.url() });
const resultResponse = z.object({
  status: z.enum(['pending', 'verified', 'not_matched', 'failed']),
  checked_at: z.string().nullable().optional(),
});
const completedResponse = z.object({ webhook: z.unknown() });

/** Talks to `apps/fake-providers` over HTTP. */
export class FakeProvidersIdentityVerification
  implements IdentityVerificationPort, IdentityVerificationTestControls
{
  readonly provider = 'fake-providers';
  constructor(private readonly baseUrl: string) {}

  async startCheck(request: IdentityCheckRequest): Promise<IdentityCheckStarted> {
    const parsed = startedResponse.safeParse(
      await requestJson<unknown>(this.provider, `${this.baseUrl}/identity/checks`, {
        body: {
          id_type: request.idType,
          id_number: request.idNumber,
          reference: request.reference,
        },
      }),
    );
    if (!parsed.success) throw unexpectedResponse(this.provider);
    return { checkId: parsed.data.check_id, captureUrl: parsed.data.capture_url };
  }

  async getResult(checkId: string): Promise<IdentityCheckResult> {
    const parsed = resultResponse.safeParse(
      await requestJson<unknown>(
        this.provider,
        `${this.baseUrl}/identity/checks/${encodeURIComponent(checkId)}`,
      ),
    );
    if (!parsed.success) throw unexpectedResponse(this.provider);
    return {
      status: parsed.data.status,
      ...(parsed.data.checked_at ? { checkedAt: parsed.data.checked_at } : {}),
    };
  }

  parseResultWebhook(body: unknown): IdentityResultEvent | null {
    return parseIdentityWebhook(body);
  }

  async completeCapture(checkId: string): Promise<unknown> {
    const parsed = completedResponse.safeParse(
      await requestJson<unknown>(
        this.provider,
        `${this.baseUrl}/identity/_test/checks/${encodeURIComponent(checkId)}/complete`,
        { body: {} },
      ),
    );
    if (!parsed.success) throw unexpectedResponse(this.provider);
    return parsed.data.webhook ?? null;
  }
}
