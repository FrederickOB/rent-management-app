import { sql, type Tx } from '@rent/db';
import { businessDateOf, instantFrom, toIsoDate } from '@rent/domain/dates';
import { formatTicketNumber } from '@rent/domain/maintenance';
import { consentText } from '@rent/domain/messaging';
import { money, toDecimal } from '@rent/domain/money';
import writeXlsxFile from 'write-excel-file/node';

/**
 * A tenant's own records for an access request (M11 decision 5; Act 843): what the export
 * workbook holds, sheet by sheet, and the stored PDFs that go beside it. Read in the company's
 * context, filtered to the one tenant on every query: never another tenant's rows, and never
 * another company's (RLS). Identity and tax numbers are given masked, as staff see them; the
 * tenant knows their own. Nothing here is logged.
 */

type Cell = { value: string | number; type?: typeof Number } | null;
export interface ExportSheet {
  readonly name: string;
  readonly columns: readonly string[];
  readonly rows: readonly Cell[][];
}

/** A stored document to put in the archive under `name`. */
export interface ExportFile {
  readonly documentId: string;
  readonly name: string;
  readonly what: string;
  /** As recorded when it was stored: what the export's size cap counts (M11 review B7). */
  readonly sizeBytes: number;
  /** A photo or recording the tenant sent: left out first when the export is over its cap. */
  readonly media: boolean;
  /** The record it belongs to, where staff can download it: `Repair MT-0042`, `Message on …`. */
  readonly belongsTo: string;
  /** Its business date. */
  readonly on: string | null;
}

export interface TenantExport {
  readonly tenantName: string;
  readonly sheets: readonly ExportSheet[];
  readonly files: readonly ExportFile[];
}

const text = (v: string | null | undefined): Cell =>
  v === null || v === undefined || v === '' ? null : { value: v };
const num = (v: number | null | undefined): Cell =>
  v === null || v === undefined ? null : { value: Number(v), type: Number };
const cedis = (v: number | null | undefined): Cell =>
  v === null || v === undefined ? null : { value: toDecimal(money(Number(v))) };
const instant = (v: Date | string | null | undefined): Cell =>
  v === null || v === undefined
    ? null
    : { value: (v instanceof Date ? v : new Date(v)).toISOString() };
const yesNo = (v: boolean | null | undefined): Cell =>
  v === null || v === undefined ? null : { value: v ? 'Yes' : 'No' };

const EXTENSION: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/3gpp': '3gp',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/amr': 'amr',
};

const safe = (part: string): string => part.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60);

