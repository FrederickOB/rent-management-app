import type { LeaseDetailView } from '@rent/contracts';
import { describe, expect, it } from 'vitest';
import {
  ONE_TENANT_PROBLEM,
  STAFF_PART_PROBLEM,
  TENANT_SIGNS_PROBLEM,
  type SignerRecords,
} from './lease-form';
import {
  handoverProblem,
  isOpenRequest,
  issueBlockers,
  issueProblem,
  needsHandover,
  recallProblem,
  requestLine,
  shortHash,
  signerLines,
  signerState,
  type SignerProgress,
} from './signing';

const ID = (n: number) => `019a3000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const TZ = 'Africa/Accra';
const now = new Date('2026-10-29T12:00:00Z');

type Party = LeaseDetailView['parties'][number];
const party = (overrides: Partial<Party>): Party => ({
  id: ID(100),
  role: 'tenant',
  name: 'Ama Mensah',
  phone: null,
  email: null,
  tenantContactId: null,
  staffPersonId: null,
  required: true,
  position: 1,
  paperSignedOn: null,
  ...overrides,
});

const draft = (overrides: Partial<LeaseDetailView> = {}): LeaseDetailView =>
  ({
    access: 'full',
    id: ID(1),
    status: 'draft',
    use: 'residential',
    unit: { id: ID(2), code: 'ACC-LEG-B1-03', propertyId: ID(3), propertyName: 'Legon (demo)' },
    tenant: { id: ID(4), displayName: 'Ama Mensah', kind: 'individual' },
    template: {
      templateId: ID(5),
      versionId: ID(6),
      name: 'Residential tenancy agreement (starter)',
      version: 1,
      counselReviewed: false,
    },
    witnessRequired: true,
    parties: [
      party({ role: 'tenant' }),
      party({ id: ID(101), role: 'landlord', name: 'Kofi Manager', staffPersonId: ID(7) }),
      party({ id: ID(102), role: 'witness', name: 'Esi Witness', phone: '+233244123456' }),
    ],
    ...overrides,
  }) as LeaseDetailView;

const signer = (overrides: Partial<SignerProgress> = {}): SignerProgress => ({
  id: ID(200),
  role: 'witness',
  roleLabel: 'Witness',
  name: 'Esi Witness',
  phoneMasked: '+233 ** *** 3456',
  emailMasked: null,
  codeChannel: 'sms',
  required: true,
  position: 3,
  status: 'pending',
  firstOpenedAt: null,
  lastOpenedAt: null,
  signedAt: null,
  declinedAt: null,
  declineReason: null,
  lockedUntil: null,
  lastLink: null,
  copySent: false,
  ...overrides,
});

describe('TL-07 sending a draft for signing', () => {
  it('sends a draft with a tenant, a landlord’s signer and the witness the company asks for', () => {
    expect(issueBlockers(draft())).toEqual([]);
  });

  it('names what the draft lacks before it is sent, as the API would refuse it', () => {
    const blockers = issueBlockers(
      draft({
        parties: [party({ role: 'guarantor', name: 'Yaa Guarantor' })],
      }),
    );
    expect(blockers).toEqual([
      'Add the tenant, or a company tenant’s authorised signatory, as a signer.',
      'Add who signs for the landlord: an owner or a manager.',
      'Add the witness who will sign, or untick “A witness signs this lease” in the draft.',
      'Add a phone or email for Yaa Guarantor (guarantor), so they can get their link and code.',
    ]);
    expect(issueBlockers(draft({ parties: [] }))).toEqual([
      'Add the people who sign, in the draft.',
    ]);
    expect(issueBlockers(draft({ template: null }))[0]).toMatch(/recorded from paper/);
    // The tenant, contacts and staff take the phone or email on their record, which only the API reads.
    expect(
      issueBlockers(draft({ witnessRequired: false, parties: draft().parties.slice(0, 2) })),
    ).toEqual([]);
  });

  it('puts every refusal of the API into words, with what to fix', () => {
    const refusal = (code: string, message = 'from the API') => ({ status: 400, code, message });
    expect(issueProblem(refusal('WITNESS_REQUIRED'))).toEqual({
      message:
        'Add the witness who will sign. Your company asks for a witness on every lease; a draft can turn this off.',
      fix: 'edit_draft',
    });
    expect(issueProblem(refusal('LANDLORD_SIGNER_REQUIRED')).fix).toBe('edit_draft');
    expect(issueProblem(refusal('LEASE_OVERLAP')).message).toMatch(/Another lease holds this unit/);
    expect(issueProblem(refusal('SIGNING_OPEN')).fix).toBe('reload');
    expect(issueProblem(refusal('LEASE_NOT_DRAFT')).fix).toBe('reload');
    expect(issueProblem(refusal('LEASE_WITHOUT_TEMPLATE')).fix).toBeNull();
    // The API names the signer; the screen keeps the name and says what to do.
    expect(
      issueProblem(
        refusal(
          'SIGNER_CONTACT',
          'Esi Witness has no phone number or email on record; add one so they can get their link and code',
        ),
      ),
    ).toEqual({
      message:
        'Esi Witness has no phone number or email on record; add one so they can get their link and code. Add their phone or email in the draft, then send it again.',
      fix: 'edit_draft',
    });
    // A code the screen does not know keeps the API's own message.
    expect(issueProblem(refusal('SOMETHING_NEW', 'Try again tomorrow'))).toEqual({
      message: 'Try again tomorrow',
      fix: null,
    });
  });

  it('explains why a recall or a hand-over was refused', () => {
    expect(recallProblem({ status: 409, code: 'SIGNING_COMPLETE', message: 'x' }).message).toMatch(
      /cancelled with a second person’s approval/,
    );
    expect(recallProblem({ status: 409, code: 'LEASE_NOT_PENDING', message: 'x' }).fix).toBe(
      'reload',
    );
    expect(
      handoverProblem({
        status: 409,
        code: 'LINK_UNAVAILABLE',
        message: 'This person has already signed or declined',
      }),
    ).toEqual({ message: 'This person has already signed or declined', fix: 'reload' });
    expect(handoverProblem({ status: 404, code: 'NOT_FOUND', message: 'x' }).fix).toBe('reload');
  });
});

describe('TL-07 signing progress', () => {
  it('says where each signer is, with times in the company’s time zone', () => {
    expect(signerState(signer(), now)).toEqual({ tone: 'neutral', label: 'Not opened yet' });
    expect(signerState(signer({ firstOpenedAt: '2026-10-29T10:00:00.000Z' }), now).label).toBe(
      'Opened, not signed',
    );
    expect(signerState(signer({ lockedUntil: '2026-10-29T12:20:00.000Z' }), now).label).toBe(
      'Locked after wrong codes',
    );
    expect(signerState(signer({ lockedUntil: '2026-10-29T11:00:00.000Z' }), now).label).toBe(
      'Not opened yet',
    );
    const signed = signer({ status: 'signed', signedAt: '2026-10-29T11:05:00.000Z' });
    expect(signerState(signed, now)).toEqual({ tone: 'green', label: 'Signed' });
    expect(signerLines(signed, TZ, now)).toEqual(['Signed 29 Oct 2026, 11:05 GMT (Africa/Accra)']);
    const declined = signer({
      status: 'declined',
      declinedAt: '2026-10-29T11:10:00.000Z',
      declineReason: 'The rent is too high',
    });
    expect(signerLines(declined, TZ, now)[0]).toBe(
      'Declined 29 Oct 2026, 11:10 GMT (Africa/Accra): “The rent is too high”',
    );
  });

  it('shows how the last link went out, and asks for a hand-over when none could', () => {
    const none = signer();
    expect(needsHandover(none)).toBe(true);
    expect(signerLines(none, TZ, now)).toEqual([
      'No link has gone out: they have no channel they agreed to. Hand one over in person.',
      'Codes go by SMS to +233 ** *** 3456',
    ]);
    const sent = signer({
      firstOpenedAt: '2026-10-29T09:00:00.000Z',
      lastOpenedAt: '2026-10-29T09:30:00.000Z',
      lockedUntil: '2026-10-29T12:30:00.000Z',
      lastLink: {
        createdAt: '2026-10-29T08:00:00.000Z',
        expiresAt: '2026-11-28T08:00:00.000Z',
        via: 'handover',
        openedAt: '2026-10-29T09:00:00.000Z',
      },
    });
    expect(needsHandover(sent)).toBe(false);
    expect(signerLines(sent, TZ, now)).toEqual([
      'Five wrong codes: signing is locked until 29 Oct 2026, 12:30 GMT (Africa/Accra)',
      'First opened 29 Oct 2026, 09:00 GMT (Africa/Accra), last 29 Oct 2026, 09:30 GMT (Africa/Accra)',
      'Link handed over in person 29 Oct 2026, 08:00 GMT (Africa/Accra), opened 29 Oct 2026, 09:00 GMT (Africa/Accra); it works until 28 Nov 2026',
      'Codes go by SMS to +233 ** *** 3456',
    ]);
  });

  it('shows a closed request’s unsigned signers without links, codes or locks', () => {
    const recalled = signer({
      lockedUntil: '2026-10-29T12:30:00.000Z',
      lastLink: {
        createdAt: '2026-10-29T08:00:00.000Z',
        expiresAt: '2026-11-28T08:00:00.000Z',
        via: 'message',
        openedAt: '2026-10-29T09:00:00.000Z',
      },
    });
    expect(signerState(recalled, now, false)).toEqual({ tone: 'neutral', label: 'Did not sign' });
    expect(signerLines(recalled, TZ, now, false)).toEqual([]);
    // While it is open, a link that was opened counts as opened.
    expect(signerState({ ...recalled, lockedUntil: null }, now).label).toBe('Opened, not signed');
  });

  it('describes the request, and shortens fingerprints for reading', () => {
    const progress = {
      requestId: ID(300),
      createdAt: '2026-10-29T08:00:00.000Z',
      openedAt: '2026-10-29T08:01:00.000Z',
      completedAt: null,
      declinedAt: null,
      declineReason: null,
      cancelledAt: '2026-10-29T09:00:00.000Z',
      cancelReason: 'Wrong rent',
      documentSha256: null,
      finalSha256: null,
      frozenDocument: true,
      signedDocument: false,
      signers: [],
    };
    expect(requestLine({ ...progress, status: 'pending' }, TZ)).toBe(
      'Out for signature since 29 Oct 2026, 08:01 GMT (Africa/Accra).',
    );
    expect(requestLine({ ...progress, status: 'cancelled' }, TZ)).toBe(
      'Recalled 29 Oct 2026, 09:00 GMT (Africa/Accra): “Wrong rent”. Its links no longer work.',
    );
    expect(isOpenRequest('preparing')).toBe(true);
    expect(isOpenRequest('completed')).toBe(false);
    expect(shortHash('a'.repeat(32) + 'b'.repeat(32))).toBe('aaaaaaaa…bbbbbbbb');
  });
});

describe('TL-07 the send confirmation checks the signers’ records', () => {
  const records: SignerRecords = {
    tenant: { name: 'Ama Mensah', kind: 'individual', phone: '+233200000099', email: null },
    contacts: [{ id: ID(8), kind: 'guarantor', name: 'Yaa Guarantor', phone: null, email: null }],
    staff: [
      {
        personId: ID(7),
        name: 'Kofi Manager',
        email: 'kofi@demo.invalid',
        phoneMasked: null,
        roleLabel: 'Property manager',
      },
    ],
  };

  it('sends a draft whose linked signers have a phone or email on their record', () => {
    expect(issueBlockers(draft(), records)).toEqual([]);
  });

  it('names a linked signer whose record has no phone or email, or is gone', () => {
    const blockers = issueBlockers(
      draft({
        parties: [
          ...draft().parties,
          party({ id: ID(103), role: 'guarantor', name: 'Yaa Guarantor', tenantContactId: ID(8) }),
          party({ id: ID(104), role: 'guarantor', name: 'Old Guarantor', tenantContactId: ID(9) }),
          party({ id: ID(105), role: 'witness', name: 'Gone Manager', staffPersonId: ID(10) }),
        ],
      }),
      records,
    );
    expect(blockers).toEqual([
      'Add a phone or email to Yaa Guarantor’s record (guarantor), so they can get their link and code.',
      'Old Guarantor (guarantor) is no longer one of the tenant’s contacts. Remove them from the signers in the draft.',
      'Gone Manager (witness) is no longer an active member of your company. Remove them from the signers in the draft.',
    ]);
    const noTenantPhone = { ...records, tenant: { ...records.tenant!, phone: null } };
    expect(issueBlockers(draft(), noTenantPhone)).toEqual([
      'Add a phone or email to the tenant’s record, so Ama Mensah can get their link and code.',
    ]);
  });

  it('refuses a second tenant and a member of staff in a part staff do not sign in', () => {
    const blockers = issueBlockers(
      draft({
        parties: [
          ...draft().parties,
          party({ id: ID(106), role: 'tenant', name: 'Akos Spouse', phone: '+233244000002' }),
          party({ id: ID(107), role: 'guarantor', name: 'Kofi Manager', staffPersonId: ID(7) }),
        ],
      }),
    );
    expect(blockers).toEqual([
      ONE_TENANT_PROBLEM,
      `Kofi Manager (guarantor): ${STAFF_PART_PROBLEM}`,
    ]);
  });
});

describe('TL-07 a person who rents signs their own lease', () => {
  const coOccupant = party({
    id: ID(108),
    role: 'tenant',
    name: 'Akos Spouse',
    tenantContactId: ID(8),
  });
  const others = draft().parties.slice(1);

  it('stops a person’s lease that a co-occupant would sign instead of them', () => {
    expect(issueBlockers(draft({ parties: [coOccupant, ...others] }))).toEqual([
      TENANT_SIGNS_PROBLEM,
    ]);
    expect(issueBlockers(draft({ parties: [draft().parties[0]!, coOccupant, ...others] }))).toEqual(
      [],
    );
  });

  it('leaves a company’s signatories to sign for it', () => {
    const company = { id: ID(4), displayName: 'Osu Traders Ltd', kind: 'company' as const };
    const signatory = party({ role: 'signatory', name: 'Kwame Director', tenantContactId: ID(9) });
    expect(issueBlockers(draft({ tenant: company, parties: [signatory, ...others] }))).toEqual([]);
  });
});
