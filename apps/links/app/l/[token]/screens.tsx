import type { SigningPage } from '../../../lib/links-api';
import {
  canDecline,
  noticeHeading,
  noticeOf,
  readOnlyBanner,
  statementOf,
  type Notice,
} from '../../../lib/notice';
import { day } from '../../../lib/pay';
import { problemText } from '../../../lib/problems';
import { sanitiseDocumentHtml } from '../../../lib/sanitize';
import { DrawPad } from './draw-pad';

type Query = Readonly<Record<string, string | undefined>>;

/** A time for people, always naming the zone (DO-04). */
function when(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
  return `${text} (${timeZone})`;
}

function Contact({ page }: { page: SigningPage }) {
  const { landlord } = page;
  return (
    <section className="panel contact" aria-labelledby="contact">
      <h2 id="contact">Questions?</h2>
      <p>
        Contact {landlord.name}
        {landlord.contactName ? `: ${landlord.contactName}` : ''}.
      </p>
      {landlord.phone ? (
        <p>
          Phone: <a href={`tel:${landlord.phone}`}>{landlord.phone}</a>
        </p>
      ) : null}
      {landlord.email ? (
        <p>
          Email: <a href={`mailto:${landlord.email}`}>{landlord.email}</a>
        </p>
      ) : null}
    </section>
  );
}

