import {
  MAINTENANCE_CATEGORY_LABELS,
  MAINTENANCE_PRIORITY_LABELS,
  MEDIA_MAX_FILES_PER_REQUEST,
  MEDIA_RULES,
} from '@rent/domain/maintenance';
import { attachmentLabel, jobSheetProblem } from '../../../lib/job-sheet';
import { newFormId } from '../../../lib/job-sheet-store';
import type { JobSheetView } from '../../../lib/links-api';
import { when } from '../../../lib/pay';

// The artisan's job sheet (MI-04, MI-06; M8 decision 6). Plain HTML forms, no script of its own.
// It shows the unit, the description, the tenant's photos and videos (F1) and the property
// contact's phone, never the tenant's own phone number or anything else about them. Each form
// carries an id of its own, so a second tap gets the first one's answer (lib/job-sheet-store.ts).

type Query = Readonly<Record<string, string | undefined>>;

const PHOTO_TYPES = MEDIA_RULES.image.contentTypes.join(',');

/** "Job MT-0042: Plumbing", or the ticket alone before the job has a category. */
export function jobHeading(sheet: JobSheetView): string {
  return sheet.category
    ? `Job ${sheet.ticket}: ${MAINTENANCE_CATEGORY_LABELS[sheet.category]}`
    : `Job ${sheet.ticket}`;
}