/** Everything the export holds about one tenant, in the caller's transaction. */
export async function tenantExportIn(
  tx: Tx,
  tenantId: string,
  timeZone: string,
): Promise<TenantExport> {
  const id = sql`${tenantId}::uuid`;
  const [t] = (
    await tx.execute<{
      kind: string;
      display_name: string;
      legal_name: string | null;
      phone: string | null;
      whatsapp_phone: string | null;
      email: string | null;
      occupation: string | null;
      business_type: string | null;
      registration_number: string | null;
      tin_masked: string | null;
      id_type: string | null;
      id_number_masked: string | null;
      id_status: string;
      id_verified_at: Date | string | null;
      notes: string | null;
      created_at: Date | string;
      archived_at: Date | string | null;
      anonymised_at: Date | string | null;
    }>(
      sql`select kind, display_name, legal_name, phone, whatsapp_phone, email, occupation,
            business_type, registration_number, tin_masked, id_type, id_number_masked, id_status,
            id_verified_at, notes, created_at, archived_at, anonymised_at
          from tenant where id = ${id}`,
    )
  ).rows;
  if (!t) throw new Error('Tenant not found');
  const profile: ExportSheet = {
    name: 'Profile',
    columns: ['Field', 'Value'],
    rows: (
      [
        ['Kind', text(t.kind)],
        ['Name', text(t.display_name)],
        ['Registered name', text(t.legal_name)],
        ['Phone', text(t.phone)],
        ['WhatsApp', text(t.whatsapp_phone)],
        ['Email', text(t.email)],
        ['Occupation', text(t.occupation)],
        ['Business type', text(t.business_type)],
        ['Registration number', text(t.registration_number)],
        ['TIN (masked)', text(t.tin_masked)],
        ['ID type', text(t.id_type)],
        ['ID number (masked)', text(t.id_number_masked)],
        ['ID status', text(t.id_status)],
        ['ID verified at (UTC)', instant(t.id_verified_at)],
        ['Notes', text(t.notes)],
        ['Recorded at (UTC)', instant(t.created_at)],
        ['Archived at (UTC)', instant(t.archived_at)],
        ['Anonymised at (UTC)', instant(t.anonymised_at)],
      ] as const
    ).map(([field, value]) => [text(field), value]),
  };

  const contacts = await tx.execute<{
    kind: string;
    name: string;
    relationship: string | null;
    organisation: string | null;
    position: string | null;
    phone: string | null;
    email: string | null;
    created_at: Date | string;
    archived_at: Date | string | null;
  }>(
    sql`select kind, name, relationship, organisation, position, phone, email, created_at, archived_at
        from tenant_contact where tenant_id = ${id} order by created_at, id`,
  );

  const consent = await tx.execute<{
    recorded_at: Date | string;
    who: string | null;
    channel: string;
    action: string;
    source: string;
    text_version: string;
  }>(
    sql`select e.recorded_at, c.name as who, e.channel, e.action, e.source, e.text_version
        from consent_event e
        left join tenant_contact c on c.company_id = e.company_id and c.id = e.tenant_contact_id
        where e.tenant_id = ${id} order by e.recorded_at, e.id`,
  );
  const consentWords = (version: string, channel: string): string | null => {
    try {
      return consentText(version, channel);
    } catch {
      return null;
    }
  };

  const leases = await tx.execute<{
    id: string;
    unit_code: string;
    property_name: string;
    status: string;
    use: string;
    start_date: string;
    end_date: string;
    monthly_rent_minor: number;
    rent_cycle: string;
    deposit_minor: number | null;
    signed_at: Date | string | null;
    signing_method: string | null;
    ended_on: string | null;
    signed_document_id: string | null;
    stamped_document_id: string | null;
    formal_wet_signed_document_id: string | null;
  }>(
    sql`select l.id, u.code as unit_code, p.name as property_name, l.status, l.use,
          l.start_date::text as start_date, l.end_date::text as end_date, l.monthly_rent_minor,
          l.rent_cycle, l.deposit_minor, l.signed_at, l.signing_method, l.ended_on::text as ended_on,
          l.signed_document_id, l.stamped_document_id, l.formal_wet_signed_document_id
        from lease l
        join unit u on u.company_id = l.company_id and u.id = l.unit_id
        join property p on p.company_id = l.company_id and p.id = l.property_id
        where l.tenant_id = ${id} order by l.start_date, l.id`,
  );

  const invoices = await tx.execute<{
    number: number;
    kind: string;
    issue_date: string;
    due_date: string;
    unit_code: string;
    line_kind: string;
    period_start: string | null;
    period_end: string | null;
    line_due: string;
    amount_minor: number;
  }>(
    sql`select i.number, i.kind, i.issue_date::text as issue_date, i.due_date::text as due_date,
          i.unit_code, l.kind as line_kind, l.period_start::text as period_start,
          l.period_end::text as period_end, l.due_date::text as line_due, l.amount_minor
        from invoice i
        join invoice_line l on l.company_id = i.company_id and l.invoice_id = i.id
        where i.tenant_id = ${id} order by i.number, l.position`,
  );

  const payments = await tx.execute<{
    received_on: string;
    method: string;
    amount_minor: number;
    provider: string | null;
    payer_name: string | null;
    provider_reference: string | null;
    sender_reference: string | null;
    reversed: boolean;
  }>(
    sql`select p.received_on::text as received_on, p.method, p.amount_minor, p.provider,
          p.payer_name, p.provider_reference, p.sender_reference,
          exists (select 1 from payment_reversal r where r.company_id = p.company_id and r.payment_id = p.id) as reversed
        from payment p where p.tenant_id = ${id} order by p.received_on, p.id`,
  );

  const receipts = await tx.execute<{
    id: string;
    number: number;
    kind: string;
    issued_at: Date | string;
    amount_minor: number;
    document_id: string | null;
  }>(
    sql`select r.id, r.number, r.kind, r.issued_at, r.amount_minor, q.document_id
        from receipt r
        left join document_render_request q on q.company_id = r.company_id and q.id = r.render_request_id
        where r.tenant_id = ${id} order by r.issued_at, r.id`,
  );

  const notices = await tx.execute<{
    id: string;
    number: number | null;
    type: string;
    status: string;
    issue_date: string | null;
    effective_date: string | null;
    electronic_service: boolean | null;
    document_id: string | null;
  }>(
    sql`select n.id, n.number, n.type, n.status, n.issue_date::text as issue_date,
          n.effective_date::text as effective_date, n.electronic_service, n.document_id
        from notice n
        where n.issued_at is not null
          and (n.tenant_id = ${id}
               or exists (select 1 from notice_recipient r where r.company_id = n.company_id
                          and r.notice_id = n.id and r.tenant_id = ${id}))
        order by n.issued_at, n.id`,
  );

  const messages = await tx.execute<{
    created_at: Date | string;
    direction: string;
    channel: string | null;
    channels: string[];
    purpose: string;
    subject: string | null;
    body: string;
    status: string | null;
  }>(
    sql`select m.created_at, m.direction, m.channel, m.channels, m.purpose, m.subject, m.body,
          (select e.status from message_event e where e.company_id = m.company_id and e.message_id = m.id
           order by e.occurred_at desc, e.id desc limit 1) as status
        from message m where m.tenant_id = ${id} order by m.created_at, m.id`,
  );

  const day = (v: Date | string) => toIsoDate(businessDateOf(instantFrom(new Date(v)), timeZone));
  // The photos, videos and voice notes the tenant sent: by message, and on repair reports in the
  // tenant app (the retention category `photos_and_recordings`). Never staff's inspection photos.
  const media = await tx.execute<{
    document_id: string;
    at: Date | string;
    source: string;
    ticket: number | null;
  }>(
    sql`select a.document_id, a.created_at as at, 'message' as source, null::int as ticket
        from message_attachment a
        join message m on m.company_id = a.company_id and m.id = a.message_id
        where m.tenant_id = ${id} and m.direction = 'inbound' and a.document_id is not null
        union all
        select j.document_id, j.created_at as at, 'repair' as source, mj.ticket_number as ticket
        from maintenance_job_attachment j
        join maintenance_job mj on mj.company_id = j.company_id and mj.id = j.job_id
        where mj.tenant_id = ${id} and j.added_by_kind = 'tenant'
        order by at, document_id`,
  );

  // The stored PDFs (and scans) of the tenant's leases, receipts and notices, and their media.
  const ids = new Set<string>();
  type Wanted = {
    documentId: string;
    stem: string;
    what: string;
    media: boolean;
    belongsTo: string;
    on: string | null;
  };
  const wanted: Wanted[] = [];
  const want = (documentId: string | null, file: Omit<Wanted, 'documentId'>) => {
    if (!documentId || ids.has(documentId)) return;
    ids.add(documentId);
    wanted.push({ documentId, ...file });
  };
  for (const l of leases.rows) {
    const base = `leases/${safe(l.unit_code)}-${l.start_date}`;
    const lease = {
      media: false,
      belongsTo: `Lease of ${l.unit_code} from ${l.start_date}`,
      on: l.start_date,
    };
    want(l.signed_document_id, { ...lease, stem: `${base}-signed`, what: 'Signed lease' });
    want(l.stamped_document_id, { ...lease, stem: `${base}-stamped`, what: 'Stamped lease' });
    want(l.formal_wet_signed_document_id, {
      ...lease,
      stem: `${base}-formal`,
      what: 'Formal lease',
    });
  }
  for (const r of receipts.rows) {
    const number = String(r.number).padStart(6, '0');
    want(r.document_id, {
      stem: `receipts/${r.kind}-${number}`,
      what: 'Receipt',
      media: false,
      belongsTo: `Receipt ${number}`,
      on: day(r.issued_at),
    });
  }
  for (const n of notices.rows) {
    const label = n.number === null ? null : `N-${String(n.number).padStart(6, '0')}`;
    want(n.document_id, {
      stem: `notices/${label ?? safe(n.id)}`,
      what: 'Notice',
      media: false,
      belongsTo: label ? `Notice ${label}` : 'Notice',
      on: n.issue_date,
    });
  }
  media.rows.forEach((m, i) =>
    want(m.document_id, {
      stem: `photos-and-recordings/${m.source}-${day(m.at)}-${String(i + 1).padStart(3, '0')}`,
      what: m.source === 'message' ? 'Sent by message' : 'Added to a repair report',
      media: true,
      belongsTo:
        m.source === 'repair' && m.ticket !== null
          ? `Repair ${formatTicketNumber(m.ticket)}`
          : `Message on ${day(m.at)}`,
      on: day(m.at),
    }),
  );
  const types =
    wanted.length === 0
      ? new Map<string, { contentType: string; sizeBytes: number }>()
      : new Map(
          (
            await tx.execute<{ id: string; content_type: string; size_bytes: number }>(
              sql`select id, content_type, size_bytes from document
                  where id in (${sql.join(
                    wanted.map((w) => sql`${w.documentId}::uuid`),
                    sql`, `,
                  )})`,
            )
          ).rows.map((d) => [
            d.id,
            { contentType: d.content_type, sizeBytes: Number(d.size_bytes) },
          ]),
        );
  const files: ExportFile[] = wanted
    .filter((w) => types.has(w.documentId))
    .map((w) => ({
      documentId: w.documentId,
      name: `${w.stem}.${EXTENSION[types.get(w.documentId)!.contentType] ?? 'bin'}`,
      what: w.what,
      sizeBytes: types.get(w.documentId)!.sizeBytes,
      media: w.media,
      belongsTo: w.belongsTo,
      on: w.on,
    }));

  return {
    tenantName: t.display_name,
    files,
    sheets: [
      profile,
      {
        name: 'Contacts',
        columns: [
          'Kind',
          'Name',
          'Relationship',
          'Organisation',
          'Position',
          'Phone',
          'Email',
          'Recorded at (UTC)',
          'Archived at (UTC)',
        ],
        rows: contacts.rows.map((c) => [
          text(c.kind),
          text(c.name),
          text(c.relationship),
          text(c.organisation),
          text(c.position),
          text(c.phone),
          text(c.email),
          instant(c.created_at),
          instant(c.archived_at),
        ]),
      },
      {
        name: 'Consent',
        columns: ['Recorded at (UTC)', 'Person', 'Channel', 'Given or withdrawn', 'How', 'Wording'],
        rows: consent.rows.map((c) => [
          instant(c.recorded_at),
          text(c.who ?? t.display_name),
          text(c.channel),
          text(c.action === 'grant' ? 'Given' : 'Withdrawn'),
          text(c.source),
          text(consentWords(c.text_version, c.channel)),
        ]),
      },
      {
        name: 'Leases',
        columns: [
          'Property',
          'Unit',
          'Use',
          'Status',
          'Start',
          'End',
          'Monthly rent (GHS)',
          'Monthly rent (pesewas)',
          'Billing cycle',
          'Deposit (GHS)',
          'Signed at (UTC)',
          'Signed',
          'Ended on',
        ],
        rows: leases.rows.map((l) => [
          text(l.property_name),
          text(l.unit_code),
          text(l.use),
          text(l.status),
          text(l.start_date),
          text(l.end_date),
          cedis(l.monthly_rent_minor),
          num(l.monthly_rent_minor),
          text(l.rent_cycle),
          cedis(l.deposit_minor),
          instant(l.signed_at),
          text(l.signing_method),
          text(l.ended_on),
        ]),
      },
      {
        name: 'Invoices',
        columns: [
          'Invoice',
          'Kind',
          'Issued',
          'Due',
          'Unit',
          'Line',
          'Period from',
          'Period to',
          'Line due',
          'Amount (GHS)',
          'Amount (pesewas)',
        ],
        rows: invoices.rows.map((i) => [
          text(`INV-${String(i.number).padStart(6, '0')}`),
          text(i.kind),
          text(i.issue_date),
          text(i.due_date),
          text(i.unit_code),
          text(i.line_kind),
          text(i.period_start),
          text(i.period_end),
          text(i.line_due),
          cedis(i.amount_minor),
          num(i.amount_minor),
        ]),
      },
      {
        name: 'Payments',
        columns: [
          'Received on',
          'Method',
          'Amount (GHS)',
          'Amount (pesewas)',
          'Provider',
          'Payer',
          'Provider reference',
          'Sender reference',
          'Reversed',
        ],
        rows: payments.rows.map((p) => [
          text(p.received_on),
          text(p.method),
          cedis(p.amount_minor),
          num(p.amount_minor),
          text(p.provider),
          text(p.payer_name),
          text(p.provider_reference),
          text(p.sender_reference),
          yesNo(p.reversed),
        ]),
      },
      {
        name: 'Receipts',
        columns: [
          'Receipt',
          'Kind',
          'Issued at (UTC)',
          'Issued on',
          'Amount (GHS)',
          'Amount (pesewas)',
          'PDF included',
        ],
        rows: receipts.rows.map((r) => [
          text(String(r.number).padStart(6, '0')),
          text(r.kind),
          instant(r.issued_at),
          text(day(r.issued_at)),
          cedis(r.amount_minor),
          num(r.amount_minor),
          yesNo(files.some((f) => f.documentId === r.document_id)),
        ]),
      },
      {
        name: 'Notices',
        columns: [
          'Notice',
          'Type',
          'Status',
          'Issued on',
          'Effective on',
          'Served electronically',
          'PDF included',
        ],
        rows: notices.rows.map((n) => [
          text(n.number === null ? null : `N-${String(n.number).padStart(6, '0')}`),
          text(n.type),
          text(n.status),
          text(n.issue_date),
          text(n.effective_date),
          yesNo(n.electronic_service),
          yesNo(files.some((f) => f.documentId === n.document_id)),
        ]),
      },
      {
        name: 'Messages',
        columns: ['At (UTC)', 'Direction', 'Channel', 'Purpose', 'Subject', 'Text', 'Status'],
        rows: messages.rows.map((m) => [
          instant(m.created_at),
          text(m.direction === 'inbound' ? 'From the tenant' : 'To the tenant'),
          text(m.channel ?? m.channels.join(', ')),
          text(m.purpose),
          text(m.subject),
          text(m.body),
          text(m.status),
        ]),
      },
    ],
  };
}