/** What a notice is: its number, type, when it was issued and its date (M7 plan 4.5). */
function NoticeFacts({ notice, timeZone }: { notice: Notice; timeZone: string }) {
  return (
    <dl className="facts" aria-label="The notice">
      <div>
        <dt>Notice</dt>
        <dd>{notice.number}</dd>
      </div>
      <div>
        <dt>Type</dt>
        <dd>{notice.typeLabel}</dd>
      </div>
      <div>
        <dt>Issued</dt>
        <dd>{when(notice.issuedAt, timeZone)}</dd>
      </div>
      {notice.effectiveDate ? (
        <div>
          <dt>Effective date</dt>
          <dd>{day(notice.effectiveDate)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

/** For a company tenant: another authorised signatory has acknowledged for the company (LN-07). */
function AcknowledgedByAnother({ notice }: { notice: Notice | null }) {
  if (!notice?.acknowledgedByAnother) return null;
  return (
    <p className="panel done" role="status">
      Someone else has already acknowledged this notice for your company.
    </p>
  );
}

/** The notice's PDF and its fingerprint, while the link may download it. */
function NoticeDownload({ token, page }: { token: string; page: SigningPage }) {
  if (!page.document.downloadable) return null;
  return (
    <p>
      <a href={`/l/${token}/document`}>Download the notice (PDF)</a>
      <br />
      <span className="small">
        Its fingerprint (SHA-256): <code className="hash">{page.document.sha256}</code>
      </span>
    </p>
  );
}

/**
 * A notice that was corrected by a later one, or closed (M7 plan 4.8): read-only, with a banner
 * naming the new notice where there is one. It still opens, and its PDF still downloads.
 */
export function NoticeReadOnly({ token, page }: { token: string; page: SigningPage }) {
  const notice = noticeOf(page);
  return (
    <>
      <h1>{noticeHeading(page)}</h1>
      <p className="panel notice" role="status">
        {readOnlyBanner(page)}
      </p>
      {notice ? <NoticeFacts notice={notice} timeZone={page.timeZone} /> : null}
      {page.document.html ? (
        <article
          className="document"
          aria-label="The notice"
          dangerouslySetInnerHTML={{ __html: sanitiseDocumentHtml(page.document.html) }}
        />
      ) : null}
      <NoticeDownload token={token} page={page} />
      <Contact page={page} />
    </>
  );
}

/** A notice's link that no longer signs: acknowledged, expired, or acknowledged by another. */
function NoticeExplanation({
  token,
  page,
  notice,
  done,
}: {
  token: string;
  page: SigningPage;
  notice: Notice;
  done?: string | undefined;
}) {
  let heading: string;
  let body: string;
  switch (page.screen) {
    case 'signed':
      heading =
        done === 'signed'
          ? 'Thank you: you have acknowledged receipt'
          : 'You have already acknowledged receipt';
      body = `You acknowledged notice ${notice.number}${page.signer.signedAt ? ` on ${when(page.signer.signedAt, page.timeZone)}` : ''}. This confirms that you received it, not that you agree with it.`;
      break;
    case 'expired':
      heading = 'This link has expired';
      body = `Links to a notice work until its notice period ends. Ask ${page.landlord.name} for a copy of notice ${notice.number}.`;
      break;
    case 'revoked':
      heading = 'This link no longer works';
      body = `Ask ${page.landlord.name} for a copy of notice ${notice.number}.`;
      break;
    default:
      heading = 'This notice no longer needs your signature';
      body = notice.acknowledgedByAnother
        ? `Someone else has already acknowledged notice ${notice.number} for your company.`
        : `Notice ${notice.number} no longer needs your signature.`;
  }
  return (
    <>
      <h1>{heading}</h1>
      <p className={done ? 'panel done' : undefined}>{body}</p>
      <NoticeFacts notice={notice} timeZone={page.timeZone} />
      {page.screen === 'expired' || page.screen === 'revoked' ? null : (
        <NoticeDownload token={token} page={page} />
      )}
      <Contact page={page} />
    </>
  );
}

function Signers({ page }: { page: SigningPage }) {
  return (
    <ul className="signers">
      {page.signers.map((s, i) => (
        <li key={i}>
          <span>
            {s.name}
            <br />
            <span className="small">{s.roleLabel}</span>
          </span>
          <span className={`status ${s.status}`}>
            {s.status === 'signed' ? 'Signed' : s.status === 'declined' ? 'Declined' : 'To sign'}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A link that no longer signs: what happened, and who to contact (plan 4.8). A signer who has
 * signed can download the document they signed only while their link is live (the API says so
 * with `downloadable`); an expired or revoked link offers nothing to download.
 */
export function Explanation({
  token,
  page,
  done,
}: {
  token: string;
  page: SigningPage;
  done?: string | undefined;
}) {
  const notice = noticeOf(page);
  if (notice) return <NoticeExplanation token={token} page={page} notice={notice} done={done} />;
  const { title } = page.document;
  let heading: string;
  let body: string;
  switch (page.screen) {
    case 'signed':
      heading = done === 'signed' ? 'Thank you: you have signed' : 'You have already signed';
      body =
        page.reason === 'completed'
          ? `Everyone has signed ${title}. Your signed copy has been sent to you.`
          : page.reason === 'cancelled'
            ? `You signed ${title}, but the landlord then withdrew it, for example to change it. If it is sent again, you will get a new link.`
            : page.reason === 'declined'
              ? `You signed ${title}, but signing stopped because another signer declined. If it is sent again, you will get a new link.`
              : `You signed ${title}${page.signer.signedAt ? ` on ${when(page.signer.signedAt, page.timeZone)}` : ''}. We will send you the signed copy once everyone has signed.`;
      break;
    case 'declined':
      heading = done === 'declined' ? 'You declined to sign' : 'You have declined to sign';
      body = `You declined to sign ${title}. The landlord has been told and may send you a new version.`;
      break;
    case 'expired':
      heading = 'This link has expired';
      body = 'Signing links work for 30 days. Ask the landlord to send you a new link.';
      break;
    case 'revoked':
      heading = 'This link has been replaced';
      body =
        page.reason === 'superseded'
          ? 'A newer link was sent to you, so this one no longer works. Use the newest message, or ask for a new link.'
          : 'This link no longer works. Ask the landlord to send you a new link.';
      break;
    default:
      heading = 'This document is no longer out for signing';
      body =
        page.reason === 'cancelled'
          ? `${title} was withdrawn by the landlord, for example to change it. If it is sent again, you will get a new link.`
          : page.reason === 'declined'
            ? `Signing ${title} stopped because one of the signers declined. If it is sent again, you will get a new link.`
            : page.reason === 'completed'
              ? `Everyone has signed ${title}.`
              : page.reason === 'signed_by_all'
                ? `Everyone who must sign ${title} has signed, so it no longer needs your signature. The signed copy is being prepared.`
                : 'Ask the landlord to send you a new link.';
  }
  return (
    <>
      <h1>{heading}</h1>
      <p className={done ? 'panel done' : undefined}>{body}</p>
      {page.screen === 'signed' && page.document.downloadable ? (
        <p>
          <a href={`/l/${token}/document`}>Download the document you signed (PDF)</a>
          <br />
          <span className="small">
            Its fingerprint (SHA-256): <code className="hash">{page.document.sha256}</code>
          </span>
        </p>
      ) : null}
      {page.screen === 'signed' && page.signers.length > 0 ? <Signers page={page} /> : null}
      <Contact page={page} />
    </>
  );
}

/** The signed-copy page: everyone has signed; download the copy with its certificate. */
export function CopyScreen({ token, page }: { token: string; page: SigningPage }) {
  const notice = noticeOf(page);
  if (notice)
    return (
      <>
        <h1>Your signed acknowledgement is ready</h1>
        <p>
          It is notice {notice.number} with a certificate page that records your acknowledgement:
          that you received the notice, not that you agree with it.
        </p>
        <p>
          <a className="button" href={`/l/${token}/document`}>
            Download the signed acknowledgement (PDF)
          </a>
        </p>
        <p className="small">
          Fingerprint of the signed acknowledgement (SHA-256):{' '}
          <code className="hash">{page.document.finalSha256}</code>
        </p>
        <p className="small">
          Fingerprint of the notice (SHA-256): <code className="hash">{page.document.sha256}</code>
        </p>
        <Contact page={page} />
      </>
    );
  return (
    <>
      <h1>Your signed copy is ready</h1>
      <p>
        Everyone has signed {page.document.title} (reference {page.document.reference}). The copy
        ends with a signing certificate that records each signature.
      </p>
      <p>
        <a className="button" href={`/l/${token}/document`}>
          Download the signed copy (PDF)
        </a>
      </p>
      <p className="small">
        Fingerprint of the signed copy (SHA-256):{' '}
        <code className="hash">{page.document.finalSha256}</code>
      </p>
      <p className="small">
        Fingerprint of the document everyone signed (SHA-256):{' '}
        <code className="hash">{page.document.sha256}</code>
      </p>
      <Contact page={page} />
    </>
  );
}

/**
 * The signing page (plan 4.8): the document, then the code, the signature and consent. For a
 * notice (M7 plan 4.5): what the notice is, the statement that signing acknowledges receipt, not
 * agreement, above the signature box, and no way to decline.
 */
export function SignScreen({
  token,
  page,
  query,
}: {
  token: string;
  page: SigningPage;
  query: Query;
}) {
  const problem = problemText(query);
  const code = page.code!;
  const locked = code.lockedUntil !== null;
  const draw = query.draw === '1';
  const notice = noticeOf(page);
  const declinable = canDecline(page);
  const declining = declinable && query.step === 'decline';
  const base = `/l/${token}`;
  return (
    <>
      {notice ? (
        <>
          <h1>{noticeHeading(page)}</h1>
          <p className="panel notice">
            {page.landlord.name} has sent you, {page.signer.name}, this notice. Read it, then{' '}
            <a href="#sign">acknowledge at the end</a> that you received it.
          </p>
          <NoticeFacts notice={notice} timeZone={page.timeZone} />
          <AcknowledgedByAnother notice={notice} />
        </>
      ) : (
        <p className="panel notice">
          {page.landlord.name} asks you, {page.signer.name}, to sign this document as{' '}
          {page.signer.roleLabel.toLowerCase()}. Read it, then <a href="#sign">sign at the end</a>.
        </p>
      )}
      <article
        className="document"
        aria-label={notice ? 'The notice' : 'The document'}
        dangerouslySetInnerHTML={{ __html: sanitiseDocumentHtml(page.document.html) }}
      />
      <p>
        <a href={`${base}/document`}>Download the PDF</a>
        <br />
        <span className="small">
          Its fingerprint (SHA-256): <code className="hash">{page.document.sha256}</code>
        </span>
      </p>

      <section id="sign" aria-labelledby="sign-heading">
        <h2 id="sign-heading">
          {notice ? 'Acknowledge receipt' : declining ? 'Decline to sign' : 'Sign'}
        </h2>
        {notice ? (
          <p className="panel notice" id="statement">
            <strong>{statementOf(notice)}</strong>
          </p>
        ) : (
          <Signers page={page} />
        )}
        {problem ? (
          <p className="panel problem" role="alert">
            {problem}
          </p>
        ) : null}
        {declining ? (
          <form method="post" action={`${base}/decline`}>
            <label htmlFor="reason">Why are you declining?</label>
            <textarea id="reason" name="reason" rows={3} required minLength={3} maxLength={500} />
            <p className="small">
              The landlord will see your reason. The lease goes back to them to change or cancel.
            </p>
            <button type="submit">Decline to sign</button> <a href={`${base}#sign`}>Back</a>
          </form>
        ) : locked ? (
          <p className="panel problem" role="alert">
            Too many wrong codes. Signing is locked until {when(code.lockedUntil, page.timeZone)}.
          </p>
        ) : code.sentAt === null ? (
          <form method="post" action={`${base}/code`}>
            <p>
              To sign, you need a 6-digit code. We will send it{' '}
              {code.channel === 'sms' ? 'by SMS to' : 'by email to'} {code.destinationMasked}.
            </p>
            <button type="submit" disabled={code.sendsLeft === 0}>
              Send me a code
            </button>
            {code.sendsLeft === 0 ? (
              <p className="small">You have asked for 3 codes. Wait a few minutes.</p>
            ) : null}
          </form>
        ) : (
          <>
            <form method="post" action={`${base}/sign`}>
              <p>
                We sent a code {code.channel === 'sms' ? 'by SMS to' : 'by email to'}{' '}
                {code.destinationMasked}. It works until {when(code.expiresAt, page.timeZone)}.
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
              {draw ? (
                <>
                  <input type="hidden" name="method" value="drawn" />
                  <label htmlFor="pad">Draw your signature</label>
                  <DrawPad name="drawing" />
                  <p className="small">
                    <a href={`${base}#sign`}>Type your name instead</a>
                  </p>
                </>
              ) : (
                <>
                  <input type="hidden" name="method" value="typed" />
                  <label htmlFor="typedName">Type your full name to sign</label>
                  <input
                    id="typedName"
                    name="typedName"
                    type="text"
                    autoComplete="name"
                    minLength={2}
                    maxLength={120}
                    required
                  />
                  <p className="small">
                    <a href={`${base}?draw=1#sign`}>Draw your signature instead</a>
                  </p>
                </>
              )}
              <input type="hidden" name="consentVersion" value={page.consent?.version ?? ''} />
              <label className="check">
                <input type="checkbox" name="consent" value="yes" required />
                <span>{page.consent?.text}</span>
              </label>
              <button type="submit">{notice ? 'Sign to acknowledge receipt' : 'Sign'}</button>
            </form>
            <form method="post" action={`${base}/code`}>
              <button className="secondary" type="submit" disabled={code.sendsLeft === 0}>
                Send a new code
              </button>
            </form>
          </>
        )}
        {declinable && !declining ? (
          <p className="small">
            <a href={`${base}?step=decline#sign`}>I do not want to sign</a>
          </p>
        ) : null}
      </section>
      <Contact page={page} />
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