function Facts({ sheet }: { sheet: JobSheetView }) {
  return (
    <dl className="facts" aria-label="The job">
      {sheet.priority ? (
        <div>
          <dt>Priority</dt>
          <dd>{MAINTENANCE_PRIORITY_LABELS[sheet.priority]}</dd>
        </div>
      ) : null}
      <div>
        <dt>Property</dt>
        <dd>{sheet.property.name}</dd>
      </div>
      {sheet.property.address ? (
        <div>
          <dt>Address</dt>
          <dd>{sheet.property.address}</dd>
        </div>
      ) : null}
      {sheet.unitCode ? (
        <div>
          <dt>Unit</dt>
          <dd>{sheet.unitCode}</dd>
        </div>
      ) : null}
      {sheet.visitAt ? (
        <div>
          <dt>Visit</dt>
          <dd>{when(sheet.visitAt, sheet.timeZone)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

/** Who to call about the job: the property's contact, never the tenant. None on a dead link. */
function Contact({ sheet }: { sheet: JobSheetView }) {
  const { contact } = sheet;
  if (!contact) return null;
  return (
    <section className="panel contact" aria-labelledby="contact">
      <h2 id="contact">Questions about this job?</h2>
      <p>Call {contact.name}.</p>
      {contact.phone ? (
        <p>
          Phone: <a href={`tel:${contact.phone}`}>{contact.phone}</a>
        </p>
      ) : null}
    </section>
  );
}

/** The person the job came from, as the notice names them: the property's contact. */
const fromWhom = (sheet: JobSheetView) => sheet.contact?.name ?? sheet.property.name;

/** F1: the tenant's photos and videos from the report; never voice notes or later files. */
function Files({ token, sheet }: { token: string; sheet: JobSheetView }) {
  const reported = sheet.attachments.filter(
    (a) => a.stage === 'report' && (a.kind === 'image' || a.kind === 'video'),
  );
  if (reported.length === 0) return null;
  return (
    <section aria-labelledby="files">
      <h2 id="files">From the tenant’s report</h2>
      <ul>
        {reported.map((attachment, index) => (
          <li key={attachment.id}>
            <a href={`/j/${token}/attachment/${attachment.id}`}>
              {attachmentLabel(attachment, index)}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Problem({ query, timeZone }: { query: Query; timeZone: string }) {
  const problem = jobSheetProblem(query, timeZone);
  return problem ? (
    <p className="panel problem" role="alert">
      {problem}
    </p>
  ) : null;
}

/** The form's own id, sent back with it. */
const FormId = () => <input type="hidden" name="form" value={newFormId()} />;

function PhotoField({ id, label, required }: { id: string; label: string; required?: boolean }) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <input id={id} name="photos" type="file" accept={PHOTO_TYPES} multiple required={required} />
      <p className="small hint">
        JPEG, PNG or WebP, up to {MEDIA_RULES.image.maxBytes / 1_000_000} MB each and{' '}
        {MEDIA_MAX_FILES_PER_REQUEST} at a time.
      </p>
    </>
  );
}

/** Accept or decline, start with a before photo or a reason, and complete with the code. */
export function SheetScreen({
  token,
  sheet,
  query,
  kept = 0,
}: {
  token: string;
  sheet: JobSheetView;
  query: Query;
  /** Photos of the finished work already in storage from a refused try (a wrong code). */
  kept?: number;
}) {
  const base = `/j/${token}`;
  const declining = sheet.actions.decline && query.step === 'decline';
  const code = sheet.code;
  const locked = code?.lockedUntil != null;
  return (
    <>
      <h1>{jobHeading(sheet)}</h1>
      <p className="panel notice">
        {sheet.artisan.name}, {fromWhom(sheet)} has a job for you. Read it, then answer below.
      </p>
      <Facts sheet={sheet} />
      {sheet.description ? (
        <section aria-labelledby="what">
          <h2 id="what">What needs doing</h2>
          <p className="instructions">{sheet.description}</p>
        </section>
      ) : null}
      <Files token={token} sheet={sheet} />

      <section id="act">
        <Problem query={query} timeZone={sheet.timeZone} />
        {sheet.actions.accept || sheet.actions.decline ? (
          <>
            <h2 id="act-respond">{declining ? 'Decline the job' : 'Can you do this job?'}</h2>
            {declining ? (
              <form method="post" action={`${base}/respond`}>
                <input type="hidden" name="response" value="declined" />
                <label htmlFor="reason">Why can you not take it?</label>
                <textarea id="reason" name="reason" rows={3} maxLength={500} />
                <button type="submit">Decline the job</button> <a href={`${base}#act`}>Back</a>
              </form>
            ) : (
              <>
                {sheet.actions.accept ? (
                  <form method="post" action={`${base}/respond`}>
                    <input type="hidden" name="response" value="accepted" />
                    <button type="submit">Accept the job</button>
                  </form>
                ) : null}
                {sheet.actions.decline ? (
                  <p className="small">
                    <a href={`${base}?step=decline#act`}>I cannot take this job</a>
                  </p>
                ) : null}
              </>
            )}
          </>
        ) : null}

        {sheet.actions.start ? (
          <>
            <h2 id="act-start">Start the work</h2>
            <form method="post" action={`${base}/start`} encType="multipart/form-data">
              <FormId />
              <PhotoField id="before" label="A photo from before you start" />
              <label htmlFor="beforePhotoReason">No photo? Say why</label>
              <textarea id="beforePhotoReason" name="beforePhotoReason" rows={2} maxLength={500} />
              <button type="submit">Start the work</button>
            </form>
          </>
        ) : null}

        {sheet.actions.complete ? (
          <>
            <h2 id="act-complete">Finish the work</h2>
            {locked ? (
              <p className="panel problem" role="alert">
                Too many wrong codes. Sending is locked until{' '}
                {when(code!.lockedUntil!, sheet.timeZone)}.
              </p>
            ) : !code || code.sentAt === null ? (
              <form method="post" action={`${base}/code`}>
                <FormId />
                <p>
                  To send the finished work, you need a 6-digit code. We will send it by SMS
                  {code ? ` to ${code.destinationMasked}` : ' to your phone'}.
                </p>
                <button type="submit" disabled={code?.sendsLeft === 0}>
                  Send me a code
                </button>
              </form>
            ) : (
              <>
                <form method="post" action={`${base}/complete`} encType="multipart/form-data">
                  <FormId />
                  {kept > 0 ? (
                    <p className="panel notice" role="status">
                      {kept === 1
                        ? 'Your photo of the finished work is kept from your last try.'
                        : `Your ${kept} photos of the finished work are kept from your last try.`}{' '}
                      Choose photos only to replace them.
                    </p>
                  ) : null}
                  <PhotoField
                    id="after"
                    label={
                      kept > 0 ? 'Other photos of the finished work' : 'Photos of the finished work'
                    }
                    required={kept === 0}
                  />
                  <label htmlFor="completionNote">What did you do?</label>
                  <textarea
                    id="completionNote"
                    name="completionNote"
                    rows={3}
                    minLength={3}
                    maxLength={2000}
                    required
                  />
                  <p>
                    We sent a code by SMS to {code.destinationMasked}. It works until{' '}
                    {code.expiresAt ? when(code.expiresAt, sheet.timeZone) : 'shortly'}.
                  </p>
                  <label htmlFor="code">Your 6-digit code</label>
                  <input
                    className="code"
                    id="code"
                    name="code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                  />
                  <button type="submit">Send the finished work</button>
                </form>
                <form method="post" action={`${base}/code`}>
                  <FormId />
                  <button className="secondary" type="submit" disabled={code.sendsLeft === 0}>
                    Send a new code
                  </button>
                </form>
              </>
            )}
          </>
        ) : null}

        {!sheet.actions.accept &&
        !sheet.actions.decline &&
        !sheet.actions.start &&
        !sheet.actions.complete ? (
          <p className="panel notice" role="status">
            {sheet.artisan.response === 'declined'
              ? 'You declined this job. Nothing more is needed from you.'
              : 'Nothing is needed from you on this job just now.'}
          </p>
        ) : null}
      </section>
      <Contact sheet={sheet} />
      <p className="small">This link works until {when(sheet.linkExpiresAt, sheet.timeZone)}.</p>
    </>
  );
}

/** The work is recorded as done; the tenant is asked to confirm. */
export function DoneScreen({ sheet, done }: { sheet: JobSheetView; done: boolean }) {
  return (
    <>
      <h1>{done ? 'Thank you: the work is recorded as done' : 'The work is recorded as done'}</h1>
      <p className={done ? 'panel done' : undefined} role="status">
        {jobHeading(sheet)} is waiting for the tenant to confirm it.
      </p>
      <Facts sheet={sheet} />
      <Contact sheet={sheet} />
    </>
  );
}

/**
 * A link that no longer works: closed, expired or replaced. An expired or replaced link names the
 * job only: no property, address or contact (M8 review LT 9); the API sends none of them.
 */
export function ClosedScreen({ sheet }: { sheet: JobSheetView }) {
  const [heading, body] =
    sheet.screen === 'expired'
      ? ['This link has expired', 'Job sheet links work until the job closes, or for 30 days.']
      : sheet.screen === 'revoked'
        ? [
            'This link no longer works',
            'The job was given to someone else, or a newer link was sent.',
          ]
        : ['This job is closed', 'Nothing more is needed from you on this job.'];
  return (
    <>
      <h1>{heading}</h1>
      <p>
        {body}{' '}
        {sheet.screen === 'closed'
          ? `${jobHeading(sheet)} at ${sheet.property.name}.`
          : `${jobHeading(sheet)}.`}
      </p>
      {sheet.screen === 'closed' ? <Contact sheet={sheet} /> : null}
    </>
  );
}

/** The API could not be reached, or asked us to slow down. */
export function Trouble({ busy }: { busy: boolean }) {
  return (
    <>
      <h1>{busy ? 'Too many requests' : 'This page is not available just now'}</h1>
      <p>
        {busy
          ? 'This link was opened many times in a short while. Wait a few minutes and try again.'
          : 'Something went wrong on our side. Try again in a few minutes.'}
      </p>
    </>
  );
}