/** The workbook: a cover sheet, then one sheet per kind of record (amounts exact, in pesewas too). */
export async function exportWorkbook(
  data: TenantExport,
  meta: { readonly companyName: string; readonly preparedAt: Date; readonly timeZone: string },
  files: readonly {
    readonly name: string;
    readonly what: string;
    readonly sha256: string;
    readonly intact: boolean;
    /** Null for a file left out: one the malware scan quarantined (M11 decision 6). */
    readonly bytes: Buffer | null;
  }[],
  /** Files left out to keep the archive under its cap (review round), largest first. */
  leftOut: readonly Pick<ExportFile, 'name' | 'what' | 'belongsTo' | 'on' | 'sizeBytes'>[] = [],
  capBytes = 0,
): Promise<Buffer> {
  const bold = (value: string) => ({ value, fontWeight: 'bold' as const });
  const cover = [
    [bold('Your personal data')],
    [{ value: 'Landlord' }, { value: meta.companyName }],
    [{ value: 'Prepared at (UTC)' }, { value: meta.preparedAt.toISOString() }],
    [{ value: 'Dates are in' }, { value: meta.timeZone }],
    [
      { value: 'About' },
      {
        value:
          'Every record the landlord holds about you in this system, under the Data Protection Act, 2012 (Act 843). ID and tax numbers are shown masked. The files listed below are in the same archive.',
      },
    ],
    [],
    [bold('File'), bold('What it is'), bold('SHA-256'), bold('Matches what was stored')],
    ...files.map((f) =>
      f.bytes
        ? [
            { value: f.name },
            { value: f.what },
            { value: f.sha256 },
            { value: f.intact ? 'Yes' : 'No' },
          ]
        : [
            { value: f.name },
            { value: f.what },
            {
              value:
                'Not included: the virus check quarantined this file. Ask the landlord for it.',
            },
          ],
    ),
    ...(leftOut.length === 0
      ? []
      : [
          [],
          [bold('Not included in this archive')],
          [
            {
              value: `One archive holds at most ${Math.ceil(capBytes / (1024 * 1024))} MB of files, so these were left out, largest first. They are still kept: staff can download each one from the record it belongs to and send it to you.`,
            },
          ],
          [bold('File'), bold('What it is'), bold('Date'), bold('Belongs to'), bold('Size (MB)')],
          ...leftOut.map((f) => [
            { value: f.name },
            { value: f.what },
            f.on ? { value: f.on } : null,
            { value: f.belongsTo },
            {
              value: (f.sizeBytes / (1024 * 1024)).toLocaleString('en-GB', {
                maximumFractionDigits: 1,
              }),
            },
          ]),
        ]),
  ];
  return writeXlsxFile([
    { sheet: 'About', data: cover },
    ...data.sheets.map((s) => ({
      sheet: s.name,
      data: [s.columns.map((c) => bold(c)), ...s.rows.map((r) => [...r])],
    })),
  ]).toBuffer();
}
