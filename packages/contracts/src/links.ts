import { oc } from '@orpc/contract';
import { SIGNER_ROLES } from '@rent/domain/esign';
import { z } from 'zod';

/**
 * The links API (TL-07; M3 plan 4.15): what apps/links calls, server to server, for the no-login
 * signing pages. A token is the only authorisation for the page; apps/links itself proves who it
 * is with a shared key in a header. It passes on the browser's address and device, which are
 * evidence, so the API accepts them only with the key.
 */
export const LINKS_API_KEY_HEADER = 'x-links-key';

/**
 * The development stand-in for LINKS_API_KEY, used on both sides when none is set. Not a secret:
 * the API refuses it in production, so a links app deployed without its key fails closed.
 * Must equal DEV_LINKS_API_KEY in packages/server (a test in apps/api checks).
 */
export const DEV_LINKS_API_KEY = 'dev-only-links-api-key-not-a-secret-000000';

/** 256 random bits, base64url (CLAUDE.md section 9). */
export const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const iso = z.string().datetime();
const token = z.string().max(64);
/** The browser behind the call, as apps/links saw it. */
const client = z
  .object({ ip: z.string().trim().min(1).max(64), userAgent: z.string().max(500) })
  .strict();
const signerStatus = z.enum(['pending', 'signed', 'declined']);

export const LINK_SCREENS = [
  'sign',
  'signed',
  'declined',
  'copy',
  'expired',
  'revoked',
  'closed',
] as const;
export type LinkScreen = (typeof LINK_SCREENS)[number];

export const signingPageSchema = z.object({
  /** What the page shows. Only `sign` accepts any action; the rest explain. */
  screen: z.enum(LINK_SCREENS),
  /**
   * For `revoked`, `closed` and `signed`: a newer link went out, the request was withdrawn,
   * declined or completed, or everyone who must sign has signed (`signed_by_all`).
   */
  reason: z
    .enum(['superseded', 'cancelled', 'declined', 'completed', 'preparing', 'signed_by_all'])
    .nullable(),
  purpose: z.enum(['sign', 'signed_copy']),
  /** Who to contact: the landlord or agency, and the landlord's signatory on the request. */
  landlord: z.object({
    name: z.string(),
    contactName: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
  }),
  timeZone: z.string(),
  linkExpiresAt: iso,
  document: z.object({
    title: z.string(),
    reference: z.string(),
    /** SHA-256 of the frozen PDF every signer signs. */
    sha256: z.string().nullable(),
    /** SHA-256 of the signed copy, on the `copy` screen. */
    finalSha256: z.string().nullable(),
    /** The document's words as HTML (no scripts, no styles), on the `sign` screen only. */
    html: z.string().nullable(),
    /**
     * Whether this link downloads a PDF now: the document being signed, the document a signer
     * signed while their link is live, or the signed copy. Never on a revoked or expired link.
     */
    downloadable: z.boolean(),
  }),
  signer: z.object({
    name: z.string(),
    role: z.enum(SIGNER_ROLES),
    roleLabel: z.string(),
    status: signerStatus,
    signedAt: iso.nullable(),
    declinedAt: iso.nullable(),
  }),
  signers: z.array(
    z.object({
      name: z.string(),
      roleLabel: z.string(),
      status: signerStatus,
      required: z.boolean(),
    }),
  ),
  /** The one-time code state, on the `sign` screen. Never the full phone number or email. */
  code: z
    .object({
      channel: z.enum(['sms', 'email']),
      destinationMasked: z.string(),
      sentAt: iso.nullable(),
      expiresAt: iso.nullable(),
      attemptsLeft: z.number().int(),
      sendsLeft: z.number().int(),
      lockedUntil: iso.nullable(),
    })
    .nullable(),
  /** The versioned consent text to show beside the signature, on the `sign` screen. */
  consent: z.object({ version: z.string(), text: z.string() }).nullable(),
});
export type SigningPage = z.infer<typeof signingPageSchema>;

const linkInput = z.object({ token, client }).strict();

export const linksContract = {
  open: oc
    .route({
      method: 'POST',
      path: '/links/open',
      summary: 'Open a link: records the open and returns what its page shows (TL-07)',
    })
    .input(linkInput)
    .output(signingPageSchema),
  document: oc
    .route({
      method: 'POST',
      path: '/links/document',
      summary: 'A 5-minute link to the frozen PDF, or on a signed-copy link to the signed copy',
    })
    .input(linkInput)
    .output(z.object({ url: z.string() })),
  sendCode: oc
    .route({
      method: 'POST',
      path: '/links/code',
      summary: 'Send the signer a one-time code, to the phone or email on record only',
    })
    .input(linkInput)
    .output(
      z.object({
        channel: z.enum(['sms', 'email']),
        destinationMasked: z.string(),
        expiresAt: iso,
        sendsLeft: z.number().int(),
      }),
    ),
  sign: oc
    .route({ method: 'POST', path: '/links/sign', summary: 'Sign with a typed name or a drawing' })
    .input(
      z
        .object({
          token,
          client,
          code: z.string().max(12),
          method: z.enum(['typed', 'drawn']),
          typedName: z.string().max(200).nullable().optional(),
          /** A PNG data URL from the drawing pad. */
          drawing: z.string().max(420_000).nullable().optional(),
          consentVersion: z.string().max(40),
          consentAccepted: z.boolean(),
        })
        .strict(),
    )
    .output(z.object({ signedAt: iso, complete: z.boolean() })),
  decline: oc
    .route({ method: 'POST', path: '/links/decline', summary: 'Decline to sign, with a reason' })
    .input(z.object({ token, client, reason: z.string().max(1000) }).strict())
    .output(z.object({ declinedAt: iso })),
};
